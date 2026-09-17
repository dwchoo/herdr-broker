import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrokerError, Herdr } from './herdr.js';
import { loadConfiguration } from './config.js';

const contextSchema = z.object({
  HERDR_ENV: z.literal('1'),
  HERDR_PANE_ID: z.string().min(1).max(256),
  HERDR_WORKSPACE_ID: z.string().min(1).max(256),
  HERDR_TAB_ID: z.string().min(1).max(256),
  HERDR_SOCKET_PATH: z.string().min(1).max(4096),
});

export async function loadHerdrConfiguration() {
  const parsed = contextSchema.safeParse(process.env);
  if (!parsed.success) throw new BrokerError('herdr_context_required');
  const config = await loadConfiguration();
  const context = parsed.data;
  try {
    if (await realpath(context.HERDR_SOCKET_PATH) !== config.endpoint) throw new Error();
    const herdr = new Herdr(config.endpoint, () => {});
    const pane = await herdr.describe(context.HERDR_PANE_ID);
    if (pane.workspace_id !== context.HERDR_WORKSPACE_ID || pane.tab_id !== context.HERDR_TAB_ID) throw new Error();
    const info = await herdr.processInfo(pane.pane_id);
    if (info.shell_pid === null) throw new Error();

    // Environment values name a candidate pane; OS ancestry establishes membership.
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,uid='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    });
    const processes = new Map<number, { parent: number; uid: number }>();
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) processes.set(Number(match[1]), { parent: Number(match[2]), uid: Number(match[3]) });
    }
    let pid = process.pid;
    const seen = new Set<number>();
    let found = false;
    while (pid > 1 && seen.size < 64 && !seen.has(pid)) {
      seen.add(pid);
      const entry = processes.get(pid);
      if (!entry || entry.uid !== process.getuid?.()) break;
      if (pid === info.shell_pid) { found = true; break; }
      pid = entry.parent;
    }
    if (!found || (await herdr.processInfo(pane.pane_id)).shell_pid !== info.shell_pid) throw new Error();
    return { ...config, herdrContext: context };
  } catch { throw new BrokerError('herdr_context_mismatch'); }
}
