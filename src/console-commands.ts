import type { Actions } from './actions.js';
import type { ConsoleView } from './console-view.js';
import { BrokerError } from './herdr.js';
import { sameTarget } from './sessions.js';

export interface ConsoleCore {
  socketPath: string; close(): Promise<void>; summary(): object; purge(id: string): object;
  actions?: Actions; consoleView?: ConsoleView; consoleStatus?(): object; addTerminal?(): Promise<object>;
}
export const encodeConsole = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
export class ConsoleCommands {
  readonly commands = ['status', 'purge <job_id>', 'purge all', 'review <proposal_id>', 'approve <proposal_id>', 'reject <proposal_id>', 'revoke <proposal_id>', 'mode <session_id> <1|2|3>', 'inspect <pane_id>', 'ssh-ready <pane_session_id> <absolute cwd>', 'recover <original_proposal_id> <new objective>', 'help', 'quit'];
  private reviewed: Pick<ReturnType<Actions['review']>, 'proposal_id' | 'payload_digest' | 'target' | 'pane_session_id' | 'mode_revision'> | undefined;
  private inspected: Awaited<ReturnType<Actions['inspect']>> | undefined;
  // Mode consumes its review; SSH/recovery must still reject the prior stale inspection.
  private modeInspection: Awaited<ReturnType<Actions['inspect']>> | undefined;
  private pending = Promise.resolve();
  private closed = false;
  constructor(private readonly core: ConsoleCore, private readonly interactive: boolean, private readonly quit: () => Promise<void>) {
    if (core.addTerminal) this.commands.unshift('panes', 'new');
  }
  idle() { return this.pending; }
  stop() { this.closed = true; this.reviewed = undefined; this.inspected = undefined; this.modeInspection = undefined; }
  run(command: string): Promise<unknown> {
    const next = this.pending.then(async () => {
      try { return await this.execute(command.trim()); }
      catch (error) { return { error: error instanceof BrokerError ? error.code : 'internal_error' }; }
    });
    this.pending = next.then(() => {});
    return next;
  }
  private async execute(command: string): Promise<unknown> {
    if (this.closed) return null;
    if (command.length > 1024) throw new BrokerError('console_input_too_large');
    if (command === 'quit') { await this.quit(); return null; }
    if (command === 'panes' && this.core.consoleStatus) return this.core.consoleStatus();
    if (command === 'new' && this.core.addTerminal) {
      if (!this.interactive) throw new BrokerError('interactive_console_required');
      return this.core.addTerminal();
    }
    const inspect = /^inspect (\S{1,256})$/.exec(command);
    const sshReady = /^ssh-ready ([0-9a-f-]{36}) (.+)$/.exec(command);
    const recover = /^recover ([0-9a-f-]{36}) (.+)$/.exec(command);
    if (inspect || recover || sshReady) {
      if (!this.interactive || !this.core.actions) throw new BrokerError('interactive_console_required');
      if (inspect) { this.inspected = await this.core.actions.inspect(inspect[1]!); this.modeInspection = this.inspected; return this.inspected; }
      if (!this.inspected) throw new BrokerError('inspect_required');
      const previous = this.inspected; this.inspected = undefined; this.modeInspection = undefined; this.reviewed = undefined;
      return sshReady ? this.core.actions.confirmSSH(previous, sshReady[1]!, sshReady[2]!) : this.core.actions.recover(previous, recover![1]!, recover![2]!);
    }
    const action = /^(review|approve|reject|revoke|mode) ([0-9a-f-]{36})(?: ([123]))?$/.exec(command);
    if (action) {
      const actions = this.core.actions;
      if (!this.interactive || !actions) throw new BrokerError('interactive_console_required');
      const [, operation, id, mode] = action;
      if (operation === 'review') {
        const value = actions.review(id!);
        const { proposal_id, payload_digest, target, pane_session_id, mode_revision } = value;
        this.reviewed = { proposal_id, payload_digest, target, pane_session_id, mode_revision };
        return value;
      }
      if (operation === 'mode' && mode) {
        this.reviewed = undefined;
        const inspected = this.modeInspection; this.modeInspection = undefined;
        return actions.changeMode(id!, Number(mode), inspected?.pane_session_id === id ? inspected : undefined);
      }
      if (operation === 'revoke') { this.reviewed = undefined; return actions.revoke(id!); }
      if (['approve', 'reject'].includes(operation!) && this.reviewed && this.reviewed.proposal_id === id) {
        const review = this.reviewed; this.reviewed = undefined;
        const current = await actions.inspect(review.target.pane_id);
        if (!sameTarget(current.target, review.target) || current.pane_session_id !== review.pane_session_id || current.mode_revision !== review.mode_revision) throw new BrokerError('review_stale');
        return actions.approve(id!, review.payload_digest, operation === 'reject');
      }
      throw new BrokerError('review_required');
    }
    const purge = /^purge (all|[0-9a-f-]{36})$/.exec(command);
    return command === 'status' ? this.core.summary() : purge ? this.core.purge(purge[1]!) : { commands: this.commands, action_supported: !!this.core.actions, modes: { default: 2, user_approval: 1, agent_risk_review: 2, autonomous: 3 }, recovery: 'inspect the current pane, then recover the original held proposal with a new objective' };
  }
}
