import test from 'node:test';
import assert from 'node:assert/strict';
import { action, scope, processInfo } from './action-harness.mjs';
import { executingHarness } from './execution-harness.mjs';
import { consoleProcess } from './console-harness.mjs';
import { connect, pane } from './harness.mjs';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function setup(t, options = {}) {
  const h = await executingHarness(t, { execute: false, ...options });
  const console = await consoleProcess(t, h, { observationMs: 200, ...options.console });
  const client = await connect(console.ready.socket, t);
  const start = await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope });
  const job = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  return { h, console, client, job };
}
const interrupt = (job, original) => ({ ...action(job.job_id), operation: 'interrupt', command: undefined, original_proposal_id: original.proposal_id });

test('A separately authorized interrupt passes the original hold once without proving its outcome', async t => {
  const { h, client, job } = await setup(t);
  const original = await client.call('action_propose', action(job.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: original.proposal_id })).submission_state, 'accepted');
  const proposal = await client.call('action_propose', interrupt(job, original));
  assert.deepEqual(proposal.payload, { text: '', keys: ['Ctrl+c'] });
  const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(receipt.submission_state, 'accepted');
  assert.equal(receipt.observation_state, 'not_applicable');
  assert.equal(receipt.original_proposal_id, original.proposal_id);
  assert.equal(receipt.exit_code, null);
  await client.call('action_submit', { proposal_id: proposal.proposal_id });
  const exhausted = await client.call('action_propose', interrupt(job, original));
  assert.equal((await client.call('action_submit', { proposal_id: exhausted.proposal_id })).error, 'action_budget_exhausted');
  const ordinary = await client.call('action_propose', action(job.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: ordinary.proposal_id })).error, 'terminal_held');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 2);
});

test('A user inspects a ready shell and resets its goal without rewriting the unknown outcome', async t => {
  const { h, console, client, job } = await setup(t);
  const original = await client.call('action_propose', action(job.job_id));
  await client.call('action_submit', { proposal_id: original.proposal_id });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await console.command(`recover ${original.proposal_id} fresh goal`)).error, 'inspect_required');
  const inspected = await console.command(`inspect ${pane.pane_id}`);
  assert.equal(inspected.shell_ready, true);
  assert.equal(inspected.held_proposal_id, original.proposal_id);
  const recovered = await console.command(`recover ${original.proposal_id} fresh goal`);
  assert.equal(recovered.recovery, 'user_verified_ready_shell');
  assert.equal(recovered.observation_state, 'outcome_unknown');
  assert.equal(recovered.exit_code, null);
  assert.equal((await console.command('status')).held_terminal_count, 0);
  assert.equal((await client.call('action_propose', action(job.job_id))).error, 'job_ended');
  const wrong = await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'old goal', action_scope: scope });
  assert.equal((await client.call('job_wait', { job_id: wrong.job_id, wait_ms: 1000 })).error, 'recovery_objective_required');
  const fresh = await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'fresh goal', action_scope: scope });
  assert.equal((await client.call('job_wait', { job_id: fresh.job_id, wait_ms: 1000 })).phase, 'result_ready');
  const next = await client.call('action_propose', { ...action(fresh.job_id), objective: 'fresh goal' });
  assert.equal((await client.call('action_submit', { proposal_id: next.proposal_id })).submission_state, 'accepted');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 2);
});

