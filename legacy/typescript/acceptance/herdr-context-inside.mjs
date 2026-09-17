import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('A project skill in a real Herdr pane reaches the running Broker MCP', async () => {
  assert.equal(process.env.HERDR_ENV, '1');
  const helper = resolve('.agents/skills/herdr-broker/scripts/run.mjs');
  const checked = spawnSync(process.execPath, [helper, 'check'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(checked.status, 0, checked.stderr);
  const context = JSON.parse(checked.stdout);
  assert.equal(context.ok, true);
  assert.equal(context.pane_id, process.env.HERDR_PANE_ID);
  const diagnosed = spawnSync(process.execPath, ['dist/cli.js', 'doctor'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  const doctor = JSON.parse(diagnosed.stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.pane_input_attempts, 0);
  const client = new Client({ name: 'herdr-project-acceptance', version: '1' });
  let names;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [helper, 'mcp'], stderr: 'pipe',
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('HERDR_'))),
    }));
    names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.length, 10);
    assert.ok(names.includes('action_submit'));
  } finally { await client.close(); }
  await writeFile(process.env.HB_CONTEXT_PROOF, JSON.stringify({ context, doctor, mcp_tools: names }, null, 2) + '\n');
});
