import test from 'node:test';
import assert from 'node:assert/strict';
import { action, scope, processInfo, job } from './action-harness.mjs';
import { executingHarness } from './execution-harness.mjs';
import { consoleProcess } from './console-harness.mjs';
import { connect, pane } from './harness.mjs';
import { createServer, createConnection } from 'node:net';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

test('A changed SSH connection creates mode 2 and cannot resume the old job or proposal', async t => {
  let context = { ...processInfo, foreground_process_group_id: 1100, foreground_processes: [{ pid: 1100, name: 'ssh', argv0: '/usr/bin/ssh', argv: ['ssh', '-tt', 'fixture-a', '/bin/sh', '-i'] }] };
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.process_info') response.result.process_info = context;
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t);
  const first = await job(client);
  await console.command(`mode ${first.pane_session_id} 3`);
  context = { ...context, foreground_processes: [{ ...context.foreground_processes[0], argv: ['ssh', '-tt', 'fixture-b', '/bin/sh', '-i'] }] };
  const replaced = await client.call('job_wait', { job_id: first.job_id, cursor: first.cursor, wait_ms: 1000 });
  assert.equal(replaced.error, 'session_changed');
  assert.equal(replaced.job_ended, true);
  const second = await job(client);
  assert.equal(second.action_mode, 2);
  assert.notEqual(second.pane_session_id, first.pane_session_id);
  const description = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.equal(description.shell_action_supported, false);
  assert.equal(description.observed_connection.kind, 'ssh');
  assert.equal(description.observed_connection.remote_identity_authenticated, false);
  assert.ok(!JSON.stringify(description).includes('fixture-b'));
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

for (const mode of [1, 2, 3]) for (const change of ['shell', 'tab', 'ssh', 'connection']) test(`Mode ${mode}: ${change} change blocks stale submission and starts a fresh mode 2 session`, async t => {
  let changed = false, fail = false;
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (fail && request.method === 'ping') { fail = false; socket.end(); return; }
    if (changed && change === 'tab' && request.method === 'pane.get') response.result.pane = { ...pane, tab_id: 'tab-2' };
    if (changed && request.method === 'pane.process_info') {
      if (change === 'shell') response.result.process_info = { ...processInfo, shell_pid: 1010, foreground_process_group_id: 1010, foreground_processes: [{ pid: 1010, name: 'sh' }] };
      if (change === 'ssh') response.result.process_info = { ...processInfo, foreground_process_group_id: 1100, foreground_processes: [{ pid: 1100, name: 'ssh', argv0: 'ssh', argv: ['ssh', 'synthetic-host'] }] };
    }
    if (changed && change === 'tab' && request.method === 'pane.read') response.result.read.tab_id = 'tab-2';
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), first = await job(client);
  await console.command(`mode ${first.pane_session_id} ${mode}`);
  const proposal = await client.call('action_propose', action(first.job_id));
  if (mode === 1) { await console.command(`review ${proposal.proposal_id}`); await console.command(`approve ${proposal.proposal_id}`); }
  changed = true; fail = change === 'connection';
  const blocked = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.ok(['target_changed', 'herdr_disconnected'].includes(blocked.error), JSON.stringify(blocked));
  const next = await job(client);
  assert.equal(next.action_mode, 2, JSON.stringify(next));
  assert.notEqual(next.pane_session_id, first.pane_session_id);
  const old = await client.call('action_status', { job_id: first.job_id, proposal_id: proposal.proposal_id });
  assert.equal(old.authorization, 'blocked');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Ordinary foreground commands preserve the local session; SSH entry and exit replace it', async t => {
  let foreground = processInfo;
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.process_info') response.result.process_info = foreground;
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), first = await job(client);
  await console.command(`mode ${first.pane_session_id} 3`);
  foreground = { ...processInfo, foreground_process_group_id: 1200, foreground_processes: [{ pid: 1200, name: 'make', argv: ['make', 'test'] }] };
  const busy = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.equal(busy.pane_session_id, first.pane_session_id);
  assert.equal(busy.action_mode, 3);
  assert.equal(busy.shell_action_supported, false);
  foreground = processInfo;
  assert.equal((await job(client)).pane_session_id, first.pane_session_id);
  foreground = { ...processInfo, foreground_process_group_id: 1200, foreground_processes: [{ pid: 1200, name: 'ssh', argv: ['ssh', 'fixture'] }] };
  const remote = await job(client);
  assert.equal(remote.action_mode, 2);
  assert.notEqual(remote.pane_session_id, first.pane_session_id);
  foreground = processInfo;
  const local = await job(client);
  assert.equal(local.action_mode, 2);
  assert.notEqual(local.pane_session_id, remote.pane_session_id);
});