for (const mode of [1, 2, 3]) test(`Mode ${mode} applies to a busy-shell interrupt with its own approval`, async t => {
  let busy = false;
  const { h, console, client, job } = await setup(t, { respond(socket, request, response) {
    if (busy && request.method === 'pane.process_info') response.result.process_info = { ...processInfo, foreground_process_group_id: 1234, foreground_processes: [{ pid: 1234, name: 'sleep' }] };
    socket.write(JSON.stringify(response) + '\n');
  } });
  await console.command(`mode ${job.pane_session_id} ${mode}`);
  const original = await client.call('action_propose', action(job.job_id));
  if (mode === 1) { await console.command(`review ${original.proposal_id}`); await console.command(`approve ${original.proposal_id}`); }
  await client.call('action_submit', { proposal_id: original.proposal_id }); busy = true;
  const proposed = await client.call('action_propose', { ...interrupt(job, original), risk: { ...action(job.job_id).risk, classification: 'high', impact: 'Stop a process whose progress can be lost' } });
  assert.ok(proposed.proposal_id, JSON.stringify(proposed));
  if (mode !== 3) {
    assert.equal((await client.call('action_submit', { proposal_id: proposed.proposal_id })).error, 'policy_requires_approval');
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
    await console.command(`review ${proposed.proposal_id}`); await console.command(`approve ${proposed.proposal_id}`);
  }
  const receipt = await client.call('action_submit', { proposal_id: proposed.proposal_id });
  assert.equal(receipt.submission_state, 'accepted');
  assert.equal(receipt.authorization, mode === 3 ? 'autonomous' : 'user_approval');
  assert.equal(receipt.observation_state, 'not_applicable');
  const status = await console.command('status');
  assert.equal(status.held_terminal_count, 1);
  assert.equal(status.receipts.find(row => row.proposal_id === original.proposal_id).exit_code, null);
});

test('Interrupt is bound to a submitted original; cancel stops it without sending control automatically', async t => {
  const { h, client, job } = await setup(t);
  const original = await client.call('action_propose', action(job.job_id));
  assert.equal((await client.call('action_propose', interrupt(job, original))).error, 'original_action_unavailable');
  await client.call('action_submit', { proposal_id: original.proposal_id });
  const pending = await client.call('action_propose', interrupt(job, original));
  await client.call('job_cancel', { job_id: job.job_id });
  assert.equal((await client.call('action_submit', { proposal_id: pending.proposal_id })).error, 'job_ended');
  assert.equal((await client.call('action_status', { job_id: job.job_id, proposal_id: pending.proposal_id })).submission_state, 'not_submitted');
  const start = await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope });
  const fresh = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  const explicit = await client.call('action_propose', interrupt(fresh, original));
  assert.equal((await client.call('action_submit', { proposal_id: explicit.proposal_id })).submission_state, 'accepted');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 2);
});

