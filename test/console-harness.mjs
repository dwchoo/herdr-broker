import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

export async function consoleProcess(t, h, { tty = true, clockPath, fault, observationMs, beforeWireConsole, redactionPatterns, executable, sshEnabled } = {}) {
  await h.core.close();
  const args = executable ? [executable, 'serve'] : ['test/process-fixture.mjs', 'serve', h.endpoint, join(h.root, 'state'), ...(clockPath ? [clockPath] : [])];
  const env = { ...process.env, ...(sshEnabled !== undefined && { HB_TEST_SSH: String(sshEnabled) }), ...(fault && { HB_TEST_FAULT: fault }), ...(observationMs && { HB_TEST_OBSERVATION_MS: String(observationMs) }), ...(beforeWireConsole && { HB_TEST_BEFORE_WIRE_CONSOLE: beforeWireConsole }), ...(redactionPatterns && { HB_TEST_REDACTION: JSON.stringify(redactionPatterns) }) };
  const child = tty ? spawn('python3', ['test/pty-fixture.py', process.execPath, ...args], { detached: true, stdio: 'pipe', env }) : spawn(process.execPath, args, { detached: true, stdio: 'pipe', env });
  const messages = [], readers = [];
  let buffer = '', raw = '';
  child.stdout.on('data', chunk => {
    raw += chunk; buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith('{')) continue;
      const parsed = JSON.parse(line);
      if (readers.length) readers.shift()(parsed); else messages.push(parsed);
    }
  });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('console response timeout')), 5000);
    readers.push(value => { clearTimeout(timer); resolve(value); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'close');
      child.stdin.end('quit\n');
      const timer = setTimeout(() => { try { process.kill(-child.pid, tty ? 'SIGTERM' : 'SIGKILL'); } catch {} }, 1000);
      await stopped; clearTimeout(timer);
    }
  });
  const ready = await next();
  return { child, ready, raw: () => raw, command: async text => { child.stdin.write(text + '\n'); return next(); } };
}
