import { BrokerError, Herdr, type ConsoleScope, type Pane, type ProcessInfo } from './herdr.js';
import type { Sessions } from './sessions.js';
import type { Jobs } from './jobs.js';
import type { Actions } from './actions.js';
import type { Ledger, Control } from './ledger.js';

export interface ParentConnection { pane_id: string | null; terminal_id: string | null; state: 'disconnected' | 'verifying' | 'connected' | 'invalid'; error: string | null }
export const connectionLabel = (state: ParentConnection['state']) => ({ disconnected: '연결 끊김', verifying: '연결 확인 중', connected: '연결됨', invalid: '검증 실패' })[state];
export interface ConsoleInfo { label: string; controller: { pane_id: string; terminal_id: string } }
type BindingState = 'checking' | 'ready' | 'missing' | 'moved' | 'replaced' | 'unavailable';
interface Metadata { state: BindingState; checked_at: number | null; error: string | null; pane?: Pane; process?: ProcessInfo }
export interface ConsolePane {
  pane_id: string; terminal_id: string; metadata: Metadata;
  connection: 'local' | 'ssh' | null;
  session: { pane_session_id: string; action_mode: number; mode_revision: number } | null;
  jobs: ReturnType<Jobs['summary']>['jobs'];
  proposals: ReturnType<Actions['consoleProposals']>;
  receipts: Control[]; held: string | null;
}
export interface ConsoleSnapshot {
  console_id: string; label: string; tab_id: string;
  parent: ParentConnection & { metadata: Metadata | null };
  controller: ConsoleInfo['controller'] & { metadata: Metadata };
  panes: ConsolePane[]; pending_approvals: number; held_count: number;
  events: { at: number; text: string }[];
}
interface ViewOptions {
  endpoint: string; consoleId: string; info: ConsoleInfo; scope: ConsoleScope; verifyAuthority(): void;
  parent(): ParentConnection; jobs: Jobs; sessions: Sessions; actions: Actions; ledger: Ledger;
}
const unchecked = (): Metadata => ({ state: 'checking', checked_at: null, error: null });
export const bindingLabel = (state: BindingState) => ({ checking: '확인 중', ready: '정상', missing: '종료됨', moved: '이동됨', replaced: '교체됨', unavailable: '확인 실패' })[state];
export function receiptLabel(receipt: Control) {
  if (receipt.recovery) return '사용자 복구 확인';
  if (receipt.observation_state === 'completion_observed') return `완료 · exit ${receipt.exit_code}`;
  if (receipt.observation_state === 'outcome_unknown') return '결과 미확정';
  if (receipt.submission_state === 'unknown') return '입력 접수 미확정';
  if (receipt.submission_state === 'rejected') return '입력 거부';
  if (receipt.submission_state === 'dispatching') return '입력 제출 중';
  return receipt.operation === 'interrupt' ? '중단 입력 접수 · 종료 미확인' : '입력 접수 · 완료 관찰 중';
}
export function paneActivity(pane: ConsolePane) {
  if (pane.held) return `보류 · ${pane.receipts.find(receipt => receipt.proposal_id === pane.held)?.hold_reason ?? '결과 확인 필요'}`;
  const pending = pane.proposals.filter(proposal => proposal.authorization === 'approval_required').length;
  if (pending) return `승인 대기 ${pending}`;
  const active = pane.jobs.filter(job => !job.job_ended && job.deadline_remaining_ms > 0);
  if (active.some(job => job.phase === 'observing' && job.worker)) return 'Worker 분석 중';
  if (active.some(job => job.phase === 'observing')) return '관찰 중';
  if (active.some(job => job.result_ready)) return '분석 결과 준비';
  return '대기';
}

