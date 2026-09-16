import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { pane, connect } from './harness.mjs';
import { action, scope } from './action-harness.mjs';
import { consoleProcess } from './console-harness.mjs';
import { executingHarness, approved } from './execution-harness.mjs';

test('Approved immutable input commits once before sending and observes exit independently of the ACK', async t => {
  const h = await executingHarness(t);
  const { console, client, job, proposal } = await approved(t, h);
  const [first, second] = await Promise.all([client.call('action_submit', { proposal_id: proposal.proposal_id }), client.call('action_submit', { proposal_id: proposal.proposal_id })]);
  assert.equal(first.submission_state, 'accepted', JSON.stringify(first));
  assert.equal(first.observation_state, 'observing');
  assert.equal(first.exit_code, null);
  assert.equal(second.budget.parent_payload_bytes_used, client.deliveries.reduce((n, text) => n + Buffer.byteLength(text), 0) + Buffer.byteLength(JSON.stringify(proposal.payload)));
  assert.equal(second.proposal_id, first.proposal_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  assert.deepEqual(h.calls.find(call => call.method === 'pane.send_input').params, { pane_id: pane.pane_id, ...proposal.payload });
  await new Promise(resolve => setTimeout(resolve, 400));
  const observed = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(observed.submission_state, 'accepted');
  assert.equal(observed.observation_state, 'completion_observed');
  assert.equal(observed.exit_code, 7);
  assert.equal(observed.hold_reason, null);
  assert.ok(observed.evidence.items.some(item => item.text.includes('__HERDR_END_')));
  assert.ok(!JSON.stringify(await console.command('status')).includes('__HERDR_END_'), 'console summaries omit retained Evidence text');
  const duplicate = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(duplicate.exit_code, 7);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  const database = await readFile(join(dirname(console.ready.socket), 'ledger.sqlite'));
  const wal = await readFile(join(dirname(console.ready.socket), 'ledger.sqlite-wal'));
  assert.ok(!Buffer.concat([database, wal]).includes(Buffer.from('observed output')));
  assert.ok(!Buffer.concat([database, wal]).includes(Buffer.from('literal')));
});

test('Action completion remains observable in a terminal split to 27 columns', async t => {
  const h = await executingHarness(t, { respond(socket, request, response) {
    if (request.method === 'pane.read') {
      response.result.read.source = request.params.source;
      if (request.params.source !== 'recent_unwrapped') response.result.read.text = response.result.read.text.split('\n').map(row => row.match(/.{1,27}/g)?.join('\r\n') ?? '').join('\r\n');
    }
    socket.write(JSON.stringify(response) + '\n');
  } });
  const { client, job, proposal } = await approved(t, h, 'echo hello; exit 255', { observationMs: 300 });
  await client.call('action_submit', { proposal_id: proposal.proposal_id });
  await new Promise(resolve => setTimeout(resolve, 400));
  const receipt = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(receipt.observation_state, 'completion_observed');
  assert.equal(receipt.exit_code, 255);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('No approval, changed mode, forged payload and cancellation before submission send no input', async t => {
  const h = await executingHarness(t), { console, client, job, proposal } = await approved(t, h);
  await console.command(`revoke ${proposal.proposal_id}`);
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'user_rejected');
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id, payload: { text: 'changed', keys: ['Enter'] } })).error, 'invalid_tool_arguments');
  const next = await client.call('action_propose', { ...action(job.job_id), cwd: h.root, affected_paths: [h.root] });
  assert.equal((await client.call('action_submit', { proposal_id: next.proposal_id })).error, 'policy_requires_approval');
  await console.command(`review ${next.proposal_id}`); await console.command(`approve ${next.proposal_id}`);
  await console.command(`mode ${job.pane_session_id} 2`);
  assert.equal((await client.call('action_submit', { proposal_id: next.proposal_id })).error, 'mode_changed');
  await client.call('job_cancel', { job_id: job.job_id });
  assert.ok(h.calls.every(call => call.method !== 'pane.send_input'));
});