test('An interrupt waits for the original submission boundary and cancellation removes queued input', async t => {
  let release;
  const { h, client, job } = await setup(t, { console: { observationMs: 2000 }, respond(socket, request, response) {
    if (request.method === 'pane.send_input' && request.params.text) release = () => socket.write(JSON.stringify(response) + '\n');
    else socket.write(JSON.stringify(response) + '\n');
  } });
  const original = await client.call('action_propose', action(job.job_id));
  const sending = client.call('action_submit', { proposal_id: original.proposal_id });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  const proposed = await client.call('action_propose', interrupt(job, original));
  const waiting = client.call('action_submit', { proposal_id: proposed.proposal_id });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  await client.call('job_cancel', { job_id: job.job_id });
  release();
  assert.equal((await sending).submission_state, 'accepted');
  assert.equal((await waiting).error, 'job_ended');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('A job deadline prevents a prepared interrupt without changing the original receipt', async t => {
  const h = await executingHarness(t, { execute: false }), clock = join(h.root, 'clock');
  await writeFile(clock, '1000');
  const console = await consoleProcess(t, h, { clockPath: clock, observationMs: 200 }), client = await connect(console.ready.socket, t);
  const start = await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope, budget: { deadline_ms: 5000 } });
  const job = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  const original = await client.call('action_propose', action(job.job_id));
  await client.call('action_submit', { proposal_id: original.proposal_id });
  const proposed = await client.call('action_propose', interrupt(job, original));
  await writeFile(clock, '6000');
  assert.equal((await client.call('action_submit', { proposal_id: proposed.proposal_id })).error, 'job_ended');
  assert.equal((await console.command('status')).receipts[0].submission_state, 'accepted');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Recovery revalidates the inspected ready shell, mode and hold and rejects pipe authority', async t => {
  let busy = false;
  const { h, console, client, job } = await setup(t, { respond(socket, request, response) {
    if (busy && request.method === 'pane.process_info') response.result.process_info = { ...processInfo, foreground_process_group_id: 1234, foreground_processes: [{ pid: 1234, name: 'sleep' }] };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const original = await client.call('action_propose', action(job.job_id));
  await client.call('action_submit', { proposal_id: original.proposal_id });
  await console.command(`inspect ${pane.pane_id}`); busy = true;
  assert.equal((await console.command(`recover ${original.proposal_id} new task`)).error, 'shell_not_ready');
  busy = false;
  await console.command(`inspect ${pane.pane_id}`);
  await console.command(`mode ${job.pane_session_id} 3`);
  assert.equal((await console.command(`recover ${original.proposal_id} new task`)).error, 'inspect_stale');
  assert.equal((await console.command('status')).held_terminal_count, 1);
  const stopped = once(console.child, 'close'); console.child.stdin.end('quit\n'); await stopped;
  const pipe = await consoleProcess(t, h, { tty: false });
  assert.equal((await pipe.command(`inspect ${pane.pane_id}`)).error, 'interactive_console_required');
  assert.equal((await pipe.command(`recover ${original.proposal_id} new task`)).error, 'interactive_console_required');
});

test('A restart hold needs fresh console confirmation; the old process cannot be interrupted by assumption', async t => {
  const { h, console, client, job } = await setup(t);
  const original = await client.call('action_propose', action(job.job_id));
  await client.call('action_submit', { proposal_id: original.proposal_id });
  const stopped = once(console.child, 'close'); console.child.stdin.end('quit\n'); await stopped;
  const restarted = await consoleProcess(t, h), nextClient = await connect(restarted.ready.socket, t);
  const start = await nextClient.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope });
  const next = await nextClient.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  assert.equal(next.action_mode, 2);
  assert.notEqual(next.pane_session_id, job.pane_session_id);
  assert.equal((await nextClient.call('action_propose', interrupt(next, original))).error, 'original_action_unavailable');
  await restarted.command(`inspect ${pane.pane_id}`);
  const recovered = await restarted.command(`recover ${original.proposal_id} inspect from scratch`);
  assert.equal(recovered.recovery, 'user_verified_ready_shell');
  assert.equal(recovered.exit_code, null);
  assert.equal((await restarted.command('status')).held_terminal_count, 0);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('An unknown interrupt keeps a durable hold even when the original completion marker arrives', async t => {
  const { h, console, client, job } = await setup(t, { console: { observationMs: 1500 }, respond(socket, request, response) {
    if (request.method === 'pane.send_input' && !request.params.text) { socket.end('invalid reply\n'); return; }
    socket.write(JSON.stringify(response) + '\n');
  } });
  const original = await client.call('action_propose', action(job.job_id));
  await client.call('action_submit', { proposal_id: original.proposal_id });
  const proposed = await client.call('action_propose', interrupt(job, original));
  assert.equal((await client.call('action_submit', { proposal_id: proposed.proposal_id })).submission_state, 'unknown');
  const nonce = original.payload.text.match(/[a-f0-9]{32}/)[0];
  h.state.text += `\n__HERDR_END_${nonce}__:0\n`;
  await new Promise(resolve => setTimeout(resolve, 250));
  const status = await console.command('status');
  const complete = status.receipts.find(row => row.proposal_id === original.proposal_id);
  assert.equal(complete.observation_state, 'completion_observed');
  assert.equal(complete.hold_reason, 'interrupt_unconfirmed');
  assert.equal(status.held_terminal_count, 1);
  const fresh = await client.call('action_propose', action(job.job_id));
  assert.equal((await client.call('action_submit', { proposal_id: fresh.proposal_id })).error, 'terminal_held');
  const stopped = once(console.child, 'close'); console.child.stdin.end('quit\n'); await stopped;
  const restarted = await consoleProcess(t, h);
  assert.equal((await restarted.command('status')).held_terminal_count, 1);
  await restarted.command(`inspect ${pane.pane_id}`);
  assert.equal((await restarted.command(`recover ${original.proposal_id} fresh task`)).recovery, 'user_verified_ready_shell');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 2);
});
