import { realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrokerError } from './herdr.js';

export async function projectContext() {
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const cwd = relative(root, await realpath(process.cwd()));
  if (cwd === '..' || cwd.startsWith('../') || isAbsolute(cwd)) throw new BrokerError('project_context_required');
  return root;
}
