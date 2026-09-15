import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { chmod, readdir } from 'node:fs/promises';
import { harness, pane, connect } from './harness.mjs';
import { consoleProcess } from './console-harness.mjs';
import { action, scope } from './action-harness.mjs';

async function doctor(endpoint, stateRoot, consoleId) {
  const child = spawn(process.execPath, ['test/process-fixture.mjs', 'doctor', endpoint, stateRoot, ...(consoleId ? [consoleId] : [])], { stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end();
  const [code] = await once(child, 'close');
  assert.ok(stdout, stderr);
  return { code, report: JSON.parse(stdout) };
}

test('Doctor checks the selected Console storage and detects its unsafe ledger permissions', async t => {
  const consoleId = 'd4f50e8a-59df-4a84-b87a-8253e48fb5f6';
  const h = await harness(t, { core: { consoleId, scope: { workspace_id: pane.workspace_id, tab_id: pane.tab_id, terminals: new Map([[pane.pane_id, pane.terminal_id]]) } } });
  const directory = dirname(h.core.socketPath);
  const normal = await doctor(h.endpoint, join(h.root, 'state'), consoleId);
  assert.equal(normal.report.state.directory, directory);
  assert.equal(normal.report.state.ok, true);
  const ledger = join(directory, 'ledger.sqlite');
  await chmod(ledger, 0o644);
  try { assert.equal((await doctor(h.endpoint, join(h.root, 'state'), consoleId)).report.state.error, 'state_permissions'); }
  finally { await chmod(ledger, 0o600); }
});

test('Doctor checks pinned runtime and state without pane input or consuming first-start initialization', async t => {
  const h = await harness(t), before = h.calls.length, stateRoot = join(h.root, 'doctor-first');
  const result = await doctor(h.endpoint, stateRoot);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.report.ok, true);
  assert.equal(result.report.runtime.node.split('.')[0], '24');
  assert.equal(result.report.herdr.protocol, 22);
  assert.equal(result.report.worker.model_requested, 'gpt-5.6-luna');
  assert.equal(result.report.worker.model_availability, 'not_probed');
  assert.equal(result.report.state.initialized, false);
  assert.deepEqual(await readdir(stateRoot), []);
  assert.ok(h.calls.slice(before).every(call => call.method === 'ping'));
  const { startCore } = await import('../dist/core.js');
  const first = await startCore({ endpoint: h.endpoint, stateRoot });
  t.after(() => first.close());
  assert.ok((await connect(first.socketPath, t)).hello.result.serverInfo);
});

test('Doctor reports unsafe state permissions instead of repairing or printing diagnostic bodies', async t => {
  const h = await harness(t, { text: 'PRIVATE_SYNTHETIC_DIAGNOSTIC' });
  await chmod(dirname(h.core.socketPath), 0o755);
  const result = await doctor(h.endpoint, join(h.root, 'state'));
  assert.equal(result.code, 1);
  assert.equal(result.report.state.error, 'state_permissions');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SYNTHETIC_DIAGNOSTIC'));
});


test('Interactive status exposes session, approval and remaining budgets without command or Evidence bodies', async t => {
  const h = await harness(t, { text: 'PRIVATE_SYNTHETIC_DIAGNOSTIC' });
  const terminal = await consoleProcess(t, h), client = await connect(terminal.ready.socket, t);
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope });
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  await terminal.command(`mode ${ready.snapshot.pane_session_id} 1`);
  const proposal = await client.call('action_propose', { ...action(start.job_id), command: 'echo PRIVATE_COMMAND_BODY' });
  const status = await terminal.command('status');
  assert.equal(status.jobs[0].pane_id, pane.pane_id);
  assert.equal(status.jobs[0].ordinary_attempts_remaining, 3);
  assert.equal(status.jobs[0].interrupt_attempts_remaining, 1);
  assert.equal(status.jobs[0].worker_calls_remaining, 4);
  assert.equal(status.sessions[0].action_mode, 1);
  assert.equal(status.proposals[0].authorization, 'approval_required');
  assert.ok(status.jobs[0].parent_payload_bytes_remaining < 16384);
  assert.ok(!JSON.stringify(status).includes('PRIVATE_'));
  assert.equal((await terminal.command('help')).action_supported, true);
  await terminal.command(`purge ${start.job_id}`);
  assert.ok((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Default 64 MiB accounting rejects active-only pressure and explicit purge frees body capacity', async t => {
  const h = await harness(t, { text: Array(1000).fill('Synthetic log row ' + 'x'.repeat(45)).join('\n') });
  const terminal = await consoleProcess(t, h), client = await connect(terminal.ready.socket, t);
  let refused, first;
  for (let index = 0; index < 500; index++) {
    const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'pressure' });
    if (start.error) { refused = start; break; }
    const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
    first ??= ready;
    if (ready.error) { refused = ready; break; }
    assert.equal(ready.result?.kind, 'prepared_context');
  }
  assert.equal(refused?.error, 'memory_budget_exhausted');
  const full = await terminal.command('status');
  assert.equal(full.memory_limit_bytes, 67108864);
  assert.ok(full.memory_bytes <= full.memory_limit_bytes);
  assert.ok(full.job_count > 100);
  await terminal.command('purge all');
  const after = await terminal.command('status');
  assert.ok(after.memory_bytes < full.memory_bytes / 2);
  const expired = await client.call('evidence_get', { job_id: first.job_id, evidence_id: `${first.snapshot.snapshot_id}:L0001` });
  assert.equal(expired.error, 'evidence_expired');
  const fresh = await client.call('job_start', { pane_id: pane.pane_id, objective: 'after purge' });
  assert.equal((await client.call('job_wait', { job_id: fresh.job_id, wait_ms: 1000 })).result?.kind, 'prepared_context');
});


test('Doctor rejects an owner read-only ledger without claiming it is writable or repairing permissions', async t => {
  const h = await harness(t), ledger = join(dirname(h.core.socketPath), 'ledger.sqlite');
  await chmod(ledger, 0o400);
  try {
    const result = await doctor(h.endpoint, join(h.root, 'state'));
    assert.equal(result.code, 1);
    assert.equal(result.report.state.error, 'state_permissions');
    const { lstat } = await import('node:fs/promises');
    assert.equal((await lstat(ledger)).mode & 0o777, 0o400);
  } finally { await chmod(ledger, 0o600); }
});
