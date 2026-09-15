import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, pane } from './harness.mjs';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { actionHarness, action, job } from './action-harness.mjs';

const consoleId = 'd4f50e8a-59df-4a84-b87a-8253e48fb5f6';
const scope = () => ({ workspace_id: pane.workspace_id, terminals: new Map([[pane.pane_id, pane.terminal_id]]) });

test('A Parent can describe its Console terminal and cannot inspect an outside pane', async t => {
  const h = await harness(t, { core: { scope: { workspace_id: pane.workspace_id, terminals: new Map([[pane.pane_id, pane.terminal_id]]) } } });
  const client = await h.connect();
  assert.equal((await client.call('pane_describe', { pane_id: pane.pane_id })).target.terminal_id, pane.terminal_id);
  const before = h.calls.length;
  const outside = await client.call('pane_describe', { pane_id: 'other:terminal' });
  assert.equal(outside.error, 'pane_outside_console');
  assert.equal(h.calls.length, before, 'An outside pane must not be queried through Herdr');
});

test('A Console keeps its terminals and receipt hold when a new Parent attaches', async t => {
  const h = await actionHarness(t, { core: { consoleId, scope: scope(), observationMs: 50 }, respond(socket, request, response) {
    if (request.method === 'pane.send_input') response.result = { type: 'ok' };
    socket.write(JSON.stringify(response) + '\n');
  } });
  const first = await h.connect();
  const ready = await job(first);
  const proposed = await first.call('action_propose', action(ready.job_id));
  await first.call('action_submit', { proposal_id: proposed.proposal_id });
  first.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = await h.connect();
  const status = await second.call('console_status', {});
  assert.equal(status.console_id, consoleId);
  assert.deepEqual(status.panes, [{ pane_id: pane.pane_id, terminal_id: pane.terminal_id }]);
  assert.equal(status.receipts[0].proposal_id, proposed.proposal_id);
  assert.equal(status.held_terminal_count, 1);
  assert.equal((await second.call('action_submit', { proposal_id: proposed.proposal_id })).error, 'proposal_unavailable');
  const next = await job(second);
  const retry = await second.call('action_propose', action(next.job_id));
  assert.equal((await second.call('action_submit', { proposal_id: retry.proposal_id })).error, 'terminal_held');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('A Console accepts only one Parent connection at a time', async t => {
  const h = await harness(t, { core: { consoleId, scope: scope() } });
  await h.connect();
  const second = createConnection(h.core.socketPath);
  second.on('error', () => {});
  t.after(() => second.destroy());
  const closed = once(second, 'close');
  const deadline = setTimeout(() => second.destroy(new Error('second Parent was not rejected')), 1000);
  try { await closed; } finally { clearTimeout(deadline); }
});

test('Moving an owned terminal after proposing refuses submission without sending input', async t => {
  const h = await actionHarness(t, { core: { consoleId, scope: scope() } });
  const client = await h.connect();
  const current = await job(client);
  const proposed = await client.call('action_propose', action(current.job_id));
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.get') response.result.pane = { ...pane, workspace_id: 'outside' };
    socket.write(JSON.stringify(response) + '\n');
  };
  assert.equal((await client.call('action_submit', { proposal_id: proposed.proposal_id })).error, 'pane_outside_console');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});
