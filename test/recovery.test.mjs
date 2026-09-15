import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { unlink, chmod, writeFile, open, truncate } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { executingHarness, approved } from './execution-harness.mjs';
import { action, scope } from './action-harness.mjs';
import { pane, connect } from './harness.mjs';
import { consoleProcess } from './console-harness.mjs';

async function proposal(h, client) {
  const initial = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scope, cwd: h.root, paths: [h.root] } });
  const job = await client.call('job_wait', { job_id: initial.job_id, wait_ms: 1000 });
  return { job, proposal: await client.call('action_propose', { ...action(job.job_id), command: ':', cwd: h.root, affected_paths: [h.root] }) };
}

async function restart(h, stateRoot = join(h.root, 'state')) {
  const child = spawn(process.execPath, ['test/process-fixture.mjs', 'serve', h.endpoint, stateRoot], { stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdout.once('data', () => child.stdin.end('status\nquit\n'));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  const [code] = await once(child, 'close'); clearTimeout(timer);
  return { code, stdout, stderr };
}

test('An unsupported Herdr at first bootstrap can be corrected and retried without deleting state', async t => {
  const h = await executingHarness(t, { execute: false });
  let protocol = 21;
  h.state.respond = (socket, request, response) => {
    if (request.method === 'ping') response.result.protocol = protocol;
    socket.write(JSON.stringify(response) + '\n');
  };
  const stateRoot = join(h.root, 'first-bootstrap');
  const failed = await restart(h, stateRoot);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /herdr_unsupported/);
  protocol = 22;
  const retried = await restart(h, stateRoot);
  assert.equal(retried.code, 0, JSON.stringify(retried));
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('A late matching ACK supplements submission without claiming completion or repeating input', async t => {
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const h = await executingHarness(t, { execute: false, core: { observationMs: 6500 }, respond(socket, request, response) {
    if (request.method === 'pane.send_input') timers.push(setTimeout(() => socket.write(JSON.stringify(response) + '\n'), 5200));
    else socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect(), current = await proposal(h, client);
  const first = await client.call('action_submit', { proposal_id: current.proposal.proposal_id });
  assert.equal(first.submission_state, 'unknown');
  assert.equal(first.exit_code, null);
  await new Promise(resolve => setTimeout(resolve, 400));
  const after = await client.call('action_status', { job_id: current.job.job_id, proposal_id: current.proposal.proposal_id });
  assert.equal(after.submission_state, 'accepted');
  assert.equal(after.observation_state, 'observing');
  assert.equal(after.exit_code, null);
  assert.ok(after.hold_reason);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  const another = await proposal(h, client);
  assert.equal((await client.call('action_submit', { proposal_id: another.proposal.proposal_id })).error, 'terminal_held');
});

test('Partial ACK bytes cannot extend the initial five-second submission deadline', async t => {
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const h = await executingHarness(t, { execute: false, core: { observationMs: 6500 }, respond(socket, request, response) {
    if (request.method !== 'pane.send_input') { socket.write(JSON.stringify(response) + '\n'); return; }
    const reply = JSON.stringify(response) + '\n';
    timers.push(setTimeout(() => socket.write(reply.slice(0, 10)), 1000));
    timers.push(setTimeout(() => socket.write(reply.slice(10)), 5200));
  } });
  const client = await h.connect(), current = await proposal(h, client);
  const first = await client.call('action_submit', { proposal_id: current.proposal.proposal_id });
  assert.equal(first.submission_state, 'unknown');
  await new Promise(resolve => setTimeout(resolve, 400));
  const after = await client.call('action_status', { job_id: current.job.job_id, proposal_id: current.proposal.proposal_id });
  assert.equal(after.submission_state, 'accepted');
  assert.equal(after.exit_code, null);
  assert.ok(after.hold_reason);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Losing both ledger files after initialization cannot silently create an empty ledger on restart', async t => {
  const h = await executingHarness(t, { execute: false }), client = await h.connect(), current = await proposal(h, client);
  await client.call('action_submit', { proposal_id: current.proposal.proposal_id });
  const directory = dirname(h.core.socketPath);
  await h.core.close();
  await unlink(join(directory, 'ledger.sqlite'));
  await unlink(join(directory, 'ledger.identity'));
  const result = await restart(h);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.stderr, /ledger_missing/);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Loss or tampering of live ledger storage blocks a proposal before any wire input', async t => {
  for (const kind of ['database missing', 'identity missing', 'identity modified', 'wal missing', 'shm missing', 'wal permissions', 'database corrupt']) await t.test(kind, async t => {
    const h = await executingHarness(t, { execute: false }), client = await h.connect(), current = await proposal(h, client);
    const directory = dirname(h.core.socketPath);
    if (kind === 'database missing') await unlink(join(directory, 'ledger.sqlite'));
    else if (kind === 'identity missing') await unlink(join(directory, 'ledger.identity'));
    else if (kind === 'identity modified') await writeFile(join(directory, 'ledger.identity'), 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    else if (kind === 'wal missing') await unlink(join(directory, 'ledger.sqlite-wal'));
    else if (kind === 'shm missing') await unlink(join(directory, 'ledger.sqlite-shm'));
    else if (kind === 'wal permissions') await chmod(join(directory, 'ledger.sqlite-wal'), 0o644);
    else { const file = await open(join(directory, 'ledger.sqlite'), 'r+'); await file.write(Buffer.from('not a database!!'), 0, 16, 0); await file.close(); }
    const receipt = await client.call('action_submit', { proposal_id: current.proposal.proposal_id });
    assert.equal(receipt.error, 'ledger_unavailable', JSON.stringify(receipt));
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
  });
});

test('A missing committed WAL after an actual crash cannot restore an older empty database', async t => {
  const h = await executingHarness(t, { execute: false });
  const { console, client, proposal: current } = await approved(t, h, ':', { fault: 'after_ack_record' });
  const stopped = once(console.child, 'close');
  void client.call('action_submit', { proposal_id: current.proposal_id });
  await stopped;
  await unlink(join(dirname(console.ready.socket), 'ledger.sqlite-wal'));
  const result = await restart(h);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.stderr, /ledger_missing|ledger_invalid/);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('A truncated committed WAL after an actual crash cannot erase a hold or consumed ID', async t => {
  const h = await executingHarness(t, { execute: false });
  const { console, client, proposal: current } = await approved(t, h, ':', { fault: 'after_ack_record' });
  const stopped = once(console.child, 'close');
  void client.call('action_submit', { proposal_id: current.proposal_id });
  await stopped;
  await truncate(join(dirname(console.ready.socket), 'ledger.sqlite-wal'), 0);
  const result = await restart(h);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.stderr, /ledger_missing|ledger_invalid/);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Owner disconnect stops pending work while a submitted Action is observed by the surviving core', async t => {
  const h = await executingHarness(t), console = await consoleProcess(t, h), client = await connect(console.ready.socket, t);
  const current = await proposal(h, client);
  assert.equal((await client.call('action_submit', { proposal_id: current.proposal.proposal_id })).submission_state, 'accepted');
  client.close();
  const other = await connect(console.ready.socket, t);
  assert.equal((await other.call('job_status', { job_id: current.job.job_id })).error, 'job_unavailable');
  await new Promise(resolve => setTimeout(resolve, 250));
  const status = await console.command('status');
  assert.equal(status.jobs[0].phase, 'cancelled');
  assert.equal(status.receipts[0].observation_state, 'completion_observed');
  assert.equal(status.receipts[0].exit_code, 0);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Malformed, mismatched, ambiguous and partial replies remain unknown without any supplementary input', async t => {
  for (const failure of ['malformed', 'wrong-id', 'ambiguous', 'partial']) await t.test(failure, async t => {
    const h = await executingHarness(t, { execute: false, core: { observationMs: 150 }, respond(socket, request, response) {
      if (request.method === 'pane.send_input') {
        if (failure === 'malformed') { socket.end('invalid\n'); return; }
        if (failure === 'wrong-id') response.id = 'unrelated';
        if (failure === 'ambiguous') { delete response.result; response.error = { code: 'server_unavailable' }; }
        if (failure === 'partial') { socket.end(JSON.stringify(response).slice(0, 10)); return; }
      }
      socket.write(JSON.stringify(response) + '\n');
    } });
    const client = await h.connect(), current = await proposal(h, client);
    assert.equal((await client.call('action_submit', { proposal_id: current.proposal.proposal_id })).submission_state, 'unknown');
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = await client.call('action_submit', { proposal_id: current.proposal.proposal_id });
    assert.equal(after.observation_state, 'outcome_unknown');
    assert.equal(after.exit_code, null);
    const next = await proposal(h, client);
    assert.equal((await client.call('action_submit', { proposal_id: next.proposal.proposal_id })).error, 'terminal_held');
    assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  });
});

test('Purge and seven-day compaction preserve consumed IDs and an unresolved hold across restart', async t => {
  const h = await executingHarness(t), clock = join(h.root, 'clock');
  await writeFile(clock, '1000');
  const console = await consoleProcess(t, h, { clockPath: clock, observationMs: 150 }), client = await connect(console.ready.socket, t);
  const resolved = await proposal(h, client);
  await client.call('action_submit', { proposal_id: resolved.proposal.proposal_id });
  await new Promise(resolve => setTimeout(resolve, 250));
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.send_input') response.result = { type: 'ok' };
    socket.write(JSON.stringify(response) + '\n');
  };
  const held = await proposal(h, client);
  await client.call('action_submit', { proposal_id: held.proposal.proposal_id });
  await new Promise(resolve => setTimeout(resolve, 250));
  await console.command('purge all');
  await console.command(`mode ${held.job.pane_session_id} 3`);
  const before = await console.command('status');
  assert.equal(before.control_record_count, 2);
  assert.equal(before.consumed_proposal_count, 2);
  assert.equal(before.held_terminal_count, 1);
  await writeFile(clock, String(1000 + 7 * 86400000 - 1));
  assert.equal((await console.command('status')).control_record_count, 2);
  await writeFile(clock, String(1000 + 7 * 86400000 + 1));
  const after = await console.command('status');
  assert.equal(after.control_record_count, 1);
  assert.equal(after.consumed_proposal_count, 2);
  assert.equal(after.receipts[0].proposal_id, held.proposal.proposal_id);
  assert.equal(after.receipts[0].observation_state, 'outcome_unknown');
  const stopped = once(console.child, 'close'); console.child.stdin.end('quit\n'); await stopped;
  const result = await restart(h);
  assert.equal(result.code, 0, JSON.stringify(result));
  const restored = JSON.parse(result.stdout.trim().split('\n')[1]);
  assert.equal(restored.held_terminal_count, 1);
  assert.equal(restored.consumed_proposal_count, 2);
  assert.equal(restored.receipts[0].exit_code, null);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 2);
});

test('A second actual core cannot remove the live socket, and lost authority blocks input', async t => {
  const h = await executingHarness(t), client = await h.connect(), current = await proposal(h, client);
  const rival = await restart(h);
  assert.equal(rival.code, 1);
  assert.match(rival.stderr, /authority_busy/);
  assert.equal((await client.call('job_status', { job_id: current.job.job_id })).phase, 'result_ready');
  await unlink(join(dirname(h.core.socketPath), 'authority.sqlite'));
  assert.equal((await client.call('action_submit', { proposal_id: current.proposal.proposal_id })).error, 'authority_lost');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Console bounds held-terminal listings while preserving every durable hold', async t => {
  let target = { ...pane };
  const h = await executingHarness(t, { execute: false, respond(socket, request, response) {
    if (request.method === 'pane.get') response.result.pane = target;
    socket.write(JSON.stringify(response) + '\n');
  } });
  const console = await consoleProcess(t, h, { observationMs: 100 }), client = await connect(console.ready.socket, t);
  for (let index = 0; index < 40; index++) {
    target = { ...pane, terminal_id: `terminal-${index}` };
    const initial = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scope, cwd: h.root, paths: [h.root] } });
    await client.call('job_wait', { job_id: initial.job_id, wait_ms: 1000 });
    const proposal = await client.call('action_propose', { ...action(initial.job_id), command: ':', target: { ...action(initial.job_id).target, terminal_id: target.terminal_id }, cwd: h.root, affected_paths: [h.root] });
    assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).submission_state, 'accepted');
  }
  const status = await console.command('status');
  assert.equal(status.held_terminal_count, 40);
  assert.equal(status.held_terminals.length, 32);
  assert.equal(status.held_terminals_truncated, true);
  assert.equal(status.consumed_proposal_count, 40);
});
