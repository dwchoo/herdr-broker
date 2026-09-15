import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { consoleHarness } from './console-project-harness.mjs';
import { consoleProcess } from './console-harness.mjs';
import { paneActivity } from '../dist/console-view.js';
import { risk } from './action-harness.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function dashboard(t, options = {}) {
  const h = await consoleHarness(t);
  const record = await h.consoles.create('공유 작업 👩🏽‍💻');
  const clockPath = join(h.root, 'clock');
  const { clock, coreOptions, ...display } = options;
  if (clock !== undefined) await writeFile(clockPath, String(clock));
  const ui = await consoleProcess(t, h, { consoleConfig: { ...h.config, ...coreOptions, ...(clock !== undefined && { clockPath }), consoleId: record.console_id }, format: 'dashboard', columns: 56, rows: 8, ...display });
  const client = await h.connect();
  const attached = await client.call('console_attach', { console_id: record.console_id });
  assert.equal(attached.console_id, record.console_id, JSON.stringify(attached));
  return { ...h, record, ui, client, target: record.panes[0], clockPath };
}
async function propose(h, overrides = {}) {
  const described = await h.client.call('pane_describe', { pane_id: h.target.pane_id });
  const started = await h.client.call('job_start', { pane_id: h.target.pane_id, objective: 'diagnose', budget: { parent_payload_bytes: 16384 }, action_scope: { profile: 'local_posix', cwd: h.config.project, paths: [h.config.project], trusted: true } });
  await h.client.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  const proposal = await h.client.call('action_propose', { job_id: started.job_id, target: described.target, objective: 'diagnose', operation: 'execute', command: 'printf "hello world\\n"', cwd: h.config.project, env: {}, affected_paths: [h.config.project], risk: { ...risk, classification: 'high' }, ...overrides });
  assert.equal(proposal.authorization, 'approval_required', JSON.stringify(proposal));
  return { ...proposal, job_id: started.job_id };
}
async function readAll(ui) {
  ui.keys('\u001b[F');
  await ui.waitFor(text => text.includes('y 승인'));
}

test('Dashboard read model uses verified Parent identities and observes without jobs, captures or budget charges', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: '읽기 전용 상태판' });
  const core = h.cores[0], view = core.consoleView;
  const status = await client.call('console_status', {});
  assert.equal(status.parent.pane_id, 'parent');
  assert.equal(status.parent.state, 'connected');
  assert.equal(status.parent_connected, true);
  assert.deepEqual(status.controller, (await h.consoles.get(created.console_id)).controller);
  const before = core.summary();
  await view.refresh(); view.snapshot(); await view.refresh();
  assert.deepEqual(core.summary(), before);
  assert.equal(h.calls.filter(call => ['pane.read', 'pane.send_input'].includes(call.method) && call.params.pane_id === created.panes[0].pane_id).length, 0);
  assert.equal(view.snapshot().panes[0].session, null);
  const started = await client.call('job_start', { pane_id: created.panes[0].pane_id, objective: 'diagnose' });
  await client.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  const budget = core.summary().jobs[0].parent_payload_bytes_remaining;
  const calls = h.calls.filter(call => call.method === 'pane.read').length;
  await view.refresh(); const current = view.snapshot();
  assert.equal(current.panes[0].session.action_mode, 2);
  assert.equal(paneActivity(current.panes[0]), '분석 결과 준비');
  assert.equal(core.summary().jobs[0].parent_payload_bytes_remaining, budget);
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, calls);
  client.close(); await delay(50);
  assert.equal(view.snapshot().parent.state, 'disconnected');
  const second = await h.connect();
  await second.call('console_attach', { console_id: created.console_id });
  await second.call('console_status', {});
  assert.equal(view.snapshot().parent.state, 'connected');
  assert.equal(h.cores.length, 1);
});

