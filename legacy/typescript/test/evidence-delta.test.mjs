import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, pane } from './harness.mjs';

async function observe(client, objective = 'diagnose fixture') {
  const start = await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective });
  return client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
}

test('Evidence resolves an immutable redacted row in its owning job without observing again', async t => {
  const h = await harness(t, { text: 'unknown fixture detail\npassword=fixture-secret' });
  const client = await h.connect();
  const ready = await observe(client);
  const evidenceId = `${ready.snapshot.snapshot_id}:L0002`;
  const readsBefore = h.calls.filter(call => call.method === 'pane.read').length;
  h.state.text = 'replacement output';
  const evidence = await client.call('evidence_get', { job_id: ready.job_id, evidence_id: evidenceId });
  assert.equal(evidence.evidence.items[0].evidence_id, evidenceId);
  assert.equal(evidence.evidence.items[0].text, '[REDACTED:credential]');
  assert.ok(!JSON.stringify(evidence).includes('fixture-secret'));
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, readsBefore);
  const stranger = await h.connect();
  assert.equal((await stranger.call('evidence_get', { job_id: ready.job_id, evidence_id: evidenceId })).error, 'job_unavailable');
  const otherJob = await observe(client, 'independent job');
  assert.equal((await client.call('evidence_get', { job_id: otherJob.job_id, evidence_id: evidenceId })).error, 'evidence_not_found');
  assert.equal((await client.call('evidence_get', { job_id: ready.job_id, evidence_id: evidenceId, quote: 'forged' })).error, 'invalid_tool_arguments');
});

test('Initial and additional Evidence stay within 2 KiB and expose UTF-8 continuation positions', async t => {
  const text = '가'.repeat(1000);
  const h = await harness(t, { text });
  const client = await h.connect();
  const ready = await observe(client);
  assert.ok(Buffer.byteLength(JSON.stringify(ready.evidence)) <= 2048);
  assert.equal(ready.evidence.truncated, true);
  assert.ok(!ready.evidence.items[0].text.includes('�'));
  const evidenceId = `${ready.snapshot.snapshot_id}:L0001`;
  let next = { evidence_id: evidenceId, offset_bytes: 0 };
  let reconstructed = '';
  while (next) {
    const response = await client.call('evidence_get', { job_id: ready.job_id, ...next });
    assert.ok(Buffer.byteLength(JSON.stringify(response.evidence)) <= 2048);
    reconstructed += response.evidence.items.map(item => item.text).join('');
    next = response.evidence.next;
  }
  assert.equal(reconstructed, text);
  assert.equal((await client.call('evidence_get', { job_id: ready.job_id, evidence_id: evidenceId, offset_bytes: 1 })).error, 'invalid_evidence_offset');
});

test('Acknowledged cursors refresh a job while retries reuse snapshots and old Evidence remains immutable', async t => {
  const h = await harness(t, { text: 'first observed value' });
  const client = await h.connect();
  const first = await observe(client);
  assert.equal(first.delta.kind, 'replace');
  assert.ok(first.cursor);
  const retransmitted = await client.call('job_wait', { job_id: first.job_id, wait_ms: 1000 });
  assert.equal(retransmitted.snapshot.snapshot_id, first.snapshot.snapshot_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 1);
  h.state.text = 'second observed value';
  const changed = await client.call('job_wait', { job_id: first.job_id, cursor: first.cursor, wait_ms: 1000 });
  assert.equal(changed.delta.kind, 'replace');
  assert.notEqual(changed.snapshot.snapshot_id, first.snapshot.snapshot_id);
  assert.match(changed.result.text, /second observed value/);
  const old = await client.call('evidence_get', { job_id: first.job_id, evidence_id: `${first.snapshot.snapshot_id}:L0001` });
  assert.equal(old.evidence.items[0].text, 'first observed value');
  const retry = await client.call('job_wait', { job_id: first.job_id, cursor: first.cursor, wait_ms: 1000 });
  assert.equal(retry.snapshot.snapshot_id, changed.snapshot.snapshot_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 2);
  const same = await client.call('job_wait', { job_id: first.job_id, cursor: changed.cursor, wait_ms: 1000 });
  assert.equal(same.delta.kind, 'unchanged_view');
  assert.equal(same.delta.snapshot_id, changed.snapshot.snapshot_id);
  assert.equal(same.delta.history_complete, false);
  assert.equal(same.result, undefined);
  assert.equal(same.evidence, undefined);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 3);
});

