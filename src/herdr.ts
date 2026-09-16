import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { z } from 'zod';

export class BrokerError extends Error {
  constructor(readonly code: string, readonly nativeCode?: string) { super(code); }
}
const id = z.string().min(1).max(256);
const paneSchema = z.object({
  pane_id: id, terminal_id: id, workspace_id: id, tab_id: id,
  cwd: z.string().max(4096).optional(), foreground_cwd: z.string().max(4096).optional(),
  agent_status: z.string().max(64),
  label: z.string().max(1024).nullable().optional(), title: z.string().max(4096).nullable().optional(), terminal_title_stripped: z.string().max(4096).nullable().optional(),
});
export type Pane = z.infer<typeof paneSchema>;
export interface ConsoleScope { workspace_id: string; tab_id: string; terminals: ReadonlyMap<string, string> }

const processSchema = z.object({ pane_id: id, shell_pid: z.number().int().positive().nullable().default(null), foreground_process_group_id: z.number().int().positive().nullable().default(null),
  foreground_processes: z.array(z.object({ pid: z.number().int().positive(), name: z.string().max(256), argv0: z.string().max(4096).nullable().optional(), argv: z.array(z.string().max(65536)).max(256).nullable().optional() })).max(256).default([]), tty: z.string().max(4096).nullable().optional() });
export type ProcessInfo = z.infer<typeof processSchema>;
interface SendHooks { beforeWrite?: () => void; afterWrite?: () => void; onLateAck?: () => void }