test('Known pre-enqueue rejection releases the hold but consumes a submission attempt', async t => {
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.send_input') { delete response.result; response.error = { code: 'invalid_key' }; }
    socket.write(JSON.stringify(response) + '\n');
  } });
  const { console, client, job, proposal } = await approved(t, h);
  const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(receipt.submission_state, 'rejected');
  assert.equal(receipt.observation_state, 'not_started');
  assert.equal(receipt.exit_code, null);
  assert.equal((await console.command('status')).held_terminals.length, 0);
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'rejected');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  assert.equal(receipt.job_id, job.job_id);
});

test('ACK loss preserves unknown submission even when completion is later observed', async t => {
  const h = await executingHarness(t, { respond(socket, request, response) {
    if (request.method === 'pane.send_input') socket.end();
    else socket.write(JSON.stringify(response) + '\n');
  } });
  const { client, job, proposal } = await approved(t, h, 'sleep 0.1; exit 0');
  const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(receipt.submission_state, 'unknown');
  await new Promise(resolve => setTimeout(resolve, 300));
  const observed = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(observed.submission_state, 'unknown');
  assert.equal(observed.observation_state, 'completion_observed');
  assert.equal(observed.exit_code, 0);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('A held terminal blocks another approved job and cancellation after acceptance sends no Ctrl-C', async t => {
  const h = await executingHarness(t), { console, client, job, proposal } = await approved(t, h, 'sleep 0.3; exit 0');
  const other = await connect(console.ready.socket, t);
  const start = await other.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scope, cwd: h.root, paths: [h.root] } });
  await other.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  const next = await other.call('action_propose', { ...action(start.job_id), cwd: h.root, affected_paths: [h.root] });
  await console.command(`review ${next.proposal_id}`); await console.command(`approve ${next.proposal_id}`);
  await client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal((await other.call('action_submit', { proposal_id: next.proposal_id })).error, 'terminal_held');
  await client.call('job_cancel', { job_id: job.job_id });
  await new Promise(resolve => setTimeout(resolve, 450));
  const after = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(after.observation_state, 'completion_observed');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  assert.ok(h.calls.filter(call => call.method === 'pane.send_input').every(call => call.params.keys[0] === 'Enter'));
});

test('Accepted input with missing, echoed or duplicated markers remains held with unknown outcome', async t => {
  for (const mode of ['missing', 'echo', 'duplicate', 'partial']) await t.test(mode, async t => {
    let h;
    h = await executingHarness(t, { execute: false, respond(socket, request, response) {
      if (request.method === 'pane.send_input') {
        const nonce = request.params.text.match(/[a-f0-9]{32}/)[0];
        h.state.text = mode === 'duplicate' ? `__HERDR_END_${nonce}__:0\n__HERDR_END_${nonce}__:7` : mode === 'echo' ? request.params.text : mode === 'partial' ? request.params.text.slice(0, 25) : 'passed\nERROR\nshell prompt >';
      }
      socket.write(JSON.stringify(response) + '\n');
    } });
    const { console, client, job, proposal } = await approved(t, h, 'exit 0', { observationMs: 250 });
    assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'accepted');
    await new Promise(resolve => setTimeout(resolve, 400));
    const receipt = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
    assert.equal(receipt.submission_state, 'accepted');
    assert.equal(receipt.observation_state, 'outcome_unknown');
    assert.equal(receipt.exit_code, null);
    assert.ok(receipt.hold_reason);
    assert.equal((await console.command('status')).held_terminals.length, 1);
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
    await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  });
});

