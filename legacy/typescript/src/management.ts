import { createConnection, createServer, type Socket } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { isatty } from 'node:tty';
import { z } from 'zod';
import { Consoles, type ConsoleRecord } from './consoles.js';
import { ConsoleCommands, encodeConsole, type ConsoleCore } from './console-commands.js';
import { startDashboard } from './console-ui.js';
import { BrokerError, Herdr } from './herdr.js';
import type { ConsoleSnapshot } from './console-view.js';

const authSchema = z.strictObject({ token: z.string().length(64), pane_id: z.string(), terminal_id: z.string(), interactive: z.boolean() });
const requestSchema = z.strictObject({ id: z.number().int(), method: z.enum(['snapshot', 'refresh', 'command']), command: z.string().max(1024).optional() });
const limit = 4 * 1024 * 1024;
const errorCode = (error: unknown) => error instanceof BrokerError ? error.code : 'management_failed';

export async function startManagementServer(consoles: Consoles, record: ConsoleRecord, core: ConsoleCore, refresh: () => Promise<void>) {
  const path = consoles.controlSocket(record);
  consoles.registry.managerClient(record.console_id, null);
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const sockets = new Set<Socket>();
  let closing = false, active: Socket | undefined;
  let retiring = Promise.resolve();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.setEncoding('utf8');
    let commands: ConsoleCommands | undefined, manager: ConsoleRecord | undefined, auth: z.infer<typeof authSchema> | undefined;
    let buffer = '', pending = Promise.resolve();
    const timeout = setTimeout(() => socket.destroy(), 5000);
    const verify = async () => {
      if (!auth) throw new BrokerError('management_unauthorized');
      const current = await consoles.get(record.console_id);
      const token = consoles.registry.managerToken(record.console_id);
      if (!token || !timingSafeEqual(Buffer.from(token), Buffer.from(auth.token)) || !current.controller || current.controller.pane_id !== auth.pane_id || current.controller.terminal_id !== auth.terminal_id) throw new BrokerError('management_unauthorized');
      const pane = await new Herdr(consoles.config.endpoint, () => {}).describe(auth.pane_id);
      if (pane.terminal_id !== auth.terminal_id || pane.tab_id !== record.tab_id || pane.workspace_id !== record.workspace_id) throw new BrokerError('management_identity_changed');
      return current;
    };
    const handle = async (line: string) => {
      let id: number | null = null;
      try {
        const value: unknown = JSON.parse(line);
        if (!commands) {
          await retiring;
          auth = authSchema.parse(value); const verified = await verify();
          if (active && !active.destroyed) throw new BrokerError('management_already_connected');
          active = socket; manager = verified;
          consoles.registry.managerClient(record.console_id, auth.terminal_id);
          commands = new ConsoleCommands(core, auth.interactive, async () => {});
          clearTimeout(timeout); socket.write(JSON.stringify({ ready: true, commands: commands.commands }) + '\n'); return;
        }
        const request = requestSchema.parse(value); id = request.id;
        await verify(); await refresh();
        let response: unknown;
        if (request.method === 'command') response = await commands.run(request.command ?? '');
        else {
          if (!core.consoleView) throw new BrokerError('view_unavailable');
          if (request.method === 'refresh') await core.consoleView.refresh();
          response = core.consoleView.snapshot();
        }
        const encoded = JSON.stringify({ id, value: response });
        if (Buffer.byteLength(encoded) > limit) throw new BrokerError('management_response_too_large');
        if (!socket.destroyed) socket.write(encoded + '\n');
      } catch (error) {
        socket.write(JSON.stringify({ id, error: errorCode(error) }) + '\n');
        if (!commands) socket.end();
      }
    };
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        pending = pending.then(() => handle(line)).catch(() => { socket.destroy(); });
      }
    });
    socket.once('close', () => {
      clearTimeout(timeout); commands?.stop(); sockets.delete(socket);
      if (active === socket) { active = undefined; consoles.registry.managerClient(record.console_id, null); }
      if (manager && !closing) retiring = pending.then(() => consoles.closeManager(manager!)).catch(() => {});
    });
  });
  server.listen(path); await once(server, 'listening'); await chmod(path, 0o600);
  return async () => { closing = true; for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await unlink(path).catch(() => {}); };
}

