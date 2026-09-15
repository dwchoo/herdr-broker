import { readFile, writeFile, mkdir, lstat, unlink, rm, open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { liveHarness } from './live-harness.mjs';
import { consoleProcess } from '../test/console-harness.mjs';

async function replacePrivate(path, data, mode = 0o600) {
  const temporary = `${path}.broker-test-${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function installedHarness(t) {
  const installation = JSON.parse(await readFile(process.env.HB_INSTALLATION ?? '/private/tmp/herdr-broker-mvp-4drnqB/issue23-installation.json', 'utf8'));
  const h = await liveHarness(t);
  const config = join(userInfo().homedir, '.config/herdr-broker/config.json');
  let saved;
  const info = await lstat(config).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info) {
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Existing configuration is not a private owner file');
    saved = await readFile(config);
  }
  await mkdir(dirname(config), { recursive: true, mode: 0o700 });
  const temporary = JSON.stringify({ herdr_socket: h.endpoint, codex_binary: '/opt/homebrew/bin/codex' }) + '\n';
  let terminal, applied = false;
  const backup = saved ? `${config}.broker-backup-${randomUUID()}` : null;
  if (saved) await replacePrivate(backup, saved);
  t.after(async () => {
    if (terminal?.child.exitCode === null && terminal.child.signalCode === null) {
      const ended = new Promise(resolve => terminal.child.once('close', resolve));
      terminal.child.stdin.end('quit\n'); await ended;
    }
    if (!applied) { if (backup) await unlink(backup); return; }
    if (await readFile(config, 'utf8') !== temporary) throw new Error('Configuration changed during acceptance; preserved for manual recovery');
    if (saved) { await replacePrivate(config, saved, info.mode & 0o777); await unlink(backup); }
    else await unlink(config);
    if (terminal?.ready.socket) await rm(dirname(terminal.ready.socket), { recursive: true, force: true });
  });
  if (saved) {
    if (!(await readFile(config)).equals(saved)) throw new Error('Configuration changed before acceptance; preserved');
    await replacePrivate(config, temporary);
  } else await writeFile(config, temporary, { mode: 0o600, flag: 'wx' });
  applied = true;
  terminal = await consoleProcess(t, h, { executable: installation.executable });
  return { ...h, installation, terminal };
}
