import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { exec } from './live-harness.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export async function sshConnect(h, cwd = h.root) {
  const keys = process.env.HB_SSH_KEYS ?? '/private/tmp/herdr-broker-mvp-4drnqB/ssh';
  const port = process.env.HB_SSH_PORT ?? '65345';
  const marker = `HB_REMOTE_READY_${randomUUID()}`;
  const remote = `cd ${quote(cwd)} && stty -echo && printf '\\033[3J\\033[2J\\033[H\\n${marker}\\n' && exec /usr/bin/env ENV=/dev/null PS1='HB> ' /bin/sh -i`;
  const args = ['/usr/bin/ssh', '-tt', '-F', '/dev/null', '-i', join(keys, 'client_key'), '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(keys, 'known_hosts')}`, '-p', port, 'dwchoo@127.0.0.1', remote];
  await exec('herdr', ['pane', 'run', h.pane.pane_id, args.map(quote).join(' ')]);
  for (let attempt = 0; attempt < 60; attempt++) {
    const info = JSON.parse((await exec('herdr', ['pane', 'process-info', '--pane', h.pane.pane_id])).stdout).result.process_info;
    const output = (await exec('herdr', ['pane', 'read', h.pane.pane_id])).stdout;
    if (info.foreground_processes.some(item => item.pid === info.foreground_process_group_id && /ssh$/.test(item.argv0 ?? item.name)) && output.replaceAll('\r', '').split('\n').includes(marker)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned SSH POSIX shell did not become ready');
}
export async function sshConfirm(terminal, paneId, cwd) {
  const inspected = await terminal.command(`inspect ${paneId}`);
  assert.equal(inspected.observed_connection.kind, 'ssh', JSON.stringify(inspected));
  const confirmed = await terminal.command(`ssh-ready ${inspected.pane_session_id} ${cwd}`);
  assert.equal(confirmed.shell_ready, true, JSON.stringify(confirmed));
  return confirmed;
}
export async function sshFailure(h) {
  await writeFile(join(h.root, 'build.sh'), `#!/bin/sh\nprintf '\\nHB_DIAG_BEGIN\\n'\nprintf 'Build requires build.config containing exactly configured.\\n'\ncat build.config\nstatus=$?\nif [ "$status" -ne 0 ]; then printf 'BUILD_FAILED: required configuration could not be read; exit 2\\n'; exit 2; fi\nif [ "$(cat build.config)" != configured ]; then printf 'BUILD_FAILED: wrong configuration; exit 2\\n'; exit 2; fi\nprintf 'BUILD_OK\\n'\n`, { mode: 0o700 });
  await exec('herdr', ['pane', 'run', h.pane.pane_id, "./build.sh; printf 'HB_DIAG_END\\n'"]);
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = (await exec('herdr', ['pane', 'read', h.pane.pane_id])).stdout.replaceAll('\r', '');
    const start = text.lastIndexOf('\nHB_DIAG_BEGIN\n'), end = text.lastIndexOf('\nHB_DIAG_END');
    if (start >= 0 && end > start) return text.slice(start + 1, end).replaceAll(h.root, '<disposable-cwd>');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Controlled SSH build failure was not observed');
}
