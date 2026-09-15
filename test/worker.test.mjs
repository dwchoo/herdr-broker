import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, pane } from './harness.mjs';
import { workerFixture } from './worker-harness.mjs';

test('Worker analysis returns a four-field Report and real redacted Evidence while small auto context avoids the Worker', async t => {
  const worker = await workerFixture(t);
  const h = await harness(t, { text: 'TS2305: missing export\npassword=synthetic-password', core: { worker: { executable: worker.executable } } });
  const client = await h.connect();
  const observe = async analysis => {
    const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'Diagnose the supplied build output', analysis });
    return client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  };
  assert.equal((await observe('auto')).result.kind, 'prepared_context');
  assert.equal((await worker.calls()).length, 0);
  const ready = await observe('worker');
  assert.equal(ready.result.kind, 'worker_report');
  assert.equal(ready.result.contract, 'diagnosis.v1');
  assert.deepEqual(Object.keys(ready.result.report).sort(), ['summary', 'findings', 'next_checks', 'uncertainties'].sort());
  const id = ready.result.report.findings[0].evidence_ids[0];
  assert.equal(ready.evidence.items[0].evidence_id, id);
  assert.match(ready.evidence.items[0].text, /TS2305/);
  const calls = await worker.calls();
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls[0].request).includes('synthetic-password'));
  assert.match(calls[0].request.snapshot.rows[1].text, /REDACTED/);
  assert.equal(ready.worker.calls, 1);
  assert.equal(ready.worker.usage.input_tokens, 100);
  assert.equal(ready.worker.usage.cached_input_tokens, 20);
  assert.equal(ready.worker.usage.output_tokens, 50);
  assert.equal(ready.worker.model_observed, null);
});

test('A structurally invalid Worker result gets one repair on the same Snapshot and both calls count toward usage', async t => {
  const worker = await workerFixture(t, { mode: 'invalid-once' });
  const h = await harness(t, { core: { worker: { executable: worker.executable } } });
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker' });
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 2000 });
  assert.equal(ready.result?.kind, 'worker_report');
  assert.equal(ready.result.report.status, undefined);
  assert.equal(ready.worker.calls, 2);
  assert.equal(ready.worker.usage.input_tokens, 200);
  assert.equal(ready.worker.usage.cached_input_tokens, 40);
  assert.equal(ready.worker.usage.output_tokens, 100);
  const calls = await worker.calls();
  assert.deepEqual(calls[0].request.snapshot, calls[1].request.snapshot);
  assert.ok(calls[1].request.repair);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 1);
});

test('Large auto context uses the Worker and initial Evidence follows its cited rows', async t => {
  const worker = await workerFixture(t, { cite: 19 });
  const text = [...Array.from({ length: 19 }, (_, index) => `unrelated ${index} ` + 'x'.repeat(240)), 'TS2305: missing export at the end'].join('\n');
  const h = await harness(t, { text, core: { worker: { executable: worker.executable } } });
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose the error at the end' });
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 2000 });
  assert.equal(ready.result.kind, 'worker_report');
  assert.equal(ready.evidence.items[0].evidence_id, ready.result.report.findings[0].evidence_ids[0]);
  assert.equal(ready.evidence.items[0].text, 'TS2305: missing export at the end');
  assert.ok(Buffer.byteLength(JSON.stringify(ready.evidence)) <= 2048);
  const calls = await worker.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.snapshot.rows.length, 20);
});

test('Worker call and observed-token budgets stop later analysis in the same job', async t => {
  for (const tokenLimit of [false, true]) {
    await t.test(tokenLimit ? 'observed tokens' : 'four calls', async t => {
      const worker = await workerFixture(t, tokenLimit ? { usage: { input_tokens: 99980, cached_input_tokens: 200, output_tokens: 20 } } : {});
      const h = await harness(t, { text: 'first', core: { worker: { executable: worker.executable } } });
      const client = await h.connect();
      const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker' });
      let current = await client.call('job_wait', { job_id: start.job_id, wait_ms: 2000 });
      const allowed = tokenLimit ? 1 : 4;
      for (let index = 1; index < allowed; index++) {
        h.state.text = `new output ${index}`;
        current = await client.call('job_wait', { job_id: start.job_id, cursor: current.cursor, wait_ms: 2000 });
        assert.equal(current.result.kind, 'worker_report');
      }
      h.state.text = 'must not start another Worker';
      const stopped = await client.call('job_wait', { job_id: start.job_id, cursor: current.cursor, wait_ms: 2000 });
      assert.equal(stopped.error, tokenLimit ? 'worker_token_budget' : 'worker_call_budget');
      assert.equal((await worker.calls()).length, allowed);
      assert.equal(stopped.worker.calls, allowed);
    });
  }
});

test('Invalid Report, stream completion, tool activity and runtime warnings fail closed with bounded repair', async t => {
  for (const [mode, error, calls] of [
    ['invalid-always', 'worker_invalid_report', 2], ['unknown-id', 'worker_invalid_report', 2], ['malformed', 'worker_invalid_report', 2],
    ['oversized', 'worker_report_too_large', 1], ['tool', 'worker_tool_forbidden', 1], ['no-terminal', 'worker_failed', 1],
    ['exit-fail', 'worker_failed', 1], ['unexpected-stderr', 'worker_profile_error', 1],
  ]) await t.test(mode, async t => {
    const worker = await workerFixture(t, { mode });
    const h = await harness(t, { core: { worker: { executable: worker.executable } } });
    const client = await h.connect();
    const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker' });
    const failure = await client.call('job_wait', { job_id: start.job_id, wait_ms: 2000 });
    assert.equal(failure.error, error);
    assert.equal(failure.result, undefined);
    assert.equal((await worker.calls()).length, calls);
    assert.ok(!JSON.stringify(failure).includes('Unexpected profile failure'));
  });
});

