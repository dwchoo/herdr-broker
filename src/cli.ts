#!/usr/bin/env node
import { startCore } from './core.js';
import { loadHerdrConfiguration } from './herdr-context.js';
import { startConsole } from './runtime.js';
import { BrokerError } from './herdr.js';
import { doctor } from './doctor.js';
import { Consoles } from './consoles.js';
import { startConsoleMcp } from './console-mcp.js';
import { projectContext } from './project-context.js';

try {
  if (process.versions.node.split('.')[0] !== '24') throw new BrokerError('node_24_required');
  const [command, ...extra] = process.argv.slice(2);
  if (command === 'serve' ? extra.length !== 1 : command === 'doctor' ? extra.length > 1 : extra.length > 0) throw new BrokerError('invalid_arguments');
  if (command === '--version') process.stdout.write('herdr-broker 0.1.0\n');
  else if (!command || command === '--help') process.stdout.write('Usage: herdr-broker serve <console_id> | mcp | doctor <console_id> | --version\nserve: run a Console core in its owned control pane\nmcp: open or attach a persistent Console from this project in Herdr\ndoctor: check runtime, pinned profile and that Console’s private state without pane input\n');
  else if (command === 'doctor') {
    const config = { ...await loadHerdrConfiguration(), project: await projectContext() };
    if (!extra[0]) throw new BrokerError('console_id_required');
    const record = await new Consoles(config).get(extra[0]);
    const report = await doctor({ ...config, consoleId: record.console_id });
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
  else if (command === 'serve') {
    const config = { ...await loadHerdrConfiguration(), project: await projectContext() };
    const consoles = new Consoles(config);
    let record = await consoles.get(extra[0]!);
    if (record.controller.pane_id !== config.herdrContext.HERDR_PANE_ID) throw new BrokerError('console_controller_required');
    await consoles.verify(record);
    const scope = { workspace_id: record.workspace_id, tab_id: record.tab_id, terminals: new Map(record.panes.map(pane => [pane.pane_id, pane.terminal_id])) };
    const core = await startCore({ ...config, consoleId: record.console_id, scope, verifyParent: async paneId => {
      await consoles.verifyParent(record, paneId); await consoles.verify(record);
    } });
    const close = startConsole({ ...core, async addTerminal() {
      record = await consoles.addTerminal(record);
      for (const pane of record.panes) scope.terminals.set(pane.pane_id, pane.terminal_id);
      return core.consoleStatus!();
    } }, process.stdin, process.stdout);
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
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
