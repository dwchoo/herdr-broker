import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Ledger, type Control, type FaultPoint } from './ledger.js';
import { excerpt } from './snapshot.js';
import { BrokerError, Herdr } from './herdr.js';
import { Jobs } from './jobs.js';
import { Sessions, targetSchema, targetOf, sameTarget, type Target } from './sessions.js';

const text = z.string().min(1).max(1024);
const riskSchema = z.strictObject({ classification: z.enum(['read', 'bounded_change', 'high', 'unknown']), inspected: z.boolean(), impact: text, recovery: text, uncertainties: z.array(text).max(5), categories: z.array(z.enum(['destructive', 'privilege', 'system_package', 'driver', 'kernel', 'disk', 'network', 'account', 'permissions', 'reboot', 'shutdown'])).max(12) });
const declaredRisk = z.union([riskSchema, z.unknown()]).describe('Use the structured Parent assessment: classification, inspected, impact, recovery, uncertainties, categories. Invalid or missing assessments require user approval in mode 2.');
export const proposalSchema = z.strictObject({ job_id: z.string().uuid(), target: targetSchema, objective: z.string().min(1).max(4096), operation: z.enum(['execute', 'interrupt']), command: z.string().min(1).max(4096).refine(value => !value.includes('\0')).optional(), original_proposal_id: z.string().uuid().optional(), cwd: z.string().min(1).max(4096), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(1024).refine(value => !value.includes('\0'))).refine(value => Object.keys(value).length <= 16), affected_paths: z.array(z.string().min(1).max(4096)).min(1).max(16), risk: declaredRisk.optional() });
type ProposalInput = z.infer<typeof proposalSchema>;
interface Body { objective: string; payload: { text: string; keys: string[] }; risk: z.infer<typeof riskSchema> | null; affected_paths: string[]; cwd: string; env: Record<string, string> }
interface Proposal { id: string; job: string; owner: string; session: string; revision: number; target: Target; operation: Control['operation']; original: string | null; digest: string; nonce: string; body?: Body; approval?: { issued: number; expires: number; revision: number; digest: string }; rejected: boolean; receipt?: Control; controlReserved?: boolean; submittedAt?: number; evidence?: ReturnType<typeof excerpt>; observation?: { method: string; truncated: boolean; baseline_digest: string } }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const within = (value: string, roots: string[]) => value.startsWith('/') && posix.normalize(value) === value && !value.includes('\0') && roots.some(root => value === root || value.startsWith(root === '/' ? '/' : root + '/'));