test('Endpoint replacement invalidates continuity even if the new peer reports identical IDs and PIDs', async t => {
  const h = await executingHarness(t, { execute: false });
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), first = await job(client);
  await console.command(`mode ${first.pane_session_id} 3`);
  const proposal = await client.call('action_propose', action(first.job_id));
  const previous = join(h.root, 'previous.sock');
  await rename(h.endpoint, previous);
  const sockets = new Set();
  const replacement = createServer(socket => {
    const upstream = createConnection(previous);
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => {}); upstream.on('error', () => {});
    socket.on('close', () => { upstream.destroy(); sockets.delete(socket); });
    upstream.on('close', () => { socket.destroy(); sockets.delete(upstream); });
    socket.pipe(upstream); upstream.pipe(socket);
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => replacement.close(resolve)); });
  await new Promise(resolve => replacement.listen(h.endpoint, resolve));
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'target_changed');
  const next = await job(client);
  assert.equal(next.action_mode, 2);
  assert.notEqual(next.pane_session_id, first.pane_session_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('A post-submission session change preserves acceptance, invalidates completion, and keeps old Evidence immutable', async t => {
  let changed = false;
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.send_input') changed = true;
    if (changed && request.method === 'pane.process_info') response.result.process_info = { ...processInfo, shell_pid: 1010, foreground_process_group_id: 1010, foreground_processes: [{ pid: 1010, name: 'sh' }] };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h, { observationMs: 1000 }), client = await connect(console.ready.socket, t), first = await job(client);
  const evidenceId = first.evidence.items[0].evidence_id;
  const oldEvidence = await client.call('evidence_get', { job_id: first.job_id, evidence_id: evidenceId });
  const proposal = await client.call('action_propose', action(first.job_id));
  const nonce = proposal.payload.text.match(/[a-f0-9]{32}/)[0];
  h.state.text = `new shell\n__HERDR_END_${nonce}__:0\n`;
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'baseline_marker_conflict');
  h.state.text = 'old baseline';
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'accepted');
  h.state.text = `new shell\n__HERDR_END_${nonce}__:0\n`;
  await new Promise(resolve => setTimeout(resolve, 250));
  const receipt = await client.call('action_status', { job_id: first.job_id, proposal_id: proposal.proposal_id });
  assert.equal(receipt.submission_state, 'accepted');
  assert.equal(receipt.observation_state, 'outcome_unknown');
  assert.equal(receipt.exit_code, null);
  assert.deepEqual((await client.call('evidence_get', { job_id: first.job_id, evidence_id: evidenceId })).evidence, oldEvidence.evidence);
  assert.equal((await console.command('status')).held_terminal_count, 1);
  const next = await job(client);
  assert.equal(next.delta.kind, 'replace');
  assert.equal(next.action_mode, 2);
  const fresh = await client.call('action_propose', action(next.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: fresh.proposal_id })).error, 'terminal_held');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

for (const mode of [1, 3]) test(`A missing different pane cannot reset an unchanged session from mode ${mode}`, async t => {
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.get' && request.params.pane_id === 'missing-pane') { delete response.result; response.error = { code: 'pane_not_found' }; }
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), first = await job(client);
  await console.command(`mode ${first.pane_session_id} ${mode}`);
  assert.equal((await client.call('pane_describe', { pane_id: 'missing-pane' })).error, 'herdr_rejected');
  const next = await job(client);
  assert.equal(next.pane_session_id, first.pane_session_id);
  assert.equal(next.action_mode, mode);
});

test('The first Snapshot cannot join pre-change output to a post-change SSH session', async t => {
  let changed = false;
  const h = await executingHarness(t, { execute: false, text: 'OLD_ENDPOINT_CONTEXT', respond(socket, request, response) {
    if (request.method === 'pane.read') changed = true;
    if (changed && request.method === 'pane.process_info') response.result.process_info = { ...processInfo, foreground_process_group_id: 1200, foreground_processes: [{ pid: 1200, name: 'ssh', argv: ['ssh', 'replacement-host'] }] };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect();
  const first = await job(client);
  assert.equal(first.error, 'target_changed');
  assert.equal(first.result, undefined);
  assert.equal(first.snapshot, undefined);
  assert.ok(!JSON.stringify(client.deliveries).includes('OLD_ENDPOINT_CONTEXT'));
});

test('An SSH transport child of local git preserves its local session and mode', async t => {
  let child = false;
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (child && request.method === 'pane.process_info') response.result.process_info = { ...processInfo, foreground_process_group_id: 1200, foreground_processes: [{ pid: 1200, name: 'git', argv: ['git', 'fetch'] }, { pid: 1201, name: 'ssh', argv: ['ssh', 'git@example.invalid', 'git-upload-pack repo'] }] };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), first = await job(client);
  await console.command(`mode ${first.pane_session_id} 1`); child = true;
  const busy = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.equal(busy.pane_session_id, first.pane_session_id);
  assert.equal(busy.action_mode, 1);
  assert.equal(busy.observed_connection.kind, 'local');
  assert.equal(busy.shell_action_supported, false);
});
