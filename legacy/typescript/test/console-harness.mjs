import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function consoleProcess(t, h, { tty = true, clockPath, fault, observationMs, beforeWireConsole, redactionPatterns, executable, sshEnabled, consoleConfig, remoteManagement = false, format = 'json', columns = 80, rows = 24, term = 'xterm-256color' } = {}) {
  await h.core.close();
  let args = executable ? [executable, 'serve'] : ['test/process-fixture.mjs', 'serve', h.endpoint, join(h.root, 'state'), ...(clockPath ? [clockPath] : [])];
  if (consoleConfig) {
    const path = join(h.root, 'console-config.json');
    await writeFile(path, JSON.stringify(consoleConfig), { mode: 0o600 });
    args = ['test/process-fixture.mjs', remoteManagement ? 'manage-console' : 'serve-console', path];
  }
  const sizePath = join(h.root, 'console-size.json');
  await writeFile(sizePath, JSON.stringify({ columns, rows }));
  const env = { ...process.env, TERM: term, HB_TEST_CONSOLE_FORMAT: format, HB_TEST_WINSIZE_PATH: sizePath, ...(sshEnabled !== undefined && { HB_TEST_SSH: String(sshEnabled) }), ...(fault && { HB_TEST_FAULT: fault }), ...(observationMs && { HB_TEST_OBSERVATION_MS: String(observationMs) }), ...(beforeWireConsole && { HB_TEST_BEFORE_WIRE_CONSOLE: beforeWireConsole }), ...(redactionPatterns && { HB_TEST_REDACTION: JSON.stringify(redactionPatterns) }) };
  const child = tty ? spawn('python3', ['test/pty-fixture.py', process.execPath, ...args], { detached: true, stdio: 'pipe', env }) : spawn(process.execPath, args, { detached: true, stdio: 'pipe', env });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const messages = [], readers = [];
  let buffer = '', raw = '';
  let terminalState, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; const match = /PTY_STATE (\{[^\n]+\})/.exec(stderr); if (match) terminalState = JSON.parse(match[1]); });
  child.stdout.on('data', chunk => {
    raw += chunk; buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (format === 'dashboard' && tty && term !== 'dumb' || !line.startsWith('{')) continue;
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
      child.stdin.end(format === 'dashboard' && tty && term !== 'dumb' ? '\u0003' : 'quit\n');
      const timer = setTimeout(() => { try { process.kill(-child.pid, tty ? 'SIGTERM' : 'SIGKILL'); } catch {} }, 1000);
      await stopped; clearTimeout(timer);
    }
  });
  const screen = () => raw.slice(raw.lastIndexOf('\u001b[1;1H')).replace(/\u001b\[\d+;1H/g, '\n').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  const waitFor = async predicate => {
    const deadline = Date.now() + 8000;
    while (!predicate(screen())) {
      if (Date.now() >= deadline) throw new Error('dashboard timeout: ' + screen());
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return screen();
  };
  const ready = format === 'dashboard' && tty && term !== 'dumb' ? await waitFor(text => text.includes('BROKER')) : await next();
  return { child, ready, raw: () => raw, screen, waitFor, stderr: () => stderr, terminalState: () => terminalState, keys: text => child.stdin.write(text),
    resize: async (columns, rows) => { await writeFile(sizePath, JSON.stringify({ columns, rows })); child.kill('SIGWINCH'); },
    command: async text => { child.stdin.write(text + '\n'); return next(); } };
}