export interface ActionOptions { ledger: Ledger; verifyAuthority: () => void; now?: (() => number) | undefined; observationMs?: number | undefined; fault?: ((point: FaultPoint) => void) | undefined }
export class Actions {
  private readonly proposals = new Map<string, Proposal>();
  private readonly submissions = new Map<string, Promise<object>>();
  private readonly wires = new Map<string, Promise<unknown>>();
  private readonly observers = new Set<Promise<void>>();
  private readonly stop = new AbortController();
  private readonly now: () => number;
  constructor(private readonly herdr: Herdr, private readonly jobs: Jobs, private readonly sessions: Sessions, private readonly options: ActionOptions) { this.now = options.now ?? Date.now; }
  async propose(owner: string, input: ProposalInput) {
    const job = this.jobs.actionContext(owner, input.job_id);
    if (!job.active) throw new BrokerError('job_ended');
    if (!job.scope) throw new BrokerError('action_scope_required');
    if (job.objectiveDigest !== createHash('sha256').update(input.objective).digest('hex')) throw new BrokerError('objective_mismatch');
    const pane = await this.herdr.describe(job.pane_id, job.signal);
    const session = await this.sessions.observe(pane, job.signal, true);
    if (session.id !== job.session || !sameTarget(targetOf(pane), input.target)) throw new BrokerError('target_changed');
    if (input.operation === 'execute' && !this.sessions.ready(session)) throw new BrokerError('shell_not_ready');
    if (!within(input.cwd, [job.scope.cwd]) || !input.affected_paths.every(path => within(path, job.scope!.paths))) throw new BrokerError('outside_scope');
    if (input.operation === 'execute' ? !input.command || input.original_proposal_id : input.command !== undefined || Object.keys(input.env).length) throw new BrokerError('invalid_operation');
    if (input.operation === 'interrupt') this.options.ledger.requireInterruptTarget(input.original_proposal_id, session.target.terminal_id, session.id);
    if ([input.command ?? '', input.cwd, ...Object.values(input.env)].some(value => /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(value))) throw new BrokerError('terminal_control_unsupported');
    const parsed = riskSchema.safeParse(input.risk);
    const nonce = randomBytes(16).toString('hex');
    const script = `cd ${quote(input.cwd)} && /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin ${Object.entries(input.env).map(([key, value]) => quote(`${key}=${value}`)).join(' ')} /bin/sh -c ${quote(input.command ?? '')}`;
    const wrapper = `printf '\\n__HERDR_%s_%s__\\n' BEGIN ${quote(nonce)}; ( ${script}\n); herdr_broker_exit=$?; printf '\\n__HERDR_%s_%s__:%s\\n' END ${quote(nonce)} "$herdr_broker_exit"; exit "$herdr_broker_exit"`;
    const body: Body = { objective: input.objective, payload: input.operation === 'interrupt' ? { text: '', keys: ['Ctrl+c'] } : { text: `/bin/sh -c ${quote(wrapper)}`, keys: ['Enter'] }, risk: parsed.success ? parsed.data : null, affected_paths: input.affected_paths, cwd: input.cwd, env: input.env };
    const original = input.original_proposal_id ?? null;
    const proposal: Proposal = { id: randomUUID(), job: job.id, owner, session: session.id, revision: session.revision, target: session.target, operation: input.operation, original, nonce, body, digest: createHash('sha256').update(JSON.stringify([session.id, session.revision, job.id, session.target, input.operation, original, body])).digest('hex'), rejected: false };
    this.jobs.retainAction(owner, job.id, 4 * Buffer.byteLength(JSON.stringify(body)), 1024 + 2 * Buffer.byteLength(JSON.stringify({ ...proposal, body: undefined })), () => { delete proposal.body; delete proposal.approval; delete proposal.evidence; });
    this.proposals.set(proposal.id, proposal);
    return { ...this.view(proposal), payload: body.payload };
  }
  private get(owner: string, job: string, id: string) {
    this.jobs.actionContext(owner, job);
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.owner !== owner || proposal.job !== job) throw new BrokerError('proposal_unavailable');
    return proposal;
  }
  private decision(proposal: Proposal) {
    const job = this.jobs.actionContext(proposal.owner, proposal.job);
    if (!job.active) return { authorization: 'blocked', reason: 'job_ended' };
    if (!proposal.body) return { authorization: 'blocked', reason: 'payload_expired' };
    let session;
    try { session = this.sessions.get(proposal.session); } catch { return { authorization: 'blocked', reason: 'session_changed' }; }
    if (proposal.revision !== session.revision) return { authorization: 'blocked', reason: 'mode_changed' };
    if (session.mode === 0) return { authorization: 'blocked', reason: 'session_stopped' };
    if (proposal.rejected) return { authorization: 'blocked', reason: 'user_rejected' };
    if (proposal.approval) {
      if (proposal.approval.expires <= this.now()) return { authorization: 'approval_required', reason: 'approval_expired' };
      return { authorization: 'user_approval', reason: null };
    }
    if (session.mode === 3) return { authorization: 'autonomous', reason: null };
    const risk = proposal.body.risk;
    if (session.mode === 2 && risk && ['read', 'bounded_change'].includes(risk.classification) && risk.inspected && !risk.uncertainties.length && !risk.categories.length) return { authorization: 'parent_risk_review', reason: null };
    return { authorization: 'approval_required', reason: risk ? 'policy_requires_approval' : 'risk_invalid_or_missing' };
  }
  private view(proposal: Proposal) {
    if (proposal.receipt) return { ...proposal.receipt, target: proposal.target, contract: 'action.v1', evidence: proposal.evidence ?? null, observation: proposal.observation ?? null };
    return { job_id: proposal.job, proposal_id: proposal.id, pane_session_id: proposal.session, target: proposal.target, mode_revision: proposal.revision, operation: proposal.operation, original_proposal_id: proposal.original, payload_digest: proposal.digest, contract: 'action.v1', submission_state: 'not_submitted', observation_state: 'not_started', exit_code: null, ...this.decision(proposal), approval_expires_at: proposal.approval ? new Date(proposal.approval.expires).toISOString() : null };
  }
  jobFor(owner: string, id: string) {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.owner !== owner) throw new BrokerError('proposal_unavailable');
    return proposal.job;
  }
  submit(owner: string, id: string) {
    const proposal = this.get(owner, this.jobFor(owner, id), id);
    if (this.submissions.has(id)) return this.submissions.get(id)!;
    if (proposal.receipt) return Promise.resolve(this.view(proposal));
    this.allowed(proposal);
    const terminal = proposal.target.terminal_id;
    const task = (this.wires.get(terminal) ?? Promise.resolve()).catch(() => {}).then(() => this.dispatch(proposal));
    this.wires.set(terminal, task);
    this.submissions.set(id, task);
    void task.finally(() => { this.submissions.delete(id); if (this.wires.get(terminal) === task) this.wires.delete(terminal); }).catch(() => {});
    return task;
  }
  private allowed(proposal: Proposal) {
    this.options.verifyAuthority();
    if (this.stop.signal.aborted || !this.jobs.actionContext(proposal.owner, proposal.job).active) throw new BrokerError('job_ended');
    const decision = this.decision(proposal);
    if (!['user_approval', 'parent_risk_review', 'autonomous'].includes(decision.authorization)) throw new BrokerError(decision.reason ?? 'approval_required');
  }
  private async dispatch(proposal: Proposal) {
    if (proposal.receipt) return this.view(proposal);
    const previous = this.options.ledger.get(proposal.id);
    if (previous) { proposal.receipt = previous; return this.view(proposal); }
    const job = this.jobs.actionContext(proposal.owner, proposal.job);
    this.allowed(proposal);
    const pane = await this.herdr.describe(proposal.target.pane_id, job.signal);
    const baseline = await this.herdr.capture(pane, job.signal);
    const verified = await this.herdr.describe(proposal.target.pane_id, job.signal);
    const session = await this.sessions.observe(verified, job.signal, true);
    if (!sameTarget(targetOf(pane), proposal.target) || !sameTarget(targetOf(verified), proposal.target) || session.id !== proposal.session) throw new BrokerError('target_changed');
    if (proposal.operation === 'execute' && !this.sessions.ready(session)) throw new BrokerError('shell_not_ready');
    this.allowed(proposal);
    if (proposal.operation === 'execute' && baseline.text.includes(proposal.nonce)) throw new BrokerError('baseline_marker_conflict');
    const payload = proposal.body!.payload;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    this.jobs.actionBudget(proposal.owner, proposal.job, bytes);
    if (!proposal.controlReserved) {
      this.jobs.retainAction(proposal.owner, proposal.job, 0, 4096, () => { delete proposal.evidence; });
      proposal.controlReserved = true;
    }
    const created = this.now();
    const authorization = this.decision(proposal).authorization;
    const receipt: Control = { proposal_id: proposal.id, job_id: proposal.job, pane_session_id: proposal.session, terminal_id: proposal.target.terminal_id, payload_digest: proposal.digest, mode_revision: proposal.revision, operation: proposal.operation, original_proposal_id: proposal.original, authorization, approval_expires: proposal.approval?.expires ?? null, approval_consumed: authorization === 'user_approval', submission_state: 'dispatching', observation_state: proposal.operation === 'execute' ? 'observing' : 'not_applicable', exit_code: null, created_at: created, updated_at: created, hold_reason: proposal.operation === 'execute' ? 'awaiting_outcome' : null, recovery: null };
    const intent = this.options.ledger.intent(receipt);
    proposal.receipt = intent.control;
    if (!intent.fresh) return this.view(proposal);
    this.jobs.actionBudget(proposal.owner, proposal.job, bytes, true);
    delete proposal.approval;
    this.options.fault?.('after_intent');
    if (proposal.operation === 'execute') proposal.observation = { method: 'bounded_passive_marker', truncated: baseline.truncated, baseline_digest: createHash('sha256').update(baseline.text).digest('hex') };
    this.options.fault?.('before_wire');
    proposal.submittedAt = Date.now();
    try {
      if (!this.jobs.actionContext(proposal.owner, proposal.job).active) throw new BrokerError('job_ended');
      this.options.verifyAuthority();
      const wireSignal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(Math.min(this.options.observationMs ?? 60000, 60000))]);
      const sent = this.herdr.send(proposal.target.pane_id, payload, wireSignal, { afterWrite: () => this.options.fault?.('after_wire'), beforeWrite: () => {
        this.options.ledger.verify();
        if (this.stop.signal.aborted || !this.jobs.actionContext(proposal.owner, proposal.job).active) throw new BrokerError('job_ended');
        const current = this.sessions.get(proposal.session);
        if (current.revision !== receipt.mode_revision || current.mode === 0) throw new BrokerError('mode_changed');
        if (!proposal.body || proposal.rejected) throw new BrokerError('proposal_invalid');
        if (receipt.authorization === 'user_approval' && receipt.approval_expires! <= this.now()) throw new BrokerError('approval_expired');
        if (receipt.authorization !== 'user_approval' && this.decision(proposal).authorization !== receipt.authorization) throw new BrokerError('authorization_changed');
        if (proposal.operation === 'interrupt') this.options.ledger.requireInterruptTarget(proposal.original ?? undefined, proposal.target.terminal_id, proposal.session);
      }, onLateAck: () => {
        if (receipt.submission_state !== 'unknown') return;
        receipt.submission_state = 'accepted'; receipt.updated_at = this.now();
        if (receipt.hold_reason === 'submission_unknown') receipt.hold_reason = 'awaiting_outcome';
        try { this.options.ledger.update(receipt); } catch { receipt.hold_reason = 'ledger_write_failed'; }
      } });
      await sent;
      receipt.submission_state = 'accepted';
    } catch (error) {
      const rejected = error instanceof BrokerError && ['pane_not_found', 'invalid_key', 'pane_send_failed'].includes(error.code);
      receipt.submission_state = rejected ? 'rejected' : 'unknown';
      if (rejected) { receipt.observation_state = proposal.operation === 'execute' ? 'not_started' : 'not_applicable'; receipt.hold_reason = null; }
      else receipt.hold_reason = 'submission_unknown';
    }
    this.options.fault?.('before_ack_record');
    receipt.updated_at = this.now();
    try { this.options.ledger.update(receipt, receipt.submission_state === 'rejected'); }
    catch { receipt.hold_reason = 'ledger_write_failed'; receipt.observation_state = proposal.operation === 'execute' ? 'outcome_unknown' : 'not_applicable'; return this.view(proposal); }
    this.options.fault?.('after_ack_record');
    if (receipt.submission_state !== 'rejected' && proposal.operation === 'execute') {
      const observing = this.observe(proposal, job.scope?.trusted === true);
      this.observers.add(observing);
      void observing.finally(() => this.observers.delete(observing));
    }
    return this.view(proposal);
  }
  private async observe(proposal: Proposal, trusted: boolean) {
    const receipt = proposal.receipt!;
    const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(Math.max(1, Math.min(this.options.observationMs ?? 60000, 60000) - (Date.now() - proposal.submittedAt!)))]);
    try {
      for (;;) {
        if (receipt.recovery) return;
        const pane = await this.herdr.describe(proposal.target.pane_id, signal);
        const session = await this.sessions.observe(pane, signal);
        if (!sameTarget(targetOf(pane), proposal.target) || session.id !== proposal.session) throw new BrokerError('target_changed');
        const capture = await this.herdr.capture(pane, signal);
        proposal.observation!.truncated ||= capture.truncated;
        const checked = await this.herdr.describe(proposal.target.pane_id, signal);
        const checkedSession = await this.sessions.observe(checked, signal);
        if (receipt.recovery) return;
        if (!sameTarget(targetOf(checked), proposal.target) || checkedSession.id !== proposal.session) throw new BrokerError('target_changed');
        const snapshot = this.jobs.prepareActionSnapshot(proposal.owner, proposal.job, capture.text, proposal.session, capture.truncated);
        proposal.observation!.truncated ||= snapshot.metadata.truncated;
        const pattern = new RegExp(`^__HERDR_END_${proposal.nonce}__:(0|[1-9][0-9]{0,2})$`);
        const matches = snapshot.rows.flatMap((row, index) => { const match = (index > 0 || !snapshot.metadata.row_mapping.first_row_partial) && pattern.exec(row); return match ? [{ index, exit: Number(match[1]) }] : []; });
        if (matches.length > 1) throw new BrokerError('ambiguous_marker');
        if (matches.length === 1 && matches[0]!.exit <= 255) {
          const retained = this.jobs.actionEvidence(proposal.owner, proposal.job, snapshot);
          if (retained) {
            this.jobs.retainAction(proposal.owner, proposal.job, 4096, 0, () => { delete proposal.evidence; });
            proposal.evidence = excerpt(retained.metadata.snapshot_id, retained.rows, 0, 0, [matches[0]!.index]);
          }
          receipt.observation_state = 'completion_observed'; receipt.exit_code = matches[0]!.exit; receipt.hold_reason = trusted ? null : 'untrusted_completion';
          receipt.updated_at = this.now();
          this.options.ledger.update(receipt, trusted);
          return;
        }
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      if (receipt.recovery) return;
      if (receipt.observation_state !== 'completion_observed') { receipt.observation_state = 'outcome_unknown'; receipt.exit_code = null; }
      receipt.hold_reason = this.stop.signal.aborted ? 'core_stopped' : signal.aborted ? 'observation_deadline' : error instanceof BrokerError ? error.code : 'observation_failed';
      receipt.updated_at = this.now();
      try { this.options.ledger.update(receipt); } catch { receipt.hold_reason = 'ledger_write_failed'; }
    }
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.submissions.values()]);
    await Promise.allSettled([...this.observers]);
  }
  status(owner: string, job: string, id: string) { return this.view(this.get(owner, job, id)); }
  lower(owner: string, job: string, mode: number) {
    const context = this.jobs.actionContext(owner, job);
    if (!context.active) throw new BrokerError('job_ended');
    return this.sessions.mode(context.session, mode);
  }
  review(id: string) {
    this.options.verifyAuthority();
    const proposal = this.proposals.get(id);
    if (!proposal) throw new BrokerError('proposal_unavailable');
    const view = this.view(proposal);
    return { ...view, action_mode: this.sessions.get(proposal.session).mode, ...proposal.body };
  }
  approve(id: string, reviewedDigest: string, reject = false) {
    this.options.verifyAuthority();
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.digest !== reviewedDigest) throw new BrokerError('review_required');
    if (this.decision(proposal).authorization === 'blocked') throw new BrokerError('proposal_invalid');
    delete proposal.approval;
    proposal.rejected = reject;
    if (!reject) proposal.approval = { issued: this.now(), expires: this.now() + 300000, revision: proposal.revision, digest: proposal.digest };
    return this.view(proposal);
  }
  revoke(id: string) {
    this.options.verifyAuthority();
    const proposal = this.proposals.get(id);
    if (!proposal) throw new BrokerError('proposal_unavailable');
    delete proposal.approval;
    proposal.rejected = true;
    return this.view(proposal);
  }
  mode(id: string, mode: number) { this.options.verifyAuthority(); return this.sessions.mode(id, mode, true); }
  async inspect(paneId: string) {
    this.options.verifyAuthority();
    const pane = await this.herdr.describe(paneId, this.stop.signal);
    const session = await this.sessions.observe(pane, this.stop.signal, true);
    return { target: session.target, pane_session_id: session.id, mode_revision: session.revision, action_mode: session.mode, observed_connection: session.connection, shell_ready: this.sessions.ready(session), shell_pid: session.process.shell_pid, foreground_process_group_id: session.process.foreground_process_group_id, held_proposal_id: this.options.ledger.held(pane.terminal_id) ?? null };
  }
  async recover(inspected: Awaited<ReturnType<Actions['inspect']>>, id: string, objective: string) {
    if (!objective.trim() || objective.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(objective)) throw new BrokerError('invalid_objective');
    const current = await this.inspect(inspected.target.pane_id);
    if (!sameTarget(inspected.target, current.target) || inspected.pane_session_id !== current.pane_session_id || inspected.mode_revision !== current.mode_revision || inspected.held_proposal_id !== id || current.held_proposal_id !== id) throw new BrokerError('inspect_stale');
    if (!inspected.shell_ready || !current.shell_ready) throw new BrokerError('shell_not_ready');
    if (this.wires.has(current.target.terminal_id)) throw new BrokerError('submission_in_progress');
    const session = this.sessions.get(current.pane_session_id);
    this.jobs.stopPane(current.target.pane_id);
    session.revision++;
    session.recoveryObjective = createHash('sha256').update(objective).digest('hex');
    const receipt = this.options.ledger.recover(id, current.target.terminal_id);
    const proposal = this.proposals.get(id);
    if (proposal?.receipt) Object.assign(proposal.receipt, receipt);
    return { ...receipt, new_job_required: true, pane_session_id: current.pane_session_id, mode_revision: session.revision };
  }
  budget(jobId: string) { return { ordinary_attempts_remaining: Math.max(0, 3 - this.options.ledger.count(jobId, 'execute')), interrupt_attempts_remaining: Math.max(0, 1 - this.options.ledger.count(jobId, 'interrupt')) }; }
  summary() { return { ...this.options.ledger.summary(), proposals: [...this.proposals.values()].slice(-32).map(proposal => ({ ...this.view(proposal), evidence: undefined })) }; }
}
