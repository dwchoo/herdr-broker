#!/usr/bin/env node
import { startCore } from './core.js';
import { loadHerdrConfiguration } from './herdr-context.js';
import { startConsole } from './runtime.js';
import { BrokerError } from './herdr.js';
import { doctor } from './doctor.js';
import { Consoles } from './consoles.js';
import { startConsoleMcp } from './console-mcp.js';
import { projectContext } from './project-context.js';
import { startBrokerService } from './service.js';
import { runManagement } from './management.js';

try {
  if (process.versions.node.split('.')[0] !== '24') throw new BrokerError('node_24_required');
  const [command, ...extra] = process.argv.slice(2);
  const jsonConsole = ['serve', 'manage'].includes(command ?? '') && extra.length === 3 && extra[1] === '--format' && extra[2] === 'json';
  if (['serve','manage','start','core'].includes(command ?? '') ? extra.length !== 1 && !jsonConsole : command === 'doctor' ? extra.length > 1 : extra.length > 0) throw new BrokerError('invalid_arguments');
  if (command === '--version') process.stdout.write('herdr-broker 0.1.0\n');
  else if (!command || command === '--help') process.stdout.write('Usage: herdr-broker start <code|UUID> | manage <code|UUID> [--format json] | serve <code|UUID> [--format json] | mcp | doctor <code|UUID> | --version\nstart: start or resume a background Broker, preserving shells\nmanage: open its temporary management pane (non-TTY/TERM=dumb: JSON)\nserve: legacy alias inside a registered management pane\nmcp: discover workspace panes, open or attach a persistent Broker from this project in Herdr\ndoctor: check runtime, pinned profile and that Console’s private state without pane input\n');
  else if (command === 'doctor') {
    const config = { ...await loadHerdrConfiguration(), project: await projectContext() };
    if (!extra[0]) throw new BrokerError('console_id_required');
    const record = await new Consoles(config).get(extra[0]);
    const report = await doctor({ ...config, consoleId: record.console_id });
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
  else if (['core', 'start', 'manage'].includes(command ?? '')) {
    const config = { ...await loadHerdrConfiguration(), project: await projectContext() };
    const consoles = new Consoles(config);
    let record = await consoles.get(extra[0]!);
    if (command === 'core') {
      if (!record.background) throw new BrokerError('console_migration_required');
      const core = await startBrokerService(consoles, record, config);
      process.once('SIGINT', () => void core.close()); process.once('SIGTERM', () => void core.close());
      if (process.send) process.send({ ready: true });
    } else if (command === 'start') {
      record = await consoles.launch(record); process.stdout.write(JSON.stringify(consoles.describeRecord(record)) + '\n');
    } else if (record.controller?.pane_id === config.herdrContext.HERDR_PANE_ID) {
      await runManagement(consoles, record, jsonConsole ? 'json' : undefined);
    } else {
      record = await consoles.launch(record);
      const opened = await consoles.openManager(record); process.stdout.write(JSON.stringify(consoles.describeRecord(opened)) + '\n');
    }
  }
  else if (command === 'serve') {
    const config = { ...await loadHerdrConfiguration(), project: await projectContext() };
    const consoles = new Consoles(config);
    let record = await consoles.get(extra[0]!);
    if (record.background) { await runManagement(consoles, record, jsonConsole ? 'json' : undefined); }
    else {
    if (record.controller?.pane_id !== config.herdrContext.HERDR_PANE_ID) throw new BrokerError('console_controller_required');
    await consoles.verify(record);
    const scope = { workspace_id: record.workspace_id, tab_id: record.tab_id, terminals: new Map(record.panes.map(pane => [pane.pane_id, pane.terminal_id])) };
    const core = await startCore({ ...config, consoleId: record.console_id, consoleInfo: record, scope, verifyParent: async paneId => {
      const parent = await consoles.verifyParent(record, paneId); await consoles.verify(record); return parent;
    } });
    const close = startConsole({ ...core, async addTerminal() {
      record = await consoles.addTerminal(record);
      for (const pane of record.panes) scope.terminals.set(pane.pane_id, pane.terminal_id);
      return core.consoleStatus!();
    } }, process.stdin, process.stdout, jsonConsole ? 'json' : undefined);
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
    }
  } else if (command === 'mcp') {
    const config = { ...await loadHerdrConfiguration(), project: await projectContext() };
    const close = startConsoleMcp(config, process.stdin, process.stdout);
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } else throw new BrokerError('invalid_arguments');
} catch (error) {
  process.stderr.write(`herdr-broker: ${error instanceof BrokerError ? error.code : 'startup_failed'}\n`);
  process.exitCode = 1;
}
