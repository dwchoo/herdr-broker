import { randomUUID, createHash } from 'node:crypto';
import { Herdr, BrokerError } from './herdr.js';
import { prepareSnapshot, sanitize, excerpt } from './snapshot.js';
import { CodexWorker, WorkerFailure, workerProfile, type Report, type Usage } from './worker.js';

import { Sessions, type Scope } from './sessions.js';

type Phase = 'observing' | 'result_ready' | 'failed' | 'cancelled' | 'deadline' | 'budget_exhausted' | 'purged';
type DataState = 'retained' | 'purged' | 'expired' | 'evicted';
interface Budget { deadline_ms?: number | undefined; parent_payload_bytes?: number | undefined }
interface SnapshotRecord {
  value?: ReturnType<typeof prepareSnapshot>; rowCount: number; cursor?: string; cursorExpires: number;
  digest?: string; scope?: string; prepared: boolean;
  report?: Report;
}
interface Job {
  id: string; owner: string; paneId: string; objective: string; objectiveDigest: string; session: string;
  phase: Phase; controller: AbortController; done: Promise<void>;
  created: number; deadline: number; limit: number; used: number; noticeSent: boolean;
  memory: number; dataState: DataState; snapshots: Map<string, SnapshotRecord>; current?: SnapshotRecord;
  binding?: string; sequence: number; observedAt?: number;
  ended?: number; timer?: NodeJS.Timeout;
  error?: string;
  scope?: Scope; controlMemory: number; bodies: Array<() => void>;
  analysis: string; workerCalls: number; workerUsage: Usage | null; workerKnown: number; workerElapsed: number;
}
const ended = (job: Job) => job.ended !== undefined;

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private readonly maintenance: NodeJS.Timeout;
  constructor(private readonly herdr: Herdr, private readonly patterns: string[] = [], private readonly now = Date.now, private readonly memoryLimit = 64 * 1024 * 1024, private readonly worker = new CodexWorker(), private readonly sessions = new Sessions(herdr)) {
    this.sessions.setRetentionGuard(bytes => this.reserve(bytes));
    this.maintenance = setInterval(() => this.sweep(), 1000);
    this.maintenance.unref();
  }
  start(owner: string, paneId: string, objective: string, analysis: string, budget: Budget = {}, scope?: Scope) {
    this.sweep();
    const initialMemory = 16384 + (scope ? 2 * Buffer.byteLength(JSON.stringify(scope)) : 0);
    this.reserve(initialMemory);
    if ([...this.jobs.values()].filter(job => job.phase === 'observing').length >= 4) throw new BrokerError('observation_busy');
    const created = this.now();
    const job: Job = { id: randomUUID(), owner, paneId, objective: sanitize(objective, this.patterns).text, objectiveDigest: createHash('sha256').update(objective).digest('hex'), session: randomUUID(), phase: 'observing', controller: new AbortController(), done: Promise.resolve(), created, deadline: created + (budget.deadline_ms ?? 300000), limit: budget.parent_payload_bytes ?? 16384, used: 0, noticeSent: false, memory: initialMemory, dataState: 'retained', snapshots: new Map(), sequence: 0, controlMemory: 0, bodies: [], ...(scope && { scope }), analysis, workerCalls: 0, workerUsage: null, workerKnown: 0, workerElapsed: 0 };
    this.jobs.set(job.id, job);
    job.timer = setTimeout(() => this.stop(job, 'deadline'), job.deadline - created);
    job.timer.unref();
    job.done = this.observe(job, analysis);
    return this.deliver(job);
  }
  private active(job: Job) {
    if (!ended(job) && this.now() >= job.deadline) this.stop(job, 'deadline');
    return !ended(job);
  }
  private stop(job: Job, phase: Phase) {
    if (ended(job)) return;
    job.phase = phase;
    job.ended = this.now();
    clearTimeout(job.timer);
    job.controller.abort();
  }
  private sweep() {
    for (const job of this.jobs.values()) {
      this.active(job);
      if (job.ended !== undefined && this.now() - job.ended >= 1800000) this.clearBodies(job, 'expired');
    }
  }
  private clearBodies(job: Job, reason: DataState) {
    if (job.dataState !== 'retained') return;
    for (const record of job.snapshots.values()) {
      delete record.value; delete record.cursor; delete record.digest; delete record.scope; delete record.report;
      record.cursorExpires = 0; record.prepared = false;
    }
    delete job.current;
    for (const purge of job.bodies) purge();
    job.bodies = [];
    job.objective = '';
    delete job.scope;
    job.dataState = reason;
    job.memory = 2048 + job.snapshots.size * 256 + job.controlMemory;
  }
  private async observe(job: Job, analysis: string) {
    try {
      if (!this.active(job)) return;
      const pane = await this.herdr.describe(job.paneId, job.controller.signal);
      if (!this.active(job)) return;
      const read = await this.herdr.capture(pane, job.controller.signal);
      if (!this.active(job)) return;
      const verified = await this.herdr.describe(job.paneId, job.controller.signal);
      if (!this.active(job)) return;
      if (verified.terminal_id !== pane.terminal_id || verified.workspace_id !== pane.workspace_id || verified.tab_id !== pane.tab_id) throw new BrokerError('target_changed');
      const binding = JSON.stringify([pane.terminal_id, pane.workspace_id, pane.tab_id]);
      const observedSession = await this.sessions.observe(verified, job.controller.signal, !!job.scope);
      if (!this.active(job)) return;
      const session = observedSession.id;
      if (observedSession.recoveryObjective) {
        if (observedSession.recoveryObjective !== job.objectiveDigest) throw new BrokerError('recovery_objective_required');
        delete observedSession.recoveryObjective;
      }
      const sequence = job.sequence + 1;
      const observedAt = this.now();
      const snapshot = prepareSnapshot(read.text, session, read.truncated, this.patterns, observedAt, sequence);
      const scope = JSON.stringify([job.owner, job.id, session, snapshot.metadata.source, snapshot.metadata.format, snapshot.metadata.redaction.version, snapshot.metadata.redaction.pattern_digest]);
      const digest = createHash('sha256').update(JSON.stringify([scope, snapshot.rows, snapshot.metadata.gaps, snapshot.metadata.row_mapping, snapshot.metadata.redaction])).digest('hex');
      if (job.current?.digest !== digest) {
        const retained = 2048 + 2 * Buffer.byteLength(snapshot.rows.join('\n')) + 128 * snapshot.rows.length + 2 * Buffer.byteLength(snapshot.text);
        this.reserve(retained);
        job.memory += retained;
        const record: SnapshotRecord = { value: Object.freeze(snapshot), rowCount: snapshot.rows.length, cursor: randomUUID(), cursorExpires: this.now() + 60000, digest, scope, prepared: analysis === 'auto' && Buffer.byteLength(snapshot.text) <= 4096 };
        job.snapshots.set(snapshot.metadata.snapshot_id, record);
        job.current = record;
      }
      job.session = session; job.binding = binding; job.sequence = sequence; job.observedAt = observedAt;
      if (job.current && !job.current.prepared && !job.current.report) {
        let previous: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!this.active(job)) return;
          if (job.workerCalls >= 4) throw new BrokerError('worker_call_budget');
          if (job.workerUsage && job.workerUsage.input_tokens + job.workerUsage.output_tokens >= 100000) throw new BrokerError('worker_token_budget');
          job.workerCalls++;
          const started = Date.now();
          let result;
          try { result = await this.worker.run(snapshot, job.objective, job.controller.signal, this.patterns, previous); }
          catch (error) { this.recordUsage(job, error instanceof WorkerFailure ? error.usage : null); throw error; }
          finally { job.workerElapsed += Date.now() - started; }
          this.recordUsage(job, result.usage);
          if (!this.active(job)) return;
          if (result.report) {
            const bytes = 2 * Buffer.byteLength(JSON.stringify(result.report));
            this.reserve(bytes); job.memory += bytes;
            job.current.report = result.report;
            break;
          }
          previous = result.invalid;
        }
        if (!job.current.report) throw new BrokerError('worker_invalid_report');
      }
      job.phase = 'result_ready';
    } catch (error) {
      if (!this.active(job)) return;
      job.error = error instanceof BrokerError ? error.code : 'internal_error';
      this.stop(job, 'failed');
    }
  }
  private actionMode(job: Job) {
    try { const session = this.sessions.get(job.session); return { action_mode: session.mode, mode_revision: session.revision }; }
    catch { return { action_mode: null, mode_revision: null }; }
  }
  actionContext(owner: string, id: string) {
    const job = this.owned(owner, id);
    return { id: job.id, pane_id: job.paneId, objective: job.objective, objectiveDigest: job.objectiveDigest, session: job.session, scope: job.scope, active: this.active(job), signal: job.controller.signal };
  }
  stopPane(paneId: string) {
    for (const job of this.jobs.values()) if (job.paneId === paneId) this.stop(job, 'cancelled');
  }
  retainAction(owner: string, id: string, bytes: number, controlBytes: number, purge: () => void) {
    const job = this.owned(owner, id);
    this.reserve(bytes + controlBytes); job.memory += bytes + controlBytes; job.controlMemory += controlBytes; job.bodies.push(purge);
  }
  async actionResponse(owner: string, id: string, work: () => object | Promise<object>) {
    const job = this.owned(owner, id);
    if (job.noticeSent) return null;
    let value: object;
    try { value = await work(); } catch (error) { value = { job_id: id, error: error instanceof BrokerError ? error.code : 'internal_error' }; }
    return this.deliver(job, false, value);
  }
  actionBudget(owner: string, id: string, bytes: number, consume = false) {
    const job = this.owned(owner, id);
    if (consume) { job.used += bytes; return; }
    if (!this.active(job)) throw new BrokerError('job_ended');
    if (job.used + bytes > job.limit - 512) { this.stop(job, 'budget_exhausted'); throw new BrokerError('parent_budget_exhausted'); }
  }
  prepareActionSnapshot(owner: string, id: string, text: string, session: string, truncated: boolean) {
    const job = this.owned(owner, id);
    return prepareSnapshot(text, session, truncated, this.patterns, this.now(), job.sequence + 1);
  }
  actionEvidence(owner: string, id: string, snapshot: ReturnType<typeof prepareSnapshot>) {
    const job = this.owned(owner, id);
    if (job.dataState !== 'retained') return null;
    const bytes = 2048 + 2 * Buffer.byteLength(snapshot.rows.join('\n')) + 128 * snapshot.rows.length + 2 * Buffer.byteLength(snapshot.text);
    this.reserve(bytes); job.memory += bytes;
    job.snapshots.set(snapshot.metadata.snapshot_id, { value: snapshot, rowCount: snapshot.rows.length, cursorExpires: 0, prepared: false });
    return snapshot;
  }
  private recordUsage(job: Job, usage: Usage | null) {
    if (!usage) return;
    const before = job.workerUsage;
    job.workerKnown++;
    job.workerUsage = { input_tokens: (before?.input_tokens ?? 0) + usage.input_tokens, output_tokens: (before?.output_tokens ?? 0) + usage.output_tokens,
      cached_input_tokens: usage.cached_input_tokens === null || before?.cached_input_tokens === null ? null : (before?.cached_input_tokens ?? 0) + usage.cached_input_tokens };
  }
  private workerStatus(job: Job) {
    return { ...workerProfile, calls: job.workerCalls, usage: job.workerKnown === job.workerCalls ? job.workerUsage : null, elapsed_ms: job.workerElapsed };
  }
  private reserve(bytes: number) {
    const limit = Math.min(this.memoryLimit, 64 * 1024 * 1024);
    const total = () => this.sessions.memoryBytes() + [...this.jobs.values()].reduce((sum, job) => sum + job.memory, 0);
    for (const job of [...this.jobs.values()].filter(job => ended(job) && job.dataState === 'retained').sort((a, b) => a.ended! - b.ended!)) {
      if (total() + bytes <= limit) break;
      this.clearBodies(job, 'evicted');
    }
    if (total() + bytes > limit) throw new BrokerError('memory_budget_exhausted');
  }
  summary() {
    this.sweep();
    return {
      jobs: [...this.jobs.values()].slice(-32).map(job => ({ job_id: job.id, phase: job.phase, data_state: job.dataState, job_ended: ended(job), ...this.actionMode(job), result_ready: !job.error && job.phase !== 'observing' && !!(job.current?.prepared || job.current?.report), deadline_remaining_ms: Math.max(0, job.deadline - this.now()), parent_payload_bytes_remaining: job.limit - job.used, ...(job.workerCalls > 0 && { worker: this.workerStatus(job) }), ...(job.ended !== undefined && { ended_at: new Date(job.ended).toISOString(), retention_expires_at: new Date(job.ended + 1800000).toISOString() }), snapshot: job.current?.value?.metadata })),
      job_count: this.jobs.size, memory_bytes: this.sessions.memoryBytes() + [...this.jobs.values()].reduce((sum, job) => sum + job.memory, 0), memory_limit_bytes: Math.min(this.memoryLimit, 64 * 1024 * 1024), retention_after_end_ms: 1800000,
      action_submission_supported: true, action_outcome: 'separate_receipt', action_mode: 'per_session',
    };
  }
  purge(id: string) {
    this.sweep();
    const selected = [...this.jobs.values()].filter(job => id === 'all' || job.id === id);
    if (!selected.length && id !== 'all') return { error: 'job_unavailable' };
    for (const job of selected) { this.stop(job, 'purged'); this.clearBodies(job, 'purged'); }
    return { purged_job_ids: selected.slice(0, 32).map(job => job.id), purged_job_count: selected.length, truncated: selected.length > 32 };
  }
  private owned(owner: string, id: string) {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new BrokerError('job_unavailable');
    return job;
  }
  invalidInput(owner: string, id?: string) {
    if (id === undefined) return { error: 'invalid_tool_arguments' };
    const job = this.owned(owner, id);
    return this.deliver(job, false, { job_id: job.id, error: 'invalid_tool_arguments' });
  }
  private status(job: Job, waitTimedOut = false, cursor?: string) {
    const base = { job_id: job.id, pane_session_id: job.session, pane_id: job.paneId, phase: job.phase, data_state: job.dataState, result_ready: !job.error && job.phase !== 'observing' && !!(job.current?.prepared || job.current?.report), job_ended: ended(job), ...this.actionMode(job), action_state: job.scope ? 'available' : 'scope_required', wait_timed_out: waitTimedOut, ...(job.workerCalls > 0 && { worker: this.workerStatus(job) }), ...(job.error && { error: job.error }) };
    const current = job.current;
    if (!current?.value || job.phase === 'observing' || (job.error && (current.prepared || current.report))) return base;
    const baseline = [...job.snapshots.values()].find(record => record.cursor === cursor);
    const unchanged = baseline && baseline.cursorExpires > this.now() && baseline.scope === current.scope && baseline.digest === current.digest;
    if (current.cursorExpires <= this.now()) {
      current.cursor = randomUUID();
      current.cursorExpires = this.now() + 60000;
    }
    const view = { cursor: current.cursor, cursor_expires_at: new Date(current.cursorExpires).toISOString(), observation: { sequence: job.sequence, observed_at: new Date(job.observedAt!).toISOString() } };
    const snapshot = current.value;
    const citedRows = current.report ? [...new Set(current.report.findings.flatMap(finding => finding.evidence_ids))].map(id => Number(id.split(':L')[1]) - 1) : undefined;
    if (unchanged) return { ...base, ...view, delta: { kind: 'unchanged_view', snapshot_id: snapshot.metadata.snapshot_id, history_complete: false } };
    return { ...base, ...view, delta: { kind: 'replace', history_complete: false }, snapshot: snapshot.metadata,
      ...((current.prepared || current.report) && { result: current.report ? { kind: 'worker_report', contract: 'diagnosis.v1', report: current.report } : { kind: 'prepared_context', text: snapshot.text }, evidence: excerpt(snapshot.metadata.snapshot_id, snapshot.rows, 0, 0, citedRows) }) };
  }
  private deliver(job: Job, waitTimedOut = false, body?: object, cursor?: string): string | null {
    if (job.noticeSent) return null;
    const budget = { deadline_ms: job.deadline - job.created, deadline_remaining_ms: Math.max(0, job.deadline - this.now()), parent_payload_bytes_limit: job.limit, parent_payload_bytes_used: 0, parent_payload_bytes_remaining: 0 };
    const view = body === undefined ? this.status(job, waitTimedOut, cursor) : undefined;
    let response: object = { ...(body ?? view), budget };
    const encode = () => {
      let bytes = 0;
      for (;;) {
        budget.parent_payload_bytes_used = job.used + bytes;
        budget.parent_payload_bytes_remaining = Math.max(0, job.limit - budget.parent_payload_bytes_used);
        const text = JSON.stringify(response);
        const actual = Buffer.byteLength(text);
        // Grow monotonically; JSON whitespace absorbs digit-boundary oscillation.
        if (actual <= bytes) return text + ' '.repeat(bytes - actual);
        bytes = actual;
      }
    };
    let text = encode();
    const firstEvidenceId = job.current?.report?.findings[0]?.evidence_ids[0] ?? (job.current?.prepared && job.current.value ? `${job.current.value.metadata.snapshot_id}:L0001` : undefined);
    if (view && 'evidence' in view && firstEvidenceId && (budget.parent_payload_bytes_used > job.limit - 512 || Buffer.byteLength(text) > 8192)) {
      response = { ...view, evidence: { items: [], truncated: true, next: { evidence_id: firstEvidenceId, offset_bytes: 0 } }, budget };
      text = encode();
    }
    if (budget.parent_payload_bytes_used > job.limit - 512 || Buffer.byteLength(text) > 8192) {
      this.stop(job, 'budget_exhausted');
      response = { job_id: job.id, error: 'parent_budget_exhausted', job_ended: true, action_state: 'stopped', budget };
      text = encode();
      job.noticeSent = true;
    }
    job.used += Buffer.byteLength(text);
    return text;
  }
  async call(owner: string, id: string, operation: 'status' | 'wait' | 'cancel', waitMs = 0, cursor?: string) {
    const job = this.owned(owner, id);
    if (operation === 'cancel') this.stop(job, 'cancelled');
    if (operation === 'wait' && this.active(job) && job.phase !== 'observing' && cursor !== undefined && cursor === job.current?.cursor && job.current.cursorExpires > this.now()) {
      if ([...this.jobs.values()].filter(other => other.phase === 'observing').length >= 4) return this.deliver(job, false, { job_id: job.id, error: 'observation_busy' });
      job.phase = 'observing';
      job.done = this.observe(job, job.analysis);
    }
    let waitTimedOut = false;
    if (operation === 'wait' && job.phase === 'observing') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(() => { waitTimedOut = true; resolve(); }, waitMs); })]);
      clearTimeout(timer);
      this.active(job);
    }
    return this.deliver(job, waitTimedOut && job.phase === 'observing', undefined, cursor);
  }
  evidence(owner: string, id: string, evidenceId: string, offsetBytes = 0) {
    const job = this.owned(owner, id);
    const [snapshotId, line] = evidenceId.split(':L');
    const record = snapshotId ? job.snapshots.get(snapshotId) : undefined;
    const row = Number(line) - 1;
    if (!record || row < 0 || row >= record.rowCount) {
      return this.deliver(job, false, { job_id: job.id, error: 'evidence_not_found' });
    }
    if (!record.value) return this.deliver(job, false, { job_id: job.id, error: 'evidence_expired' });
    const rows = record.value.rows;
    const bytes = Buffer.from(rows[row]!);
    if (offsetBytes > bytes.length || (offsetBytes < bytes.length && (bytes[offsetBytes]! & 0xc0) === 0x80)) {
      return this.deliver(job, false, { job_id: job.id, error: 'invalid_evidence_offset' });
    }
    return this.deliver(job, false, { job_id: job.id, evidence: excerpt(record.value.metadata.snapshot_id, rows, row, offsetBytes) });
  }
  disconnect(owner: string) {
    for (const job of this.jobs.values()) if (job.owner === owner) this.stop(job, 'cancelled');
  }
  close() {
    clearInterval(this.maintenance);
    const pending = [...this.jobs.values()].map(job => {
      this.stop(job, 'cancelled'); this.clearBodies(job, 'purged');
      return job.done;
    });
    this.jobs.clear();
    return Promise.allSettled(pending);
  }
}
