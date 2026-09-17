import Database from 'better-sqlite3';
import type { Stats } from 'node:fs';
import { lstatSync, existsSync, openSync, closeSync, readSync, readFileSync, writeFileSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrokerError } from './herdr.js';

export type Submission = 'dispatching' | 'accepted' | 'rejected' | 'unknown';
export type Observation = 'not_started' | 'observing' | 'completion_observed' | 'outcome_unknown' | 'not_applicable';
export interface Control {
  proposal_id: string; job_id: string; pane_session_id: string; terminal_id: string;
  payload_digest: string; mode_revision: number; operation: 'input' | 'execute' | 'interrupt';
  original_proposal_id: string | null;
  authorization: string; approval_expires: number | null; approval_consumed: boolean;
  submission_state: Submission; observation_state: Observation; exit_code: number | null;
  created_at: number; updated_at: number; hold_reason: string | null; recovery: string | null;
}
export type FaultPoint = 'before_intent' | 'in_transaction' | 'after_intent' | 'before_wire' | 'after_wire' | 'before_ack_record' | 'after_ack_record';
export class Ledger {
  private readonly db: Database.Database;
  private readonly path: string;
  private readonly inode: Stats;
  private readonly sidecars = new Map<string, Stats>();
  private identity?: { path: string; value: string };
  constructor(directory: string, private readonly verifyAuthority: () => void, private readonly now = Date.now, private readonly fault: (point: FaultPoint) => void = () => {}, allowInitialize = false) {
    this.path = join(directory, 'ledger.sqlite');
    const marker = join(directory, 'ledger.identity');
    const fresh = !existsSync(this.path) && !existsSync(marker);
    if (fresh && !allowInitialize) throw new BrokerError('ledger_missing');
    if (!fresh && (!existsSync(this.path) || !existsSync(marker))) throw new BrokerError('ledger_missing');
    if (!fresh) {
      if (this.checkFile(marker).size > 128) throw new BrokerError('ledger_invalid');
      const identity = readFileSync(marker, 'utf8');
      if (!/^[0-9a-f-]{36}\n(?:dirty|clean)\n\d{1,16}$/.test(identity) || !Number.isSafeInteger(Number(identity.split('\n')[2]))) throw new BrokerError('ledger_invalid');
      if (identity.split('\n')[1] === 'dirty' && !existsSync(this.path + '-wal')) throw new BrokerError('ledger_missing');
    }
    if (fresh) closeSync(openSync(this.path, 'wx', 0o600));
    this.inode = lstatSync(this.path);
    this.checkFile(this.path);
    let db: Database.Database | undefined;
    try {
      db = new Database(this.path, { timeout: 0 });
      this.db = db;
      db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
      if (fresh) {
        const identity = randomUUID();
        db.transaction(() => {
          db!.exec('CREATE TABLE metadata (identity TEXT NOT NULL, generation INTEGER NOT NULL); CREATE TABLE intents (id TEXT PRIMARY KEY, job TEXT NOT NULL, terminal TEXT NOT NULL, operation TEXT NOT NULL, updated INTEGER NOT NULL, control TEXT NOT NULL); CREATE TABLE holds (terminal TEXT PRIMARY KEY, proposal TEXT NOT NULL); CREATE TABLE consumed (id TEXT PRIMARY KEY, digest TEXT NOT NULL)');
          db!.prepare('INSERT INTO metadata VALUES (?, 0)').run(identity);
        }).immediate();
        const fd = openSync(marker, 'wx', 0o600);
        try { writeFileSync(fd, identity + '\ndirty\n0'); fsyncSync(fd); } finally { closeSync(fd); }
        const directoryFd = openSync(directory, 'r');
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
      this.checkFile(marker);
      const saved = readFileSync(marker, 'utf8').split('\n');
      const metadata = db.prepare('SELECT identity, generation FROM metadata').get() as { identity: string; generation: number } | undefined;
      if (!metadata || metadata.identity !== saved[0] || metadata.generation < Number(saved[2]) || db.pragma('quick_check', { simple: true }) !== 'ok') throw new BrokerError('ledger_invalid');
      this.identity = { path: marker, value: metadata.identity + '\ndirty\n' + metadata.generation };
      this.mark('dirty');
      this.verify();
      this.commit(() => {
        for (const row of db!.prepare('SELECT control FROM intents').all() as Array<{ control: string }>) {
          const control: Control = JSON.parse(row.control);
          if (control.submission_state === 'dispatching') control.submission_state = 'unknown';
          if (control.observation_state === 'observing') control.observation_state = 'outcome_unknown';
          if (this.held(control.terminal_id) === control.proposal_id) { control.hold_reason = 'core_restart'; control.updated_at = this.now(); }
          db!.prepare('UPDATE intents SET control = ?, updated = ? WHERE id = ?').run(JSON.stringify(control), control.updated_at, control.proposal_id);
        }
      });
      for (const path of [marker, this.path + '-wal', this.path + '-shm']) this.sidecars.set(path, this.checkFile(path));
    } catch (error) { db?.close(); throw error instanceof BrokerError ? error : new BrokerError('ledger_invalid'); }
  }
  private checkFile(path: string) {
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new BrokerError('ledger_permissions');
    return info;
  }
  private mark(state: 'dirty' | 'clean', generation = Number(this.identity!.value.split('\n')[2])) {
    const value = this.identity!.value.split('\n')[0] + '\n' + state + '\n' + generation;
    const fd = openSync(this.identity!.path, 'r+');
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    this.identity!.value = value;
  }
  private commit<T>(work: () => T): T {
    const result = this.db.transaction(() => {
      const value = work();
      this.db.prepare('UPDATE metadata SET generation = generation + 1').run();
      return value;
    }).immediate();
    const { generation } = this.db.prepare('SELECT generation FROM metadata').get() as { generation: number };
    // This durable witness must advance before any input can leave the core.
    this.mark('dirty', generation);
    this.verify();
    return result;
  }
  verify() {
    try {
      this.verifyAuthority(); this.checkFile(this.path);
      const current = lstatSync(this.path);
      if (current.ino !== this.inode.ino || current.dev !== this.inode.dev) throw new BrokerError('ledger_lost');
      const fd = openSync(this.path, 'r'), header = Buffer.alloc(16);
      try { if (readSync(fd, header, 0, 16, 0) !== 16 || header.toString() !== 'SQLite format 3\0') throw new BrokerError('ledger_invalid'); }
      finally { closeSync(fd); }
      if (this.identity && (this.checkFile(this.identity.path).size > 128 || readFileSync(this.identity.path, 'utf8') !== this.identity.value)) throw new BrokerError('ledger_lost');
      for (const [path, expected] of this.sidecars) {
        const info = this.checkFile(path);
        if (info.ino !== expected.ino || info.dev !== expected.dev || info.size < expected.size) throw new BrokerError('ledger_lost');
        this.sidecars.set(path, info);
      }
    } catch { throw new BrokerError('ledger_unavailable'); }
  }
  get(id: string): Control | undefined {
    this.verify();
    const row = this.db.prepare('SELECT control FROM intents WHERE id = ?').get(id) as { control: string } | undefined;
    return row ? JSON.parse(row.control) : undefined;
  }
  held(terminal: string) {
    this.verify();
    return (this.db.prepare('SELECT proposal FROM holds WHERE terminal = ?').get(terminal) as { proposal: string } | undefined)?.proposal;
  }
  count(job: string, operation: string) { return (this.db.prepare('SELECT count(*) AS n FROM intents WHERE job = ? AND operation = ?').get(job, operation) as { n: number }).n; }
  ordinaryCount(job: string) { return this.count(job, 'input') + this.count(job, 'execute'); }
  requireInterruptTarget(id: string | undefined, terminal: string, session: string) {
    const original = id ? this.get(id) : undefined;
    if (!original || original.operation !== 'execute' || original.terminal_id !== terminal || original.pane_session_id !== session || this.held(terminal) !== id || !['observing', 'outcome_unknown'].includes(original.observation_state)) throw new BrokerError('original_action_unavailable');
    return original;
  }
  intent(control: Control) {
    this.verify(); this.fault('before_intent');
    try {
      const result = this.commit(() => {
        const existing = this.get(control.proposal_id);
        if (existing) {
          if (existing.payload_digest !== control.payload_digest) throw new BrokerError('payload_mismatch');
          return { fresh: false, control: existing };
        }
        if (this.db.prepare('SELECT id FROM consumed WHERE id = ?').get(control.proposal_id)) throw new BrokerError('proposal_consumed');
        if (control.operation !== 'interrupt' && this.held(control.terminal_id)) throw new BrokerError('terminal_held');
        if (control.operation === 'interrupt') this.requireInterruptTarget(control.original_proposal_id ?? undefined, control.terminal_id, control.pane_session_id);
        if (control.operation === 'interrupt' ? this.count(control.job_id, 'interrupt') >= 1 : this.ordinaryCount(control.job_id) >= 3) throw new BrokerError('action_budget_exhausted');
        this.db.prepare('INSERT INTO intents VALUES (?, ?, ?, ?, ?, ?)').run(control.proposal_id, control.job_id, control.terminal_id, control.operation, control.updated_at, JSON.stringify(control));
        this.db.prepare('INSERT INTO consumed VALUES (?, ?)').run(control.proposal_id, control.payload_digest);
        if (control.operation !== 'interrupt') this.db.prepare('INSERT INTO holds VALUES (?, ?)').run(control.terminal_id, control.proposal_id);
        this.fault('in_transaction'); this.verify();
        return { fresh: true, control };
      });
      this.verify();
      return result;
    } catch (error) { throw error instanceof BrokerError ? error : new BrokerError('ledger_commit_failed'); }
  }
  update(control: Control, release = false) {
    this.verify();
    try { this.commit(() => {
      if (release && !control.recovery && control.operation === 'execute') {
        const pending = (this.db.prepare('SELECT control FROM intents WHERE terminal = ? AND operation = ?').all(control.terminal_id, 'interrupt') as Array<{ control: string }>).some(row => {
          const interrupt: Control = JSON.parse(row.control);
          return interrupt.original_proposal_id === control.proposal_id && ['dispatching', 'unknown'].includes(interrupt.submission_state);
        });
        if (pending) { release = false; control.hold_reason = 'interrupt_unconfirmed'; }
      }
      this.db.prepare('UPDATE intents SET updated = ?, control = ? WHERE id = ?').run(control.updated_at, JSON.stringify(control), control.proposal_id);
      if (release) this.db.prepare('DELETE FROM holds WHERE terminal = ? AND proposal = ?').run(control.terminal_id, control.proposal_id);
    }); } catch { throw new BrokerError('ledger_commit_failed'); }
  }
  recover(id: string, terminal: string) {
    const receipt = this.get(id);
    if (!receipt || this.held(terminal) !== id || receipt.terminal_id !== terminal) throw new BrokerError('hold_changed');
    receipt.recovery = receipt.operation === 'input' ? 'user_verified_input_target' : 'user_verified_ready_shell'; receipt.hold_reason = null; receipt.updated_at = this.now();
    if (receipt.observation_state === 'observing') receipt.observation_state = 'outcome_unknown';
    this.update(receipt, true);
    return receipt;
  }
  summary(maintain = true) {
    this.verify();
    if (maintain) this.commit(() => this.db.prepare("DELETE FROM intents WHERE updated < ? AND id NOT IN (SELECT proposal FROM holds) AND (operation != 'interrupt' OR json_extract(control, '$.original_proposal_id') NOT IN (SELECT proposal FROM holds))").run(this.now() - 7 * 86400000));
    const counts = this.db.prepare('SELECT (SELECT count(*) FROM intents) AS control_record_count, (SELECT count(*) FROM consumed) AS consumed_proposal_count, (SELECT count(*) FROM holds) AS held_terminal_count').get() as { control_record_count: number; consumed_proposal_count: number; held_terminal_count: number };
    return { ...counts, receipts: (this.db.prepare('SELECT control FROM intents ORDER BY updated DESC LIMIT 32').all() as Array<{ control: string }>).map(row => JSON.parse(row.control) as Control), held_terminals: this.db.prepare('SELECT h.terminal, h.proposal FROM holds h JOIN intents i ON i.id = h.proposal ORDER BY i.updated DESC, h.terminal LIMIT 32').all(), held_terminals_truncated: counts.held_terminal_count > 32, tombstone_days: 7 };
  }
  close() {
    if (!this.db.open) return;
    let intact = false;
    try { this.verify(); intact = true; } catch { /* A damaged ledger must remain dirty. */ }
    this.db.close();
    if (intact) this.mark('clean');
  }
}
