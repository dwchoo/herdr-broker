import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, pane } from './harness.mjs';

test('Parent discovers passive tools and describes the exact pane without input', async t => {
  const h = await harness(t);
  const client = await h.connect();
  assert.equal(client.hello.result.serverInfo.name, 'herdr-broker');
  const tools = await client.request('tools/list', {});
  for (const tool of tools.result.tools) {
    assert.equal(tool.annotations?.readOnlyHint, ['pane_describe', 'job_status', 'job_wait', 'evidence_get', 'action_status'].includes(tool.name));
    assert.equal(tool.annotations?.destructiveHint, tool.name === 'action_submit');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(), ['pane_describe', 'job_start', 'job_status', 'job_wait', 'job_cancel', 'evidence_get', 'action_propose', 'action_status', 'action_submit', 'session_lower_mode'].sort());
  const result = await client.call('pane_describe', { pane_id: pane.pane_id });
  assert.deepEqual(result.target, { pane_id: 'ws:pane', terminal_id: 'terminal-1', workspace_id: 'ws', tab_id: 'tab-1' });
  assert.equal(result.context.cwd, '/fixture');
  assert.deepEqual(h.calls.map(call => call.method), ['ping', 'ping', 'pane.get', 'pane.process_info']);
  assert.equal(h.calls[2].params.pane_id, 'ws:pane');
});

test('Parent receives immutable prepared context while the observation job remains active', async t => {
  const h = await harness(t);
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'Explain the build outcome', analysis: 'auto' });
  assert.ok(start.job_id);
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  assert.equal(ready.phase, 'result_ready');
  assert.equal(ready.job_ended, false);
  assert.equal(ready.action_state, 'scope_required');
  assert.equal(ready.result.kind, 'prepared_context');
  assert.match(ready.result.text, /build failed: missing module/);
  assert.match(ready.result.text, /unknown detail/);
  assert.match(ready.result.text, /build passed/);
  assert.match(ready.result.text, new RegExp(ready.snapshot.snapshot_id + ':L0001'));
  const again = await client.call('job_status', { job_id: start.job_id });
  assert.equal(again.snapshot.snapshot_id, ready.snapshot.snapshot_id);
  assert.equal(again.result.text, ready.result.text);
  const cancel = await client.call('job_cancel', { job_id: start.job_id });
  assert.equal(cancel.phase, 'cancelled');
  assert.equal(cancel.job_ended, true);
  const reads = h.calls.filter(call => call.method === 'pane.read');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].params, { pane_id: 'ws:pane', source: 'recent', lines: 1000, format: 'ansi', strip_ansi: false });
  assert.ok(h.calls.every(call => ['ping', 'pane.get', 'pane.read', 'pane.process_info'].includes(call.method)));
});

test('Snapshot normalizes terminal rows and redacts credentials before preserving evidence', async t => {
  const secret = 'ghp_' + 'A'.repeat(36);
  const h = await harness(t, { text: '\x1b[31merror\x1b[0m\nprogress 10%\rprogress 90%\nPASS\nPASS\nunknown result\npassword=hunter2\n' + secret + '\n-----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----\ncustom-sensitive\ncontradictory success', core: { redactionPatterns: ['custom-sensitive'] } });
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose' });
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  const body = JSON.stringify(ready);
  for (const secretText of ['hunter2', secret, 'secret-key-body', 'custom-sensitive', '\\u001b', 'progress 10%']) assert.ok(!body.includes(secretText), secretText);
  assert.match(ready.result.text, /progress 90%/);
  assert.match(ready.result.text, /unknown result/);
  assert.match(ready.result.text, /contradictory success/);
  assert.match(ready.result.text, /:L0003\.\..*:L0004 \[count=2 omitted=1\] PASS/);
  assert.equal(ready.snapshot.redaction.version, 'basic-v1');
  assert.ok(ready.snapshot.redaction.count >= 4);
  assert.equal(ready.snapshot.row_mapping.normalized_to_physical, 'one_to_one');
});

