import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { run, scratch, save } from './probe.mjs';

const binary = '/Users/dwchoo/.local/bin/herdr';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const observations = []; let workspace, pane, socketPath;
async function cli(args) { const r = await run(binary, args); return JSON.parse(r.stdout); }
function request(method, params, id, { dropAck = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('response timeout; submission may be unknown')); }, 5000);
    socket.on('error', e => { clearTimeout(timer); reject(e); });
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', b => {
      text += b;
      if (Buffer.byteLength(text) > 2_000_000) { socket.destroy(); clearTimeout(timer); reject(new Error('response bound')); return; }
      if (!text.includes('\n')) return;
      clearTimeout(timer); socket.end();
      const response = JSON.parse(text.slice(0, text.indexOf('\n')));
      if (response.id !== id) { reject(new Error('response ID mismatch')); return; }
      resolve(dropAck ? { injected: 'discarded live ACK', submission_state: 'unknown' } : response);
    });
  });
}
const read = () => request('pane.read', { pane_id: pane, source: 'recent', lines: 1000, format: 'ansi', strip_ansi: false }, 'probe-read');
const send = (text, id, options) => request('pane.send_input', { pane_id: pane, text, keys: ['Enter'] }, id, options);
const plain = response => stripVTControlCharacters(response.result.read.text).replaceAll('\r', '');
try {
  const status = await cli(['status', 'server', '--json']); socketPath = status.socket;
  const created = await cli(['workspace', 'create', '--cwd', scratch, '--label', 'herdr-socket-probe', '--no-focus']);
  workspace = created.result.workspace.workspace_id; pane = created.result.root_pane.pane_id;
  await pause(600);
  const before = (await read()).result.read;
  observations.push({ name: 'read-metadata', keys: Object.keys(before), revision: before.revision, format: before.format, source: before.source });
  const ack = await send('sleep 1; printf "\\nSOCKET_PROBE_DONE\\n"', 'probe-delayed');
  const immediate = plain(await read()).split('\n').some(x => x.trim() === 'SOCKET_PROBE_DONE');
  await pause(1100);
  observations.push({ name: 'matching-ack-before-completion', ack, immediateStandaloneMarker: immediate, laterStandaloneMarker: plain(await read()).split('\n').some(x => x.trim() === 'SOCKET_PROBE_DONE') });
  const dupCommand = 'printf "attempt\\n" >> duplicate-count.txt';
  const duplicateA = await send(dupCommand, 'same-request-id');
  const duplicateB = await send(dupCommand, 'same-request-id');
  await pause(300);
  observations.push({ name: 'herdr-id-is-not-idempotency', responses: [duplicateA, duplicateB], executionCount: (await readFile(join(scratch, 'duplicate-count.txt'), 'utf8')).trim().split('\n').length });
  const dropped = await send('printf "once\\n" >> dropped-ack-count.txt', 'dropped-ack', { dropAck: true });
  await pause(200);
  observations.push({ name: 'injected-ack-loss-after-live-send', receipt: dropped, executionCount: (await readFile(join(scratch, 'dropped-ack-count.txt'), 'utf8')).trim().split('\n').length, autoResends: 0 });
  await send('sleep 1; printf "long done\\n" >> external-input.txt', 'one-job');
  const external = await send('printf "external accepted\\n" >> external-input.txt', 'outside-broker');
  await pause(1300);
  observations.push({ name: 'no-global-input-lock', secondInputAck: external, output: await readFile(join(scratch, 'external-input.txt'), 'utf8') });
  const largeAck = await send("awk 'BEGIN {for(i=1;i<=1300;i++) print \"raw socket fixture\",i}'", 'large-output');
  await pause(300);
  const tail = (await read()).result.read;
  observations.push({ name: 'read-row-limit', ack: largeAck, revision: tail.revision, format: tail.format, lineCount: tail.line_count ?? null, returnedLines: plain({ result: { read: tail } }).split('\n').length });
  const invalid = await request('pane.send_input', { pane_id: pane, text: 'never enqueue this', keys: ['HERDR_INVALID_KEY'] }, 'invalid-key');
  observations.push({ name: 'pre-enqueue-rejection', response: invalid });
} catch (error) { observations.push({ name: 'probe-error', error: error.message }); process.exitCode = 1; }
finally {
  if (workspace) observations.push({ name: 'cleanup-owned-workspace', response: await cli(['workspace', 'close', workspace]) });
  await save('herdr-socket', { at: new Date().toISOString(), observations });
  console.log(JSON.stringify(observations));
}