test('Metadata changes show stale Mode, missing, moved and failed panes without mutating the execution session', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: '연결 확인' });
  const core = h.cores[0], view = core.consoleView, paneId = created.panes[0].pane_id;
  const described = await client.call('pane_describe', { pane_id: paneId });
  core.actions.mode(described.pane_session_id, 1);
  await view.refresh(); assert.equal(view.snapshot().panes[0].session.action_mode, 1);
  const original = h.state.respond;
  let fail = false, shell = 2000;
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.process_info' && request.params.pane_id === paneId) {
      socket.write(JSON.stringify(fail ? { id: request.id, error: { code: 'offline' } } : { id: request.id, result: { type: 'pane_process_info', process_info: { pane_id: paneId, shell_pid: shell, foreground_process_group_id: shell, foreground_processes: [{ pid: shell, name: 'sh' }] } } }) + '\n');
    } else return original(socket, request, response);
  };
  await view.refresh(); assert.equal(view.snapshot().panes[0].session, null);
  assert.equal(core.summary().sessions[0].active, true);
  assert.equal(core.summary().sessions[0].action_mode, 1);
  shell = 1000; await view.refresh();
  const checked = view.snapshot().panes[0].metadata.checked_at;
  fail = true; await view.refresh();
  assert.equal(view.snapshot().panes[0].metadata.state, 'unavailable');
  assert.equal(view.snapshot().panes[0].metadata.checked_at, checked);
  assert.equal(view.snapshot().panes[0].session, null);
  fail = false; h.panes.get(paneId).tab_id = 'other'; await view.refresh();
  assert.equal(view.snapshot().panes[0].metadata.state, 'moved');
  h.panes.get(paneId).tab_id = created.tab_id; h.panes.get(paneId).terminal_id = 'replacement'; await view.refresh();
  assert.equal(view.snapshot().panes[0].metadata.state, 'replaced');
  h.panes.delete(paneId); await view.refresh();
  assert.equal(view.snapshot().panes[0].metadata.state, 'missing');
  assert.equal(core.summary().sessions[0].action_mode, 1);
  for (let i = 0; i < 55; i++) { core.actions.mode(described.pane_session_id, i % 2 + 1); h.panes.set(paneId, { ...described.target, cwd: h.config.project, agent_status: 'unknown' }); await view.refresh(); view.snapshot(); }
  assert.equal(view.snapshot().events.length, 50);
});

test('Real PTY dashboard stays readable at 56/27 columns and resize preserves input and target selection', async t => {
  const h = await dashboard(t), { ui, client, target } = h;
  await ui.waitFor(text => text.includes('Codex parent · 연결됨'));
  assert.ok(ui.screen().includes(h.record.controller.pane_id));
  assert.ok(ui.screen().includes(target.pane_id));
  assert.ok(!ui.screen().includes('"console_id"'));
  assert.equal(h.calls.filter(call => call.method === 'pane.read').length, 0);
  await client.call('pane_describe', { pane_id: target.pane_id });
  await ui.waitFor(text => text.includes('M2'));
  await ui.resize(56, 5); await ui.waitFor(text => text.includes('M2') && text.split('\n').length === 5);
  assert.ok(ui.screen().includes(target.pane_id), 'A five-row controller must still show its selected Target');
  await ui.resize(56, 8);
  ui.keys(':inspe'); await ui.waitFor(text => text.includes(': inspe'));
  await delay(1150); assert.ok(ui.screen().includes(': inspe'));
  await ui.resize(27, 7); ui.keys(`ct ${target.pane_id}`);
  await ui.waitFor(text => text.includes('inspect'));
  for (const line of ui.screen().split('\n')) assert.ok(stringWidth(line) <= 26, line);
  ui.keys('\r'); await ui.waitFor(text => text.includes('명령 결과'));
  ui.keys('\u001b'); await delay(50); await ui.resize(100, 24);
  await ui.waitFor(text => text.includes('최근 이벤트'));
  const splitCount = h.calls.filter(call => call.method === 'pane.split').length;
  ui.keys('\u001b[200~na\ny\u001b[201~'); await delay(200);
  assert.equal(h.calls.filter(call => call.method === 'pane.split').length, splitCount, 'Pasted shortcuts must not execute');
  ui.keys('n'); await ui.waitFor(text => text.includes('명령 결과'));
  ui.keys('\u001b'); await ui.waitFor(text => text.startsWith('BROKER')); ui.keys('\u001b[B');
  await ui.waitFor(text => text.includes('Target 2/2'));
  await delay(1150); assert.ok(ui.screen().includes('Target 2/2'));
  assert.ok(!ui.screen().includes('\ufffd'), 'UTF-8 screen capture must preserve split Korean and emoji bytes');
  const updated = await h.consoles.get(h.record.console_id);
  assert.equal(updated.panes[0].pane_id, target.pane_id);
  assert.equal(h.panes.get(updated.panes[1].pane_id).tab_id, h.record.tab_id);
  assert.equal(h.calls.filter(call => ['layout.apply', 'tab.create', 'workspace.create'].includes(call.method)).length, 0);
  await writeFile('/private/tmp/herdr-dashboard-pty-screen.txt', ui.screen());
  client.close(); await ui.waitFor(text => text.includes('연결 끊김'));
  const next = await h.connect(); await next.call('console_attach', { console_id: h.record.console_id });
  await ui.waitFor(text => text.includes('연결됨'));
  assert.equal(ui.child.exitCode, null);
});