// This observer owns a separate Herdr continuity counter. Painting cannot invalidate Actions.
export class ConsoleView {
  private readonly herdr: Herdr;
  private readonly metadata = new Map<string, Metadata>();
  private readonly stop = new AbortController();
  private pending: Promise<void> | undefined;
  private readonly events: ConsoleSnapshot['events'] = [];
  private previous = new Map<string, string>();
  constructor(private readonly options: ViewOptions) { this.herdr = new Herdr(options.endpoint, options.verifyAuthority); }
  refresh(): Promise<void> {
    if (this.stop.signal.aborted) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.observe().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async observe() {
    const { scope, info } = this.options;
    const parent = this.options.parent();
    const targets = [...scope.terminals].map(([pane_id, terminal_id]) => ({ pane_id, terminal_id, process: true }));
    const identities = [...targets, { ...info.controller, process: false }, ...(parent.pane_id && parent.state !== 'disconnected' ? [{ pane_id: parent.pane_id, terminal_id: parent.terminal_id, process: false }] : [])];
    const known = new Set(identities.map(item => item.pane_id));
    for (const id of this.metadata.keys()) if (!known.has(id)) this.metadata.delete(id);
    await Promise.all(identities.map(async identity => {
      const previous = this.metadata.get(identity.pane_id) ?? unchecked();
      try {
        const pane = await this.herdr.describe(identity.pane_id, this.stop.signal);
        const state = pane.workspace_id !== scope.workspace_id || pane.tab_id !== scope.tab_id ? 'moved' : identity.terminal_id && pane.terminal_id !== identity.terminal_id ? 'replaced' : 'ready';
        const process = identity.process && state === 'ready' ? await this.herdr.processInfo(identity.pane_id, this.stop.signal) : undefined;
        if (!this.stop.signal.aborted) this.metadata.set(identity.pane_id, { state, checked_at: Date.now(), error: null, pane, ...(process && { process }) });
      } catch (error) {
        if (!this.stop.signal.aborted) this.metadata.set(identity.pane_id, { state: error instanceof BrokerError && error.nativeCode === 'pane_not_found' ? 'missing' : 'unavailable', checked_at: previous.checked_at, error: error instanceof BrokerError ? error.code : 'internal_error' });
      }
    }));
  }
  snapshot(): ConsoleSnapshot {
    const { scope, info, jobs, sessions, actions, ledger } = this.options;
    this.options.verifyAuthority();
    const status = jobs.summary('dashboard');
    const active = new Set(status.jobs.filter(job => !job.job_ended && job.deadline_remaining_ms > 0).map(job => job.job_id));
    const proposals = actions.consoleProposals(active);
    const control = ledger.summary(false);
    const parent = this.options.parent();
    const panes = [...scope.terminals].map(([pane_id, terminal_id]): ConsolePane => {
      const metadata = this.metadata.get(pane_id) ?? unchecked();
      const observed = metadata.state === 'ready' && metadata.pane && metadata.process ? sessions.peek(metadata.pane, metadata.process) : null;
      const held = ledger.held(terminal_id) ?? null;
      const receipts = control.receipts.filter(receipt => receipt.terminal_id === terminal_id);
      if (held && !receipts.some(receipt => receipt.proposal_id === held)) { const receipt = ledger.get(held); if (receipt) receipts.unshift(receipt); }
      return { pane_id, terminal_id, metadata, connection: observed?.connection ?? null, session: observed?.session ?? null,
        jobs: status.jobs.filter(job => job.pane_id === pane_id), proposals: proposals.filter(proposal => proposal.target.pane_id === pane_id), receipts, held };
    });
    const controller = { ...info.controller, metadata: this.metadata.get(info.controller.pane_id) ?? unchecked() };
    const parentMeta = parent.pane_id ? this.metadata.get(parent.pane_id) ?? null : null;
    const changes = new Map<string, string>([
      ['parent', `Codex ${parent.pane_id ?? '—'} · ${connectionLabel(parent.state)}${parentMeta && parentMeta.state !== 'ready' ? ` · ${bindingLabel(parentMeta.state)}` : ''}`],
      ['controller', `Console ${controller.pane_id} · ${bindingLabel(controller.metadata.state)}`],
      ...panes.map(pane => [pane.pane_id, `${pane.pane_id} · ${bindingLabel(pane.metadata.state)} · ${pane.session ? `Mode ${pane.session.action_mode}` : '확인 필요'} · ${paneActivity(pane)}${pane.receipts[0] ? ` · ${receiptLabel(pane.receipts[0])}` : ''}`] as const),
    ]);
    for (const [key, text] of changes) if (this.previous.get(key) !== text) this.events.push({ at: Date.now(), text });
    this.previous = changes;
    if (this.events.length > 50) this.events.splice(0, this.events.length - 50);
    return { console_id: this.options.consoleId, label: info.label, tab_id: scope.tab_id, parent: { ...parent, metadata: parentMeta }, controller, panes,
      pending_approvals: proposals.filter(proposal => proposal.authorization === 'approval_required').length, held_count: control.held_terminal_count, events: [...this.events] };
  }
  async close() { this.stop.abort(); await this.pending; }
}
