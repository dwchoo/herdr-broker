#!/usr/bin/env node
import { realpath, access } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const fail = code => { throw Object.assign(new Error(code), { code }); };
try {
  const root = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
  const cwd = relative(root, await realpath(process.cwd()));
  if (cwd === '..' || cwd.startsWith('../') || isAbsolute(cwd)) fail('project_context_required');
  if (process.versions.node.split('.')[0] !== '24') fail('node_24_required');
  const [operation, ...extra] = process.argv.slice(2);
  if (extra.length || !['check', 'serve', 'parent', 'mcp'].includes(operation)) fail('invalid_arguments');
  const cli = join(root, 'dist/cli.js');
  await access(cli).catch(() => fail('build_required'));
  const { loadHerdrConfiguration } = await import(pathToFileURL(join(root, 'dist/herdr-context.js')).href);
  const config = await loadHerdrConfiguration();
  if (operation === 'check') {
    process.stdout.write(JSON.stringify({ ok: true, project: root, pane_id: process.env.HERDR_PANE_ID }) + '\n');
  } else {
    let command = process.execPath;
    let args = [cli, operation];
    if (operation === 'parent') {
      const { stateDirectory } = await import(pathToFileURL(join(root, 'dist/authority.js')).href);
      await new Promise((resolve, reject) => {
        const socket = createConnection(join(stateDirectory(config.endpoint, config.stateRoot), 'core.sock'));
        socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
        socket.once('error', () => reject(Object.assign(new Error('core_unavailable'), { code: 'core_unavailable' })));
        socket.once('connect', () => { socket.destroy(); resolve(); });
      });
      command = config.worker.executable;
      args = ['--no-alt-screen', '-a', 'on-request', '-C', root,
        '-c', 'mcp_servers.herdr_broker.command=' + JSON.stringify(process.execPath),
        '-c', 'mcp_servers.herdr_broker.args=' + JSON.stringify([fileURLToPath(import.meta.url), 'mcp']),
        '-c', 'mcp_servers.herdr_broker.enabled=true'];
      for (const [key, value] of Object.entries(config.herdrContext)) {
        args.push('-c', 'mcp_servers.herdr_broker.env.' + key + '=' + JSON.stringify(value));
      }
    }
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    process.on('SIGINT', () => {}); // The terminal sends SIGINT to the child's foreground group too.
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    child.once('error', () => { process.stderr.write('herdr-broker skill: launch_failed\n'); process.exitCode = 1; });
    child.once('close', code => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'setup_failed';
  process.stderr.write('herdr-broker skill: ' + code + '\n');
  process.exitCode = 1;
}