test('PTY approval freezes the exact proposal, rejects stale Mode, and shares command authority checks', async t => {
  const h = await dashboard(t, { columns: 100, rows: 24 });
  const proposal = await propose(h, { risk: { ...risk, classification: 'high', impact: 'Bidi \u202e and ESC \u001b[2J are data' } });
  await h.ui.waitFor(text => text.includes('승인 1'));
  h.ui.keys('a'); await h.ui.waitFor(text => text.includes('정확한 입력 검토'));
  assert.ok(h.ui.screen().includes(proposal.proposal_id));
  h.ui.keys('y'); await h.ui.waitFor(text => text.includes('끝까지 검토'));
  await readAll(h.ui);
  assert.ok(h.ui.screen().includes('\\u202e'));
  assert.ok(h.ui.screen().includes('\\u001b[2J'));
  await h.client.call('session_lower_mode', { job_id: proposal.job_id, mode: 1 });
  h.ui.keys('y'); await h.ui.waitFor(text => text.includes('review_stale'));
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
  h.ui.keys('\u001b'); await delay(50);
  const fresh = await propose(h);
  await h.ui.waitFor(text => text.includes('승인 1'));
  h.ui.keys('a'); await h.ui.waitFor(text => text.includes(fresh.proposal_id)); await readAll(h.ui);
  h.ui.keys('y'); await h.ui.waitFor(text => text.includes('명령 결과'));
  const authorized = await h.client.call('action_status', { job_id: fresh.job_id, proposal_id: fresh.proposal_id });
  assert.equal(authorized.authorization, 'user_approval');
  assert.equal(authorized.submission_state, 'not_submitted');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('PTY Mode selection confirms the current session, and a shell change invalidates a frozen review', async t => {
  const h = await dashboard(t, { columns: 100, rows: 24 });
  h.ui.keys('m'); await h.ui.waitFor(text => text.includes('Action Mode'));
  h.ui.keys('1\r'); await h.ui.waitFor(text => text.includes('명령 결과'));
  assert.equal((await h.client.call('pane_describe', { pane_id: h.target.pane_id })).action_mode, 1);
  h.ui.keys('\u001b'); await delay(50);
  const proposal = await propose(h);
  await h.ui.waitFor(text => text.includes('승인 1'));
  h.ui.keys('a'); await h.ui.waitFor(text => text.includes(proposal.proposal_id)); await readAll(h.ui);
  const original = h.state.respond;
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.process_info' && request.params.pane_id === h.target.pane_id) socket.write(JSON.stringify({ id: request.id, result: { type: 'pane_process_info', process_info: { pane_id: h.target.pane_id, shell_pid: 2000, foreground_process_group_id: 2000, foreground_processes: [{ pid: 2000, name: 'sh' }] } } }) + '\n');
    else return original(socket, request, response);
  };
  h.ui.keys('y'); await h.ui.waitFor(text => text.includes('review_stale'));
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Dashboard observes real child command completion and preserves its Receipt across core restart', async t => {
  const h = await dashboard(t, { columns: 100, rows: 24 });
  const original = h.state.respond;
  let output = 'fixture shell ready';
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.read') { response.result = { type: 'pane_read', read: { ...h.panes.get(request.params.pane_id), source: request.params.source, format: 'ansi', text: output, truncated: false, revision: 0 } }; socket.write(JSON.stringify(response) + '\n'); }
    else if (request.method === 'pane.send_input') {
      const child = spawn('/bin/sh', ['-c', request.params.text], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      socket.write(JSON.stringify({ id: request.id, result: { type: 'ok' } }) + '\n');
    } else return original(socket, request, response);
  };
  const proposal = await propose(h);
  await h.ui.waitFor(text => text.includes('승인 1')); h.ui.keys('a'); await h.ui.waitFor(text => text.includes(proposal.proposal_id)); await readAll(h.ui);
  h.ui.keys('y'); await h.ui.waitFor(text => text.includes('명령 결과'));
  const submitted = await h.client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(submitted.submission_state, 'accepted');
  h.ui.keys('\u001b'); await h.ui.waitFor(text => text.includes('완료 · exit 0'));
  const stopped = once(h.ui.child, 'close'); h.ui.keys('\u0003'); await stopped;
  assert.equal(h.ui.child.exitCode, 0, h.ui.stderr());
  assert.ok(h.ui.raw().includes('\u001b[?2004l\u001b[?25h\u001b[?1049l'));
  assert.deepEqual(h.ui.terminalState(), { canonical: true, echo: true }, h.ui.stderr());
  h.client.close(); await delay(50);
  const again = await consoleProcess(t, h, { consoleConfig: { ...h.config, consoleId: h.record.console_id }, format: 'dashboard', columns: 100, rows: 24 });
  await again.waitFor(text => text.includes('완료 · exit 0'));
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
  assert.equal(h.panes.get(h.target.pane_id).terminal_id, h.target.terminal_id);
});

test('Frozen review cannot approve an expired job and bracketed command paste waits for explicit Enter', async t => {
  const h = await dashboard(t, { columns: 100, rows: 24, clock: 1000 });
  h.ui.keys(':\u001b[200~status\nnew\u001b[201~');
  await h.ui.waitFor(text => text.includes('status new'));
  await delay(1150); assert.ok(h.ui.screen().startsWith('명령 입력'));
  assert.equal(h.calls.filter(call => call.method === 'pane.split').length, 2);
  h.ui.keys('\u001b'); await h.ui.waitFor(text => text.startsWith('BROKER'));
  const proposal = await propose(h);
  await h.ui.waitFor(text => text.includes('승인 1'));
  h.ui.keys('a'); await h.ui.waitFor(text => text.includes(proposal.proposal_id)); await readAll(h.ui);
  await writeFile(h.clockPath, '400000');
  h.ui.keys('y'); await h.ui.waitFor(text => text.includes('proposal_invalid'));
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 0);
});

