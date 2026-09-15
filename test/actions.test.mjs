import test from 'node:test';
import assert from 'node:assert/strict';
import { pane } from './harness.mjs';

import { scope, risk, processInfo, action, job, actionHarness } from './action-harness.mjs';

test('Public proposal fixes full payload and mode 2 persists for the same Pane Session without sending input', async t => {
  const h = await actionHarness(t), client = await h.connect();
  const first = await job(client);
  assert.equal(first.action_mode, 2);
  const proposal = await client.call('action_propose', action(first.job_id));
  assert.equal(proposal.authorization, 'parent_risk_review');
  assert.equal(proposal.submission_state, 'not_submitted');
  assert.deepEqual(proposal.payload.keys, ['Enter']);
  assert.match(proposal.payload.text, /^\/bin\/sh -c /);
  assert.match(proposal.payload.text, /__HERDR/);
  const lowered = await client.call('session_lower_mode', { job_id: first.job_id, mode: 1 });
  assert.equal(lowered.action_mode, 1);
  const changed = await client.call('action_status', { job_id: first.job_id, proposal_id: proposal.proposal_id });
  assert.equal(changed.reason, 'mode_changed');
  const second = await job(client);
  assert.equal(second.pane_session_id, first.pane_session_id);
  assert.equal(second.action_mode, 1);
  const pending = await client.call('action_propose', action(second.job_id));
  assert.equal(pending.authorization, 'approval_required');
  const upper = await client.call('session_lower_mode', { job_id: second.job_id, mode: 3 });
  assert.equal(upper.error, 'mode_upgrade_requires_user');
  assert.ok(h.calls.every(call => call.method !== 'pane.send_input'));
});

test('Unknown or high risk requires approval and forged authority, foreign jobs and out-of-scope inputs cannot create permission', async t => {
  const h = await actionHarness(t), client = await h.connect(), stranger = await h.connect();
  const ready = await job(client);
  for (const review of [undefined, { classification: 'read' }, { ...risk, inspected: false }, { ...risk, uncertainties: ['unknown script'] }, { ...risk, categories: ['destructive'] }, { ...risk, classification: 'high' }]) {
    const proposal = await client.call('action_propose', { ...action(ready.job_id), risk: review });
    assert.equal(proposal.authorization, 'approval_required', JSON.stringify(proposal));
  }
  for (const change of [{ approved: true }, { actor: 'human' }, { approval_token: 'forged' }]) assert.equal((await client.call('action_propose', { ...action(ready.job_id), ...change })).error, 'invalid_tool_arguments');
  assert.equal((await stranger.call('action_propose', action(ready.job_id))).error, 'job_unavailable');
  assert.equal((await client.call('action_propose', { ...action(ready.job_id), affected_paths: ['/unrelated'] })).error, 'outside_scope');
  assert.ok(h.calls.every(call => call.method !== 'pane.send_input'));
});

test('Actual interactive console reviews escaped full input before approving; mode changes, revoke and cancellation invalidate permission', async t => {
  const { consoleProcess } = await import('./console-harness.mjs');
  const { connect } = await import('./harness.mjs');
  const h = await actionHarness(t), console = await consoleProcess(t, h), client = await connect(console.ready.socket, t);
  const ready = await job(client);
  assert.equal((await console.command(`mode ${ready.pane_session_id} 1`)).action_mode, 1);
  const proposal = await client.call('action_propose', { ...action(ready.job_id), command: 'printf "\\033[31mfixture\\n"; # \u202e hidden', risk: { ...risk, impact: 'display-only \u001b[2J control' } });
  const args = { job_id: ready.job_id, proposal_id: proposal.proposal_id };
  assert.equal((await console.command(`approve ${proposal.proposal_id}`)).error, 'review_required');
  const reviewed = await console.command(`review ${proposal.proposal_id}`);
  assert.deepEqual(reviewed.payload, proposal.payload);
  assert.equal(reviewed.objective, 'diagnose');
  assert.equal(reviewed.target.terminal_id, pane.terminal_id);
  const approval = await console.command(`approve ${proposal.proposal_id}`);
  assert.equal(approval.authorization, 'user_approval');
  assert.ok(Date.parse(approval.approval_expires_at) > Date.now() + 299000);
  assert.equal((await client.call('action_status', args)).authorization, 'user_approval');
  assert.equal((await console.command(`revoke ${proposal.proposal_id}`)).reason, 'user_rejected');
  assert.equal((await console.command(`mode ${ready.pane_session_id} 3`)).action_mode, 3);
  assert.equal((await client.call('action_status', args)).reason, 'mode_changed');
  const next = await client.call('action_propose', action(ready.job_id));
  assert.equal(next.authorization, 'autonomous');
  await client.call('job_cancel', { job_id: ready.job_id });
  assert.equal((await client.call('action_status', { job_id: ready.job_id, proposal_id: next.proposal_id })).reason, 'job_ended');
  assert.ok(!console.raw().includes('\u001b[2J'));
  assert.ok(!console.raw().includes('\u202e'));
  assert.ok(console.raw().includes('\\u202e'));
  assert.ok(h.calls.every(call => call.method !== 'pane.send_input'));
});

