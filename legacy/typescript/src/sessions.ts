import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { BrokerError, Herdr, type Pane, type ProcessInfo } from './herdr.js';

const path = z.string().min(1).max(4096).refine(value => value.startsWith('/') && posix.normalize(value) === value && !value.includes('\0'));
export const scopeSchema = z.discriminatedUnion('profile', [z.strictObject({ profile: z.literal('terminal') }), z.strictObject({ profile: z.enum(['local_posix', 'ssh_posix']), cwd: path, paths: z.array(path).min(1).max(16), trusted: z.boolean() })]);
export type Scope = z.infer<typeof scopeSchema>;
export const targetSchema = z.strictObject({ pane_id: z.string().min(1).max(256), terminal_id: z.string().min(1).max(256), workspace_id: z.string().min(1).max(256), tab_id: z.string().min(1).max(256) });
export type Target = z.infer<typeof targetSchema>;
export interface Session { id: string; target: Target; process: ProcessInfo; fingerprint: string; continuity: number; connection: { kind: 'local' | 'ssh'; local_ssh_process_ids: number[]; remote_identity_authenticated: false }; mode: number; revision: number; active: boolean; bytes: number; recoveryObjective?: string; ssh?: { cwd: string; ready: boolean } }
export const targetOf = (pane: Pane): Target => ({ pane_id: pane.pane_id, terminal_id: pane.terminal_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id });
export const sameTarget = (a: Target, b: Target) => JSON.stringify(a) === JSON.stringify(b);
function binding(pane: Pane, info: ProcessInfo, generation: number) {
  const target = targetOf(pane);
  const ssh = info.foreground_processes.filter(item => item.pid === info.foreground_process_group_id && posix.basename(item.argv0 ?? item.name) === 'ssh').map(item => [item.pid, createHash('sha256').update(JSON.stringify([item.name, item.argv0, item.argv])).digest('hex')] as const);
  const connection: Session['connection'] = { kind: ssh.length ? 'ssh' : 'local', local_ssh_process_ids: ssh.map(item => item[0]), remote_identity_authenticated: false };
  return { target, connection, fingerprint: JSON.stringify([target, info.shell_pid, generation, ssh.length ? [info.foreground_process_group_id, ssh] : null]) };
}
export class Sessions {
  private readonly current = new Map<string, Session>();
  private retain: (bytes: number) => void = () => {};
  constructor(private readonly herdr: Herdr, private readonly sshEnabled = false) {}
  setRetentionGuard(retain: (bytes: number) => void) { this.retain = retain; }
  memoryBytes() { return [...this.current.values()].reduce((sum, session) => sum + session.bytes, 0); }
  async observe(pane: Pane, signal?: AbortSignal, actionTarget = false) {
    let info: ProcessInfo;
    try { info = await this.herdr.processInfo(pane.pane_id, signal); }
    catch (error) { if (signal?.aborted) throw error; const previous = this.current.get(pane.pane_id); if (previous) previous.active = false; throw error; }
    if (signal?.aborted) throw new BrokerError('cancelled');
    if (actionTarget && info.foreground_processes.some(item => item.pid === process.pid)) throw new BrokerError('console_target_forbidden');
    const { target, connection, fingerprint } = binding(pane, info, this.herdr.generation);
    const previous = this.current.get(pane.pane_id);
    if (previous && previous.fingerprint !== fingerprint) previous.active = false;
    const bytes = 1024 + 2 * Buffer.byteLength(JSON.stringify([target, info, fingerprint])) + (previous?.fingerprint === fingerprint && previous.ssh ? 2 * Buffer.byteLength(previous.ssh.cwd) : 0);
    this.retain(Math.max(0, bytes - (previous?.bytes ?? 0)));
    if (previous?.active && previous.fingerprint === fingerprint) { previous.process = info; previous.bytes = bytes; return previous; }
    if (previous) previous.active = false;
    const session: Session = { id: randomUUID(), target, process: info, fingerprint, continuity: this.herdr.generation, connection, mode: 2, revision: 1, active: true, bytes };
    this.current.set(pane.pane_id, session);
    return session;
  }
  get(id: string) {
    const session = [...this.current.values()].find(value => value.id === id && value.active && value.continuity === this.herdr.generation);
    if (!session) throw new BrokerError('session_changed');
    return session;
  }
  // A display observation cannot create, replace or invalidate an execution session.
  peek(pane: Pane, info: ProcessInfo) {
    const observed = binding(pane, info, this.herdr.generation);
    const session = this.current.get(pane.pane_id);
    const verified = session?.active && session.fingerprint === observed.fingerprint && this.herdr.currentEndpoint();
    return { connection: observed.connection.kind, session: verified ? { pane_session_id: session.id, action_mode: session.mode, mode_revision: session.revision } : null };
  }
  mode(id: string, mode: number, human = false) {
    const session = this.get(id);
    if (!human && mode > session.mode) throw new BrokerError('mode_upgrade_requires_user');
    if (mode !== session.mode) { session.mode = mode; session.revision++; }
    return { pane_session_id: id, action_mode: session.mode, mode_revision: session.revision };
  }
  summary() { return { session_count: this.current.size, sessions: [...this.current.values()].slice(-32).map(session => ({ pane_session_id: session.id, target: session.target, action_mode: session.mode, mode_revision: session.revision, active: session.active && session.continuity === this.herdr.generation, observed_connection: session.connection, ...(session.ssh && { ssh_preparation: { ...session.ssh, declaration: 'user_verified_ssh_posix' } }) })) }; }
  confirmSSH(id: string, cwd: string) {
    if (!this.sshEnabled) throw new BrokerError('ssh_profile_disabled');
    const session = this.get(id);
    if (session.connection.kind !== 'ssh') throw new BrokerError('ssh_session_required');
    if (!path.safeParse(cwd).success || /[\u0000-\u001f\u007f-\u009f]/.test(cwd)) throw new BrokerError('invalid_cwd');
    const added = 2 * Buffer.byteLength(cwd) - (session.ssh ? 2 * Buffer.byteLength(session.ssh.cwd) : 0);
    this.retain(Math.max(0, added)); session.bytes += added;
    session.ssh = { cwd, ready: true }; session.revision++;
    return { pane_session_id: id, mode_revision: session.revision, action_mode: session.mode, shell_ready: true, declaration: 'user_verified_ssh_posix', cwd, remote_identity_authenticated: false };
  }
  checkScope(session: Session, scope: Scope) {
    if (scope.profile === 'terminal') return;
    if (scope.profile !== (session.connection.kind === 'ssh' ? 'ssh_posix' : 'local_posix')) throw new BrokerError('profile_mismatch');
    if (session.connection.kind === 'ssh' && (!session.ssh || session.ssh.cwd !== scope.cwd)) throw new BrokerError('ssh_scope_mismatch');
  }
  consumeReady(session: Session) { if (session.ssh) session.ssh.ready = false; }
  restoreReady(id: string) { try { const session = this.get(id); if (session.ssh) session.ssh.ready = true; } catch { /* A replaced session never inherits readiness. */ } }
  ready(session: Session) {
    if (!session.active || session.continuity !== this.herdr.generation) return false;
    if (session.connection.kind === 'ssh') return this.sshEnabled && session.ssh?.ready === true;

    const info = session.process;
    return localShellReady(info);
  }
}

export function localShellReady(info: ProcessInfo) {
  return info.shell_pid !== null && info.foreground_process_group_id === info.shell_pid && info.foreground_processes.some(item => item.pid === info.shell_pid && ['sh', 'zsh', 'bash', 'dash', 'ksh'].includes(posix.basename(item.argv0 ?? item.name)));
}
