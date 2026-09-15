import { harness, pane } from './harness.mjs';

export const scope = { profile: 'local_posix', cwd: '/fixture', paths: ['/fixture'], trusted: true };
export const risk = { classification: 'read', inspected: true, impact: 'Read a single fixture file', recovery: 'No changes', uncertainties: [], categories: [] };
export const processInfo = { pane_id: pane.pane_id, shell_pid: 1000, foreground_process_group_id: 1000, foreground_processes: [{ pid: 1000, name: 'sh', argv0: 'sh' }] };
export const action = job_id => ({ job_id, target: { pane_id: pane.pane_id, terminal_id: pane.terminal_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id }, objective: 'diagnose', operation: 'execute', command: "printf '%s\\n' 'literal $HOME and quote'", cwd: '/fixture', env: {}, affected_paths: ['/fixture'], risk });
export async function job(client) {
  const start = await client.call('job_start', { pane_id: pane.pane_id, objective: 'diagnose', action_scope: scope });
  return client.call('job_wait', { job_id: start.job_id, wait_ms: 1000 });
}
export async function actionHarness(t, options = {}) {
  return harness(t, { ...options, respond(socket, request, response) {
    if (request.method === 'pane.process_info') response.result = { type: 'pane_process_info', process_info: processInfo };
    if (options.respond) options.respond(socket, request, response);
    else socket.write(JSON.stringify(response) + '\n');
  } });
}