export async function connectManagement(consoles: Consoles, record: ConsoleRecord, auth: z.infer<typeof authSchema>) {
  const socket = createConnection(consoles.controlSocket(record)); socket.setEncoding('utf8'); socket.on('error', () => {});
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let sequence = 0, buffer = '';
  let readyResolve: () => void, readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => socket.destroy(new BrokerError('management_timeout')), 5000);
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > limit) { socket.destroy(new BrokerError('management_response_too_large')); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
      try {
        const value = JSON.parse(line);
        if (value.ready === true) { clearTimeout(timer); readyResolve(); continue; }
        if (value.id === null && value.error) { readyReject(new BrokerError(value.error)); continue; }
        const pending = waiting.get(value.id); if (!pending) continue;
        waiting.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(new BrokerError(value.error)); else pending.resolve(value.value);
      } catch { socket.destroy(new BrokerError('management_invalid_response')); }
    }
  });
  socket.once('close', () => {
    clearTimeout(timer); readyReject(new BrokerError('management_disconnected'));
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new BrokerError('management_disconnected')); }
    waiting.clear();
  });
  socket.once('connect', () => socket.write(JSON.stringify(auth) + '\n'));
  await ready;
  return { socket, close: () => socket.destroy(), request(method: 'snapshot' | 'refresh' | 'command', command?: string) {
    return new Promise<unknown>((resolve,reject) => {
      if (socket.destroyed) { reject(new BrokerError('management_disconnected')); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new BrokerError('management_timeout')); }, 15000);
      waiting.set(id, { resolve, reject, timer }); socket.write(JSON.stringify({ id, method, ...(command !== undefined && { command }) }) + '\n');
    });
  } };
}

export async function runManagement(consoles: Consoles, record: ConsoleRecord, format?: 'json') {
  const interactive = isatty(0) && isatty(1);
  const pane = await consoles.parent();
  if (!record.controller || record.controller.pane_id !== pane.pane_id || record.controller.terminal_id !== pane.terminal_id) throw new BrokerError('console_controller_required');
  const token = consoles.registry.managerToken(record.console_id);
  if (!token) throw new BrokerError('management_unauthorized');
  const rpc = await connectManagement(consoles, record, { token, pane_id: pane.pane_id, terminal_id: pane.terminal_id, interactive });
  let snapshot = await rpc.request('refresh') as ConsoleSnapshot;
  let closed = false, cleanup = () => {}, poll: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return; closed = true; clearInterval(poll); cleanup(); process.stdin.destroy(); rpc.close();
  };
  rpc.socket.once('close', close);
  const commands = { async run(command: string) { const value = await rpc.request('command', command); if (command === 'quit' || command === 'stop') close(); return value; } };
  if (interactive && format !== 'json' && process.env.TERM !== 'dumb') {
    const view = { snapshot: () => snapshot, async refresh() { snapshot = await rpc.request('refresh') as ConsoleSnapshot; } };
    cleanup = startDashboard(view, commands, async () => close());
    let pending = false;
    poll = setInterval(() => { if (!pending && !closed) { pending = true; void rpc.request('snapshot').then(value => { snapshot = value as ConsoleSnapshot; }).catch(close).finally(() => { pending = false; }); } }, 1000);
  } else {
    process.stdout.write(encodeConsole({ status: 'ready', console: snapshot }) + '\n');
    let buffer = '', pending = Promise.resolve(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk; if (buffer.length > 1024) { buffer = ''; process.stdout.write('{"error":"console_input_too_large"}\n'); return; }
      let end; while ((end = buffer.indexOf('\n')) >= 0) { const command = buffer.slice(0,end); buffer = buffer.slice(end+1); pending = pending.then(async () => { const value = await commands.run(command); if (!closed) process.stdout.write(encodeConsole(value) + '\n'); }).catch(() => close()); }
    });
    process.stdin.once('end', () => void pending.then(close));
  }
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return close;
}
