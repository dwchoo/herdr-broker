import Database from 'better-sqlite3';
import { mkdir, lstat, open, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrokerError, Herdr } from './herdr.js';
import { stateDirectory } from './authority.js';
import { CodexWorker, workerProfile } from './worker.js';
import type { CoreOptions } from './core.js';

const reason = (error: unknown) => error instanceof BrokerError ? error.code : error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(String(error.code)) ? String(error.code) : 'check_failed';
async function state(options: CoreOptions) {
  try {
    await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
    const directory = stateDirectory(options.endpoint, options.stateRoot);
    const privatePath = async (path: string, kind: 'directory' | 'file' | 'socket') => {
      const info = await lstat(path);
      if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600) || !(kind === 'directory' ? info.isDirectory() : kind === 'socket' ? info.isSocket() : info.isFile() && info.nlink === 1)) throw new BrokerError('state_permissions');
      return info;
    };
    await privatePath(options.stateRoot, 'directory');
    const exists = await lstat(directory).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) {
      await privatePath(directory, 'directory');
      for (const name of ['authority.sqlite', 'ledger.sqlite', 'ledger.identity']) await privatePath(join(directory, name), 'file');
      const marker = join(directory, 'ledger.identity');
      if ((await lstat(marker)).size > 128 || !/^[0-9a-f-]{36}\n(?:dirty|clean)\n\d{1,16}$/.test(await readFile(marker, 'utf8'))) throw new BrokerError('ledger_invalid');
      for (const [name, kind] of [['core.sock', 'socket'], ['ledger.sqlite-wal', 'file'], ['ledger.sqlite-shm', 'file']] as const) {
        await privatePath(join(directory, name), kind).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    const probe = join(exists ? directory : options.stateRoot, `.doctor-${randomUUID()}`);
    const file = await open(probe, 'wx', 0o600);
    try { await file.writeFile('probe'); await file.sync(); } finally { await file.close(); await unlink(probe); }
    return { ok: true, directory, initialized: exists, owner_only: true, writable: true, ledger_integrity: 'checked_by_core_on_use' };
  } catch (error) { return { ok: false, error: reason(error) }; }
}

export async function doctor(options: CoreOptions) {
  let sqlite: string | null = null;
  try { const database = new Database(':memory:'); try { sqlite = (database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version; } finally { database.close(); } } catch { /* Report a missing native binding without loading user data. */ }
  const runtime = { node: process.versions.node, platform: process.platform, arch: process.arch, sqlite, supported: process.versions.node.split('.')[0] === '24' && process.platform === 'darwin' && process.arch === 'arm64' && sqlite !== null };
  let herdr, worker;
  try { await new Herdr(options.endpoint, () => {}).check(); herdr = { ok: true, version: '0.9.0', protocol: 22 }; }
  catch (error) { herdr = { ok: false, error: reason(error), expected_version: '0.9.0', expected_protocol: 22 }; }
  try { await new CodexWorker(options.worker).check(); worker = { ok: true, ...workerProfile, profile: 'restricted_diagnosis', model_availability: 'not_probed', inference_performed: false }; }
  catch (error) { worker = { ok: false, error: reason(error), expected_cli_version: workerProfile.cli_version, model_availability: 'not_probed' }; }
  const storage = await state(options);
  return { ok: runtime.supported && herdr.ok && worker.ok && storage.ok, runtime, herdr, worker, state: storage, profiles: { passive: herdr.ok, local_posix: herdr.ok, ssh_posix: herdr.ok, ssh_readiness: 'interactive_confirmation_required' }, limits: { parent_payload_bytes: 16384, worker_calls: 4, ordinary_actions: 3, interrupts: 1 }, privacy: { mode: 'broker_memory', complete_no_store: false }, pane_input_attempts: 0 };
}
