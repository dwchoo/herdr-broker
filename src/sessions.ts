import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { BrokerError, Herdr, type Pane, type ProcessInfo } from './herdr.js';

const path = z.string().min(1).max(4096).refine(value => value.startsWith('/') && posix.normalize(value) === value && !value.includes('\0'));
export const scopeSchema = z.strictObject({ profile: z.literal('local_posix'), cwd: path, paths: z.array(path).min(1).max(16), trusted: z.boolean() });
export type Scope = z.infer<typeof scopeSchema>;
export const targetSchema = z.strictObject({ pane_id: z.string().min(1).max(256), terminal_id: z.string().min(1).max(256), workspace_id: z.string().min(1).max(256), tab_id: z.string().min(1).max(256) });
export type Target = z.infer<typeof targetSchema>;
export interface Session { id: string; target: Target; process: ProcessInfo; fingerprint: string; continuity: number; connection: { kind: 'local' | 'ssh'; local_ssh_process_ids: number[]; remote_identity_authenticated: false }; mode: number; revision: number; active: boolean; bytes: number; recoveryObjective?: string }
export const targetOf = (pane: Pane): Target => ({ pane_id: pane.pane_id, terminal_id: pane.terminal_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id });
export const sameTarget = (a: Target, b: Target) => JSON.stringify(a) === JSON.stringify(b);
export class Sessions {
  private readonly current = new Map<string, Session>();
  private retain: (bytes: number) => void = () => {};
  constructor(private readonly herdr: Herdr) {}
  setRetentionGuard(retain: (bytes: number) => void) { this.retain = retain; }
  memoryBytes() { return [...this.current.values()].reduce((sum, session) => sum + session.bytes, 0); }
  async observe(pane: Pane, signal?: AbortSignal, actionTarget = false) {
    let info: ProcessInfo;
    try { info = await this.herdr.processInfo(pane.pane_id, signal); }
    catch (error) { if (signal?.aborted) throw error; const previous = this.current.get(pane.pane_id); if (previous) previous.active = false; throw error; }
    if (signal?.aborted) throw new BrokerError('cancelled');
    if (actionTarget && info.foreground_processes.some(item => item.pid === process.pid)) throw new BrokerError('console_target_forbidden');
    const target = targetOf(pane);
    const ssh = info.foreground_processes.filter(item => item.pid === info.foreground_process_group_id && posix.basename(item.argv0 ?? item.name) === 'ssh').map(item => [item.pid, createHash('sha256').update(JSON.stringify([item.name, item.argv0, item.argv])).digest('hex')] as const);
    const connection: Session['connection'] = { kind: ssh.length ? 'ssh' : 'local', local_ssh_process_ids: ssh.map(item => item[0]), remote_identity_authenticated: false };
    const fingerprint = JSON.stringify([target, info.shell_pid, this.herdr.generation, ssh.length ? [info.foreground_process_group_id, ssh] : null]);
    const previous = this.current.get(pane.pane_id);
    if (previous && previous.fingerprint !== fingerprint) previous.active = false;
    const bytes = 1024 + 2 * Buffer.byteLength(JSON.stringify([target, info, fingerprint]));
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
  mode(id: string, mode: number, human = false) {
    const session = this.get(id);
    if (!human && mode > session.mode) throw new BrokerError('mode_upgrade_requires_user');
    if (mode !== session.mode) { session.mode = mode; session.revision++; }
    return { pane_session_id: id, action_mode: session.mode, mode_revision: session.revision };
  }
  ready(session: Session) {
    const info = session.process;
    return info.shell_pid !== null && info.foreground_process_group_id === info.shell_pid && info.foreground_processes.some(item => item.pid === info.shell_pid && ['sh', 'zsh', 'bash', 'dash', 'ksh'].includes(posix.basename(item.argv0 ?? item.name)));
  }
}
