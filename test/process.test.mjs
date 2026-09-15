import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { harness, pane } from './harness.mjs';

function child(t, args) {
  const process = spawn(globalThis.process.execPath, ['test/process-fixture.mjs', ...args], { stdio: 'pipe' });
  let stderr = '';
  process.stderr.on('data', data => { stderr += data; });
  t.after(() => { process.stdin.destroy(); process.kill('SIGKILL'); });
  return { process, errors: () => stderr };
}

async function nextLine(stream) {
  let text = '';
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    text += chunk;
    if (text.includes('\n')) return JSON.parse(text.slice(0, text.indexOf('\n')));
  }
  throw new Error('process ended before console response');
}

test('Console core survives facade exit, rejects a second process, and recovers its lock after a crash', { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.core.close();
  const owner = child(t, ['serve', h.endpoint, join(h.root, 'state')]);
  const ready = await nextLine(owner.process.stdout);
  assert.equal(ready.status, 'ready');
  owner.process.stdin.write('status\n');
  const status = await nextLine(owner.process.stdout);
  assert.equal(status.memory_limit_bytes, 64 * 1024 * 1024);
  const second = child(t, ['serve', h.endpoint, join(h.root, 'state')]);
  assert.equal((await once(second.process, 'exit'))[0], 1);
  assert.match(second.errors(), /authority_busy/);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['test/process-fixture.mjs', 'mcp', ready.socket], stderr: 'pipe' });
  const client = new Client({ name: 'installed-protocol-peer', version: '1' });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 6);
  const described = await client.callTool({ name: 'pane_describe', arguments: { pane_id: pane.pane_id } });
  assert.equal(JSON.parse(described.content[0].text).target.pane_id, pane.pane_id);
  const started = await client.callTool({ name: 'job_start', arguments: { pane_id: pane.pane_id, objective: 'process retention fixture' } });
  const job = JSON.parse(started.content[0].text);
  const observed = await client.callTool({ name: 'job_wait', arguments: { job_id: job.job_id, wait_ms: 1000 } });
  const snapshot = JSON.parse(observed.content[0].text).snapshot;
  const evidenceArgs = { job_id: job.job_id, evidence_id: `${snapshot.snapshot_id}:L0001` };
  const evidence = await client.callTool({ name: 'evidence_get', arguments: evidenceArgs });
  assert.match(JSON.parse(evidence.content[0].text).evidence.items[0].text, /build failed/);
  await client.close();
  owner.process.stdin.write('status\n');
  const retained = await nextLine(owner.process.stdout);
  assert.equal(retained.action_submission, 'unsupported');
  assert.equal(retained.jobs[0].phase, 'cancelled');
  assert.ok(!JSON.stringify(retained).includes('build failed'));
  assert.ok(!owner.errors().includes('build failed'));
  const exited = once(owner.process, 'exit');
  owner.process.kill('SIGKILL');
  await exited;
  const replacement = child(t, ['serve', h.endpoint, join(h.root, 'state')]);
  assert.equal((await nextLine(replacement.process.stdout)).status, 'ready');
  replacement.process.stdin.write('status\n');
  assert.equal((await nextLine(replacement.process.stdout)).job_count, 0);
  const reconnected = new Client({ name: 'after-core-restart', version: '1' });
  await reconnected.connect(new StdioClientTransport({ command: process.execPath, args: ['test/process-fixture.mjs', 'mcp', ready.socket], stderr: 'pipe' }));
  const expired = await reconnected.callTool({ name: 'evidence_get', arguments: evidenceArgs });
  assert.equal(JSON.parse(expired.content[0].text).error, 'job_unavailable');
  await reconnected.close();
  const stopped = once(replacement.process, 'exit');
  replacement.process.stdin.write('quit\n');
  assert.equal((await stopped)[0], 0);
  const orphan = child(t, ['mcp', ready.socket]);
  assert.equal((await once(orphan.process, 'exit'))[0], 1);
  assert.match(orphan.errors(), /core_unavailable/);
});
