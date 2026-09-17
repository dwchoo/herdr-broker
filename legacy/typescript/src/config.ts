import { userInfo } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { z } from 'zod';
import { BrokerError } from './herdr.js';

const configuration = z.strictObject({
  herdr_socket: z.string().min(1).max(4096).refine(isAbsolute).optional(),
  codex_binary: z.string().min(1).max(4096).refine(isAbsolute).optional(),
  redaction_patterns: z.array(z.string().min(1).max(256)).max(16).default([]),
});
export async function loadConfiguration() {
  // OS account home is authoritative; a facade's HOME/XDG overrides cannot fork state.
  const home = userInfo().homedir;
  const path = join(home, '.config/herdr-broker/config.json');
  let value: unknown = {};
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16384) throw new BrokerError('config_invalid');
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new BrokerError('config_invalid');
  }
  const parsed = configuration.safeParse(value);
  if (!parsed.success) throw new BrokerError('config_invalid');
  try {
    return { endpoint: await realpath(parsed.data.herdr_socket ?? join(home, '.config/herdr/herdr.sock')), stateRoot: join(home, '.local/state/herdr-broker'), redactionPatterns: parsed.data.redaction_patterns, worker: { executable: parsed.data.codex_binary ?? '/opt/homebrew/bin/codex' } };
  } catch { throw new BrokerError('herdr_unavailable'); }
}
