import { createServer, createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

export const pane = { pane_id: 'ws:pane', terminal_id: 'terminal-1', workspace_id: 'ws', tab_id: 'tab-1', cwd: '/fixture', agent_status: 'unknown', revision: 0, focused: false };

export async function harness(t, options = {}) {
  const root = await mkdtemp('/private/tmp/hb-test-');
  const endpoint = join(root, 'herdr.sock');
  const calls = [];
  const sockets = new Set();
  const state = { text: 'build failed: missing module\nunknown detail\nbuild passed', ...options };
  const peer = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        calls.push(request);
        const result = request.method === 'ping' ? { type: 'pong', version: '0.9.0', protocol: 22 }
          : request.method === 'pane.get' ? { type: 'pane_info', pane }
          : request.method === 'pane.process_info' ? { type: 'pane_process_info', process_info: { pane_id: pane.pane_id, shell_pid: 1000, foreground_process_group_id: 1000, foreground_processes: [{ pid: 1000, name: 'sh', argv0: 'sh' }] } }
          : { type: 'pane_read', read: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id, text: state.text, source: request.params.source, format: 'ansi', truncated: false, revision: 0 } };
        const reply = { id: request.id, result };
        if (state.respond) state.respond(socket, request, reply);
        else socket.write(JSON.stringify(reply) + '\n');
      }
    });
  });
  let core;
  t.after(async () => {
    await state.beforeClose?.();
    await core?.close();
    for (const socket of sockets) socket.destroy();
    if (peer.listening) await new Promise(resolve => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  peer.listen(endpoint);
  await once(peer, 'listening');
  const { startCore } = await import('../dist/core.js');
  core = await startCore({ endpoint, stateRoot: join(root, 'state'), worker: { executable: join(root, 'unavailable-worker') }, ...options.core });
  return { root, endpoint, core, calls, state, connect: () => connect(core.socketPath, t) };
}

export async function connect(socketPath, t) {
  const socket = createConnection(socketPath);
  socket.on('error', () => {});
  await once(socket, 'connect');
  const pending = new Map();
  const deliveries = [];
  let buffer = '';
  let sequence = 0;
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  t?.after(() => socket.destroy());
  const request = (method, params) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const hello = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'acceptance-peer', version: '1' } });
  socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    hello, request, deliveries, close: () => socket.destroy(),
    async call(name, args) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.error) return { protocol_error: response.error };
      const text = response.result.content?.[0]?.text;
      if (text) deliveries.push(text);
      if (!text) return { payload_omitted: true };
      try { return JSON.parse(text); } catch { return { tool_error: text }; }
    },
  };
}