async function consoleFor(core, t) {
  const { PassThrough } = await import('node:stream');
  const { startConsole } = await import('../dist/runtime.js');
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let notify;
  output.on('data', chunk => { messages.push(...chunk.toString().trim().split('\n').map(JSON.parse)); notify?.(); });
  startConsole(core, input, output);
  messages.shift(); // ready
  t.after(() => { input.destroy(); output.destroy(); });
  return async command => {
    const available = new Promise(resolve => { notify = resolve; });
    input.write(command + '\n');
    if (!messages.length) await available;
    return messages.shift();
  };
}

test('Console purge and retention expiry remove diagnostic bodies while preserving issued IDs and spent budgets', async t => {
  let now = Date.now();
  const h = await harness(t, { text: 'retained-only-fixture', core: { now: () => now } });
  const client = await h.connect();
  const console = await consoleFor(h.core, t);
  const first = await observe(client);
  const evidenceId = `${first.snapshot.snapshot_id}:L0001`;
  const purged = await console(`purge ${first.job_id}`);
  assert.deepEqual(purged.purged_job_ids, [first.job_id]);
  const status = await client.call('job_status', { job_id: first.job_id });
  assert.equal(status.data_state, 'purged');
  assert.equal(status.job_ended, true);
  assert.equal(status.result, undefined);
  assert.equal(status.snapshot, undefined);
  assert.equal(status.cursor, undefined);
  assert.ok(status.budget.parent_payload_bytes_used > first.budget.parent_payload_bytes_used);
  const before = h.calls.length;
  assert.equal((await client.call('evidence_get', { job_id: first.job_id, evidence_id: evidenceId })).error, 'evidence_expired');
  assert.equal((await client.call('evidence_get', { job_id: first.job_id, evidence_id: evidenceId.replace('L0001', 'L0099') })).error, 'evidence_not_found');
  await client.call('job_wait', { job_id: first.job_id, cursor: first.cursor, wait_ms: 0 });
  assert.equal(h.calls.length, before);
  assert.ok(!JSON.stringify(await console('status')).includes('retained-only-fixture'));
  const second = await observe(client, 'retention');
  await client.call('job_cancel', { job_id: second.job_id });
  now += 1800000 - 1;
  const args = { job_id: second.job_id, evidence_id: `${second.snapshot.snapshot_id}:L0001` };
  assert.equal((await client.call('evidence_get', args)).evidence.items[0].text, 'retained-only-fixture');
  now++;
  assert.equal((await client.call('evidence_get', args)).error, 'evidence_expired');
  assert.equal((await client.call('job_status', { job_id: second.job_id })).data_state, 'expired');
});

test('Expired cursors replace the retained snapshot without observing or resetting the job budget and deadline', async t => {
  let now = Date.now();
  const h = await harness(t, { text: 'stable value', core: { now: () => now } });
  const client = await h.connect();
  const first = await observe(client);
  now += 59999;
  assert.equal((await client.call('job_status', { job_id: first.job_id, cursor: first.cursor })).delta.kind, 'unchanged_view');
  now++;
  const expired = await client.call('job_wait', { job_id: first.job_id, cursor: first.cursor, wait_ms: 1000 });
  assert.equal(expired.delta.kind, 'replace');
  assert.equal(expired.snapshot.snapshot_id, first.snapshot.snapshot_id);
  assert.notEqual(expired.cursor, first.cursor);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 1);
  assert.equal(expired.budget.deadline_remaining_ms, 240000);
  assert.ok(expired.budget.parent_payload_bytes_used > first.budget.parent_payload_bytes_used);
});

