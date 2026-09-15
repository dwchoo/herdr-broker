import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, pane, connect } from './harness.mjs';
import { consoleProcess } from './console-harness.mjs';
import { action, scope, processInfo } from './action-harness.mjs';

async function ssh(t, { enabled = true, tty = true } = {}) {
  const state = { pid: 2000, destination: 'fixture@localhost' };
  const h = await harness(t, { core: { sshEnabled: enabled }, respond(socket, request, response) {
    if (request.method === 'pane.process_info') response.result.process_info = { ...processInfo, foreground_process_group_id: state.pid, foreground_processes: [{ pid: state.pid, name: 'ssh', argv0: 'ssh', argv: ['ssh', state.destination] }] };
    if (request.method === 'pane.send_input') response.result = { type: 'pane_input_sent' };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const terminal = await consoleProcess(t, h, { tty, sshEnabled: enabled });
  const client = await connect(terminal.ready.socket, t);
  return { h, state, terminal, client };
}

test('An unconfirmed SSH shell remains passive; current interactive confirmation binds profile and cwd', async t => {
  const { h, terminal, client } = await ssh(t);
  const before = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.deepEqual(before.supported_profiles, ['passive']);
  const scopeSSH = { ...scope, profile: 'ssh_posix' };
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: scopeSSH });
  await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  assert.equal((await client.call('action_propose', action(start.job_id))).error, 'shell_not_ready');
  assert.equal((await terminal.command(`ssh-ready ${before.pane_session_id} /fixture`)).error, 'inspect_required');
  await terminal.command(`inspect ${pane.pane_id}`);
  assert.equal((await terminal.command(`ssh-ready ${before.pane_session_id} /fixture`)).shell_ready, true);
  const after = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.deepEqual(after.supported_profiles, ['passive', 'ssh_posix']);
  assert.equal(after.observed_connection.remote_identity_authenticated, false);
  const proposed = await client.call('action_propose', action(start.job_id));
  assert.ok(proposed.proposal_id, JSON.stringify(proposed));
  const local = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope });
  await client.call('job_wait', { job_id: local.job_id, wait_ms: 1000 });
  assert.equal((await client.call('action_propose', action(local.job_id))).error, 'profile_mismatch');
  const wrong = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scopeSSH, cwd: '/fixture/other' } });
  await client.call('job_wait', { job_id: wrong.job_id, wait_ms: 1000 });
  assert.equal((await client.call('action_propose', { ...action(wrong.job_id), cwd: '/fixture/other' })).error, 'ssh_scope_mismatch');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('SSH reconnect invalidates inspected readiness, approvals and inherited mode', async t => {
  const { h, state, terminal, client } = await ssh(t);
  const before = await terminal.command(`inspect ${pane.pane_id}`);
  await terminal.command(`ssh-ready ${before.pane_session_id} /fixture`);
  await terminal.command(`mode ${before.pane_session_id} 3`);
  await terminal.command(`inspect ${pane.pane_id}`);
  state.pid++;
  assert.equal((await terminal.command(`ssh-ready ${before.pane_session_id} /fixture`)).error, 'target_changed');
  const after = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.equal(after.action_mode, 2);
  assert.deepEqual(after.supported_profiles, ['passive']);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

for (const variant of [{ enabled: false, tty: true, expected: 'ssh_profile_disabled' }, { enabled: true, tty: false, expected: 'interactive_console_required' }]) test(`SSH preparation gate: ${variant.expected}`, async t => {
  const { h, terminal, client } = await ssh(t, variant);
  const before = await client.call('pane_describe', { pane_id: pane.pane_id });
  await terminal.command(`inspect ${pane.pane_id}`);
  assert.equal((await terminal.command(`ssh-ready ${before.pane_session_id} /fixture`)).error, variant.expected);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});
