#!/usr/bin/env node
import { realpath, access, mkdir, readFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
try {
  const root = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
  const cwd = relative(root, await realpath(process.cwd()));
  if (cwd === '..' || cwd.startsWith('../') || isAbsolute(cwd)) fail('project_context_required');
  if (process.versions.node.split('.')[0] !== '24') fail('node_24_required');
  const [operation, ...extra] = process.argv.slice(2);
  if (!['setup', 'check', 'serve', 'start', 'manage', 'parent', 'mcp'].includes(operation) || (['serve', 'start', 'manage'].includes(operation) ? extra.length !== 1 : extra.length > 0)) fail('invalid_arguments');
  const cli = join(root, 'dist/cli.js');
  await access(cli).catch(() => fail('build_required'));
  const contextKeys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_SOCKET_PATH'];
  if (operation === 'setup') {
    const directory = join(root, '.codex');
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory()) fail('project_config_invalid');
    const path = join(directory, 'config.toml');
    const start = '# herdr-broker project MCP: begin';
    const end = '# herdr-broker project MCP: end';
    const block = `${start}\n[mcp_servers.herdr_broker]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([cli, 'mcp'])}\ncwd = ${JSON.stringify(root)}\nenabled = true\nenv_vars = ${JSON.stringify(contextKeys)}\n${end}\n`;
    let previous = '';
    let existed = false;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1) fail('project_config_invalid');
      existed = true;
      previous = await readFile(path, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const begin = previous.indexOf(start), finish = previous.indexOf(end);
    if (begin < 0 && /mcp_servers\.herdr_broker/.test(previous)) fail('project_mcp_already_configured');
    if (begin >= 0 && finish < begin) fail('project_config_invalid');
    const next = begin >= 0 ? previous.slice(0, begin) + block + previous.slice(finish + end.length).replace(/^\n/, '') : (previous || 'approval_policy = "on-request"\n') + '\n' + block;
    if (next !== previous) {
      const staging = join(directory, '.herdr-broker-' + randomUUID() + '.tmp');
      try {
        const file = await open(staging, 'wx', 0o600);
        try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
        const current = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!(await lstat(directory)).isDirectory() || Boolean(current) !== existed || (current && (!current.isFile() || current.nlink !== 1 || await readFile(path, 'utf8') !== previous))) fail('project_config_changed');
        await rename(staging, path);
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      } finally { await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    process.stdout.write(JSON.stringify({ ok: true, project_config: path, next: 'Start a new Codex in this project inside Herdr, then invoke $broker.' }) + '\n');
  } else if (['mcp', 'serve', 'start', 'manage'].includes(operation)) {
    process.argv = [process.execPath, cli, operation, ...extra];
    await import(pathToFileURL(cli).href);
  } else {
    const { loadHerdrConfiguration } = await import(pathToFileURL(join(root, 'dist/herdr-context.js')).href);
    const config = await loadHerdrConfiguration();
    if (operation === 'check') {
      process.stdout.write(JSON.stringify({ ok: true, project: root, pane_id: process.env.HERDR_PANE_ID }) + '\n');
    } else {
      const args = ['--no-alt-screen', '-a', 'on-request', '-C', root,
        '-c', 'mcp_servers.herdr_broker.command=' + JSON.stringify(process.execPath),
        '-c', 'mcp_servers.herdr_broker.args=' + JSON.stringify([cli, 'mcp']),
        '-c', 'mcp_servers.herdr_broker.cwd=' + JSON.stringify(root),
        '-c', 'mcp_servers.herdr_broker.enabled=true'];
      for (const [key, value] of Object.entries(config.herdrContext)) args.push('-c', 'mcp_servers.herdr_broker.env.' + key + '=' + JSON.stringify(value));
      const child = spawn(config.worker.executable, args, { cwd: root, stdio: 'inherit' });
      process.on('SIGINT', () => {});
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.once('error', () => { process.stderr.write('broker skill: launch_failed\n'); process.exitCode = 1; });
      child.once('close', code => { process.exitCode = code ?? 1; });
    }
  }
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'setup_failed';
  process.stderr.write('broker skill: ' + code + '\n');
  process.exitCode = 1;
}
