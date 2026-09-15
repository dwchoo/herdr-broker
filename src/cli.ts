#!/usr/bin/env node
import { join } from 'node:path';
import { startCore } from './core.js';
import { loadConfiguration } from './config.js';
import { stateDirectory } from './authority.js';
import { startConsole, connectFacade } from './runtime.js';
import { BrokerError } from './herdr.js';
import { doctor } from './doctor.js';

try {
  if (process.versions.node.split('.')[0] !== '24') throw new BrokerError('node_24_required');
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length) throw new BrokerError('invalid_arguments');
  if (command === '--version') process.stdout.write('herdr-broker 0.1.0\n');
  else if (!command || command === '--help') process.stdout.write('Usage: herdr-broker serve | mcp | doctor | --version\nserve: start the local core and interactive console\nmcp: connect stdio to the existing core\ndoctor: check runtime, pinned profile and private state without pane input\n');
  else if (command === 'doctor') {
    const report = await doctor(await loadConfiguration());
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
  else if (command === 'serve') {
    const core = await startCore(await loadConfiguration());
    const close = startConsole(core, process.stdin, process.stdout);
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } else if (command === 'mcp') {
    const config = await loadConfiguration();
    await connectFacade(join(stateDirectory(config.endpoint, config.stateRoot), 'core.sock'), process.stdin, process.stdout);
  } else throw new BrokerError('invalid_arguments');
} catch (error) {
  process.stderr.write(`herdr-broker: ${error instanceof BrokerError ? error.code : 'startup_failed'}\n`);
  process.exitCode = 1;
}
