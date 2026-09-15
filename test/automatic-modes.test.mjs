import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pane, connect } from './harness.mjs';
import { action, scope, risk } from './action-harness.mjs';
import { executingHarness } from './execution-harness.mjs';
import { consoleProcess } from './console-harness.mjs';

async function start(client, h, trusted = true) {
  const initial = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scope, cwd: h.root, paths: [h.root], trusted } });
  return client.call('job_wait', { job_id: initial.job_id, wait_ms: 1000 });
}
const input = (h, job, overrides = {}) => ({ ...action(job.job_id), command: ':', cwd: h.root, affected_paths: [h.root], ...overrides });

test('Default mode 2 executes an inspected bounded change and shares the original observation budget', async t => {
  const h = await executingHarness(t), client = await h.connect(), job = await start(client, h);
  assert.equal((await client.call('pane_describe', { pane_id: pane.pane_id })).automatic_modes_supported, true);
  const proposal = await client.call('action_propose', input(h, job, { command: "printf 'ready\\n' > fixture", risk: { ...risk, classification: 'bounded_change', impact: 'Write one disposable fixture', recovery: 'Remove that fixture' } }));
  const first = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(first.submission_state, 'accepted', JSON.stringify(first));
  assert.equal(first.authorization, 'parent_risk_review');
  assert.equal(first.approval_consumed, false);
  assert.equal(first.approval_expires, null);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await readFile(join(h.root, 'fixture'), 'utf8'), 'ready\n');
  const next = await client.call('job_wait', { job_id: job.job_id, cursor: job.cursor, wait_ms: 1000 });
  assert.equal(next.phase, 'result_ready', JSON.stringify(next));
  assert.ok(next.budget.parent_payload_bytes_used > first.budget.parent_payload_bytes_used);
  assert.equal(next.worker, undefined);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Untrusted completion cannot authorize an automatic chain through a new trusted job or mode 3', async t => {
  const h = await executingHarness(t), console = await consoleProcess(t, h), client = await connect(console.ready.socket, t);
  const job = await start(client, h, false);
  const proposal = await client.call('action_propose', input(h, job));
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'accepted');
  await new Promise(resolve => setTimeout(resolve, 200));
  const observed = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(observed.observation_state, 'completion_observed');
  assert.equal(observed.hold_reason, 'untrusted_completion');
  const next = await start(client, h, true);
  await console.command(`mode ${next.pane_session_id} 3`);
  const fresh = await client.call('action_propose', input(h, next));
  assert.equal((await client.call('action_submit', { proposal_id: fresh.proposal_id })).error, 'terminal_held');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Mode 2 requires approval for uninspected, high, unknown, malformed or missing risk', async t => {
  for (const [name, review] of [
    ['uninspected build script', { ...risk, inspected: false }],
    ['high', { ...risk, classification: 'high' }],
    ['unknown', { ...risk, classification: 'unknown' }],
    ['high category despite read label', { ...risk, categories: ['permissions'] }],
    ['uncertain', { ...risk, uncertainties: ['The script has not been read'] }],
    ['malformed', { approved: true }], ['missing', undefined],
  ]) await t.test(name, async t => {
    const h = await executingHarness(t), client = await h.connect(), job = await start(client, h);
    const proposal = await client.call('action_propose', input(h, job, { risk: review }));
    assert.equal(proposal.authorization, 'approval_required');
    assert.ok((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error);
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
  });
});

test('Mode 2 high-risk input can use an exact user approval without changing the session mode', async t => {
  const h = await executingHarness(t), console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), job = await start(client, h);
  const proposal = await client.call('action_propose', input(h, job, { risk: { ...risk, classification: 'high' } }));
  await console.command(`review ${proposal.proposal_id}`); await console.command(`approve ${proposal.proposal_id}`);
  const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(receipt.authorization, 'user_approval');
  assert.equal(receipt.approval_consumed, true);
  assert.equal(receipt.submission_state, 'accepted');
  assert.equal((await client.call('job_status', { job_id: job.job_id })).action_mode, 2);
});

test('User-selected mode 3 executes scoped high and unknown risk and still rejects scope, goal and agent upgrades', async t => {
  const h = await executingHarness(t), console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), job = await start(client, h);
  assert.equal((await client.call('session_lower_mode', { job_id: job.job_id, mode: 3 })).error, 'mode_upgrade_requires_user');
  const stale = await client.call('action_propose', input(h, job));
  await console.command(`mode ${job.pane_session_id} 3`);
  assert.equal((await client.call('action_submit', { proposal_id: stale.proposal_id })).error, 'mode_changed');
  for (const [classification, command] of [['high', 'rm disposable'], ['unknown', ':']]) {
    await writeFile(join(h.root, 'disposable'), 'owned test file');
    const current = await start(client, h);
    assert.equal(current.action_mode, 3, 'mode persists to the same-session new job');
    assert.equal((await client.call('action_propose', input(h, current, { affected_paths: ['/outside'] }))).error, 'outside_scope');
    assert.equal((await client.call('action_propose', input(h, current, { objective: 'different task' }))).error, 'objective_mismatch');
    const proposal = await client.call('action_propose', input(h, current, { command, risk: { ...risk, classification, categories: ['destructive'], uncertainties: ['Risk is not fully known'] } }));
    const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(receipt.authorization, 'autonomous');
    assert.equal(receipt.approval_consumed, false);
    assert.equal(receipt.submission_state, 'accepted', JSON.stringify(receipt));
    await new Promise(resolve => setTimeout(resolve, 200));
    if (classification === 'high') await assert.rejects(readFile(join(h.root, 'disposable')), { code: 'ENOENT' });
  }
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 2);
});

test('Mode 3 obeys the same three-attempt limit and cannot restart a cancelled job', async t => {
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.send_input') { delete response.result; response.error = { code: 'invalid_key' }; }
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t), job = await start(client, h);
  await console.command(`mode ${job.pane_session_id} 3`);
  for (let n = 0; n < 4; n++) {
    const proposal = await client.call('action_propose', input(h, job));
    const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(n < 3 ? receipt.submission_state : receipt.error, n < 3 ? 'rejected' : 'action_budget_exhausted', JSON.stringify(receipt));
  }
  await client.call('job_cancel', { job_id: job.job_id });
  assert.equal((await client.call('action_propose', input(h, job))).error, 'job_ended');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 3);
});