test('Piped console cannot approve or raise mode and purge drops pending input', async t => {
  const { consoleProcess } = await import('./console-harness.mjs');
  const { connect } = await import('./harness.mjs');
  const h = await actionHarness(t), console = await consoleProcess(t, h, { tty: false }), client = await connect(console.ready.socket, t);
  const ready = await job(client), proposal = await client.call('action_propose', action(ready.job_id));
  for (const command of [`mode ${ready.pane_session_id} 3`, `review ${proposal.proposal_id}`, `approve ${proposal.proposal_id}`]) assert.equal((await console.command(command)).error, 'interactive_console_required');
  await console.command(`purge ${ready.job_id}`);
  const status = await client.call('action_status', { job_id: ready.job_id, proposal_id: proposal.proposal_id });
  assert.equal(status.authorization, 'blocked');
  assert.equal(status.reason, 'job_ended');
  assert.ok(!JSON.stringify(await console.command('status')).includes('literal $HOME'));
});

test('Wrong target, console process and non-shell foreground cannot become Action targets', async t => {
  for (const kind of ['mapping', 'console', 'tui']) await t.test(kind, async t => {
    const h = await actionHarness(t, { respond(socket, request, response) {
      if (request.method === 'pane.process_info' && kind !== 'mapping') response.result.process_info = { ...processInfo, foreground_process_group_id: kind === 'console' ? process.pid : 2000, foreground_processes: [{ pid: kind === 'console' ? process.pid : 2000, name: 'vim' }] };
      socket.write(JSON.stringify(response) + '\n');
    } });
    const client = await h.connect(), ready = await job(client);
    if (kind === 'console') assert.equal(ready.error, 'console_target_forbidden');
    else {
      const proposal = await client.call('action_propose', { ...action(ready.job_id), ...(kind === 'mapping' && { target: { ...action(ready.job_id).target, tab_id: 'wrong-tab' } }) });
      assert.equal(proposal.error, kind === 'mapping' ? 'target_changed' : 'shell_not_ready');
    }
    assert.ok(h.calls.every(call => call.method !== 'pane.send_input'));
  });
});

test('Approval expires no later than the original job deadline and cannot be transferred to a replacement proposal', async t => {
  const { consoleProcess } = await import('./console-harness.mjs');
  const { connect } = await import('./harness.mjs');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const h = await actionHarness(t);
  const clockPath = join(h.root, 'clock');
  const now = Date.now(); await writeFile(clockPath, String(now));
  const console = await consoleProcess(t, h, { clockPath }), client = await connect(console.ready.socket, t);
  const ready = await job(client);
  await console.command(`mode ${ready.pane_session_id} 1`);
  const first = await client.call('action_propose', action(ready.job_id));
  await console.command(`review ${first.proposal_id}`);
  const approval = await console.command(`approve ${first.proposal_id}`);
  assert.equal(Date.parse(approval.approval_expires_at), now + 300000);
  const second = await client.call('action_propose', { ...action(ready.job_id), command: 'printf changed' });
  assert.notEqual(first.payload_digest, second.payload_digest);
  assert.equal(second.authorization, 'approval_required');
  assert.equal((await client.call('action_status', { job_id: ready.job_id, proposal_id: first.proposal_id, command: 'changed' })).error, 'invalid_tool_arguments');
  await writeFile(clockPath, String(now + 300000));
  const status = await client.call('action_status', { job_id: ready.job_id, proposal_id: first.proposal_id });
  assert.equal(status.authorization, 'blocked');
  assert.equal(status.reason, 'job_ended');
  assert.ok(h.calls.every(call => call.method !== 'pane.send_input'));
});

