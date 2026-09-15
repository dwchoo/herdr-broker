import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { liveHarness, exec } from './live-harness.mjs';
import { consoleProcess } from '../test/console-harness.mjs';
import { connect } from '../test/harness.mjs';

test('Actual pane move and recreation reject old bindings in all three modes', async t => {
  const h = await liveHarness(t), cases = [];
  const console = await consoleProcess(t, h), client = await connect(console.ready.socket, t);
  let pane = h.pane;
  const scope = { profile: 'local_posix', cwd: h.root, paths: [h.root], trusted: true };
  for (const mode of [1, 2, 3]) {
    const first = await client.call('pane_describe', { pane_id: pane.pane_id });
    const initial = await client.call('job_start', { pane_id: pane.pane_id, objective: 'verify exact pane', action_scope: scope });
    const job = await client.call('job_wait', { job_id: initial.job_id, wait_ms: 1000 });
    await console.command(`mode ${job.pane_session_id} ${mode}`);
    const input = { job_id: job.job_id, target: first.target, objective: 'verify exact pane', operation: 'execute', command: ':', cwd: h.root, env: {}, affected_paths: [h.root], risk: { classification: 'read', inspected: true, impact: 'No persistent change', recovery: 'Nothing to undo', uncertainties: [], categories: [] } };
    const proposal = await client.call('action_propose', input);
    assert.ok(proposal.proposal_id, JSON.stringify(proposal));
    if (mode === 1) { await console.command(`review ${proposal.proposal_id}`); await console.command(`approve ${proposal.proposal_id}`); }
    await exec('herdr', ['pane', 'move', pane.pane_id, '--new-tab', '--workspace', h.workspace, '--label', 'broker-session-move', '--no-focus']);
    const moved = await client.call('pane_describe', { pane_id: pane.pane_id });
    assert.equal(moved.target.pane_id, first.target.pane_id);
    assert.equal(moved.target.terminal_id, first.target.terminal_id);
    assert.notEqual(moved.target.tab_id, first.target.tab_id);
    assert.equal(moved.action_mode, 2);
    assert.notEqual(moved.pane_session_id, first.pane_session_id);
    const stale = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(stale.error, 'session_changed');
    const after = await client.call('job_wait', { job_id: job.job_id, cursor: job.cursor, wait_ms: 1000 });
    assert.equal(after.error, 'session_changed');
    const split = JSON.parse((await exec('herdr', ['pane', 'split', pane.pane_id, '--direction', 'right', '--cwd', h.root, '--env', `ZDOTDIR=${h.root}`, '--env', 'HISTFILE=/dev/null', '--no-focus'])).stdout).result.pane;
    assert.ok(split.pane_id);
    await exec('herdr', ['pane', 'close', pane.pane_id]);
    const closed = await client.call('pane_describe', { pane_id: pane.pane_id });
    assert.ok(closed.error);
    const recreated = await client.call('pane_describe', { pane_id: split.pane_id });
    assert.notEqual(recreated.target.terminal_id, first.target.terminal_id);
    assert.equal(recreated.action_mode, 2);
    cases.push({ mode, before: first, moved, stale, old_job: after, closed, recreated });
    pane = split;
  }
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
  await writeFile(new URL('../docs/implementation/issue-21-local-acceptance.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), node: process.versions.node, herdr: '0.9.0', protocol: 22, boundary: 'actual disposable Herdr pane move/split/close, actual Broker console/public MCP; no submitted input', cases, stale_wire_attempts: 0 }, null, 2).replaceAll(h.root, '<disposable-cwd>') + '\n');
});
