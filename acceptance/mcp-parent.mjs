import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';

export async function mcpParent(t, installation, directory, prompt) {
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const args = ['--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'plugins', '--disable', 'multi_agent', '--disable', 'code_mode', '--disable', 'code_mode_only', 'exec', '--ignore-user-config', '--strict-config', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', directory, '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"', '-c', `sqlite_home=${JSON.stringify(join(directory, 'parent-state'))}`, '-c', `log_dir=${JSON.stringify(join(directory, 'parent-logs'))}`, '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"', '-c', `mcp_servers.herdr_broker.command=${JSON.stringify(installation.executable)}`, '-c', 'mcp_servers.herdr_broker.args=["mcp"]', '-c', `mcp_servers.herdr_broker.env.PATH=${JSON.stringify(env.PATH)}`, '-c', 'mcp_servers.herdr_broker.required=true', '-c', 'mcp_servers.herdr_broker.default_tools_approval_mode="writes"', '--json', '-'];
  const began = Date.now(), child = spawn('/opt/homebrew/bin/codex', args, { cwd: directory, env, detached: true, stdio: 'pipe' });
  let stdout = '', stderr = '';
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(stop, 240000); t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) stop(); });
  child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 524288) stop(); });
  child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 65536) stop(); });
  child.stdin.on('error', stop); child.stdin.end(prompt);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timer);
  const events = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  const calls = events.filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map(event => event.item);
  const values = calls.map(call => ({ tool: call.tool, value: (() => { try { return JSON.parse(call.result?.content?.[0]?.text); } catch { return null; } })() }));
  return { code, elapsed_ms: Date.now() - began, calls, values, usage: events.filter(event => event.type === 'turn.completed').map(event => event.usage), stderr_bytes: Buffer.byteLength(stderr), final: events.filter(event => event.item?.type === 'agent_message').map(event => event.item.text) };
}
