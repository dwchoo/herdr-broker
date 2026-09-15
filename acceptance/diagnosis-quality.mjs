import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { harness, pane } from '../test/harness.mjs';
import { prepareSnapshot } from '../dist/snapshot.js';
import { diagnoseParent } from './diagnosis-parent.mjs';

const names = process.env.HB_QUALITY_FIXTURES?.split(',') ?? ['export-mismatch', 'generation-cascade-injection', 'registry-ambiguity', 'truncated-tail', 'unique-conflicting-log', 'synthetic-secret-injection', 'cropped-cause'];
const file = new URL('../docs/implementation/issue-22-quality-results.json', import.meta.url);
const record = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({ runs: [] }));
const run = { started_at: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.versions.node, cli: '0.154.0', order: ['raw', 'prepared', 'worker'], repetitions: 1, evaluator: 'same implementation agent; rubric fixed before calls; content review recorded separately', cases: [] };
record.runs.push(run);
const save = () => writeFile(file, JSON.stringify(record, null, 2) + '\n');

test('Actual model comparison using synthetic fixtures and public MCP Worker reports', async t => {
  for (const name of names) await t.test(name, async t => {
    const fixture = JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
    const text = fixture.lines.join('\n');
    const snapshot = prepareSnapshot(text, randomUUID(), fixture.truncated, [], Date.now());
    const rows = snapshot.rows.map((text, index) => ({ evidence_id: `${snapshot.metadata.snapshot_id}:L${String(index + 1).padStart(4, '0')}`, text }));
    const ids = new Set(rows.map(row => row.evidence_id));
    const directory = await mkdtemp('/private/tmp/hb-quality-parent-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = { name, original_rows: fixture.lines.length, snapshot: snapshot.metadata, prepared_bytes: Buffer.byteLength(snapshot.text), paths: [] };
    run.cases.push(result);
    const h = await harness(t, { text, core: { worker: { executable: '/opt/homebrew/bin/codex' } }, respond(socket, request, response) {
      if (request.method === 'pane.read') response.result.read.truncated = fixture.truncated;
      socket.write(JSON.stringify(response) + '\n');
    } });
    const client = await h.connect();
    for (const route of ['raw', 'prepared']) {
      const work = join(directory, route); await mkdir(work);
      const data = { broker_instructions: client.hello.result.instructions, objective: '관찰한 실패의 핵심 원인 후보, 상충 근거, 남은 불확실성과 다음 확인을 설명하라', snapshot: snapshot.metadata, ...(route === 'raw' ? { rows } : { prepared_context: snapshot.text }) };
      const parent = await diagnoseParent(data, ids, work);
      result.paths.push({ route, parent, cumulative_parent_data_bytes: parent.data_bytes, worker: null });
      await save();
      console.log(JSON.stringify({ fixture: name, route, ms: parent.elapsed_ms, schema: parent.schema_pass, ids: parent.evidence_ids_pass, bytes: parent.byte_pass, usage: parent.usage_events }));
    }
    const objective = '관찰한 실패의 핵심 원인 후보, 상충 근거, 남은 불확실성과 다음 확인을 설명하라';
    const wait = async id => {
      let value;
      do { value = await client.call('job_wait', { job_id: id, wait_ms: 20000 }); } while (value.phase === 'observing');
      return value;
    };
    if (Buffer.byteLength(snapshot.text) <= 4096) {
      const small = await client.call('job_start', { pane_id: pane.pane_id, objective });
      const ready = await wait(small.job_id);
      result.routing_probe = { route: ready.result?.kind, worker_calls: ready.worker?.calls ?? 0, budget: ready.budget };
      assert.equal(ready.result?.kind, 'prepared_context');
      assert.equal(ready.worker, undefined);
      await client.call('job_cancel', { job_id: small.job_id });
    }
    const startIndex = client.deliveries.length, began = Date.now();
    const started = await client.call('job_start', { pane_id: pane.pane_id, objective, analysis: Buffer.byteLength(snapshot.text) > 4096 ? 'auto' : 'worker' });
    const ready = await wait(started.job_id);
    result.worker_result = ready;
    await save();
    assert.equal(ready.result?.kind, 'worker_report', JSON.stringify(ready));
    assert.ok(ready.worker.calls <= 4);
    assert.ok(Buffer.byteLength(JSON.stringify(ready.result.report)) <= 4096);
    const cited = ready.result.report.findings[0]?.evidence_ids[0];
    if (cited) await client.call('evidence_get', { job_id: ready.job_id, evidence_id: cited });
    await client.call('job_status', { job_id: ready.job_id, cursor: ready.cursor });
    await client.call('job_cancel', { job_id: ready.job_id });
    const deliveries = client.deliveries.slice(startIndex);
    const bytes = deliveries.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    assert.ok(bytes <= 16384);
    assert.ok(deliveries.every(value => Buffer.byteLength(value) <= 8192));
    assert.ok(!deliveries.join('').includes('synthetic-private-token-DO-NOT-OUTPUT'));
    const productIds = new Set(Array.from({ length: ready.snapshot.physical_rows }, (_, i) => `${ready.snapshot.snapshot_id}:L${String(i + 1).padStart(4, '0')}`));
    const work = join(directory, 'worker'); await mkdir(work);
    const parent = await diagnoseParent({ objective, broker_instructions: client.hello.result.instructions, broker_deliveries: deliveries.map(JSON.parse) }, productIds, work);
    result.paths.push({ route: 'worker', parent, worker: ready.worker, cumulative_parent_data_bytes: bytes, parent_model_data_bytes: parent.data_bytes, broker_elapsed_ms: Date.now() - began - parent.elapsed_ms, deliveries: deliveries.map(JSON.parse) });
    await save();
    console.log(JSON.stringify({ fixture: name, route: 'worker', ms: parent.elapsed_ms, schema: parent.schema_pass, ids: parent.evidence_ids_pass, bytes: parent.byte_pass, parent_usage: parent.usage_events, worker: ready.worker }));
    for (const path of result.paths) {
      assert.equal(path.parent.code, 0);
      assert.equal(path.parent.schema_pass, true);
      assert.equal(path.parent.evidence_ids_pass, true);
      assert.equal(path.parent.byte_pass, true);
      assert.equal(path.parent.tool_calls, 0);
    }
    assert.ok(h.calls.every(call => ['ping', 'pane.get', 'pane.process_info', 'pane.read'].includes(call.method)));
  });
});