test('Unknown Action holds remain visible across a stopped core without replaying input', async t => {
  const h = await dashboard(t, { columns: 100, rows: 24, coreOptions: { observationMs: 100 } });
  const proposal = await propose(h);
  await h.ui.waitFor(text => text.includes('승인 1')); h.ui.keys('a'); await h.ui.waitFor(text => text.includes(proposal.proposal_id)); await readAll(h.ui);
  h.ui.keys('y'); await h.ui.waitFor(text => text.includes('명령 결과'));
  const submitted = await h.client.call('action_submit', { proposal_id: proposal.proposal_id });
  assert.equal(submitted.submission_state, 'accepted');
  h.ui.keys('\u001b'); await h.ui.waitFor(text => text.includes('결과 미확정') && text.includes('보류 1'));
  const stopped = once(h.ui.child, 'close'); h.ui.keys(':quit\r'); await stopped;
  assert.equal(h.ui.child.exitCode, 0, h.ui.stderr());
  assert.deepEqual(h.ui.terminalState(), { canonical: true, echo: true }, h.ui.stderr());
  h.client.close(); await delay(50);
  const ui = await consoleProcess(t, h, { consoleConfig: { ...h.config, consoleId: h.record.console_id }, format: 'dashboard', columns: 100, rows: 24 });
  await ui.waitFor(text => text.includes('결과 미확정') && text.includes('보류 1'));
  const newParent = await h.connect();
  await newParent.call('console_attach', { console_id: h.record.console_id });
  const status = await newParent.call('console_status', {});
  assert.equal(status.held_terminal_count, 1);
  assert.equal(status.receipts[0].proposal_id, proposal.proposal_id);
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input').length, 1);
});

test('Dashboard fallback keeps JSON usable on non-TTY and TERM=dumb without granting pipe authority', async t => {
  for (const options of [{ tty: false }, { tty: true, term: 'dumb' }, { tty: true, format: 'json' }]) {
    await t.test(JSON.stringify(options), async t => {
      const h = await dashboard(t, options);
      assert.equal(h.ui.ready.status, 'ready');
      assert.ok(!h.ui.raw().includes('\u001b[?1049h'));
      const value = await h.ui.command(`inspect ${h.target.pane_id}`);
      if (options.tty === false) assert.equal(value.error, 'interactive_console_required');
      else assert.equal(value.target.pane_id, h.target.pane_id);
    });
  }
});