test('Two consumers and two jobs keep independent cursor baselines and survive another facade closing', async t => {
  const h = await harness(t, { text: 'original' });
  const a = await h.connect();
  const b = await h.connect();
  const first = await observe(a);
  const second = await observe(a, 'second job');
  const other = await observe(b, 'second consumer');
  for (const tool of ['job_status', 'job_wait', 'job_cancel']) {
    assert.equal((await b.call(tool, { job_id: first.job_id })).error, 'job_unavailable');
  }
  const foreignCursor = await a.call('job_wait', { job_id: second.job_id, cursor: first.cursor, wait_ms: 0 });
  assert.equal(foreignCursor.delta.kind, 'replace');
  assert.equal(foreignCursor.snapshot.snapshot_id, second.snapshot.snapshot_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 3);
  h.state.text = 'changed';
  const changed = await b.call('job_wait', { job_id: other.job_id, cursor: other.cursor, wait_ms: 1000 });
  assert.equal(changed.delta.kind, 'replace');
  const unchanged = await a.call('job_status', { job_id: first.job_id, cursor: first.cursor });
  assert.equal(unchanged.delta.kind, 'unchanged_view');
  assert.equal(unchanged.delta.snapshot_id, first.snapshot.snapshot_id);
  const secondReplay = await a.call('job_status', { job_id: second.job_id });
  assert.equal(secondReplay.snapshot.snapshot_id, second.snapshot.snapshot_id);
  a.close();
  const retained = await b.call('evidence_get', { job_id: other.job_id, evidence_id: `${changed.snapshot.snapshot_id}:L0001` });
  assert.equal(retained.evidence.items[0].text, 'changed');
  const c = await h.connect();
  assert.equal((await c.call('job_status', { job_id: first.job_id })).error, 'job_unavailable');
  assert.ok((await c.call('pane_describe', { pane_id: pane.pane_id })).target);
});

test('Views track gaps and redaction while a changed Pane Session requires a new job', async t => {
  const patterns = [];
  let terminal = pane.terminal_id;
  let title = 'before';
  let revision = 0;
  let truncated = false;
  const h = await harness(t, { text: 'stable text', core: { redactionPatterns: patterns }, respond(socket, request, response) {
    response = structuredClone(response);
    if (request.method === 'pane.get') Object.assign(response.result.pane, { terminal_id: terminal, title, revision });
    if (request.method === 'pane.read') Object.assign(response.result.read, { truncated, revision });
    socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect();
  const first = await observe(client);
  title = 'after'; revision = 99;
  const metadata = await client.call('job_wait', { job_id: first.job_id, cursor: first.cursor, wait_ms: 1000 });
  assert.equal(metadata.delta.kind, 'unchanged_view');
  assert.equal(metadata.delta.snapshot_id, first.snapshot.snapshot_id);
  assert.equal(metadata.observation.sequence, 2);
  truncated = true;
  const gap = await client.call('job_wait', { job_id: first.job_id, cursor: metadata.cursor, wait_ms: 1000 });
  assert.equal(gap.delta.kind, 'replace');
  assert.ok(gap.snapshot.gaps.includes('herdr_truncated'));
  terminal = 'replacement-terminal';
  const changed = await client.call('job_wait', { job_id: first.job_id, cursor: gap.cursor, wait_ms: 1000 });
  assert.equal(changed.error, 'session_changed');
  assert.equal(changed.job_ended, true);
  const session = await observe(client);
  assert.equal(session.delta.kind, 'replace');
  assert.notEqual(session.pane_session_id, first.pane_session_id);
  patterns.push('nonmatching-literal');
  const rules = await client.call('job_wait', { job_id: session.job_id, cursor: session.cursor, wait_ms: 1000 });
  assert.equal(rules.delta.kind, 'replace');
  assert.notEqual(rules.snapshot.redaction.pattern_digest, session.snapshot.redaction.pattern_digest);
  assert.notEqual(rules.snapshot.snapshot_id, session.snapshot.snapshot_id);
  assert.equal(rules.evidence.items[0].text, session.evidence.items[0].text);
  const original = await client.call('evidence_get', { job_id: first.job_id, evidence_id: `${first.snapshot.snapshot_id}:L0001` });
  assert.equal(original.evidence.items[0].text, 'stable text');
});

test('Memory pressure removes ended bodies before refusing active data and never forgets issued Evidence IDs', async t => {
  const h = await harness(t, { text: 'memory fixture', core: { memoryLimit: 24576 } });
  const client = await h.connect();
  const console = await consoleFor(h.core, t);
  const first = await observe(client);
  await client.call('job_cancel', { job_id: first.job_id });
  const second = await observe(client);
  assert.equal(second.phase, 'result_ready');
  assert.equal((await client.call('job_status', { job_id: first.job_id })).data_state, 'evicted');
  const id = `${first.snapshot.snapshot_id}:L0001`;
  assert.equal((await client.call('evidence_get', { job_id: first.job_id, evidence_id: id })).error, 'evidence_expired');
  assert.equal((await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'active overflow' })).error, 'memory_budget_exhausted');
  const purged = await console('purge all');
  assert.equal(purged.purged_job_count, 2);
  assert.equal((await client.call('job_status', { job_id: second.job_id })).data_state, 'purged');
  let refused = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const next = await client.call('job_start', { pane_id: pane.pane_id, objective: 'bounded issued IDs', analysis: 'worker' });
    if (next.error === 'memory_budget_exhausted') { refused = true; break; }
    await console(`purge ${next.job_id}`);
  }
  assert.ok(refused, 'Minimal issued-ID records must also obey the memory limit');
  assert.equal((await client.call('evidence_get', { job_id: first.job_id, evidence_id: id })).error, 'evidence_expired');
  const summary = await console('status');
  assert.ok(summary.memory_bytes <= 24576);
  assert.ok(summary.memory_bytes > 0);
  assert.ok(!JSON.stringify(summary).includes('memory fixture'));
});

