import { startCore, type CoreOptions } from './core.js';
import { startManagementServer } from './management.js';
import { Consoles, type ConsoleRecord } from './consoles.js';
import { BrokerError, Herdr } from './herdr.js';

export async function startBrokerService(consoles: Consoles, initial: ConsoleRecord, options: CoreOptions) {
  let record = initial;
  const info = { label: record.label, controller: record.controller, console_code: consoles.code(record), paneCodes: new Map<string,string>() };
  const scope = { workspace_id: record.workspace_id, tab_id: record.tab_id, terminals: new Map<string,string>() };
  const refresh = async () => {
    record = await consoles.get(initial.console_id); info.controller = record.controller;
    scope.terminals.clear(); info.paneCodes.clear();
    for (const pane of record.panes) { scope.terminals.set(pane.pane_id, pane.terminal_id); info.paneCodes.set(pane.pane_id, consoles.registry.identifyPane(record.endpoint, pane).code); }
  };
  await refresh();
  const core = await startCore({ ...options, consoleId: record.console_id, consoleInfo: info, scope, refreshConsole: refresh,
    verifyParent: async paneId => { await refresh(); return consoles.verifyParent(record, paneId); } });
  let closed = false, stopManagement = async () => {};
  const close = async () => {
    if (closed) return; closed = true; clearInterval(notifications);
    await stopManagement(); await core.close(); consoles.registry.offline(initial.console_id);
    record = await consoles.get(initial.console_id);
    if (record.controller) await consoles.closeManager(record);
  };
  const herdr = new Herdr(options.endpoint, () => {});
  let lastPending = 0, observing = false, ticks = 0;
  consoles.registry.heartbeat(record.console_id, core.parent());
  const notifications = setInterval(() => {
    if (closed) return;
    if (core.isClosed()) { void close(); return; }
    consoles.registry.heartbeat(record.console_id, core.parent());
    if (++ticks % 2 === 0 && !observing) {
      observing = true;
      void refresh().then(() => core.consoleView!.refresh()).catch(() => {}).finally(() => { observing = false; });
    }
    try { const pending = core.consoleView!.snapshot().pending_approvals;
      if (pending > lastPending) void herdr.notify(`Broker ${info.console_code} · 승인 대기`, '관리 화면에서 정확한 입력을 검토해 주세요.').catch(() => {});
      lastPending = pending;
    } catch { /* Authority shutdown is handled by the core. */ }
  }, 1000);
  notifications.unref();
  try {
    stopManagement = await startManagementServer(consoles, record, { ...core, close, async addTerminal() {
      await refresh(); record = await consoles.addTerminal(record, core.parent().pane_id ?? undefined); await refresh(); return core.consoleStatus!();
    }, resolvePane: async ref => (await consoles.resolvePane(ref)).pane_id,
    workspace: cursor => consoles.paneList(record, 'workspace', cursor), async stopBroker() {
      if (core.actions.executing()) throw new BrokerError('action_in_progress');
      setImmediate(() => void close());
    } }, refresh);
  } catch (error) { await close(); throw error; }
  return { ...core, close };
}