test('Snapshot enforces row and UTF-8 byte limits and routes oversized context to unsupported Worker', async t => {
  const h = await harness(t, { text: Array(1005).fill('repeat').join('\n') });
  const client = await h.connect();
  const observe = async analysis => {
    const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis });
    return client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  };
  const rows = await observe('auto');
  assert.equal(rows.snapshot.physical_rows, 1000);
  assert.equal(rows.snapshot.row_mapping.first_physical_row, 6);
  assert.equal(rows.snapshot.truncated, true);
  assert.ok(rows.snapshot.gaps.includes('row_limit'));
  assert.match(rows.result.text, /count=1000 omitted=999/);
  h.state.text = '가'.repeat(30000);
  const bytes = await observe('auto');
  assert.equal(bytes.error, 'worker_unsupported');
  assert.equal(bytes.result, undefined);
  assert.equal(bytes.snapshot.utf8_bytes, 65535);
  assert.equal(bytes.snapshot.row_mapping.first_row_partial, true);
  assert.ok(bytes.snapshot.gaps.includes('byte_limit'));
  assert.ok(!JSON.stringify(bytes).includes('�'));
  h.state.text = 'x'.repeat(4053); // 43-byte Evidence prefix + 4053 = 4096.
  assert.equal((await observe('auto')).result.kind, 'prepared_context');
  h.state.text += 'x';
  assert.equal((await observe('auto')).error, 'worker_unsupported');
  const before = h.calls.length;
  assert.equal((await observe('worker')).error, 'worker_unsupported');
  assert.ok(h.calls.length > before); // Explicit Worker also captures the full bounded Snapshot.
});

test('Delegation Jobs enforce connection ownership, deadlines, wait timeout, and cumulative delivery', async t => {
  let now = Date.now();
  const h = await harness(t, { text: 'x'.repeat(2000), core: { now: () => now } });
  const client = await h.connect();
  const stranger = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose' });
  assert.equal(start.budget.deadline_ms, 300000);
  for (const tool of ['job_status', 'job_wait', 'job_cancel']) assert.equal((await stranger.call(tool, { job_id: start.job_id, ...(tool === 'job_wait' ? { wait_ms: 0 } : {}) })).error, 'job_unavailable');
  await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  let notice;
  for (let index = 0; index < 10; index++) {
    const response = await client.call('job_status', { job_id: start.job_id });
    if (response.error === 'parent_budget_exhausted') { notice = response; break; }
  }
  assert.ok(notice);
  const delivered = client.deliveries.filter(text => JSON.parse(text).job_id === start.job_id).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  assert.equal(notice.budget.parent_payload_bytes_used, delivered);
  assert.ok(delivered <= 16384);
  assert.deepEqual(await client.call('job_status', { job_id: start.job_id }), { payload_omitted: true });
  const delayed = [];
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.read') delayed.push(() => { if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n'); });
    else socket.write(JSON.stringify(response) + '\n');
  };
  const pending = await client.call('job_start', { pane_id: pane.pane_id, objective: 'waiting', budget: { deadline_ms: 50 } });
  const timeout = await client.call('job_wait', { job_id: pending.job_id, wait_ms: 1 });
  assert.equal(timeout.phase, 'observing');
  assert.equal(timeout.wait_timed_out, true);
  now += 51;
  const expired = await client.call('job_status', { job_id: pending.job_id });
  assert.equal(expired.phase, 'deadline');
  assert.equal(expired.job_ended, true);
  const before = h.calls.length;
  for (const reply of delayed) reply();
  assert.equal((await client.call('job_wait', { job_id: pending.job_id, wait_ms: 0 })).result, undefined);
  assert.equal(h.calls.length, before);
  now += 30 * 60 * 1000 + 1;
  assert.equal((await client.call('job_status', { job_id: pending.job_id })).data_state, 'expired');
});

