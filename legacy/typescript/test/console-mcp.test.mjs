import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { consoleHarness } from './console-project-harness.mjs';
import { consoleProcess } from './console-harness.mjs';

test('The project MCP skill opens one persistent Console and resumes its shared terminal', async t => {
  const h = await consoleHarness(t);
  const first = await h.connect();
  h.state.starting = 2;
  const discovery = await first.request('tools/list', {});
  assert.equal(discovery.result.tools.length, 20);
  assert.equal((await first.call('console_status', {})).attached, false);
  assert.equal((await first.call('pane_describe', { pane_id: 'outside' })).error, 'console_attach_required');
  const created = await first.call('console_open', { label: 'shared work' });
  assert.equal(created.created, true, JSON.stringify(created));
  assert.equal(created.workspace_id, 'workspace-1');
  assert.equal(created.tab_id, 'tab-1');
  const record = await h.consoles.get(created.console_id);
  assert.equal(record.controller, null);
  assert.equal(h.panes.get(created.panes[0].pane_id).tab_id, 'tab-1');
  assert.equal(h.calls.filter(call => call.method === 'workspace.create' || call.method === 'tab.create').length, 0);
  assert.equal((await first.call('pane_describe', { pane_id: h.parent.pane_id })).error, 'pane_outside_console');
  assert.equal(h.cores.length, 1);
  const paneId = created.panes[0].pane_id;
  assert.equal((await first.call('pane_describe', { pane_id: paneId })).target.pane_id, paneId);
  assert.equal((await first.call('console_open', { label: 'accidental second' })).error, 'console_already_bound');
  const other = await h.connect();
  assert.equal((await other.call('console_attach', { console_id: created.console_id })).error, 'console_busy_or_disconnected');
  const started = await first.call('job_start', { analysis: 'auto', pane_id: paneId, objective: 'read shared output' });
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
  assert.equal(h.calls.filter(call => call.method === 'workspace.create').length, 0);
  const started = await first.call('job_start', { analysis: 'auto', pane_id: resumed.panes[0].pane_id, objective: 'read after restart' });
  const ready = await first.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  const invalid = await first.call('job_status', { job_id: started.job_id, extra: true });
  assert.equal(invalid.error, 'invalid_tool_arguments');
  assert.ok(invalid.budget.parent_payload_bytes_used > ready.budget.parent_payload_bytes_used, 'Forwarding must charge invalid input to the core job budget');
});

test('Two Consoles own disjoint terminals and switching cannot bypass terminal scope', async t => {
  const h = await consoleHarness(t);
  const first = await h.connect(), second = await h.connect();
  const a = await first.call('console_open', { label: 'A' });
  const b = await second.call('console_open', { label: 'B' });
  assert.notEqual(a.console_id, b.console_id);
  assert.equal(h.cores.length, 2);
  const foreignReads = () => h.calls.filter(call => call.params?.pane_id === b.panes[0].pane_id).length;
  const reads = foreignReads();
  assert.equal((await first.call('pane_describe', { pane_id: b.panes[0].pane_id })).error, 'pane_outside_console');
  assert.equal((await first.call('job_start', { analysis: 'auto', pane_id: b.panes[0].pane_id, objective: 'foreign' })).error, 'pane_outside_console');
  assert.equal(foreignReads(), reads);
  assert.equal((await first.call('console_attach', { console_id: b.console_id })).error, 'console_busy_or_disconnected');
  await first.call('console_attach', { console_id: a.console_id });
  const target = h.panes.get(a.panes[0].pane_id);
  target.workspace_id = 'outside-workspace';
  assert.equal((await first.call('pane_describe', { pane_id: target.pane_id })).error, 'pane_outside_console');
  target.workspace_id = a.workspace_id;
  target.tab_id = 'outside-tab';
  assert.equal((await first.call('pane_describe', { pane_id: target.pane_id })).error, 'pane_outside_console');
  target.tab_id = a.tab_id;
  target.terminal_id = 'replaced';
  assert.equal((await first.call('pane_describe', { pane_id: target.pane_id })).error, 'pane_outside_console');
});

