import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, pane } from './harness.mjs';
import { risk, processInfo } from './action-harness.mjs';
import { workerFixture } from './worker-harness.mjs';

const target = { pane_id: pane.pane_id, terminal_id: pane.terminal_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id };
const input = job_id => ({ job_id, target, objective: 'shared work', operation: 'input', text: 'pwd', keys: ['Enter'], risk });
async function start(client) {
  const job = await client.call('job_start', { pane_id: pane.pane_id, objective: 'shared work', analysis: 'direct', action_scope: { profile: 'terminal' } });
  assert.ok(job.job_id, JSON.stringify(job));
  const ready = await client.call('job_wait', { job_id: job.job_id, wait_ms: 1000 });
  assert.equal(ready.result?.kind, 'prepared_context', JSON.stringify(ready));
  return ready;
}
for (const name of ['ssh', 'python', 'vim']) test(`Raw pane input in ${name} needs no shell readiness or cwd`, async t => {
  const h = await harness(t, { respond(socket, request, response) {
    if (request.method === 'pane.process_info') response.result.process_info = { ...processInfo, foreground_process_group_id: 2000, foreground_processes: [{ pid: 2000, name, argv0: name }] };
    if (request.method === 'pane.send_input') response.result = { type: 'ok' };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect();
  const described = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.ok(described.supported_profiles.includes('terminal'));
  assert.equal(described.action_supported, true);
  assert.equal(described.shell_action_supported, false);
  const job = await start(client);
  const proposal = await client.call('action_propose', { ...input(job.job_id), text: '한글\n내용', keys: [] });
  assert.equal(proposal.authorization, 'parent_risk_review', JSON.stringify(proposal));
  assert.deepEqual(proposal.payload, { text: '한글\n내용', keys: [] });
  const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(receipt.submission_state, 'accepted');
  assert.equal(receipt.observation_state, 'not_applicable');
  assert.equal(receipt.exit_code, null);
  assert.equal(h.core.summary().held_terminal_count, 0);
  assert.deepEqual(h.calls.filter(call => call.method === 'pane.send_input').map(call => call.params), [{ pane_id: pane.pane_id, text: '한글\n내용', keys: [] }]);
  await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  h.state.text = 'new screen after input';
  const next = await client.call('job_wait', { job_id: job.job_id, cursor: job.cursor, wait_ms: 1000 });
  assert.match(next.result.text, /new screen/);
});

test('Default observations use luna high even for short text; user-requested direct reads bypass Worker', async t => {
  const worker = await workerFixture(t);
  const h = await harness(t, { text: 'short output', core: { worker: { executable: worker.executable } } });
  const client = await h.connect();
  const job = await client.call('job_start', { pane_id: pane.pane_id, objective: 'summarize' });
  const ready = await client.call('job_wait', { job_id: job.job_id, wait_ms: 2000 });
  assert.equal(ready.result.kind, 'worker_report');
  const [call] = await worker.calls();
  assert.ok(call.args.includes('gpt-5.6-luna'));
  assert.ok(call.args.includes('model_reasoning_effort="high"'));
  assert.match(call.request.instructions, /Do not use tools, read files, execute commands/);
  h.state.text = '긴 원문 '.repeat(1500);
  const direct = await start(client);
  assert.ok(Buffer.byteLength(direct.result.text) <= 4096);
  assert.equal(direct.result.truncated, true);
  assert.equal((await worker.calls()).length, 1);
});

async function inputHarness(t, options = {}) {
  return harness(t, { ...options, respond(socket, request, response) {
    if (request.method === 'pane.send_input') response.result = { type: 'ok' };
    if (options.respond) options.respond(socket, request, response);
    else socket.write(JSON.stringify(response) + '\n');
  } });
}

test('Input uses current Mode and exact interactive approval; stale reviews cannot authorize changed input', async t => {
  const { consoleProcess } = await import('./console-harness.mjs');
  const { connect } = await import('./harness.mjs');
  const h = await inputHarness(t), terminal = await consoleProcess(t, h), client = await connect(terminal.ready.socket, t);
  let job = await start(client);
  await terminal.command(`mode ${job.pane_session_id} 1`);
  const first = await client.call('action_propose', { ...input(job.job_id), text: '', keys: ['Escape'] });
  assert.equal(first.authorization, 'approval_required');
  assert.equal((await client.call('action_submit', { proposal_id: first.proposal_id })).error, 'policy_requires_approval');
  assert.equal((await terminal.command(`approve ${first.proposal_id}`)).error, 'review_required');
  const review = await terminal.command(`review ${first.proposal_id}`);
  assert.deepEqual(review.payload, { text: '', keys: ['Escape'] });
  await terminal.command(`approve ${first.proposal_id}`);
  const changed = await client.call('action_propose', input(job.job_id));
  assert.notEqual(changed.payload_digest, first.payload_digest);
  assert.equal(changed.authorization, 'approval_required');
  assert.equal((await client.call('action_submit', { proposal_id: first.proposal_id })).authorization, 'user_approval');
  await terminal.command(`mode ${job.pane_session_id} 2`);
  assert.equal((await client.call('action_submit', { proposal_id: changed.proposal_id })).error, 'mode_changed');
  await client.call('job_cancel', { job_id: job.job_id });
  job = await start(client);
  assert.equal((await client.call('session_lower_mode', { job_id: job.job_id, mode: 3 })).error, 'mode_upgrade_requires_user');
  const high = await client.call('action_propose', { ...input(job.job_id), risk: { ...risk, classification: 'high' } });
  assert.equal(high.authorization, 'approval_required');
  await terminal.command(`mode ${job.pane_session_id} 3`);
  const autonomous = await client.call('action_propose', { ...input(job.job_id), risk: { ...risk, classification: 'unknown' } });
  assert.equal((await client.call('action_submit', { proposal_id: autonomous.proposal_id })).authorization, 'autonomous');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 2);
});

test('Exact identity and strict input fields reject stale or altered targets before sending', async t => {
  const h = await inputHarness(t), client = await h.connect(), job = await start(client);
  for (const changes of [{ text: '', keys: [] }, { text: '\0' }, { cwd: '/invented' }, { approved: true }]) {
    assert.equal((await client.call('action_propose', { ...input(job.job_id), ...changes })).error, 'invalid_tool_arguments');
  }
  const proposal = await client.call('action_propose', input(job.job_id));
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.get') response.result.pane = { ...pane, terminal_id: 'replacement' };
    socket.write(JSON.stringify(response) + '\n');
  };
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'target_changed');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Input shares the ordinary three-attempt budget and accepts exact keys without injected Enter', async t => {
  const h = await inputHarness(t), client = await h.connect(), job = await start(client);
  for (let i = 0; i < 4; i++) {
    const proposal = await client.call('action_propose', { ...input(job.job_id), text: '', keys: ['Ctrl+c'] });
    const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    if (i < 3) assert.equal(receipt.submission_state, 'accepted', JSON.stringify(receipt));
    else assert.equal(receipt.error, 'action_budget_exhausted');
  }
  const sent = h.calls.filter(call => call.method === 'pane.send_input');
  assert.equal(sent.length, 3);
  assert.ok(sent.every(call => call.params.text === '' && JSON.stringify(call.params.keys) === '["Ctrl+c"]'));
});

