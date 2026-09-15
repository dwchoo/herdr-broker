import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { BrokerError, Herdr } from './herdr.js';
import { Jobs } from './jobs.js';
import { Sessions, targetSchema, targetOf, sameTarget, type Target } from './sessions.js';

const text = z.string().min(1).max(1024);
const riskSchema = z.strictObject({ classification: z.enum(['read', 'bounded_change', 'high', 'unknown']), inspected: z.boolean(), impact: text, recovery: text, uncertainties: z.array(text).max(5), categories: z.array(z.enum(['destructive', 'privilege', 'system_package', 'driver', 'kernel', 'disk', 'network', 'account', 'permissions', 'reboot', 'shutdown'])).max(12) });
export const proposalSchema = z.strictObject({ job_id: z.string().uuid(), target: targetSchema, objective: z.string().min(1).max(4096), operation: z.enum(['execute', 'interrupt']), command: z.string().min(1).max(4096).refine(value => !value.includes('\0')).optional(), original_proposal_id: z.string().uuid().optional(), cwd: z.string().min(1).max(4096), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(1024).refine(value => !value.includes('\0'))).refine(value => Object.keys(value).length <= 16), affected_paths: z.array(z.string().min(1).max(4096)).min(1).max(16), risk: z.unknown().optional() });
type ProposalInput = z.infer<typeof proposalSchema>;
interface Body { objective: string; payload: { text: string; keys: string[] }; risk: z.infer<typeof riskSchema> | null; affected_paths: string[]; cwd: string; env: Record<string, string> }
interface Proposal { id: string; job: string; owner: string; session: string; revision: number; target: Target; operation: string; digest: string; nonce: string; body?: Body; approval?: { issued: number; expires: number; revision: number; digest: string }; rejected: boolean }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const within = (value: string, roots: string[]) => value.startsWith('/') && posix.normalize(value) === value && !value.includes('\0') && roots.some(root => value === root || value.startsWith(root === '/' ? '/' : root + '/'));

export class Actions {
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly herdr: Herdr, private readonly jobs: Jobs, private readonly sessions: Sessions, private readonly now = Date.now, private readonly verifyAuthority: () => void = () => {}) {}
  async propose(owner: string, input: ProposalInput) {
    const job = this.jobs.actionContext(owner, input.job_id);
    if (!job.active) throw new BrokerError('job_ended');
    if (!job.scope) throw new BrokerError('action_scope_required');
    if (job.objectiveDigest !== createHash('sha256').update(input.objective).digest('hex')) throw new BrokerError('objective_mismatch');
    const pane = await this.herdr.describe(job.pane_id, job.signal);
    const session = await this.sessions.observe(pane, job.signal, true);
    if (session.id !== job.session || !sameTarget(targetOf(pane), input.target)) throw new BrokerError('target_changed');
    if (!this.sessions.ready(session)) throw new BrokerError('shell_not_ready');
    if (!within(input.cwd, [job.scope.cwd]) || !input.affected_paths.every(path => within(path, job.scope!.paths))) throw new BrokerError('outside_scope');
    if (input.operation !== 'execute') throw new BrokerError('interrupt_unsupported');
    if (!input.command || input.original_proposal_id) throw new BrokerError('invalid_operation');
    const parsed = riskSchema.safeParse(input.risk);
    const nonce = randomBytes(16).toString('hex');
    const script = `cd ${quote(input.cwd)} && /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin ${Object.entries(input.env).map(([key, value]) => quote(`${key}=${value}`)).join(' ')} /bin/sh -c ${quote(input.command)}`;
    const wrapper = `printf '\\n__HERDR_%s_%s__\\n' BEGIN ${quote(nonce)}; ( ${script}\n); herdr_broker_exit=$?; printf '\\n__HERDR_%s_%s__:%s\\n' END ${quote(nonce)} "$herdr_broker_exit"; exit "$herdr_broker_exit"`;
    const body: Body = { objective: input.objective, payload: { text: `/bin/sh -c ${quote(wrapper)}`, keys: ['Enter'] }, risk: parsed.success ? parsed.data : null, affected_paths: input.affected_paths, cwd: input.cwd, env: input.env };
    const proposal: Proposal = { id: randomUUID(), job: job.id, owner, session: session.id, revision: session.revision, target: session.target, operation: input.operation, nonce, body, digest: createHash('sha256').update(JSON.stringify([session.id, session.revision, job.id, session.target, input.operation, body])).digest('hex'), rejected: false };
    this.jobs.retainAction(owner, job.id, 4 * Buffer.byteLength(JSON.stringify(body)), 1024 + 2 * Buffer.byteLength(JSON.stringify({ ...proposal, body: undefined })), () => { delete proposal.body; delete proposal.approval; });
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
    return { job_id: proposal.job, proposal_id: proposal.id, pane_session_id: proposal.session, target: proposal.target, mode_revision: proposal.revision, operation: proposal.operation, payload_digest: proposal.digest, contract: 'action.v1', submission_state: 'not_submitted', observation_state: 'not_started', exit_code: null, ...this.decision(proposal), approval_expires_at: proposal.approval ? new Date(proposal.approval.expires).toISOString() : null };
  }
  status(owner: string, job: string, id: string) { return this.view(this.get(owner, job, id)); }
  lower(owner: string, job: string, mode: number) {
    const context = this.jobs.actionContext(owner, job);
    if (!context.active) throw new BrokerError('job_ended');
    return this.sessions.mode(context.session, mode);
  }
  review(id: string) {
    this.verifyAuthority();
    const proposal = this.proposals.get(id);
    if (!proposal) throw new BrokerError('proposal_unavailable');
    const view = this.view(proposal);
    return { ...view, action_mode: this.sessions.get(proposal.session).mode, ...proposal.body };
  }
  approve(id: string, reviewedDigest: string, reject = false) {
    this.verifyAuthority();
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.digest !== reviewedDigest) throw new BrokerError('review_required');
    if (this.decision(proposal).authorization === 'blocked') throw new BrokerError('proposal_invalid');
    delete proposal.approval;
    proposal.rejected = reject;
    if (!reject) proposal.approval = { issued: this.now(), expires: this.now() + 300000, revision: proposal.revision, digest: proposal.digest };
    return this.view(proposal);
  }
  revoke(id: string) {
    this.verifyAuthority();
    const proposal = this.proposals.get(id);
    if (!proposal) throw new BrokerError('proposal_unavailable');
    delete proposal.approval;
    proposal.rejected = true;
    return this.view(proposal);
  }
  mode(id: string, mode: number) { this.verifyAuthority(); return this.sessions.mode(id, mode, true); }
  summary() { return { proposals: [...this.proposals.values()].slice(-32).map(proposal => this.view(proposal)) }; }
}
