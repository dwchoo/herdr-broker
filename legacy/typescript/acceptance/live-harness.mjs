import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startCore } from '../dist/core.js';
export const exec = promisify(execFile);
export async function liveHarness(t) {
  const root = await mkdtemp('/private/tmp/hb-live-local-');
  let core, workspace;
  const peerSockets = new Set(), calls = [], captures = [];
  const endpoint = join(root, 'herdr.sock');
  const state = { connected: true, transform: null, input: null };
  const proxy = createServer(socket => {
    if (!state.connected) { socket.destroy(); return; }
    const upstream = createConnection('/Users/dwchoo/.config/herdr/herdr.sock');
    peerSockets.add(socket); peerSockets.add(upstream);
    let buffer = '';
    let received = '';
    upstream.on('data', chunk => {
      received += chunk;
      let end;
      while ((end = received.indexOf('\n')) >= 0) {
        const response = JSON.parse(received.slice(0, end)); received = received.slice(end + 1);
        if (response.result?.type === 'pane_read') captures.push(response.result.read.text);
        const forwarded = state.transform ? state.transform(response) : response;
        if (forwarded !== null) socket.write(JSON.stringify(forwarded) + '\n');
      }
    });
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); calls.push(request);
        const forwarded = state.input ? state.input(request) : request;
        if (forwarded !== null) upstream.write(JSON.stringify(forwarded) + '\n');
      }
    });
    for (const connection of [socket, upstream]) connection.on('error', () => {});
    socket.on('close', () => { upstream.destroy(); peerSockets.delete(socket); });
    upstream.on('close', () => { socket.destroy(); peerSockets.delete(upstream); });

  });
  t.after(async () => {
    await core?.close();
    for (const socket of peerSockets) socket.destroy();
    if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
    if (workspace) await exec('herdr', ['workspace', 'close', workspace]);
    await rm(root, { recursive: true, force: true });
  });
  const created = JSON.parse((await exec('herdr', ['workspace', 'create', '--cwd', root, '--label', 'broker-local-acceptance', '--env', `ZDOTDIR=${root}`, '--env', 'HISTFILE=/dev/null', '--no-focus'])).stdout).result;
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane;
  await new Promise(resolve => proxy.listen(endpoint, resolve));
  core = await startCore({ endpoint, stateRoot: join(root, 'state') });
  return { root, endpoint, core, pane, workspace, calls, captures, state };
}
