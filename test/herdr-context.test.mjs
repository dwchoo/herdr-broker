import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

for (const command of ['serve', 'mcp', 'doctor']) test(`Production ${command} refuses a caller running outside Herdr`, () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')));
  const result = spawnSync(process.execPath, ['dist/cli.js', command], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /herdr_context_required/);
});

for (const command of ['--help', '--version']) test(`${command} remains available before entering Herdr`, () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', command], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /herdr-broker/);
});

test('The project skill refuses another project before starting a Parent', () => {
  const result = spawnSync(process.execPath, [resolve('.agents/skills/herdr-broker/scripts/run.mjs'), 'parent'], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /project_context_required/);
});

test('The project skill refuses an outside Parent even in the right project', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HERDR_')));
  const result = spawnSync(process.execPath, ['.agents/skills/herdr-broker/scripts/run.mjs', 'parent'], {
    env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /herdr_context_required/);
});
