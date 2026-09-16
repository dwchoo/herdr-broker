import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/hb-setup-');
  const project = join(root, 'project'), directory = join(project, '.agents/skills/broker/scripts');
  await mkdir(directory, { recursive: true });
  const helper = join(directory, 'run.mjs');
  await copyFile('.agents/skills/broker/scripts/run.mjs', helper);
  await mkdir(join(project, 'dist')); await writeFile(join(project, 'dist/cli.js'), '');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project, config: join(project, '.codex/config.toml'), run: () => spawnSync(process.execPath, [helper, 'setup'], { cwd: project, encoding: 'utf8', timeout: 5000 }) };
}

test('Project setup rejects a .codex symlink and preserves the outside configuration', async t => {
  const h = await fixture(t), outside = join(h.root, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'config.toml'), 'model = "existing"\n');
  await symlink(outside, join(h.project, '.codex'));
  const result = h.run();
  assert.equal(result.status, 1); assert.match(result.stderr, /project_config_invalid/);
  assert.equal(await readFile(join(outside, 'config.toml'), 'utf8'), 'model = "existing"\n');
});

test('Project setup preserves existing settings and is idempotent', async t => {
  const h = await fixture(t);
  await mkdir(join(h.project, '.codex')); await writeFile(h.config, 'approval_policy = "on-request"\nmodel = "existing"\n');
  assert.equal(h.run().status, 0);
  const first = await readFile(h.config, 'utf8');
  assert.ok(first.startsWith('approval_policy = "on-request"\nmodel = "existing"\n'));
  assert.match(first, /\[mcp_servers.herdr_broker\]/);
  assert.equal(h.run().status, 0);
  assert.equal(await readFile(h.config, 'utf8'), first);
});

test('A failed staged settings write leaves the original project configuration intact', async t => {
  const h = await fixture(t), directory = join(h.project, '.codex');
  await mkdir(directory); await writeFile(h.config, 'model = "existing"\n', { mode: 0o600 });
  await chmod(directory, 0o500);
  try {
    assert.equal(h.run().status, 1);
    assert.equal(await readFile(h.config, 'utf8'), 'model = "existing"\n');
  } finally { await chmod(directory, 0o700); }
});