test('A marker already in the baseline blocks transmission', async t => {
  const h = await executingHarness(t), { client, proposal } = await approved(t, h);
  const nonce = proposal.payload.text.match(/[a-f0-9]{32}/)[0];
  h.state.text = `__HERDR_END_${nonce}__:0`;
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'baseline_marker_conflict');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Console revocation, mode change and purge after intent still prevent socket write', async t => {
  for (const change of ['revoke', 'mode', 'purge']) await t.test(change, async t => {
    const h = await executingHarness(t, { execute: false });
    const commandPath = join(h.root, 'console-line');
    const { client, job, proposal } = await approved(t, h, ':', { beforeWireConsole: commandPath, observationMs: 100 });
    await writeFile(commandPath, change === 'mode' ? `mode ${job.pane_session_id} 2\n` : change === 'purge' ? `purge ${job.job_id}\n` : `revoke ${proposal.proposal_id}\n`);
    const receipt = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0, JSON.stringify(receipt));
    assert.equal(receipt.submission_state, 'unknown', 'committed but not sent: conservatively held, never replayed');
  });
});

test('Post-submission truncation remains visible even when completion never appears', async t => {
  let submitted = false;
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.send_input') submitted = true;
    if (submitted && request.method === 'pane.read') response.result.read.truncated = true;
    socket.write(JSON.stringify(response) + '\n');
  } });
  const { client, job, proposal } = await approved(t, h, ':', { observationMs: 150 });
  await client.call('action_submit', { proposal_id: proposal.proposal_id });
  await new Promise(resolve => setTimeout(resolve, 300));
  const receipt = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
  assert.equal(receipt.observation_state, 'outcome_unknown');
  assert.equal(receipt.observation.truncated, true);
});

test('Byte cropping or redaction cannot turn a partial or missing Evidence row into completion', async t => {
  for (const kind of ['partial', 'redaction']) await t.test(kind, async t => {
    let h;
    h = await executingHarness(t, { execute: false, respond(socket, request, response) {
      if (request.method === 'pane.send_input') {
        const marker = `__HERDR_END_${request.params.text.match(/[a-f0-9]{32}/)[0]}__:7`;
        h.state.text = kind === 'partial' ? 'not an independent marker: ' + marker + '\n' + 'x'.repeat(65536 - Buffer.byteLength(marker) - 1) : marker + '\n' + 'X'.repeat(4500);
      }
      socket.write(JSON.stringify(response) + '\n');
    } });
    const { console, client, job, proposal } = await approved(t, h, ':', { observationMs: 150, redactionPatterns: kind === 'redaction' ? ['X'] : [] });
    await client.call('action_submit', { proposal_id: proposal.proposal_id });
    await new Promise(resolve => setTimeout(resolve, 300));
    const receipt = await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id });
    assert.equal(receipt.observation_state, 'outcome_unknown', JSON.stringify(receipt));
    assert.equal(receipt.exit_code, null);
    assert.equal(receipt.evidence, null);
    assert.equal(receipt.observation.truncated, true);
    assert.equal((await console.command('status')).held_terminals.length, 1);
  });
});

test('Terminal control bytes cannot hide an interrupt in an execute proposal', async t => {
  const h = await executingHarness(t), { client, job } = await approved(t, h);
  for (const input of [{ command: '\u0003' }, { command: 'echo\tcomplete' }, { env: { VALUE: '\u001b[A' } }, { cwd: h.root + '/\u0085' }]) {
    const response = await client.call('action_propose', { ...action(job.job_id), cwd: h.root, affected_paths: [h.root], ...input });
    assert.equal(response.error, 'terminal_control_unsupported');
  }
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('A real SQLite write lock fails the intent without consuming approval or sending input', async t => {
  const h = await executingHarness(t), { console, client, job, proposal } = await approved(t, h);
  const blocker = new Database(join(dirname(console.ready.socket), 'ledger.sqlite'));
  try {
    blocker.exec('BEGIN IMMEDIATE');
    assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'ledger_commit_failed');
    assert.equal((await client.call('action_status', { job_id: job.job_id, proposal_id: proposal.proposal_id })).authorization, 'user_approval');
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
    blocker.exec('ROLLBACK');
    assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'accepted');
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  } finally { blocker.close(); }
});

