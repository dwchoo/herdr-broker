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
  assert.equal((await client.listTools()).tools.length, 5);
  const described = await client.callTool({ name: 'pane_describe', arguments: { pane_id: pane.pane_id } });
  assert.equal(JSON.parse(described.content[0].text).target.pane_id, pane.pane_id);
  await client.close();
  owner.process.stdin.write('status\n');
  assert.equal((await nextLine(owner.process.stdout)).action_submission, 'unsupported');
  const exited = once(owner.process, 'exit');
  owner.process.kill('SIGKILL');
  await exited;
  const replacement = child(t, ['serve', h.endpoint, join(h.root, 'state')]);
  assert.equal((await nextLine(replacement.process.stdout)).status, 'ready');
  const stopped = once(replacement.process, 'exit');
  replacement.process.stdin.write('quit\n');
  assert.equal((await stopped)[0], 0);
  const orphan = child(t, ['mcp', ready.socket]);
  assert.equal((await once(orphan.process, 'exit'))[0], 1);
  assert.match(orphan.errors(), /core_unavailable/);
});
