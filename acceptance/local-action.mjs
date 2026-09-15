import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { liveHarness } from './live-harness.mjs';
import { connect } from '../test/harness.mjs';
import { consoleProcess } from '../test/console-harness.mjs';

test('Actual disposable Herdr POSIX shell through public Broker and interactive console', async t => {
  const { root, endpoint, core, pane, calls, captures } = await liveHarness(t);
  const evidence = [];
  const console = await consoleProcess(t, { root, endpoint, core }), client = await connect(console.ready.socket, t);
  const described = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.equal(described.action_supported, true);
  const target = described.target;
  for (const [name, command, expected] of [
    ['cwd-env-literals-nonzero', 'pwd; printf "env=%s\\n" "$HB_LITERAL"; printf \'%s\\n\' \'literal $HOME $(not-a-command)\'; exit 7', 7],
    ['subshell-cwd', 'cd /; pwd; exit 0', 0],
    ['fresh-explicit-cwd', 'pwd; sleep 0.3; exit 0', 0],
  ]) {
    const started = await client.call('job_start', { pane_id: pane.pane_id, objective: name, action_scope: { profile: 'local_posix', cwd: root, paths: [root], trusted: true } });
    const ready = await client.call('job_wait', { job_id: started.job_id, wait_ms: 20000 });
    assert.equal(ready.phase, 'result_ready', JSON.stringify(ready));
    await console.command(`mode ${ready.pane_session_id} 1`);
    const proposal = await client.call('action_propose', { job_id: started.job_id, target, objective: name, operation: 'execute', command, cwd: root, env: { HB_LITERAL: "literal ' $HOME $(unexecuted)" }, affected_paths: [root], risk: { classification: 'read', inspected: true, impact: 'Print only synthetic cwd and literals.', recovery: 'No persistent changes.', uncertainties: [], categories: [] } });
    assert.ok(proposal.proposal_id, JSON.stringify(proposal));
    await console.command(`review ${proposal.proposal_id}`); await console.command(`approve ${proposal.proposal_id}`);
    const first = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(first.submission_state, 'accepted', JSON.stringify(first));
    assert.equal(first.observation_state, 'observing');
    let receipt = first;
    for (let n = 0; n < 6 && receipt.observation_state === 'observing'; n++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      receipt = await client.call('action_status', { job_id: started.job_id, proposal_id: proposal.proposal_id });
    }
    assert.equal(receipt.observation_state, 'completion_observed', JSON.stringify(receipt));
    assert.equal(receipt.exit_code, expected);
    const output = captures.at(-1).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
    const nonce = proposal.payload.text.match(/[a-f0-9]{32}/)[0];
    const observed = output.split(`__HERDR_BEGIN_${nonce}__\n`)[1]?.split(`__HERDR_END_${nonce}__`)[0];
    assert.ok(observed, 'standalone command output between actual markers');
    if (name === 'cwd-env-literals-nonzero') {
      assert.ok(observed.includes(root + '\n'));
      assert.ok(observed.includes("env=literal ' $HOME $(unexecuted)\n"));
      assert.ok(observed.includes('literal $HOME $(not-a-command)\n'));
    } else if (name === 'subshell-cwd') assert.equal(observed.trim(), '/');
    else assert.equal(observed.trim(), root);
    const after = await client.call('pane_describe', { pane_id: pane.pane_id });
    assert.equal(after.context.foreground_cwd, root, 'the parent shell cwd is unchanged');
    const row = receipt.evidence.items[0].evidence_id.split(':L')[0] + ':L0001';
    const retained = await client.call('evidence_get', { job_id: started.job_id, evidence_id: row });
    evidence.push({ name, first, receipt, actual_output: observed.trim(), parent_cwd: after.context.foreground_cwd, excerpt: retained.evidence });
    await client.call('job_cancel', { job_id: started.job_id });
  }
  assert.equal(calls.filter(call => call.method === 'pane.send_input').length, 3);
  const record = { at: new Date().toISOString(), node: process.versions.node, herdr: '0.9.0', protocol: 22, boundary: 'actual Herdr socket; observing proxy counts only Broker submissions; actual interactive PTY console', target, wire_attempts: 3, cases: evidence };
  await writeFile(new URL('../docs/implementation/issue-17-local-acceptance.json', import.meta.url), JSON.stringify(record, null, 2).replaceAll(root, '<disposable-cwd>') + '\n');
});
