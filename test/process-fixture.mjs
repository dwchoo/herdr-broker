// Test-only construction seam; never included in the installed package.
import { readFileSync } from 'node:fs';
import { startCore } from '../dist/core.js';
import { startConsole, connectFacade } from '../dist/runtime.js';
const [mode, endpoint, stateRoot, clockPath] = process.argv.slice(2);
try {
  if (mode === 'doctor') {
    const { doctor } = await import('../dist/doctor.js');
    const report = await doctor({ endpoint, stateRoot, ...(clockPath && { consoleId: clockPath }) });
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = report.ok ? 0 : 1;
  } else if (mode === 'core-console' || mode === 'manage-console') {
    const { Consoles } = await import('../dist/consoles.js');
    const config = JSON.parse(readFileSync(endpoint, 'utf8'));
    const consoles = new Consoles(config), record = await consoles.get(config.consoleId);
    if (mode === 'core-console') {
      const { startBrokerService } = await import('../dist/service.js');
      const core = await startBrokerService(consoles, record, config);
      process.stdout.write('READY\n'); process.once('SIGTERM', () => void core.close());
    } else {
      const { runManagement } = await import('../dist/management.js');
      await runManagement(consoles, record, process.env.HB_TEST_CONSOLE_FORMAT === 'dashboard' ? undefined : 'json');
    }
  } else if (mode === 'serve-console') {
    const { Consoles } = await import('../dist/consoles.js');
    const config = JSON.parse(readFileSync(endpoint, 'utf8'));
    const consoles = new Consoles(config);
    let record = await consoles.get(config.consoleId);
    const scope = { workspace_id: record.workspace_id, tab_id: record.tab_id, terminals: new Map(record.panes.map(pane => [pane.pane_id, pane.terminal_id])) };
    const core = await startCore({ ...config, ...(config.clockPath && { now: () => Number(readFileSync(config.clockPath, 'utf8')) }), consoleInfo: record, scope, verifyParent: async paneId => { const parent = await consoles.verifyParent(record, paneId); await consoles.verify(record); return parent; } });
    const close = startConsole({ ...core, async close() {
      await core.close();
      // Keep the controlling process alive briefly so the external PTY can inspect restored termios.
      if (process.env.HB_TEST_CONSOLE_FORMAT === 'dashboard') await new Promise(resolve => setTimeout(resolve, 150));
    }, async addTerminal() {
      record = await consoles.addTerminal(record);
      for (const pane of record.panes) scope.terminals.set(pane.pane_id, pane.terminal_id);
      return core.consoleStatus();
    } }, process.stdin, process.stdout, process.env.HB_TEST_CONSOLE_FORMAT === 'dashboard' ? undefined : 'json');
    process.once('SIGTERM', () => void close());
  } else if (mode === 'serve') {
    const core = await startCore({ endpoint, stateRoot, ...(process.env.HB_TEST_SSH !== undefined && { sshEnabled: process.env.HB_TEST_SSH === 'true' }), ...(clockPath && { now: () => Number(readFileSync(clockPath, 'utf8')) }), ...(process.env.HB_TEST_REDACTION && { redactionPatterns: JSON.parse(process.env.HB_TEST_REDACTION) }), ...(process.env.HB_TEST_OBSERVATION_MS && { observationMs: Number(process.env.HB_TEST_OBSERVATION_MS) }), fault: point => {
      if (process.env.HB_TEST_FAULT === point) process.kill(process.pid, 'SIGKILL');
      if (point === 'before_wire' && process.env.HB_TEST_BEFORE_WIRE_CONSOLE) {
        const command = readFileSync(process.env.HB_TEST_BEFORE_WIRE_CONSOLE);
        // Schedule a console line after intent but before the asynchronous socket connects.
        queueMicrotask(() => process.stdin.emit('data', command));
      }
    } });
    const close = startConsole(core, process.stdin, process.stdout, 'json');
    process.once('SIGTERM', () => void close());
  } else await connectFacade(endpoint, process.stdin, process.stdout);
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
