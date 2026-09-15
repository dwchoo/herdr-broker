import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export class BrokerError extends Error {
  constructor(readonly code: string) { super(code); }
}
const id = z.string().min(1).max(256);
const paneSchema = z.object({
  pane_id: id, terminal_id: id, workspace_id: id, tab_id: id,
  cwd: z.string().max(4096).optional(), foreground_cwd: z.string().max(4096).optional(),
  agent_status: z.string().max(64),
});
export type Pane = z.infer<typeof paneSchema>;

export class Herdr {
  constructor(private readonly endpoint: string, private readonly verifyAuthority: () => void) {}
  private request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      try { this.verifyAuthority(); } catch (error) { reject(error); return; }
      const requestId = randomUUID();
      const socket = createConnection(this.endpoint);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: BrokerError, result?: unknown) => {
        if (settled) return;
        settled = true;
        buffer = Buffer.alloc(0);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(new BrokerError('cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      socket.setTimeout(5000, () => finish(new BrokerError('herdr_timeout')));
      socket.on('error', () => finish(new BrokerError('herdr_unavailable')));
      socket.on('end', () => finish(new BrokerError('herdr_disconnected')));
      socket.on('connect', () => {
        try { this.verifyAuthority(); socket.write(JSON.stringify({ id: requestId, method, params }) + '\n'); }
        catch { finish(new BrokerError('authority_lost')); }
      });
      socket.on('data', chunk => {
        if (buffer.length + chunk.length > 1024 * 1024) { finish(new BrokerError('herdr_response_too_large')); return; }
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end < 0) return;
        try {
          const response = z.object({ id: z.literal(requestId), result: z.unknown().optional(), error: z.object({ code: z.string() }).optional() })
            .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))));
          if (response.error) throw new BrokerError('herdr_rejected');
          if (!response.result) throw new BrokerError('herdr_invalid_response');
          this.verifyAuthority();
          finish(undefined, response.result);
        } catch (error) { finish(error instanceof BrokerError ? error : new BrokerError('herdr_invalid_response')); }
      });
    });
  }
  async capture(pane: Pane, signal?: AbortSignal) {
    const parsed = z.object({ type: z.literal('pane_read'), read: z.object({
      pane_id: id, workspace_id: id, tab_id: id, text: z.string().refine(text => text.isWellFormed()),
      source: z.literal('recent'), format: z.literal('ansi'), truncated: z.boolean(), revision: z.number().int().nonnegative(),
    }) }).safeParse(await this.request('pane.read', { pane_id: pane.pane_id, source: 'recent', lines: 1000, format: 'ansi', strip_ansi: false }, signal));
    if (!parsed.success) throw new BrokerError('herdr_invalid_response');
    const read = parsed.data.read;
    if (read.pane_id !== pane.pane_id || read.workspace_id !== pane.workspace_id || read.tab_id !== pane.tab_id) throw new BrokerError('target_changed');
    return read;
  }
  async check(signal?: AbortSignal) {
    const result = await this.request('ping', {}, signal);
    if (!z.object({ type: z.literal('pong'), version: z.literal('0.9.0'), protocol: z.literal(22) }).safeParse(result).success)
      throw new BrokerError('herdr_unsupported');
  }
  async describe(paneId: string, signal?: AbortSignal): Promise<Pane> {
    await this.check(signal);
    const result = z.object({ type: z.literal('pane_info'), pane: paneSchema }).safeParse(await this.request('pane.get', { pane_id: paneId }, signal));
    if (!result.success) throw new BrokerError('herdr_invalid_response');
    if (result.data.pane.pane_id !== paneId) throw new BrokerError('target_changed');
    return result.data.pane;
  }
}
