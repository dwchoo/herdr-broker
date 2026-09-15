import Database from 'better-sqlite3';
import { mkdirSync, lstatSync, chmodSync, existsSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BrokerError } from './herdr.js';

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new BrokerError('state_permissions');
  chmodSync(path, 0o700);
}
export function stateDirectory(endpoint: string, stateRoot: string) {
  return join(stateRoot, createHash('sha256').update(endpoint).digest('hex').slice(0, 24));
}
export function acquireAuthority(endpoint: string, stateRoot: string) {
  privateDirectory(stateRoot);
  const directory = stateDirectory(endpoint, stateRoot);
  const existing = existsSync(directory);
  privateDirectory(directory);
  const path = join(directory, 'authority.sqlite');
  const fresh = !existsSync(path);
  if (fresh && existing) throw new BrokerError('authority_invalid');
  if (fresh) closeSync(openSync(path, 'wx', 0o600));
  const inode = lstatSync(path);
  if (!inode.isFile() || inode.uid !== process.getuid?.() || inode.nlink !== 1) throw new BrokerError('state_permissions');
  chmodSync(path, 0o600);
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { timeout: 0 });
    database.pragma('journal_mode = DELETE');
    database.exec('BEGIN EXCLUSIVE');
    if (fresh) {
      database.exec('CREATE TABLE authority (endpoint TEXT NOT NULL, format INTEGER NOT NULL)');
      database.prepare('INSERT INTO authority VALUES (?, 1)').run(endpoint);
      database.exec('COMMIT; BEGIN EXCLUSIVE');
    }
    const row = database.prepare('SELECT endpoint, format FROM authority').get();
    if (JSON.stringify(row) !== JSON.stringify({ endpoint, format: 1 }) || database.pragma('quick_check', { simple: true }) !== 'ok') throw new BrokerError('authority_invalid');
    const held = database;
    return { directory,
      verify() {
        try {
          const current = lstatSync(path);
          if (!held.inTransaction || current.ino !== inode.ino || current.dev !== inode.dev || current.nlink !== 1) throw new BrokerError('authority_lost');
        } catch { throw new BrokerError('authority_lost'); }
      },
      close() { if (held.open) held.close(); },
    };
  } catch (error) {
    database?.close();
    if (error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY') throw new BrokerError('authority_busy');
    throw error instanceof BrokerError ? error : new BrokerError('authority_invalid');
  }
}