export class Herdr {
  generation = 0;
  private endpointIdentity: string | undefined;
  constructor(private readonly endpoint: string, private readonly verifyAuthority: () => void, private readonly scope?: ConsoleScope) {}
  currentEndpoint() {
    try { const info = lstatSync(this.endpoint); return info.isSocket() && this.endpointIdentity === `${info.dev}:${info.ino}`; }
    catch { return false; }
  }
  requirePane(paneId: string) {
    if (this.scope && !this.scope.terminals.has(paneId)) throw new BrokerError('pane_outside_console');
  }
  private requireTarget(pane: Pane) {
    this.requirePane(pane.pane_id);
    if (this.scope && (pane.workspace_id !== this.scope.workspace_id || pane.tab_id !== this.scope.tab_id || this.scope.terminals.get(pane.pane_id) !== pane.terminal_id)) throw new BrokerError('pane_outside_console');
  }
  private request(method: string, params: object, signal?: AbortSignal, submission?: SendHooks): Promise<unknown> {
    return new Promise((resolve, reject) => {
      try {
        this.verifyAuthority();
        const info = lstatSync(this.endpoint);
        if (!info.isSocket()) throw new BrokerError('herdr_unavailable');
        const identity = `${info.dev}:${info.ino}`;
        if (this.endpointIdentity !== undefined && this.endpointIdentity !== identity) this.generation++;
        this.endpointIdentity = identity;
      } catch (error) {
        this.generation++;
        reject(error instanceof BrokerError ? error : new BrokerError('herdr_unavailable')); return;
      }
      const requestId = randomUUID();
      const socket = createConnection(this.endpoint);
      let buffer = Buffer.alloc(0);
      let settled = false;
      let closed = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: BrokerError, result?: unknown) => {
        if (closed) return;
        closed = true;
        if (error && !submission && !signal?.aborted && ['herdr_timeout', 'herdr_disconnected', 'herdr_unavailable', 'herdr_invalid_response', 'herdr_response_too_large'].includes(error.code)) this.generation++;
        clearTimeout(deadline);
        buffer = Buffer.alloc(0);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (!settled) { settled = true; if (error) reject(error); else resolve(result); }
        else if (!error && z.object({ type: z.literal('ok') }).safeParse(result).success) submission?.onLateAck?.();
      };
      const abort = () => finish(new BrokerError('cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      deadline = setTimeout(() => {
        if (!settled && submission?.onLateAck) {
          settled = true; reject(new BrokerError('herdr_timeout'));
        } else finish(new BrokerError('herdr_timeout'));
      }, 5000);
      socket.on('error', () => finish(new BrokerError('herdr_unavailable')));
      socket.on('end', () => finish(new BrokerError('herdr_disconnected')));
      socket.on('connect', () => {
        try { this.verifyAuthority(); submission?.beforeWrite?.(); socket.write(JSON.stringify({ id: requestId, method, params }) + '\n', () => {
          try { submission?.afterWrite?.(); } catch { finish(new BrokerError('send_interrupted')); }
        }); }
        catch (error) { finish(error instanceof BrokerError ? error : new BrokerError('authority_lost')); }
      });
      socket.on('data', chunk => {
        if (buffer.length + chunk.length > 1024 * 1024) { finish(new BrokerError('herdr_response_too_large')); return; }
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        try {
          const response = z.object({ id: z.literal(requestId), result: z.unknown().optional(), error: z.object({ code: z.string() }).optional() })
            .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))));
          if (response.error) throw new BrokerError(submission && ['pane_not_found', 'invalid_key', 'pane_send_failed'].includes(response.error.code) ? response.error.code : 'herdr_rejected', response.error.code);
          if (!response.result) throw new BrokerError('herdr_invalid_response');
          this.verifyAuthority();
          finish(undefined, response.result);
        } catch (error) { finish(error instanceof BrokerError ? error : new BrokerError('herdr_invalid_response')); }
      });
    });
  }
  async send(paneId: string, payload: { text: string; keys: string[] }, signal: AbortSignal, hooks: SendHooks) {
    this.requirePane(paneId);
    const response = await this.request('pane.send_input', { pane_id: paneId, ...payload }, signal, hooks);
    if (!z.object({ type: z.literal('ok') }).safeParse(response).success) throw new BrokerError('herdr_invalid_response');
  }
  async processInfo(paneId: string, signal?: AbortSignal) {
    this.requirePane(paneId);
    const parsed = z.object({ type: z.literal('pane_process_info'), process_info: processSchema }).safeParse(await this.request('pane.process_info', { pane_id: paneId }, signal));
    if (!parsed.success) throw new BrokerError('herdr_invalid_response');
    if (parsed.data.process_info.pane_id !== paneId) throw new BrokerError('target_changed');
    return parsed.data.process_info;
  }
  async capture(pane: Pane, signal?: AbortSignal, source: 'recent' | 'recent_unwrapped' = 'recent') {
    this.requireTarget(pane);
    const parsed = z.object({ type: z.literal('pane_read'), read: z.object({
      pane_id: id, workspace_id: id, tab_id: id, text: z.string().refine(text => text.isWellFormed()),
      source: z.literal(source), format: z.literal('ansi'), truncated: z.boolean(), revision: z.number().int().nonnegative(),
    }) }).safeParse(await this.request('pane.read', { pane_id: pane.pane_id, source, lines: 1000, format: 'ansi', strip_ansi: false }, signal));
    if (!parsed.success) throw new BrokerError('herdr_invalid_response');
    const read = parsed.data.read;
    if (read.pane_id !== pane.pane_id || read.workspace_id !== pane.workspace_id || read.tab_id !== pane.tab_id) throw new BrokerError('target_changed');
    return read;
  }
  async check(signal?: AbortSignal) {
    const result = await this.request('ping', {}, signal);
    if (!z.object({ type: z.literal('pong'), version: z.literal('0.9.0'), protocol: z.literal(22) }).safeParse(result).success) {
      this.generation++;
      throw new BrokerError('herdr_unsupported');
    }
  }
  async describe(paneId: string, signal?: AbortSignal): Promise<Pane> {
    this.requirePane(paneId);
    await this.check(signal);
    const result = z.object({ type: z.literal('pane_info'), pane: paneSchema }).safeParse(await this.request('pane.get', { pane_id: paneId }, signal));
    if (!result.success) throw new BrokerError('herdr_invalid_response');
    if (result.data.pane.pane_id !== paneId) throw new BrokerError('target_changed');
    this.requireTarget(result.data.pane);
    return result.data.pane;
  }
  async splitPane(source: Pane, cwd: string, direction: 'right' | 'down', ratio = 0.5) {
    const result = z.object({ pane: paneSchema }).safeParse(await this.request('pane.split', { workspace_id: source.workspace_id, target_pane_id: source.pane_id, direction, ratio, cwd, focus: false }));
    if (!result.success || result.data.pane.workspace_id !== source.workspace_id || result.data.pane.tab_id !== source.tab_id) throw new BrokerError('herdr_invalid_response');
    return result.data.pane;
  }
  async list(workspaceId: string) {
    await this.check();
    const result = z.object({ type: z.literal('pane_list'), panes: z.array(paneSchema).max(4096) }).safeParse(await this.request('pane.list', { workspace_id: workspaceId }));
    if (!result.success || result.data.panes.some(pane => pane.workspace_id !== workspaceId)) throw new BrokerError('herdr_invalid_response');
    return result.data.panes;
  }
  async renamePane(paneId: string, label: string) { await this.request('pane.rename', { pane_id: paneId, label }); }
  async closePane(paneId: string) { await this.request('pane.close', { pane_id: paneId }); }
  async notify(title: string, body: string) { await this.request('notification.show', { title, body, sound: 'none' }); }
}
