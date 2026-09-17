import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { harness, connect } from './harness.mjs';
import { Consoles } from '../dist/consoles.js';
import { startConsoleMcp } from '../dist/console-mcp.js';
import { startCore } from '../dist/core.js';
import { startBrokerService } from '../dist/service.js';

export async function consoleHarness(t) {
  const h = await harness(t);
  await h.core.close();
  const config = { endpoint: h.endpoint, stateRoot: join(h.root, 'consoles-state'), project: resolve('.'), herdrContext: { HERDR_PANE_ID: 'parent', HERDR_WORKSPACE_ID: 'workspace-1', HERDR_TAB_ID: 'tab-1' } };
  const consoles = new Consoles(config);
  const panes = new Map(), cores = [], gateways = [];
  config.launchCore = async record => { cores.push(await startBrokerService(consoles, record, config)); };
  let sequence = 0;
  const create = (workspace_id, tab_id = `tab-${sequence + 1}`) => {
    const id = ++sequence;
    const pane = { pane_id: `ws${workspace_id}:p${id}`, terminal_id: `terminal-${id}`, workspace_id, tab_id, cwd: config.project, agent_status: 'unknown' };
    panes.set(pane.pane_id, pane);
    return pane;
  };
  const parent = { pane_id: 'parent', terminal_id: 'parent-terminal', workspace_id: 'workspace-1', tab_id: 'tab-1', cwd: config.project, agent_status: 'unknown' };
  panes.set(parent.pane_id, parent);
  h.state.respond = async (socket, request, response) => {
    const params = request.params;
    if (request.method === 'workspace.create') response.result = { type: 'workspace_created', root_pane: create(`workspace-${sequence}`) };
    else if (request.method === 'pane.split' || request.method === 'tab.create') response.result = { type: 'pane_created', [request.method === 'pane.split' ? 'pane' : 'root_pane']: create(params.workspace_id, panes.get(params.target_pane_id)?.tab_id) };
    else if (request.method === 'pane.list') response.result = { type: 'pane_list', panes: [...panes.values()].filter(pane => pane.workspace_id === params.workspace_id) };
    else if (request.method === 'pane.rename') { panes.get(params.pane_id).label = params.label; response.result = { type: 'ok' }; }
    else if (request.method === 'pane.close') { panes.delete(params.pane_id); response.result = { type: 'ok' }; }
    else if (request.method === 'notification.show') response.result = { type: 'ok' };
    else if (request.method === 'pane.get') {
      if (panes.has(params.pane_id)) response.result = { type: 'pane_info', pane: panes.get(params.pane_id) };
      else { delete response.result; response.error = { code: 'pane_not_found' }; }
      h.state.afterGet?.(params.pane_id);
    }
    else if (request.method === 'pane.process_info') {
      const starting = h.state.starting > 0;
      if (starting) h.state.starting--;
      const name = h.state.controllerProcess ?? (starting ? 'initializing' : 'sh');
      response.result = { type: 'pane_process_info', process_info: { pane_id: params.pane_id, shell_pid: 1000, foreground_process_group_id: starting ? 1001 : 1000, foreground_processes: [{ pid: starting ? 1001 : 1000, name, argv0: name }] } };
    }
    else if (request.method === 'pane.read') {
      if (h.state.beforeRead) await h.state.beforeRead();
      const pane = panes.get(params.pane_id);
      response.result = { type: 'pane_read', read: { ...pane, source: params.source, format: 'ansi', text: 'shared terminal output', truncated: false, revision: 0 } };
    } else if (request.method === 'pane.send_input') {
      const match = / 'serve' '([a-f0-9-]+)'$/.exec(params.text);
      if (match) {
        const record = await consoles.get(match[1]);
        cores.push(await startCore({ ...config, consoleId: record.console_id, consoleInfo: record, verifyParent: async paneId => { const parent = await consoles.verifyParent(record, paneId); await consoles.verify(record); return parent; }, scope: { workspace_id: record.workspace_id, tab_id: record.tab_id, terminals: new Map(record.panes.map(pane => [pane.pane_id, pane.terminal_id])) } }));
      }
      response.result = { type: 'ok' };
    }
    socket.write(JSON.stringify(response) + '\n');
  };
  const endpoint = join(h.root, 'gateway.sock');
  const server = createServer(socket => gateways.push(startConsoleMcp({ ...config, herdrContext: { ...config.herdrContext } }, socket, socket)));
  server.listen(endpoint); await once(server, 'listening');
  h.state.beforeClose = async () => {
    for (const close of gateways) await close();
    await new Promise(resolve => server.close(resolve));
    for (const core of cores) await core.close();
  };
  return { ...h, config, consoles, cores, panes, parent, create, async controllerRecord(label) { return consoles.openManager(await consoles.create(label)); }, connect: () => connect(endpoint, t) };
}
