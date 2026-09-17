import { spawn } from 'node:child_process';
import { pane, connect } from './harness.mjs';
import { actionHarness, action, scope } from './action-harness.mjs';
import { consoleProcess } from './console-harness.mjs';

export async function executingHarness(t, options = {}) {
  let h;
  const children = new Set();
  h = await actionHarness(t, { text: 'synthetic shell ready', ...options, respond(socket, request, reply) {
    if (request.method === 'pane.send_input') {
      if (options.execute !== false) {
      const child = spawn('/bin/sh', ['-c', request.params.text], { cwd: h.root, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      child.stdout.on('data', chunk => { h.state.text += '\n' + chunk; });
      child.stderr.on('data', chunk => { h.state.text += '\n' + chunk; });
      child.once('close', () => children.delete(child));
      }
      reply.result = { type: 'ok' };
    }
    if (options.respond) options.respond(socket, request, reply);
    else socket.write(JSON.stringify(reply) + '\n');
  } });
  t.after(() => { for (const child of children) child.kill('SIGKILL'); });
  return h;
}

export async function approved(t, h, command = 'sleep 0.2; printf "observed output\\n"; exit 7', options = {}) {
  const console = await consoleProcess(t, h, options), client = await connect(console.ready.socket, t);
  const start = await client.call('job_start', { analysis: 'auto', pane_id: pane.pane_id, objective: 'diagnose', action_scope: { ...scope, cwd: h.root, paths: [h.root] } });
  const ready = await client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
  await console.command(`mode ${ready.pane_session_id} 1`);
  const proposal = await client.call('action_propose', { ...action(ready.job_id), command, cwd: h.root, affected_paths: [h.root], env: { HB_LITERAL: "literal ' $HOME $(unexecuted)" } });
  await console.command(`review ${proposal.proposal_id}`);
  await console.command(`approve ${proposal.proposal_id}`);
  return { console, client, job: ready, proposal };
}
