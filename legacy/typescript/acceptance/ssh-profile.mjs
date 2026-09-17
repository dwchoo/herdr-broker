import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { liveHarness, exec } from './live-harness.mjs';
import { sshConnect, sshConfirm, sshFailure } from './ssh-harness.mjs';
import { consoleProcess } from '../test/console-harness.mjs';
import { connect } from '../test/harness.mjs';

async function completed(client, job, proposal) {
  let status;
  for (let index = 0; index < 20; index++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = await client.call('action_status', { job_id: job, proposal_id: proposal });
    if (status.observation_state !== 'observing') return status;
  }
  throw new Error(JSON.stringify(status));
}

test('Candidate SSH profile: actual remote POSIX modes, scoped input, completion and reconnect', async t => {
  const h = await liveHarness(t), terminal = await consoleProcess(t, h, { sshEnabled: true, observationMs: 1200 });
  const client = await connect(terminal.ready.socket, t);
  await sshConnect(h);
  const failure = await sshFailure(h);
  const unprepared = await client.call('pane_describe', { pane_id: h.pane.pane_id });
  assert.equal(unprepared.action_mode, 2);
  assert.equal(unprepared.action_supported, false);
  await sshConfirm(terminal, h.pane.pane_id, h.root);
  const scope = { profile: 'ssh_posix', cwd: h.root, paths: [h.root], trusted: true };
  const target = unprepared.target, results = [];
  const start = async objective => {
    const initial = await client.call('job_start', { pane_id: target.pane_id, objective, action_scope: scope });
    const ready = await client.call('job_wait', { job_id: initial.job_id, wait_ms: 1000 });
    assert.equal(ready.phase, 'result_ready', JSON.stringify(ready)); return ready;
  };
  const propose = (job, objective, command, high = false) => client.call('action_propose', { job_id: job.job_id, target, objective, operation: 'execute', command, cwd: h.root, env: {}, affected_paths: [h.root], risk: { classification: high ? 'high' : 'bounded_change', inspected: true, impact: high ? 'Remove one disposable acceptance file' : 'Print or create only the declared fixture', recovery: 'Recreate disposable fixture', uncertainties: [], categories: high ? ['destructive'] : [] } });
  for (const mode of [1, 2, 3]) {
    const session = await client.call('pane_describe', { pane_id: target.pane_id });
    await terminal.command(`mode ${session.pane_session_id} ${mode}`);
    const objective = `SSH mode ${mode}`, job = await start(objective);
    await writeFile(join(h.root, 'disposable'), 'fixture');
    const proposal = await propose(job, objective, mode === 3 ? 'rm ./disposable' : `printf 'SSH_MODE_${mode}_OK\\n'`, mode === 3);
    assert.ok(proposal.proposal_id, JSON.stringify(proposal));
    const before = h.calls.filter(call => call.method === 'pane.send_input').length;
    if (mode === 1) {
      assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'policy_requires_approval');
      assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, before);
      await terminal.command(`review ${proposal.proposal_id}`);
      await terminal.command(`approve ${proposal.proposal_id}`);
    }
    const submitted = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(submitted.submission_state, 'accepted', JSON.stringify(submitted));
    const outcome = await completed(client, job.job_id, proposal.proposal_id);
    assert.equal(outcome.exit_code, 0, JSON.stringify(outcome));
    await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, before + 1);
    if (mode === 2) {
      const high = await propose(job, objective, 'rm ./disposable', true);
      assert.equal(high.authorization, 'approval_required');
      assert.equal((await client.call('action_submit', { proposal_id: high.proposal_id })).error, 'policy_requires_approval');
    }
    const invalid = await client.call('action_propose', { job_id: job.job_id, approved: true });
    assert.equal(invalid.error, 'invalid_tool_arguments');
    results.push({ mode, authorization: submitted.authorization, outcome, input_attempts: h.calls.filter(call => call.method === 'pane.send_input').length - before });
    await client.call('job_cancel', { job_id: job.job_id });
  }
  const staleJob = await start('stale connection'), stale = await propose(staleJob, 'stale connection', 'printf stale');
  const before = h.calls.filter(call => call.method === 'pane.send_input').length;
  await exec('herdr', ['pane', 'run', target.pane_id, 'exit']);
  await new Promise(resolve => setTimeout(resolve, 200));
  const local = await client.call('pane_describe', { pane_id: target.pane_id });
  assert.equal(local.observed_connection.kind, 'local');
  const changedCwd = join(h.root, 'reconnected-cwd'); await mkdir(changedCwd);
  await sshConnect(h, changedCwd);
  const reconnect = await client.call('pane_describe', { pane_id: target.pane_id });
  assert.equal(reconnect.action_mode, 2);
  assert.equal(reconnect.action_supported, false);
  assert.ok((await client.call('action_submit', { proposal_id: stale.proposal_id })).error);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, before);
  assert.equal((await client.call('job_wait', { job_id: staleJob.job_id, wait_ms: 1000, cursor: staleJob.cursor })).error, 'session_changed');
  const fixture = { name: 'actual-ssh-missing-config', source: 'Captured from the disposable localhost SSH build, not a synthetic replacement of the observed error', truncated: false, lines: failure.split('\n') };
  await writeFile(new URL('./fixtures/actual-ssh-missing-config.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
  const record = { at: new Date().toISOString(), profile: 'candidate CoreOptions sshEnabled; not yet public default', node: process.versions.node, herdr: '0.9.0/protocol22', endpoint: '127.0.0.1:65345', remote_user: 'dwchoo', shell: '/bin/sh -i', cwd: '<disposable-cwd>', identity: 'fixture declaration; local SSH process is not remote authentication', results, failure_fixture: fixture, reconnect, stale_input_attempts: 0, changed_remote_cwd: '<disposable-cwd>/reconnected-cwd', ordinary_wire_attempts: before, setup: 'Owned native CLI only for SSH connect/build-failure/exit; Broker inputs counted separately' };
  await writeFile(new URL('../docs/implementation/issue-24-ssh-profile-results.json', import.meta.url), JSON.stringify(record, null, 2).replaceAll(h.root, '<disposable-cwd>') + '\n');
});
