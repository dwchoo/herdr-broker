import Database from 'better-sqlite3';
import { existsSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './authority.js';
import { BrokerError, type Pane } from './herdr.js';

export interface Address { code: string; kind: 'broker' | 'pane'; key: string; pane_id: string | null; terminal_id: string | null; owner: string | null; role: 'target' | 'manager' | null; label: string | null }
export const paneKey = (endpoint: string, terminal: string) => JSON.stringify([endpoint, terminal]);

// One local namespace and ownership transaction across all cores/projects.
export class Registry {
  constructor(private readonly root: string) {}
  private use<T>(work: (db: Database.Database) => T): T {
    privateDirectory(this.root);
    const path = join(this.root, 'registry.sqlite');
    if (!existsSync(path)) { try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; } }
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077)) throw new BrokerError('registry_permissions');
    const db = new Database(path, { timeout: 5000 });
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS addresses (code INTEGER PRIMARY KEY CHECK(code BETWEEN 1000 AND 9999), kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, pane_id TEXT, terminal_id TEXT, owner TEXT, role TEXT, label TEXT);
        CREATE TABLE IF NOT EXISTS brokers (id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS managers (id TEXT PRIMARY KEY, token TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS manager_clients (id TEXT PRIMARY KEY, terminal TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL);`);
      return work(db);
    } finally { db.close(); }
  }
  private address(db: Database.Database, kind: Address['kind'], key: string, pane?: Pick<Pane, 'pane_id' | 'terminal_id'>): Address {
    let row = db.prepare('SELECT * FROM addresses WHERE key = ?').get(key) as Address | undefined;
    if (!row) {
      const { next } = db.prepare('SELECT COALESCE(MAX(code)+1,1000) AS next FROM addresses').get() as { next: number };
      if (next > 9999) throw new BrokerError('address_space_exhausted');
      db.prepare('INSERT INTO addresses(code,kind,key,pane_id,terminal_id) VALUES(?,?,?,?,?)').run(next, kind, key, pane?.pane_id ?? null, pane?.terminal_id ?? null);
      row = db.prepare('SELECT * FROM addresses WHERE key = ?').get(key) as Address;
    }
    return { ...row, code: String(row.code) };
  }
  identifyBroker(id: string) { return this.use(db => db.transaction(() => this.address(db, 'broker', id)).immediate()); }
  identifyPane(endpoint: string, pane: Pick<Pane, 'pane_id' | 'terminal_id'>) { return this.use(db => db.transaction(() => this.address(db, 'pane', paneKey(endpoint, pane.terminal_id), pane)).immediate()); }
  reservePane() { return this.use(db => db.transaction(() => this.address(db, 'pane', 'reserved:' + randomUUID())).immediate()); }
  bindReserved(address: Address, endpoint: string, pane: Pick<Pane, 'pane_id' | 'terminal_id'>) {
    this.use(db => db.transaction(() => {
      const key = paneKey(endpoint, pane.terminal_id);
      // Another metadata reader may discover the split before its creator receives it.
      // Preserve that published address and leave the reservation permanently unused.
      if (db.prepare('SELECT code FROM addresses WHERE key=?').get(key)) return;
      const result = db.prepare('UPDATE addresses SET key=?,pane_id=?,terminal_id=? WHERE key=? AND terminal_id IS NULL').run(key, pane.pane_id, pane.terminal_id, address.key);
      if (result.changes !== 1) throw new BrokerError('address_reservation_changed');
    }).immediate());
  }
  resolve(ref: string, kind: Address['kind']) {
    if (!/^[1-9][0-9]{3}$/.test(ref)) throw new BrokerError('address_exact_required');
    return this.use(db => {
      const row = db.prepare('SELECT * FROM addresses WHERE code = ? AND kind = ?').get(ref, kind) as Address | undefined;
      if (!row) throw new BrokerError('address_not_found');
      return { ...row, code: String(row.code) };
    });
  }
  read(id: string): unknown | undefined { return this.use(db => { const row = db.prepare('SELECT record FROM brokers WHERE id=?').get(id) as { record: string } | undefined; return row && JSON.parse(row.record); }); }
  records(): unknown[] { return this.use(db => (db.prepare('SELECT record FROM brokers').all() as { record: string }[]).map(row => JSON.parse(row.record))); }
  save(record: { console_id: string; endpoint: string; panes: { pane_id: string; terminal_id: string }[]; controller: { pane_id: string; terminal_id: string } | null }, token?: string, previous?: object) {
    return this.use(db => db.transaction(() => {
      const saved = db.prepare('SELECT record FROM brokers WHERE id=?').get(record.console_id) as { record: string } | undefined;
      if (previous && saved?.record !== JSON.stringify(previous)) throw new BrokerError('console_changed');
      this.address(db, 'broker', record.console_id);
      for (const [role, panes] of [['target', record.panes], ['manager', record.controller ? [record.controller] : []]] as const) for (const pane of panes) {
        const address = this.address(db, 'pane', paneKey(record.endpoint, pane.terminal_id), pane);
        if (address.owner && address.owner !== record.console_id) throw new BrokerError('pane_already_owned');
        db.prepare('UPDATE addresses SET owner=?, role=? WHERE key=?').run(record.console_id, role, address.key);
      }
      db.prepare("UPDATE addresses SET owner=NULL,role=NULL WHERE owner=? AND role='manager' AND terminal_id IS NOT ?").run(record.console_id, record.controller?.terminal_id ?? null);
      db.prepare('INSERT INTO brokers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.console_id, JSON.stringify(record));
      if (token) db.prepare('INSERT INTO managers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token').run(record.console_id, token);
      if (!record.controller) db.prepare('DELETE FROM managers WHERE id=?').run(record.console_id);
    }).immediate());
  }
  label(code: string, label: string) { this.use(db => db.prepare('UPDATE addresses SET label=? WHERE code=?').run(label, code)); }
  managerToken(id: string) { return this.use(db => (db.prepare('SELECT token FROM managers WHERE id=?').get(id) as { token: string } | undefined)?.token); }
  managerConnected(id: string, terminal: string) { return this.use(db => !!db.prepare('SELECT id FROM manager_clients WHERE id=? AND terminal=?').get(id, terminal)); }
  managerClient(id: string, terminal: string | null) { this.use(db => { if (terminal) db.prepare('INSERT INTO manager_clients VALUES(?,?) ON CONFLICT(id) DO UPDATE SET terminal=excluded.terminal').run(id, terminal); else db.prepare('DELETE FROM manager_clients WHERE id=?').run(id); }); }
  heartbeat(id: string, parent: { pane_id: string | null; terminal_id: string | null; state: string }) { this.use(db => db.prepare('INSERT INTO runtime VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(id, JSON.stringify(parent), Date.now())); }
  offline(id: string) { this.use(db => db.prepare('DELETE FROM runtime WHERE id=?').run(id)); }
  presence(id: string): { parent: { pane_id: string | null; terminal_id: string | null; state: string }; checked_at: number } | null {
    return this.use(db => { const row = db.prepare('SELECT state,updated FROM runtime WHERE id=?').get(id) as { state: string; updated: number } | undefined;
      return row && Date.now() - row.updated < 4000 ? { parent: JSON.parse(row.state), checked_at: row.updated } : null; });
  }
}