test('A controller exec replacement cannot receive a core startup command', async t => {
  const h = await consoleHarness(t);
  h.state.controllerProcess = 'python3';
  const client = await h.connect();
  await client.call('console_open', { label: 'replaced controller' });
  const result = await client.call('console_manage', {});
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
    assert.ok(page.consoles.every(record => record.workspace_id === 'workspace-1' && record.tab_id === 'tab-1'));
    found.push(...page.consoles.map(record => record.console_id));
    cursor = page.next;
    assert.equal(page.truncated, cursor !== null);
  } while (cursor);
  assert.deepEqual(found.sort(), expected.sort());
});

test('A closed management pane does not prevent restarting its background Broker', async t => {
  const h = await consoleHarness(t), first = await h.connect();
  const created = await first.call('console_open', { label: 'closed management' });
  const view = await first.call('console_manage', {});
  h.panes.delete(view.controller.pane_id);
  await h.cores[0].close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const resumed = await first.call('console_attach', { console_id: created.console_id });
  assert.equal(resumed.console_id, created.console_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.split').length, 2);
  assert.equal(h.panes.has(created.panes[0].pane_id), true);
});

test('A Parent in another tab cannot attach and can still open a Console beside itself', async t => {
  const h = await consoleHarness(t), first = await h.connect();
  const created = await first.call('console_open', { label: 'original tab' });
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  h.panes.set('other-parent', { ...h.parent, pane_id: 'other-parent', terminal_id: 'other-parent-terminal', tab_id: 'tab-2' });
  h.config.herdrContext = { ...h.config.herdrContext, HERDR_PANE_ID: 'other-parent', HERDR_TAB_ID: 'tab-2' };
  const second = await h.connect();
  assert.equal((await second.call('console_attach', { console_id: created.console_id })).error, 'console_tab_required');
  assert.equal(h.cores[0].consoleStatus().parent_connected, false);
  const opened = await second.call('console_open', { label: 'beside new Parent' });
  assert.equal(opened.tab_id, 'tab-2', JSON.stringify(opened));
});

test('Moving the Parent to another tab disconnects its Console and ends unsubmitted jobs', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: 'moved Parent' });
  const started = await client.call('job_start', { analysis: 'auto', pane_id: created.panes[0].pane_id, objective: 'observe beside Parent' });
  h.parent.tab_id = 'other-tab';
  assert.equal((await client.call('job_status', { job_id: started.job_id })).error, 'console_tab_required');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.cores[0].consoleStatus().parent_connected, false);
  assert.equal(h.cores[0].summary().jobs.find(job => job.job_id === started.job_id).job_ended, true);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Legacy Console records are preserved and cannot be silently adopted into the Parent tab', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const record = { console_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', label: 'legacy', endpoint: h.config.endpoint, project: h.config.project, workspace_id: 'workspace-1', tab_id: 'tab-1', controller: { pane_id: 'old', terminal_id: 'old-terminal' }, panes: [], created_at: new Date().toISOString() };
  await mkdir(join(h.config.stateRoot, 'consoles'), { recursive: true });
  const path = join(h.config.stateRoot, 'consoles', record.console_id + '.json');
  const { tab_id, ...legacy } = record;
  const saved = JSON.stringify(legacy);
  await writeFile(path, saved, { mode: 0o600 });
  const before = h.calls.length;
  assert.equal((await client.call('console_attach', { console_id: record.console_id })).error, 'console_layout_upgrade_required');
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.equal(h.calls.length, before);
});

test('A moved management pane does not transfer target scope or terminate the Parent', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: 'moved management' });
  const view = await client.call('console_manage', {});
  h.panes.get(view.controller.pane_id).tab_id = 'other-tab';
  assert.equal((await client.call('console_status', {})).parent_connected, true);
  assert.equal((await client.call('pane_describe', { pane_id: view.controller.pane_id })).error, 'pane_outside_console');
  assert.equal((await client.call('pane_describe', { pane_id: created.panes[0].pane_id })).target.tab_id, 'tab-1');
});