test('Active approval queues include Jobs and proposals older than the last 32 summaries', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: '많은 승인 대기' });
  const context = { ...h, client, target: created.panes[0] };
  const first = await propose(context);
  for (let i = 0; i < 33; i++) await propose(context);
  const core = h.cores[0]; await core.consoleView.refresh();
  const state = core.consoleView.snapshot();
  assert.equal(state.pending_approvals, 34);
  assert.equal(state.panes[0].proposals.find(proposal => proposal.proposal_id === first.proposal_id).authorization, 'approval_required');
  assert.equal(state.panes[0].jobs.length, 34);
});

for (const otherInspection of [false, true]) test(`Legacy Mode commands verify a fresh session even with ${otherInspection ? 'another Target inspected' : 'no prior inspection'}`, async t => {
  const h = await dashboard(t, { format: 'json' });
  const originalSession = await h.client.call('pane_describe', { pane_id: h.target.pane_id });
  if (otherInspection) {
    const added = await h.ui.command('new');
    await h.ui.command(`inspect ${added.panes[1].pane_id}`);
  }
  const original = h.state.respond;
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.process_info' && request.params.pane_id === h.target.pane_id) socket.write(JSON.stringify({ id: request.id, result: { type: 'pane_process_info', process_info: { pane_id: h.target.pane_id, shell_pid: 9999, foreground_process_group_id: 9999, foreground_processes: [{ pid: 9999, name: 'sh' }] } } }) + '\n');
    else return original(socket, request, response);
  };
  assert.equal((await h.ui.command(`mode ${originalSession.pane_session_id} 3`)).error, 'session_changed');
  assert.equal((await h.client.call('pane_describe', { pane_id: h.target.pane_id })).action_mode, 2);
});

test('Successive legacy Mode commands consume their Mode inspection', async t => {
  const h = await dashboard(t, { format: 'json' });
  const inspected = await h.ui.command(`inspect ${h.target.pane_id}`);
  assert.equal((await h.ui.command(`mode ${inspected.pane_session_id} 1`)).action_mode, 1);
  assert.equal((await h.ui.command(`mode ${inspected.pane_session_id} 2`)).action_mode, 2);
});

test('The verified Parent terminal identity is preserved and replacement prevents Action submission', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const created = await client.call('console_open', { label: 'Parent identity' });
  const target = created.panes[0], described = await client.call('pane_describe', { pane_id: target.pane_id });
  const started = await client.call('job_start', { pane_id: target.pane_id, objective: 'diagnose', action_scope: { profile: 'local_posix', cwd: h.config.project, paths: [h.config.project], trusted: true } });
  await client.call('job_wait', { job_id: started.job_id, wait_ms: 1000 });
  const proposal = await client.call('action_propose', { job_id: started.job_id, target: described.target, objective: 'diagnose', operation: 'execute', command: 'echo hello', cwd: h.config.project, env: {}, affected_paths: [h.config.project], risk });
  assert.equal(proposal.authorization, 'parent_risk_review');
  h.parent.terminal_id = 'replaced-parent-terminal';
  const core = h.cores[0]; await core.consoleView.refresh();
  const snapshot = core.consoleView.snapshot();
  assert.equal(snapshot.parent.terminal_id, 'parent-terminal');
  assert.equal(snapshot.parent.metadata.state, 'replaced');
  assert.equal((await client.call('action_submit', { proposal_id: proposal.proposal_id })).error, 'console_parent_changed');
  assert.equal(h.calls.filter(call => call.method === 'pane.send_input' && call.params.pane_id === target.pane_id).length, 0);
});

test('A wrapped proposal picker keeps the selected proposal visible at 27 columns', async t => {
  const h = await dashboard(t, { columns: 27, rows: 7 });
  let last;
  for (let i = 0; i < 6; i++) last = await propose(h);
  await h.ui.waitFor(text => text.includes('승인 6'));
  h.ui.keys('a'); await h.ui.waitFor(text => text.includes('승인 대기 선택'));
  h.ui.keys('\u001b[B'.repeat(5));
  await h.ui.waitFor(text => text.includes(`> ${last.proposal_id.slice(0,15)}`));
  h.ui.keys('\r'); await h.ui.waitFor(text => text.includes('정확한 입력 검토')); await readAll(h.ui);
  h.ui.keys('n'); await h.ui.waitFor(text => text.includes('제안을 거절'));
  assert.equal((await h.client.call('action_status', { job_id: last.job_id, proposal_id: last.proposal_id })).reason, 'user_rejected');
});
