import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { harness, connect } from './harness.mjs';
import { Consoles } from '../dist/consoles.js';
import { startConsoleMcp } from '../dist/console-mcp.js';
import { startCore } from '../dist/core.js';

async function consoleHarness(t) {
  const h = await harness(t);
  await h.core.close();
  const config = { endpoint: h.endpoint, stateRoot: join(h.root, 'consoles-state'), project: resolve('.') };
  const consoles = new Consoles(config);
  const panes = new Map(), cores = [], gateways = [];
  let sequence = 0;
  const create = workspace_id => {
    const id = ++sequence;
    const pane = { pane_id: `ws${workspace_id}:p${id}`, terminal_id: `terminal-${id}`, workspace_id, tab_id: `t${id}`, cwd: config.project, agent_status: 'unknown' };
    panes.set(pane.pane_id, pane);
    return pane;
  };
  h.state.respond = async (socket, request, response) => {
    const params = request.params;
    if (request.method === 'workspace.create') response.result = { type: 'workspace_created', root_pane: create(`workspace-${sequence}`) };
    else if (request.method === 'pane.split' || request.method === 'tab.create') response.result = { type: 'pane_created', [request.method === 'pane.split' ? 'pane' : 'root_pane']: create(params.workspace_id) };
    else if (request.method === 'pane.get') response.result = { type: 'pane_info', pane: panes.get(params.pane_id) };
    else if (request.method === 'pane.process_info') {
      const starting = h.state.starting > 0;
      if (starting) h.state.starting--;
      const name = h.state.controllerProcess ?? (starting ? 'initializing' : 'sh');
      response.result = { type: 'pane_process_info', process_info: { pane_id: params.pane_id, shell_pid: 1000, foreground_process_group_id: starting ? 1001 : 1000, foreground_processes: [{ pid: starting ? 1001 : 1000, name, argv0: name }] } };
    }
    else if (request.method === 'pane.read') {
      const pane = panes.get(params.pane_id);
      response.result = { type: 'pane_read', read: { ...pane, source: 'recent', format: 'ansi', text: 'shared terminal output', truncated: false, revision: 0 } };
    } else if (request.method === 'pane.send_input') {
      const match = / 'serve' '([a-f0-9-]+)'$/.exec(params.text);
      if (match) {
        const record = await consoles.get(match[1]);
        cores.push(await startCore({ ...config, consoleId: record.console_id, scope: { workspace_id: record.workspace_id, terminals: new Map(record.panes.map(pane => [pane.pane_id, pane.terminal_id])) } }));
      }
      response.result = { type: 'ok' };
    }
    socket.write(JSON.stringify(response) + '\n');
  };
  const endpoint = join(h.root, 'gateway.sock');
  const server = createServer(socket => gateways.push(startConsoleMcp(config, socket, socket)));
  server.listen(endpoint); await once(server, 'listening');
  t.after(async () => {
    for (const close of gateways) await close();
    await new Promise(resolve => server.close(resolve));
    for (const core of cores) await core.close();
  });
  return { ...h, config, consoles, cores, panes, connect: () => connect(endpoint, t) };
}

test('The project MCP skill opens one persistent Console and resumes its shared terminal', async t => {
  const h = await consoleHarness(t);
  const first = await h.connect();
  h.state.starting = 2;
  const discovery = await first.request('tools/list', {});
  assert.equal(discovery.result.tools.length, 14);
  assert.equal((await first.call('console_status', {})).attached, false);
  assert.equal((await first.call('pane_describe', { pane_id: 'outside' })).error, 'console_attach_required');
  const created = await first.call('console_open', { label: 'shared work' });
  assert.equal(created.created, true, JSON.stringify(created));
  assert.equal(h.cores.length, 1);
  const paneId = created.panes[0].pane_id;
  assert.equal((await first.call('pane_describe', { pane_id: paneId })).target.pane_id, paneId);
  assert.equal((await first.call('console_open', { label: 'accidental second' })).error, 'console_already_bound');
  const other = await h.connect();
  assert.equal((await other.call('console_attach', { console_id: created.console_id })).error, 'console_busy_or_disconnected');
  const started = await first.call('job_start', { pane_id: paneId, objective: 'read shared output' });
  await first.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const attached = await other.call('console_attach', { console_id: created.console_id });
  assert.equal(attached.console_id, created.console_id);
  const current = await other.call('console_status', {});
  assert.equal(current.panes[0].pane_id, paneId);
  assert.equal(h.cores.length, 1, 'Parent disconnection must not restart the core');
  assert.equal(h.cores[0].summary().jobs.find(job => job.job_id === started.job_id).job_ended, true);
  assert.equal((await other.call('job_status', { job_id: started.job_id })).error, 'job_unavailable');
  assert.equal(h.panes.has(paneId), true);
});