test('Three ordinary attempts include verified rejection and a fourth proposal cannot bypass the limit', async t => {
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.send_input') { delete response.result; response.error = { code: 'pane_send_failed' }; }
    socket.write(JSON.stringify(response) + '\n');
  } });
  const { console, client, job, proposal } = await approved(t, h, ':');
  for (let index = 0; index < 4; index++) {
    const current = index === 0 ? proposal : await client.call('action_propose', { ...action(job.job_id), command: ':', cwd: h.root, affected_paths: [h.root] });
    await console.command(`review ${current.proposal_id}`); await console.command(`approve ${current.proposal_id}`);
    const receipt = await client.call('action_submit', { proposal_id: current.proposal_id });
    assert.equal(index < 3 ? receipt.submission_state : receipt.error, index < 3 ? 'rejected' : 'action_budget_exhausted', JSON.stringify(receipt));
  }
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 3);
});

test('Cancellation and revocation arriving during the passive baseline block the first wire', async t => {
  for (const change of ['cancel', 'revoke', 'mode']) await t.test(change, async t => {
    const h = await executingHarness(t), { console, client, job, proposal } = await approved(t, h);
    h.state.respond = async (socket, request, response) => {
      if (request.method === 'pane.read') {
        if (change === 'cancel') await client.call('job_cancel', { job_id: job.job_id });
        else await console.command(change === 'mode' ? `mode ${job.pane_session_id} 2` : `revoke ${proposal.proposal_id}`);
      }
      socket.write(JSON.stringify(response) + '\n');
    };
    const result = await client.call('action_submit', { proposal_id: proposal.proposal_id });
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
  });
});

test('Actual Broker crashes around the SQLite intent recover without replaying input', async t => {
  const { once } = await import('node:events');
  for (const point of ['before_intent', 'in_transaction', 'after_intent', 'after_wire', 'before_ack_record', 'after_ack_record']) await t.test(point, async t => {
    const h = await executingHarness(t, { execute: false });
    const { console, client, proposal } = await approved(t, h, 'printf crash-fixture', { fault: point });
    const stopped = once(console.child, 'close');
    void client.call('action_submit', { proposal_id: proposal.proposal_id });
    await stopped;
    const count = h.calls.filter(call => call.method === 'pane.send_input').length;
    assert.equal(count, ['after_wire', 'before_ack_record', 'after_ack_record'].includes(point) ? 1 : 0);
    const replacement = await consoleProcess(t, h);
    const recovered = await replacement.command('status');
    assert.equal(recovered.held_terminals.length, ['before_intent', 'in_transaction'].includes(point) ? 0 : 1);
    if (recovered.receipts.length) {
      const receipt = recovered.receipts[0];
      assert.equal(receipt.submission_state, point === 'after_ack_record' ? 'accepted' : 'unknown');
      assert.equal(receipt.observation_state, 'outcome_unknown');
      assert.equal(receipt.exit_code, null);
      assert.ok(!JSON.stringify(recovered).includes('crash-fixture'));
      const newOwner = await connect(replacement.ready.socket, t);
      assert.equal((await newOwner.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'proposal_unavailable');
      const freshJob = await newOwner.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scope, cwd: h.root, paths: [h.root] } });
      const ready = await newOwner.call('job_wait', { job_id: freshJob.job_id, wait_ms: 1000 });
      await replacement.command(`mode ${ready.pane_session_id} 1`);
      const fresh = await newOwner.call('action_propose', { ...action(freshJob.job_id), cwd: h.root, affected_paths: [h.root] });
      await replacement.command(`review ${fresh.proposal_id}`); await replacement.command(`approve ${fresh.proposal_id}`);
      assert.equal((await newOwner.call('action_submit', { proposal_id: fresh.proposal_id })).error, 'terminal_held');
    }
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, count);
  });
});