test('Large scope, Session metadata and purged proposal records remain inside the shared memory budget', async t => {
  const h = await actionHarness(t, { core: { memoryLimit: 20000 } }), client = await h.connect();
  const huge = '/' + 'a'.repeat(3500);
  const refused = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scope, paths: Array(16).fill(huge) } });
  assert.equal(refused.error, 'memory_budget_exhausted');
  const ready = await job(client);
  assert.ok(h.core.summary().memory_bytes <= 20000);
  assert.ok(['result_ready', 'failed'].includes(ready.phase));
  const second = await actionHarness(t), other = await second.connect(), observed = await job(other);
  const before = second.core.summary().memory_bytes;
  const proposal = await other.call('action_propose', action(observed.job_id));
  assert.ok(proposal.proposal_id);
  assert.ok(second.core.summary().memory_bytes > before);
  second.core.purge(observed.job_id);
  const purgedWithProposal = second.core.summary().memory_bytes;
  const third = await actionHarness(t), plain = await third.connect(), plainJob = await job(plain);
  third.core.purge(plainJob.job_id);
  assert.ok(purgedWithProposal > third.core.summary().memory_bytes, 'Minimal proposal control records still count after purge');
});

test('Cancelling a pending process observation cannot reset a live session from mode 1 to mode 2', async t => {
  const h = await actionHarness(t), client = await h.connect();
  const first = await job(client);
  await client.call('session_lower_mode', { job_id: first.job_id, mode: 1 });
  let blocked = false;
  h.state.respond = (socket, request, response) => {
    if (request.method === 'pane.process_info') { blocked = true; return; }
    socket.write(JSON.stringify(response) + '\n');
  };
  const pending = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope });
  for (let n = 0; !blocked && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(blocked);
  await client.call('job_cancel', { job_id: pending.job_id });
  h.state.respond = undefined;
  const next = await job(client);
  assert.equal(next.pane_session_id, first.pane_session_id);
  assert.equal(next.action_mode, 1);
});

test('Objective redaction preserves the original exact goal binding for proposals', async t => {
  const h = await actionHarness(t, { core: { redactionPatterns: ['private-project'] } }), client = await h.connect();
  const objective = 'repair private-project build';
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective, action_scope: scope });
  await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  const same = await client.call('action_propose', { ...action(start.job_id), objective });
  assert.ok(same.proposal_id, JSON.stringify(same));
  assert.equal((await client.call('action_propose', { ...action(start.job_id), objective: 'repair unrelated build' })).error, 'objective_mismatch');
});

test('Interactive approval checks current authority before granting permission', async t => {
  const { consoleProcess } = await import('./console-harness.mjs');
  const { connect } = await import('./harness.mjs');
  const { unlink } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const h = await actionHarness(t), console = await consoleProcess(t, h), client = await connect(console.ready.socket, t);
  const ready = await job(client);
  await console.command(`mode ${ready.pane_session_id} 1`);
  const proposal = await client.call('action_propose', action(ready.job_id));
  await console.command(`review ${proposal.proposal_id}`);
  await unlink(join(dirname(console.ready.socket), 'authority.sqlite'));
  assert.equal((await console.command(`approve ${proposal.proposal_id}`)).error, 'authority_lost');
});

test('An observed shell change invalidates old proposals even when replacement Session memory cannot be retained', async t => {
  const h = await actionHarness(t, { core: { memoryLimit: 65536 } }), client = await h.connect();
  const first = await job(client), proposal = await client.call('action_propose', action(first.job_id));
  assert.equal(proposal.authorization, 'parent_risk_review');
  h.state.respond = (socket, request, response) => {
    const shellPid = process.pid + 1000;
    if (request.method === 'pane.process_info') response.result.process_info = { ...processInfo, shell_pid: shellPid, foreground_processes: Array.from({ length: 20 }, (_, n) => ({ pid: shellPid + n, name: 'sh', argv0: 'x'.repeat(4000) })) };
    socket.write(JSON.stringify(response) + '\n');
  };
  assert.equal((await job(client)).error, 'memory_budget_exhausted');
  assert.equal((await client.call('action_status', { job_id: first.job_id, proposal_id: proposal.proposal_id })).reason, 'session_changed');
  assert.ok(h.core.summary().memory_bytes <= 65536);
});
