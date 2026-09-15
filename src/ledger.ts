import Database from 'better-sqlite3';
import type { Stats } from 'node:fs';
import { lstatSync, existsSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrokerError } from './herdr.js';

export type Submission = 'dispatching' | 'accepted' | 'rejected' | 'unknown';
export type Observation = 'not_started' | 'observing' | 'completion_observed' | 'outcome_unknown' | 'not_applicable';
export interface Control {
  proposal_id: string; job_id: string; pane_session_id: string; terminal_id: string;
  payload_digest: string; mode_revision: number; operation: 'execute' | 'interrupt';
  authorization: string; approval_expires: number | null; approval_consumed: boolean;
  submission_state: Submission; observation_state: Observation; exit_code: number | null;
  created_at: number; updated_at: number; hold_reason: string | null; recovery: string | null;
}
export type FaultPoint = 'before_intent' | 'in_transaction' | 'after_intent' | 'before_wire' | 'after_wire' | 'before_ack_record' | 'after_ack_record';
export class Ledger {
  private readonly db: Database.Database;
  private readonly path: string;
  private readonly inode: Stats;
  constructor(directory: string, private readonly verifyAuthority: () => void, private readonly now = Date.now, private readonly fault: (point: FaultPoint) => void = () => {}) {
    this.path = join(directory, 'ledger.sqlite');
    const marker = join(directory, 'ledger.identity');
    const fresh = !existsSync(this.path) && !existsSync(marker);
    if (!fresh && (!existsSync(this.path) || !existsSync(marker))) throw new BrokerError('ledger_missing');
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
          db!.exec('CREATE TABLE metadata (identity TEXT NOT NULL); CREATE TABLE intents (id TEXT PRIMARY KEY, job TEXT NOT NULL, terminal TEXT NOT NULL, operation TEXT NOT NULL, updated INTEGER NOT NULL, control TEXT NOT NULL); CREATE TABLE holds (terminal TEXT PRIMARY KEY, proposal TEXT NOT NULL); CREATE TABLE consumed (id TEXT PRIMARY KEY, digest TEXT NOT NULL)');
          db!.prepare('INSERT INTO metadata VALUES (?)').run(identity);
        }).immediate();
        const fd = openSync(marker, 'wx', 0o600);
        try { writeFileSync(fd, identity); fsyncSync(fd); } finally { closeSync(fd); }
        const directoryFd = openSync(directory, 'r');
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
      this.checkFile(marker);
      const metadata = db.prepare('SELECT identity FROM metadata').get() as { identity: string } | undefined;
      if (metadata?.identity !== readFileSync(marker, 'utf8') || db.pragma('quick_check', { simple: true }) !== 'ok') throw new BrokerError('ledger_invalid');
      this.verify();
      db.transaction(() => {
        for (const row of db!.prepare('SELECT control FROM intents').all() as Array<{ control: string }>) {
          const control: Control = JSON.parse(row.control);
          if (control.submission_state === 'dispatching') control.submission_state = 'unknown';
          if (control.observation_state === 'observing') control.observation_state = 'outcome_unknown';
          if (this.held(control.terminal_id) === control.proposal_id) { control.hold_reason = 'core_restart'; control.updated_at = this.now(); }
          db!.prepare('UPDATE intents SET control = ?, updated = ? WHERE id = ?').run(JSON.stringify(control), control.updated_at, control.proposal_id);
        }
      }).immediate();
    } catch (error) { db?.close(); throw error instanceof BrokerError ? error : new BrokerError('ledger_invalid'); }
  }
  private checkFile(path: string) {
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new BrokerError('ledger_permissions');
  }
  verify() {
    try {
      this.verifyAuthority(); this.checkFile(this.path);
      const current = lstatSync(this.path);
      if (current.ino !== this.inode.ino || current.dev !== this.inode.dev) throw new BrokerError('ledger_lost');
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
  intent(control: Control) {
    this.verify(); this.fault('before_intent');
    try {
      return this.db.transaction(() => {
        const existing = this.get(control.proposal_id);
        if (existing) {
          if (existing.payload_digest !== control.payload_digest) throw new BrokerError('payload_mismatch');
          return { fresh: false, control: existing };
        }
        if (this.db.prepare('SELECT id FROM consumed WHERE id = ?').get(control.proposal_id)) throw new BrokerError('proposal_consumed');
        if (control.operation === 'execute' && this.held(control.terminal_id)) throw new BrokerError('terminal_held');
        if (this.count(control.job_id, control.operation) >= (control.operation === 'execute' ? 3 : 1)) throw new BrokerError('action_budget_exhausted');
        this.db.prepare('INSERT INTO intents VALUES (?, ?, ?, ?, ?, ?)').run(control.proposal_id, control.job_id, control.terminal_id, control.operation, control.updated_at, JSON.stringify(control));
        this.db.prepare('INSERT INTO consumed VALUES (?, ?)').run(control.proposal_id, control.payload_digest);
        if (control.operation === 'execute') this.db.prepare('INSERT INTO holds VALUES (?, ?)').run(control.terminal_id, control.proposal_id);
        this.fault('in_transaction'); this.verify();
        return { fresh: true, control };
      }).immediate();
    } catch (error) { throw error instanceof BrokerError ? error : new BrokerError('ledger_commit_failed'); }
  }
  update(control: Control, release = false) {
    this.verify();
    try { this.db.transaction(() => {
      this.db.prepare('UPDATE intents SET updated = ?, control = ? WHERE id = ?').run(control.updated_at, JSON.stringify(control), control.proposal_id);
      if (release) this.db.prepare('DELETE FROM holds WHERE terminal = ? AND proposal = ?').run(control.terminal_id, control.proposal_id);
    }).immediate(); } catch { throw new BrokerError('ledger_commit_failed'); }
  }
  summary() {
    this.verify();
    this.db.prepare('DELETE FROM intents WHERE updated < ? AND id NOT IN (SELECT proposal FROM holds)').run(this.now() - 7 * 86400000);
    return { receipts: (this.db.prepare('SELECT control FROM intents ORDER BY updated DESC LIMIT 32').all() as Array<{ control: string }>).map(row => JSON.parse(row.control)), held_terminals: this.db.prepare('SELECT terminal, proposal FROM holds').all(), tombstone_days: 7 };
  }
  close() { if (this.db.open) this.db.close(); }
}