test('Concurrent waits share an observation and console purge prevents late capture results', async t => {
  const h = await harness(t, { text: 'before concurrent observation' });
  const client = await h.connect();
  const console = await consoleFor(h.core, t);
  const first = await observe(client);
  let release;
  let captured;
  let pendingCapture = new Promise(resolve => { captured = resolve; });
  h.state.text = 'after concurrent observation';
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.read') {
      release = () => { if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n'); };
      captured();
    } else socket.write(JSON.stringify(response) + '\n');
  };
  const args = { job_id: first.job_id, cursor: first.cursor, wait_ms: 1000 };
  const a = client.call('job_wait', args);
  await pendingCapture;
  const b = client.call('job_wait', args);
  const timeout = await client.call('job_wait', { ...args, wait_ms: 0 });
  assert.equal(timeout.wait_timed_out, true);
  assert.equal(timeout.phase, 'observing');
  assert.equal(timeout.result, undefined);
  release();
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.snapshot.snapshot_id, two.snapshot.snapshot_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 2);
  pendingCapture = new Promise(resolve => { captured = resolve; });
  const pending = client.call('job_wait', { ...args, cursor: one.cursor });
  await pendingCapture;
  await console(`purge ${first.job_id}`);
  release();
  const purged = await pending;
  assert.equal(purged.data_state, 'purged');
  assert.equal(purged.result, undefined);
  assert.equal(purged.cursor, undefined);
  assert.equal((await client.call('evidence_get', { job_id: first.job_id, evidence_id: `${one.snapshot.snapshot_id}:L0001` })).error, 'evidence_expired');
});

test('Owned-job input failures, Evidence, cursor responses and purge share the exact delivered byte budget', async t => {
  const h = await harness(t, { text: '가나다 "quoted" \\ fixture' });
  const client = await h.connect();
  const console = await consoleFor(h.core, t);
  const first = await observe(client);
  const args = { job_id: first.job_id, evidence_id: `${first.snapshot.snapshot_id}:L0001` };
  await client.call('evidence_get', args);
  await client.call('job_status', { job_id: first.job_id, cursor: first.cursor });
  const invalid = await client.call('evidence_get', { ...args, quote: 'caller fixture must not be echoed' });
  assert.equal(invalid.error, 'invalid_tool_arguments');
  assert.ok(invalid.budget);
  await console(`purge ${first.job_id}`);
  let notice;
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await client.call(attempt % 2 ? 'job_status' : 'evidence_get', attempt % 2 ? { job_id: first.job_id, cursor: 'invalid-cursor' } : args);
    const delivered = client.deliveries.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    assert.equal(response.budget.parent_payload_bytes_used, delivered);
    assert.ok(delivered <= 16384);
    if (response.error === 'parent_budget_exhausted') { notice = response; break; }
  }
  assert.ok(notice);
  assert.equal(notice.job_ended, true);
  assert.ok(!client.deliveries.join('').includes('caller fixture'));
  const before = client.deliveries.length;
  assert.deepEqual(await client.call('evidence_get', { ...args, path: '/caller/path' }), { payload_omitted: true });
  assert.equal(client.deliveries.length, before);
});

