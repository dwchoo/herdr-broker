import { randomUUID } from 'node:crypto';
import { Herdr, BrokerError } from './herdr.js';
import { prepareSnapshot, sanitize } from './snapshot.js';

type Phase = 'observing' | 'result_ready' | 'failed' | 'cancelled' | 'deadline' | 'budget_exhausted';
interface Budget { deadline_ms?: number | undefined; parent_payload_bytes?: number | undefined }
interface Job {
  id: string; owner: string; paneId: string; objective: string; session: string;
  phase: Phase; controller: AbortController; done: Promise<void>;
  created: number; deadline: number; limit: number; used: number; noticeSent: boolean;
  memory: number; rows?: readonly string[];
  ended?: number; timer?: NodeJS.Timeout;
  snapshot?: object; result?: { kind: string; text: string }; error?: string;
}
const ended = (job: Job) => job.ended !== undefined;

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private readonly maintenance: NodeJS.Timeout;
  constructor(private readonly herdr: Herdr, private readonly patterns: string[] = [], private readonly now = Date.now, private readonly memoryLimit = 64 * 1024 * 1024) {
    this.maintenance = setInterval(() => this.sweep(), 1000);
    this.maintenance.unref();
  }
  start(owner: string, paneId: string, objective: string, analysis: string, budget: Budget = {}) {
    this.sweep();
    this.reserve(16384);
    if ([...this.jobs.values()].filter(job => job.phase === 'observing').length >= 4) throw new BrokerError('observation_busy');
    const created = this.now();
    const job: Job = { id: randomUUID(), owner, paneId, objective: sanitize(objective, this.patterns).text, session: randomUUID(), phase: 'observing', controller: new AbortController(), done: Promise.resolve(), created, deadline: created + (budget.deadline_ms ?? 300000), limit: budget.parent_payload_bytes ?? 16384, used: 0, noticeSent: false, memory: 16384 };
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
    for (const [id, job] of this.jobs) {
      this.active(job);
      if (job.ended !== undefined && this.now() - job.ended >= 1800000) this.jobs.delete(id);
    }
  }
  private async observe(job: Job, analysis: string) {
    try {
      if (analysis === 'worker') throw new BrokerError('worker_unsupported');
      if (!this.active(job)) return;
      const pane = await this.herdr.describe(job.paneId, job.controller.signal);
      if (!this.active(job)) return;
      const read = await this.herdr.capture(pane, job.controller.signal);
      if (!this.active(job)) return;
      const verified = await this.herdr.describe(job.paneId, job.controller.signal);
      if (!this.active(job)) return;
      if (verified.terminal_id !== pane.terminal_id || verified.workspace_id !== pane.workspace_id || verified.tab_id !== pane.tab_id) throw new BrokerError('target_changed');
      const snapshot = prepareSnapshot(read.text, job.session, read.truncated, this.patterns, this.now());
      const retained = 2 * Buffer.byteLength(snapshot.rows.join('\n')) + 128 * snapshot.rows.length + 2 * Buffer.byteLength(snapshot.text);
      this.reserve(retained);
      job.memory += retained;
      job.rows = Object.freeze(snapshot.rows);
      job.snapshot = Object.freeze(snapshot.metadata);
      if (Buffer.byteLength(snapshot.text) > 4096) throw new BrokerError('worker_unsupported');
      job.result = { kind: 'prepared_context', text: snapshot.text };
      job.phase = 'result_ready';
    } catch (error) {
      if (!this.active(job)) return;
      job.error = error instanceof BrokerError ? error.code : 'internal_error';
      this.stop(job, 'failed');
    }
  }
  private reserve(bytes: number) {
    const limit = Math.min(this.memoryLimit, 64 * 1024 * 1024);
    const total = () => [...this.jobs.values()].reduce((sum, job) => sum + job.memory, 0);
    for (const job of [...this.jobs.values()].filter(ended).sort((a, b) => a.ended! - b.ended!)) {
      if (total() + bytes <= limit) break;
      this.jobs.delete(job.id);
    }
    if (total() + bytes > limit) throw new BrokerError('memory_budget_exhausted');
  }
  summary() {
    this.sweep();
    return {
      jobs: [...this.jobs.values()].slice(-32).map(job => ({ job_id: job.id, phase: job.phase, job_ended: ended(job), result_ready: !!job.result, deadline_remaining_ms: Math.max(0, job.deadline - this.now()), parent_payload_bytes_remaining: job.limit - job.used, snapshot: job.snapshot })),
      job_count: this.jobs.size, memory_bytes: [...this.jobs.values()].reduce((sum, job) => sum + job.memory, 0), memory_limit_bytes: Math.min(this.memoryLimit, 64 * 1024 * 1024), retention_after_end_ms: 1800000,
      action_submission: 'unsupported', action_outcome: 'unsupported', action_mode: 'unavailable',
    };
  }
  private owned(owner: string, id: string) {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new BrokerError('job_unavailable');
    return job;
  }
  private status(job: Job, waitTimedOut = false) {
    return { job_id: job.id, pane_session_id: job.session, pane_id: job.paneId, phase: job.phase, result_ready: !!job.result, job_ended: ended(job), action_state: 'unsupported', wait_timed_out: waitTimedOut,
      ...(job.snapshot && { snapshot: job.snapshot }), ...(job.result && { result: job.result }), ...(job.error && { error: job.error }) };
  }
  private deliver(job: Job, waitTimedOut = false): string | null {
    if (job.noticeSent) return null;
    const budget = { deadline_ms: job.deadline - job.created, deadline_remaining_ms: Math.max(0, job.deadline - this.now()), parent_payload_bytes_limit: job.limit, parent_payload_bytes_used: 0, parent_payload_bytes_remaining: 0 };
    let response: object = { ...this.status(job, waitTimedOut), budget };
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
    if (budget.parent_payload_bytes_used > job.limit - 512 || Buffer.byteLength(text) > 8192) {
      this.stop(job, 'budget_exhausted');
      response = { job_id: job.id, error: 'parent_budget_exhausted', job_ended: true, action_state: 'unsupported', budget };
      text = encode();
      job.noticeSent = true;
    }
    job.used += Buffer.byteLength(text);
    return text;
  }
  async call(owner: string, id: string, operation: 'status' | 'wait' | 'cancel', waitMs = 0) {
    const job = this.owned(owner, id);
    if (operation === 'cancel') this.stop(job, 'cancelled');
    let waitTimedOut = false;
    if (operation === 'wait' && job.phase === 'observing') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(() => { waitTimedOut = true; resolve(); }, waitMs); })]);
      clearTimeout(timer);
      this.active(job);
    }
    return this.deliver(job, waitTimedOut && job.phase === 'observing');
  }
  disconnect(owner: string) {
    for (const job of this.jobs.values()) if (job.owner === owner) this.stop(job, 'cancelled');
  }
  close() {
    clearInterval(this.maintenance);
    for (const job of this.jobs.values()) this.stop(job, 'cancelled');
    this.jobs.clear();
  }
}