test('Retained diagnostic memory evicts ended bodies first and refuses active overflow', async t => {
  const h = await harness(t, { core: { memoryLimit: 45000 } });
  const client = await h.connect();
  const start = async () => client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose' });
  const first = await start();
  await client.call('job_wait', { job_id: first.job_id, wait_ms: 1000 });
  await client.call('job_cancel', { job_id: first.job_id });
  const second = await start();
  await client.call('job_wait', { job_id: second.job_id, wait_ms: 1000 });
  const third = await start();
  await client.call('job_wait', { job_id: third.job_id, wait_ms: 1000 });
  assert.equal((await client.call('job_status', { job_id: first.job_id })).data_state, 'evicted');
  assert.equal((await start()).error, 'memory_budget_exhausted');
  assert.equal((await client.call('job_status', { job_id: second.job_id })).phase, 'result_ready');
});

test('Herdr version changes and malformed responses fail closed without exposing raw peer content', async t => {
  const h = await harness(t);
  const client = await h.connect();
  h.state.respond = (socket, request, response) => {
    if (request.method === 'ping') response.result.protocol = 23;
    socket.write(JSON.stringify(response) + '\n');
  };
  assert.equal((await client.call('pane_describe', { pane_id: pane.pane_id })).error, 'herdr_unsupported');
  for (const mutation of [response => { response.id = 'wrong'; }, response => { response.result.type = 'wrong'; }, response => { response.result.pane.pane_id = 'different'; }]) {
    h.state.respond = (socket, request, response) => {
      if (request.method === 'pane.get') { response = structuredClone(response); mutation(response); }
      socket.write(JSON.stringify(response) + '\n');
    };
    assert.ok(['herdr_invalid_response', 'target_changed'].includes((await client.call('pane_describe', { pane_id: pane.pane_id })).error));
  }
  h.state.respond = undefined;
  h.state.text = 'secret'.repeat(180000);
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose' });
  const failure = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  assert.equal(failure.error, 'herdr_response_too_large');
  assert.equal(failure.result, undefined);
  assert.ok(!JSON.stringify(failure).includes('secret'));
  assert.ok((await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', approved: true })).tool_error);
});

test('Cancellation during identity observation prevents capture and cannot be reversed by a late reply', async t => {
  let reply;
  const h = await harness(t, { respond(socket, request, response) {
    if (request.method === 'pane.get') reply = () => { if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n'); };
    else socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'cancel before capture' });
  await client.call('job_wait', { job_id: start.job_id, wait_ms: 5 });
  assert.equal((await client.call('job_cancel', { job_id: start.job_id })).phase, 'cancelled');
  reply?.();
  const status = await client.call('job_status', { job_id: start.job_id });
  assert.equal(status.phase, 'cancelled');
  assert.equal(status.result, undefined);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 0);
});

test('Pane mapping changes during capture invalidate the observation', async t => {
  let gets = 0;
  const h = await harness(t, { respond(socket, request, response) {
    if (request.method === 'pane.get' && ++gets === 2) response = { ...response, result: { ...response.result, pane: { ...response.result.pane, terminal_id: 'replacement-terminal' } } };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'observe identity' });
  const status = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  assert.equal(status.error, 'target_changed');
  assert.equal(status.result, undefined);
});

test('Quoted credential assignments and escaped values are redacted from JSON and YAML logs', async t => {
  const h = await harness(t, { text: '{"password":"fixture-secret","api_key":"fixture-api-value","token":"escaped\\\"token-tail"}\n\'secret\': \'yaml-sensitive\'\nstatus: unknown' });
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose' });
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  for (const value of ['fixture-secret', 'fixture-api-value', 'token-tail', 'yaml-sensitive']) assert.ok(!JSON.stringify(ready).includes(value), value);
  assert.match(ready.result.text, /status: unknown/);
});

test('Reported Parent usage equals wire text bytes across remaining-budget digit boundaries', async t => {
  const h = await harness(t);
  const client = await h.connect();
  for (let limit = 1400; limit <= 1450; limit++) {
    const response = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker', budget: { parent_payload_bytes: limit } });
    const bytes = Buffer.byteLength(client.deliveries.at(-1));
    assert.equal(response.budget.parent_payload_bytes_used, bytes, `limit=${limit}`);
    assert.equal(response.budget.parent_payload_bytes_remaining, limit - bytes);
    await client.call('job_cancel', { job_id: response.job_id });
  }
});
