import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { harness, pane } from './harness.mjs';
import { startCore } from '../dist/core.js';

test('One SQLite authority owns a canonical endpoint and preserves the live core socket', async t => {
  const h = await harness(t);
  const client = await h.connect();
  await assert.rejects(startCore({ endpoint: h.endpoint, stateRoot: join(h.root, 'state') }), /authority_busy/);
  assert.equal((await client.call('pane_describe', { pane_id: pane.pane_id })).target.pane_id, pane.pane_id);
  const directory = dirname(h.core.socketPath);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(h.core.socketPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'authority.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(directory, 'authority.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\0');
  await h.core.close();
  await writeFile(join(directory, 'authority.sqlite'), 'broken');
  await assert.rejects(startCore({ endpoint: h.endpoint, stateRoot: join(h.root, 'state') }), /authority_invalid/);
});

test('Authority loss during an asynchronous lookup prevents capture and prepared-context publication', async t => {
  const { unlink } = await import('node:fs/promises');
  let reply;
  const h = await harness(t, { respond(socket, request, response) {
    if (request.method === 'pane.get') reply = () => { if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n'); };
    else socket.write(JSON.stringify(response) + '\n');
  } });
  const client = await h.connect();
  const started = await client.call('job_start', { pane_id: pane.pane_id, objective: 'observe authority' });
  await client.call('job_wait', { job_id: started.job_id, wait_ms: 10 });
  assert.ok(reply);
  const waiting = client.call('job_wait', { job_id: started.job_id, wait_ms: 500 });
  await new Promise(resolve => setTimeout(resolve, 10));
  await unlink(join(dirname(h.core.socketPath), 'authority.sqlite'));
  reply();
  const response = await waiting;
  assert.equal(response.error, 'authority_lost');
  assert.equal(response.result, undefined);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 0);
});
