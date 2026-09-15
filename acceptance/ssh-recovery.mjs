import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { liveHarness, exec } from './live-harness.mjs';
import { sshConnect, sshConfirm } from './ssh-harness.mjs';
import { consoleProcess } from '../test/console-harness.mjs';
import { connect } from '../test/harness.mjs';

const records = [];
const save = () => writeFile(new URL('../docs/implementation/issue-24-ssh-recovery-results.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), environment: 'actual localhost SSH and native Herdr, candidate profile, 1200 ms observation test seam', records }, null, 2) + '\n');
async function setup(t) {
  const h = await liveHarness(t), terminal = await consoleProcess(t, h, { sshEnabled: true, observationMs: 1200 });
  const client = await connect(terminal.ready.socket, t);
  await sshConnect(h); await sshConfirm(terminal, h.pane.pane_id, h.root);
  const scope = { profile: 'ssh_posix', cwd: h.root, paths: [h.root], trusted: true };
  const start = async (objective = 'SSH recovery') => {
    const initial = await client.call('job_start', { pane_id: h.pane.pane_id, objective, action_scope: scope });
    let ready;
    do { ready = await client.call('job_wait', { job_id: initial.job_id, wait_ms: 20000 }); } while (ready.phase === 'observing');
    assert.equal(ready.phase, 'result_ready', JSON.stringify(ready)); return ready;
  };
  const job = await start();
  const common = { job_id: job.job_id, objective: 'SSH recovery', target: (await client.call('pane_describe', { pane_id: h.pane.pane_id })).target, cwd: h.root, env: {}, affected_paths: [h.root], risk: { classification: 'bounded_change', inspected: true, impact: 'Only the owned disposable SSH shell and fixture', recovery: 'Verify ready shell and reset goal', uncertainties: [], categories: [] } };
  return { h, terminal, client, start, job, common };
}

for (const fault of ['lost_ack_and_marker', 'duplicate_marker', 'truncated_missing_marker', 'partial_input']) test(`Actual SSH transport with injected ${fault} retains hold and never resends`, async t => {
  const { h, terminal, client, job, common } = await setup(t);
  let shortened = 0;
  h.state.input = request => {
    if (fault === 'partial_input' && request.method === 'pane.send_input' && request.params.keys?.includes('Enter')) {
      shortened++; return { ...request, params: { ...request.params, text: request.params.text.slice(0, 10), keys: [] } };
    }
    return request;
  };
  h.state.transform = response => {
    if (fault === 'lost_ack_and_marker' && response.result?.type === 'ok') return null;
    const read = response.result?.read;
    if (read) {
      read.text = read.text.replace(/__HERDR_END_[0-9a-f]{32}__:\d+/g, text => fault === 'duplicate_marker' ? `${text}\n${text}` : 'END_HIDDEN_BY_TEST');
      if (fault === 'truncated_missing_marker') read.truncated = true;
    }
    return response;
  };
  const proposal = await client.call('action_propose', { ...common, operation: 'execute', command: "printf 'SSH_FAULT_PROBE\\n'" });
  const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(receipt.submission_state, fault === 'lost_ack_and_marker' ? 'unknown' : 'accepted', JSON.stringify(receipt));
  await new Promise(resolve => setTimeout(resolve, 1350));
  const outcome = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(outcome.observation_state, 'outcome_unknown');
  assert.equal(outcome.exit_code, null);
  await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  assert.equal((await terminal.command('status')).held_terminal_count, 1);
  assert.equal((await terminal.command(`inspect ${h.pane.pane_id}`)).shell_ready, false);
  h.state.input = null; h.state.transform = null;
  if (fault === 'partial_input') {
    const interrupt = await client.call('action_propose', { ...common, operation: 'interrupt', original_proposal_id: proposal.proposal_id });
    assert.equal((await client.call('action_submit', { proposal_id: interrupt.proposal_id })).submission_state, 'accepted');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await sshConfirm(terminal, h.pane.pane_id, h.root);
  await terminal.command(`inspect ${h.pane.pane_id}`);
  const recovered = await terminal.command(`recover ${proposal.proposal_id} verified SSH shell`);
  assert.equal(recovered.recovery, 'user_verified_ready_shell', JSON.stringify(recovered));
  assert.equal(recovered.exit_code, null);
  assert.equal((await terminal.command('status')).held_terminal_count, 0);
  records.push({ fault, submission: receipt.submission_state, observation: outcome.observation_state, hold_reason: outcome.hold_reason, truncated: outcome.observation?.truncated, wire_attempts: h.calls.filter(call => call.method === 'pane.send_input').length, prefix_deliveries_without_enter: shortened, automatic_resends: 0, recovery: recovered.recovery, provenance: fault === 'partial_input' ? 'proxy delivered first 10 payload characters without Enter to actual SSH, then an authorized interrupt cleared that input' : 'proxy modified/dropped native Herdr responses; real remote command executed' });
  await save();
});

test('Actual SSH cancel is input-free; separate interrupt and fresh user preparation recover the shell', async t => {
  const { h, terminal, client, job, common, start } = await setup(t);
  const original = await client.call('action_propose', { ...common, operation: 'execute', command: 'exec sleep 20' });
  assert.equal((await client.call('action_submit', { proposal_id: original.proposal_id })).submission_state, 'accepted');
  await client.call('job_cancel', { job_id: job.job_id });
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  const next = await start();
  const interrupt = await client.call('action_propose', { ...common, job_id: next.job_id, operation: 'interrupt', original_proposal_id: original.proposal_id });
  const receipt = await client.call('action_submit', { proposal_id: interrupt.proposal_id });
  assert.equal(receipt.submission_state, 'accepted');
  assert.equal(receipt.observation_state, 'not_applicable');
  await new Promise(resolve => setTimeout(resolve, 1350));
  const outcome = (await terminal.command('status')).receipts.find(value => value.proposal_id === original.proposal_id);
  assert.equal(outcome.observation_state, 'outcome_unknown');
  assert.equal(outcome.exit_code, null);
  await sshConfirm(terminal, h.pane.pane_id, h.root);
  await terminal.command(`inspect ${h.pane.pane_id}`);
  const recovered = await terminal.command(`recover ${original.proposal_id} verified SSH shell`);
  assert.equal(recovered.recovery, 'user_verified_ready_shell');
  records.push({ fault: 'none: real sleep/cancel/Ctrl+c', input_after_cancel: 1, total_inputs: 2, interrupt_keys: h.calls.filter(call => call.method === 'pane.send_input')[1].params.keys, original_observation: outcome.observation_state, exit: null, recovery: recovered.recovery });
  await save();
});

test('Actual SSH pane move/recreation and proxy continuity loss invalidate earlier preparation and mode', async t => {
  const { h, terminal, client, job, common } = await setup(t);
  const old = await client.call('pane_describe', { pane_id: h.pane.pane_id });
  await terminal.command(`mode ${old.pane_session_id} 3`);
  const proposal = await client.call('action_propose', { ...common, operation: 'execute', command: 'printf stale' });
  await exec('herdr', ['pane', 'move', h.pane.pane_id, '--new-tab', '--workspace', h.workspace, '--label', 'broker-ssh-move', '--no-focus']);
  assert.ok((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error);
  const moved = await client.call('pane_describe', { pane_id: h.pane.pane_id });
  assert.equal(moved.action_mode, 2); assert.equal(moved.action_supported, false);
  await sshConfirm(terminal, h.pane.pane_id, h.root);
  await terminal.command(`mode ${moved.pane_session_id} 3`);
  h.state.connected = false;
  assert.ok((await client.call('pane_describe', { pane_id: h.pane.pane_id })).error);
  h.state.connected = true;
  const resumed = await client.call('pane_describe', { pane_id: h.pane.pane_id });
  assert.equal(resumed.action_mode, 2); assert.equal(resumed.action_supported, false);
  const created = JSON.parse((await exec('herdr', ['pane', 'split', h.pane.pane_id, '--direction', 'right', '--cwd', h.root, '--env', `ZDOTDIR=${h.root}`, '--env', 'HISTFILE=/dev/null', '--no-focus'])).stdout).result.pane;
  await exec('herdr', ['pane', 'close', h.pane.pane_id]);
  const recreated = await client.call('pane_describe', { pane_id: created.pane_id });
  assert.equal(recreated.action_mode, 2);
  assert.ok((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
  records.push({ fault: 'actual move/recreate; actual proxy IPC disconnect (Herdr app not restarted)', moved_mode: moved.action_mode, continuity_mode: resumed.action_mode, recreated_mode: recreated.action_mode, stale_inputs: 0, old_job: job.job_id });
  await save();
});