test('A Parent moved while job_wait is capturing receives no Evidence and loses its connection', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: 'pending observation' });
  const started = await client.call('job_start', { analysis: 'auto', pane_id: created.panes[0].pane_id, objective: 'observe together' });
  const first = await client.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  h.state.beforeRead = async () => { entered.resolve(); await release.promise; };
  const waiting = client.call('job_wait', { job_id: started.job_id, cursor: first.cursor, wait_ms: 1000 });
  await entered.promise;
  h.parent.tab_id = 'other-tab'; release.resolve();
  assert.equal((await waiting).error, 'console_tab_required');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.cores[0].consoleStatus().parent_connected, false);
});

for (const moving of ['Parent']) test(`Moving the ${moving} during Action baseline capture prevents all Target input`, async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: 'pending Action' });
  const record = await h.consoles.get(created.console_id);
  const described = await client.call('pane_describe', { pane_id: created.panes[0].pane_id });
  const objective = 'Print together', cwd = h.config.project;
  const started = await client.call('job_start', { analysis: 'auto', pane_id: described.target.pane_id, objective, action_scope: { profile: 'local_posix', cwd, paths: [cwd], trusted: true } });
  await client.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  const proposal = await client.call('action_propose', { job_id: started.job_id, target: described.target, objective, operation: 'execute', command: 'echo hello', cwd, env: {}, affected_paths: [cwd], risk: { classification: 'read', inspected: true, impact: 'Fixed terminal output', recovery: 'No persistent changes', uncertainties: [], categories: [] } });
  assert.ok(proposal.proposal_id, JSON.stringify(proposal));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  h.state.beforeRead = async () => { entered.resolve(); await release.promise; };
  const submitting = client.call('action_submit', { proposal_id: proposal.proposal_id });
  await entered.promise;
  (moving === 'Parent' ? h.parent : h.panes.get(record.controller.pane_id)).tab_id = 'other-tab';
  release.resolve();
  assert.equal((await submitting).error, moving === 'Parent' ? 'console_tab_required' : 'console_workspace_changed');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input' && call.params.pane_id === described.target.pane_id).length, 0);
  assert.equal(h.cores[0].consoleStatus().control_record_count, 0);
});

test('The user console keeps adding same-tab terminals after the first Target is closed', async t => {
  const h = await consoleHarness(t);
  const record = await h.controllerRecord('shared split terminals');
  const controller = await consoleProcess(t, h, { consoleConfig: { ...h.config, consoleId: record.console_id } });
  const client = await h.connect();
  await client.call('console_attach', { console_id: record.console_id });
  const second = await controller.command('new');
  assert.equal(second.panes.length, 2, JSON.stringify(second));
  h.panes.delete(record.panes[0].pane_id);
  const third = await controller.command('new');
  assert.equal(third.panes.length, 3, JSON.stringify(third));
  const current = await client.call('console_status', {});
  assert.deepEqual(current.panes, third.panes);
  for (const target of current.panes.slice(1)) {
    assert.equal((await client.call('pane_describe', { pane_id: target.pane_id })).target.tab_id, 'tab-1');
  }
  assert.equal(h.calls.filter(call => call.method === 'tab.create' || call.method === 'workspace.create').length, 0);
});

for (const reconnect of [false, true]) test(`Attach checks Parent location again before returning ${reconnect ? 'a new connection' : 'existing receipts'}`, async t => {
  const h = await consoleHarness(t), first = await h.connect();
  const created = await first.call('console_open', { label: 'attach race' });
  if (reconnect) { first.close(); await new Promise(resolve => setTimeout(resolve, 50)); }
  const client = reconnect ? await h.connect() : first;
  let calls = 0; h.state.afterGet = paneId => { if (paneId === h.parent.pane_id && ++calls === 1) h.parent.tab_id = 'other-tab'; };
  assert.equal((await client.call('console_attach', { console_id: created.console_id })).error, 'console_tab_required');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.cores[0].consoleStatus().parent_connected, false);
});