test('Worker timeout, cancellation and facade loss stop the owned process group; stream caps do not repair', async t => {
  for (const mode of ['timeout', 'cancel', 'disconnect', 'event-overflow', 'stream-overflow']) await t.test(mode, async t => {
    const worker = await workerFixture(t, { mode: mode.endsWith('overflow') ? mode : 'hang' });
    const h = await harness(t, { core: { worker: { executable: worker.executable, timeoutMs: mode === 'timeout' ? 1500 : 10000 } } });
    const client = await h.connect();
    const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker' });
    const child = await worker.waitForCall();
    if (mode === 'cancel') await client.call('job_cancel', { job_id: start.job_id });
    if (mode === 'disconnect') client.close();
    else {
      const stopped = await client.call('job_wait', { job_id: start.job_id, wait_ms: 3000 });
      if (mode === 'cancel') assert.equal(stopped.phase, 'cancelled');
      else assert.equal(stopped.error, mode === 'timeout' ? 'worker_timeout' : mode === 'event-overflow' ? 'worker_event_limit' : 'worker_output_limit');
      assert.equal(stopped.result, undefined);
    }
    let alive = true;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { process.kill(-child.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { alive = false; break; } if (error.code !== 'EPERM') throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(alive, false, 'Owned process group must be gone');
    assert.equal((await worker.calls()).length, 1);
    const other = await h.connect();
    assert.ok((await other.call('pane_describe', { pane_id: pane.pane_id })).target);
  });
});

test('The core limits Worker concurrency and waits for its owned Worker to stop during shutdown', async t => {
  const worker = await workerFixture(t, { mode: 'hang' });
  const h = await harness(t, { core: { worker: { executable: worker.executable } } });
  const a = await h.connect();
  const b = await h.connect();
  await a.call('job_start', { pane_id: pane.pane_id, objective: 'first Worker', analysis: 'worker' });
  const child = await worker.waitForCall();
  const other = await b.call('job_start', { pane_id: pane.pane_id, objective: 'concurrent Worker', analysis: 'worker' });
  const busy = await b.call('job_wait', { job_id: other.job_id, wait_ms: 1000 });
  assert.equal(busy.error, 'worker_busy');
  assert.equal((await worker.calls()).length, 1);
  await h.core.close();
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('Worker profile and strict report bounds fail closed and missing usage remains unknown', async t => {
  for (const state of [{ version: 'codex-cli 0.155.0' }, { patch: { summary: 'x'.repeat(1201) } }, { patch: { next_checks: Array(6).fill('check') } }, { patch: { next_checks: ['x'.repeat(601)] } }, { patch: { summary: 'X'.repeat(1200) } }, { usage: null }]) {
    await t.test(JSON.stringify(state).slice(0, 70), async t => {
      const worker = await workerFixture(t, state);
      const h = await harness(t, { core: { redactionPatterns: ['X'], worker: { executable: worker.executable } } });
      const client = await h.connect();
      const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker' });
      const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 2000 });
      if ('usage' in state) {
        assert.equal(ready.worker.usage, null);
        assert.equal(ready.result.kind, 'worker_report');
        assert.equal(h.core.summary().jobs[0].result_ready, true);
      } else {
        assert.ok(['worker_unsupported', 'worker_invalid_report', 'worker_report_too_large'].includes(ready.error), JSON.stringify(ready));
        assert.equal(ready.result, undefined);
      }
    });
  }
});

test('Version preflight uses the same environment and process-group cleanup as analysis', async t => {
  const worker = await workerFixture(t, { versionHang: true });
  process.env.HERDR_WORKER_VERSION_CANARY = 'synthetic';
  t.after(() => { delete process.env.HERDR_WORKER_VERSION_CANARY; });
  const h = await harness(t, { core: { worker: { executable: worker.executable, timeoutMs: 1500 } } });
  const client = await h.connect();
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker' });
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 3000 });
  assert.equal(ready.error, 'worker_timeout');
  const versions = await worker.versions();
  assert.equal(versions.length, 1);
  assert.ok(!versions[0].envKeys.includes('HERDR_WORKER_VERSION_CANARY'));
  await h.core.close();
  assert.throws(() => process.kill(versions[0].pid, 0), { code: 'ESRCH' });
  assert.equal((await worker.calls()).length, 0);
});

test('Observed Worker usage survives a failed exit or oversized final result', async t => {
  for (const mode of ['exit-fail', 'oversized', 'unexpected-stderr']) await t.test(mode, async t => {
    const worker = await workerFixture(t, { mode, usage: { input_tokens: 1234, cached_input_tokens: 234, output_tokens: 56 } });
    const h = await harness(t, { core: { worker: { executable: worker.executable } } });
    const client = await h.connect();
    const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', analysis: 'worker' });
    const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 2000 });
    assert.equal(ready.phase, 'failed');
    assert.equal(ready.result, undefined);
    assert.deepEqual(ready.worker.usage, { input_tokens: 1234, cached_input_tokens: 234, output_tokens: 56 });
    assert.deepEqual(h.core.summary().jobs[0].worker.usage, ready.worker.usage);
  });
});
