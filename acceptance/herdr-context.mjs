import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const command of ['serve', 'mcp', 'doctor']) test(`Copying a real Herdr pane environment does not admit external ${command}`, async () => {
  assert.notEqual(process.env.HERDR_ENV, '1', 'Run this probe outside Herdr');
  const context = JSON.parse(await readFile(process.env.HB_HERDR_CONTEXT, 'utf8'));
  const result = spawnSync(process.execPath, ['dist/cli.js', command], {
    env: { ...process.env, ...context.env }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /herdr_context_mismatch/);
});