test('Reattaching a stopped Console restarts its core and retains the same terminal identity', async t => {
  const h = await consoleHarness(t);
  const first = await h.connect();
  const created = await first.call('console_open', { label: 'restart' });
  await h.cores[0].close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const resumed = await first.call('console_attach', { console_id: created.console_id });
  assert.equal(resumed.console_id, created.console_id);
  assert.deepEqual(resumed.panes, created.panes);
  assert.equal(h.cores.length, 2);
  assert.equal(h.calls.filter(call => call.method === 'workspace.create').length, 1);
  const started = await first.call('job_start', { pane_id: resumed.panes[0].pane_id, objective: 'read after restart' });
  const ready = await first.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  const invalid = await first.call('job_status', { job_id: started.job_id, extra: true });
  assert.equal(invalid.error, 'invalid_tool_arguments');
  assert.ok(invalid.budget.parent_payload_bytes_used > ready.budget.parent_payload_bytes_used, 'Forwarding must charge invalid input to the core job budget');
});

test('Two Consoles own disjoint terminals and a Parent cannot switch or read across them', async t => {
  const h = await consoleHarness(t);
  const first = await h.connect(), second = await h.connect();
  const a = await first.call('console_open', { label: 'A' });
  const b = await second.call('console_open', { label: 'B' });
  assert.notEqual(a.console_id, b.console_id);
  assert.equal(h.cores.length, 2);
  const reads = h.calls.length;
  assert.equal((await first.call('pane_describe', { pane_id: b.panes[0].pane_id })).error, 'pane_outside_console');
  assert.equal((await first.call('job_start', { pane_id: b.panes[0].pane_id, objective: 'foreign' })).error, 'pane_outside_console');
  assert.equal(h.calls.length, reads);
  assert.equal((await first.call('console_attach', { console_id: b.console_id })).error, 'console_already_bound');
  const target = h.panes.get(a.panes[0].pane_id);
  target.workspace_id = b.workspace_id;
  assert.equal((await first.call('pane_describe', { pane_id: target.pane_id })).error, 'pane_outside_console');
  target.workspace_id = a.workspace_id;
  target.terminal_id = 'replaced';
  assert.equal((await first.call('pane_describe', { pane_id: target.pane_id })).error, 'pane_outside_console');
});

test('A controller exec replacement cannot receive a core startup command', async t => {
  const h = await consoleHarness(t);
  h.state.controllerProcess = 'python3';
  const client = await h.connect();
  const result = await client.call('console_open', { label: 'replaced controller' });
  assert.equal(result.error, 'console_controller_busy');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Console discovery pages every registration within the UTF-8 response limit', async t => {
  const h = await consoleHarness(t);
  const expected = [];
  for (let i = 0; i < 35; i++) expected.push((await h.consoles.create('가'.repeat(80))).console_id);
  const client = await h.connect(), found = [];
  let cursor;
  do {
    const page = await client.call('console_list', cursor ? { cursor } : {});
    assert.ok(Buffer.byteLength(client.deliveries.at(-1)) <= 8192);
    assert.ok(page.consoles.length <= 20);
    found.push(...page.consoles.map(record => record.console_id));
    cursor = page.next;
    assert.equal(page.truncated, cursor !== null);
  } while (cursor);
  assert.deepEqual(found.sort(), expected.sort());
});

test('A closed Console workspace cannot be recreated by reattaching its saved ID', async t => {
  const h = await consoleHarness(t), first = await h.connect();
  const created = await first.call('console_open', { label: 'closed workspace' });
  const record = await h.consoles.get(created.console_id);
  await h.cores[0].close();
  h.panes.delete(record.controller.pane_id);
  const next = await h.connect();
  assert.ok((await next.call('console_attach', { console_id: created.console_id })).error);
  assert.equal(h.calls.filter(call => call.method === 'workspace.create').length, 1);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1, 'Only the original core startup was submitted');
});
