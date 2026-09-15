import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startCore } from '../dist/core.js';
import { connect } from '../test/harness.mjs';
import { consoleProcess } from '../test/console-harness.mjs';

const exec = promisify(execFile);
test('Actual disposable Herdr POSIX shell through public Broker and interactive console', async t => {
  const root = await mkdtemp('/private/tmp/hb-live-local-');
  let core, workspace;
  const peerSockets = new Set(), calls = [], evidence = [], captures = [];
  const endpoint = join(root, 'herdr.sock');
  const proxy = createServer(socket => {
    const upstream = createConnection('/Users/dwchoo/.config/herdr/herdr.sock');
    peerSockets.add(socket); peerSockets.add(upstream);
    let buffer = '';
    let received = '';
    upstream.on('data', chunk => {
      received += chunk;
      let end;
      while ((end = received.indexOf('\n')) >= 0) {
        const response = JSON.parse(received.slice(0, end)); received = received.slice(end + 1);
        if (response.result?.type === 'pane_read') captures.push(response.result.read.text);
      }
    });
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { calls.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    });
    for (const connection of [socket, upstream]) connection.on('error', () => {});
    socket.on('close', () => { upstream.destroy(); peerSockets.delete(socket); });
    upstream.on('close', () => { socket.destroy(); peerSockets.delete(upstream); });
    socket.pipe(upstream); upstream.pipe(socket);
  });
  t.after(async () => {
    await core?.close();
    for (const socket of peerSockets) socket.destroy();
    if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
    if (workspace) await exec('herdr', ['workspace', 'close', workspace]);
    await rm(root, { recursive: true, force: true });
  });
  const created = JSON.parse((await exec('herdr', ['workspace', 'create', '--cwd', root, '--label', 'broker-local-acceptance', '--env', `ZDOTDIR=${root}`, '--env', 'HISTFILE=/dev/null', '--no-focus'])).stdout).result;
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane;
  await new Promise(resolve => proxy.listen(endpoint, resolve));
  core = await startCore({ endpoint, stateRoot: join(root, 'state') });
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