test('A failed observation cannot mix a new Pane Session with the previous Snapshot or claim an unchanged view', async t => {
  const h = await harness(t, { text: 'old retained view', core: { memoryLimit: 22000 } });
  const client = await h.connect();
  const first = await observe(client);
  h.state.respond = (socket, request, response) => {
    response = structuredClone(response);
    if (request.method === 'pane.get') response.result.pane.terminal_id = 'replacement-terminal';
    socket.write(JSON.stringify(response) + '\n');
  };
  const failure = await client.call('job_wait', { job_id: first.job_id, cursor: first.cursor, wait_ms: 1000 });
  assert.equal(failure.error, 'session_changed');
  assert.equal(failure.pane_session_id, first.pane_session_id);
  assert.equal(failure.result_ready, false);
  for (const key of ['result', 'delta', 'snapshot', 'observation']) assert.equal(failure[key], undefined, key);
  const old = await client.call('evidence_get', { job_id: first.job_id, evidence_id: `${first.snapshot.snapshot_id}:L0001` });
  assert.equal(old.evidence.items[0].text, 'old retained view');
});

test('Initial Evidence can defer its excerpts so JSON escaping does not reject a supported prepared context', async t => {
  const h = await harness(t, { text: '\\'.repeat(2500) });
  const client = await h.connect();
  const ready = await observe(client);
  assert.equal(ready.phase, 'result_ready');
  assert.equal(ready.job_ended, false);
  assert.ok(Buffer.byteLength(ready.result.text) < 4096);
  assert.ok(Buffer.byteLength(client.deliveries.at(-1)) <= 8192);
  assert.equal(ready.evidence.truncated, true);
  assert.equal(ready.evidence.next.evidence_id, `${ready.snapshot.snapshot_id}:L0001`);
  const additional = await client.call('evidence_get', { job_id: ready.job_id, ...ready.evidence.next });
  assert.ok(additional.evidence.items[0].text.startsWith('\\'));
  assert.ok(Buffer.byteLength(JSON.stringify(additional.evidence)) <= 2048);
  const delivered = client.deliveries.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  assert.equal(additional.budget.parent_payload_bytes_used, delivered);
});

test('The 4096-byte routing boundary also obeys the independent encoded-response limit', async t => {
  const h = await harness(t, { text: 'x'.repeat(4053) });
  const client = await h.connect();
  const plain = await observe(client);
  assert.equal(Buffer.byteLength(plain.result.text), 4096);
  assert.ok(Buffer.byteLength(client.deliveries.at(-1)) <= 8192);
  h.state.text = '\\'.repeat(4053); // Same 4096 prepared bytes including the 43-byte Evidence prefix.
  const escaped = await observe(client, 'encoded response boundary');
  assert.equal(escaped.error, 'parent_budget_exhausted');
  assert.equal(escaped.job_ended, true);
  assert.equal(escaped.result, undefined);
  assert.equal(escaped.evidence, undefined);
  assert.ok(escaped.budget.parent_payload_bytes_remaining > 10000);
  const delivered = client.deliveries.filter(text => JSON.parse(text).job_id === escaped.job_id).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  assert.equal(escaped.budget.parent_payload_bytes_used, delivered);
  assert.deepEqual(await client.call('job_status', { job_id: escaped.job_id }), { payload_omitted: true });
});

test('Evidence pagination completion never clears a truncated Snapshot history', async t => {
  const h = await harness(t, { text: 'make: Error 2', respond(socket, request, response) {
    if (request.method === 'pane.read') response.result.read.truncated = true;
    socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect(), ready = await observe(client);
  const reply = await client.call('evidence_get', { job_id: ready.job_id, evidence_id: `${ready.snapshot.snapshot_id}:L0001` });
  assert.equal(ready.snapshot.truncated, true);
  assert.equal(ready.snapshot.history_complete, false);
  assert.equal(reply.evidence.truncated, false);
  assert.equal(reply.evidence.truncation_scope, 'excerpt');
  assert.match(client.hello.result.instructions, /excerpt pagination/);
});
