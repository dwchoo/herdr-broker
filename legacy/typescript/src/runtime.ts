import { createConnection } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { isatty } from 'node:tty';
import { BrokerError } from './herdr.js';
import { ConsoleCommands, encodeConsole, type ConsoleCore } from './console-commands.js';
import { startDashboard } from './console-ui.js';

export function startConsole(core: ConsoleCore, input: Readable, output: Writable, format?: 'json') {
  const interactive = input === process.stdin && output === process.stdout && isatty(0) && isatty(1);
  let closing = false;
  let cleanup = () => {};
  const close = async () => {
    if (closing) return;
    closing = true;
    commands.stop();
    cleanup();
    input.destroy();
    await core.close();
  };
  const commands = new ConsoleCommands(core, interactive, close);
  input.once('end', () => void commands.idle().then(close));
  input.once('error', () => void close());
  output.once('error', () => void close());
  if (interactive && format !== 'json' && process.env.TERM !== 'dumb' && core.consoleView) {
    cleanup = startDashboard(core.consoleView, commands, close);
  } else {
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (buffer.length > 1024) { buffer = ''; output.write('{"error":"console_input_too_large"}\n'); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const command = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        void commands.run(command).then(value => { if (!closing) output.write(encodeConsole(value) + '\n'); });
      }
    };
    input.on('data', onData);
    cleanup = () => { input.off('data', onData); };
    output.write(encodeConsole({ status: 'ready', socket: core.socketPath, ...(core.consoleStatus && { console: core.consoleStatus() }), commands: commands.commands }) + '\n');
  }
  return close;
}

export function connectFacade(socketPath: string, input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(new BrokerError('core_unavailable')), 5000);
    let connected = false;
    let failure: BrokerError | undefined;
    const inputError = () => socket.destroy(new BrokerError('stdio_unavailable'));
    input.once('error', inputError);
    output.once('error', inputError);
    socket.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      input.pipe(socket);
      socket.pipe(output, { end: false });
    });
    socket.on('error', () => { failure = new BrokerError(connected ? 'core_disconnected' : 'core_unavailable'); });
    socket.once('close', () => {
      clearTimeout(timer);
      input.unpipe(socket); socket.unpipe(output); input.destroy();
      input.off('error', inputError); output.off('error', inputError);
      if (failure) reject(failure); else resolve();
    });
  });
}