test('Unknown input is held across restart without replay or a generic-input bypass', async t => {
  const { join } = await import('node:path');
  const { startCore } = await import('../dist/core.js');
  const h = await inputHarness(t, { core: { observationMs: 60 }, respond(socket, request, response) {
    if (request.method !== 'pane.send_input') socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect(), job = await start(client);
  const proposal = await client.call('action_propose', input(job.job_id));
  const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(receipt.submission_state, 'unknown');
  assert.equal(h.core.summary().held_terminal_count, 1);
  const next = await client.call('action_propose', input(job.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: next.proposal_id })).error, 'terminal_held');
  await h.core.close();
  const restarted = await startCore({ endpoint: h.endpoint, stateRoot: join(h.root, 'state') });
  try {
    const summary = restarted.summary();
    assert.equal(summary.held_terminal_count, 1);
    assert.equal(summary.receipts[0].proposal_id, proposal.proposal_id);
    assert.equal(summary.receipts[0].hold_reason, 'core_restart');
    assert.equal(summary.receipts[0].exit_code, null);
  } finally { await restarted.close(); }
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Input cannot pass a held POSIX execution', async t => {
  const { scope, action } = await import('./action-harness.mjs');
  const h = await inputHarness(t, { core: { observationMs: 70 } }), client = await h.connect();
  const initial = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'direct', action_scope: scope });
  await client.call('job_wait', { job_id: initial.job_id, wait_ms: 1000 });
  const execute = await client.call('action_propose', action(initial.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: execute.proposal_id })).submission_state, 'accepted');
  const job = await start(client), proposal = await client.call('action_propose', input(job.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'terminal_held');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Interactive input recovery verifies the pane without requiring a ready shell', async t => {
  const { consoleProcess } = await import('./console-harness.mjs');
  const { connect } = await import('./harness.mjs');
  const h = await inputHarness(t, { respond(socket, request, response) {
    if (request.method === 'pane.process_info') response.result.process_info = { ...processInfo, foreground_process_group_id: 2000, foreground_processes: [{ pid: 2000, name: 'python' }] };
    if (request.method !== 'pane.send_input') socket.write(JSON.stringify(response) + '\n');
  } });
  const terminal = await consoleProcess(t, h, { observationMs: 60 }), client = await connect(terminal.ready.socket, t);
  const job = await start(client), proposal = await client.call('action_propose', input(job.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'unknown');
  assert.equal((await terminal.command(`inspect ${pane.pane_id}`)).shell_ready, false);
  const recovered = await terminal.command(`recover ${proposal.proposal_id} continue shared work`);
  assert.equal(recovered.recovery, 'user_verified_input_target', JSON.stringify(recovered));
  assert.equal(recovered.exit_code, null);
  assert.equal((await terminal.command('status')).held_terminal_count, 0);
});

test('A late input ACK resolves only delivery, with no completion claim or replay', async t => {
  let timer;
  t.after(() => clearTimeout(timer));
  const h = await inputHarness(t, { core: { observationMs: 6500 }, respond(socket, request, response) {
    if (request.method === 'pane.send_input') timer = setTimeout(() => socket.write(JSON.stringify(response) + '\n'), 5200);
    else socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect(), job = await start(client), proposal = await client.call('action_propose', input(job.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'unknown');
  assert.equal(h.core.summary().held_terminal_count, 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  const final = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(final.submission_state, 'accepted');
  assert.equal(final.observation_state, 'not_applicable');
  assert.equal(final.exit_code, null);
  assert.equal(h.core.summary().held_terminal_count, 0);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});
