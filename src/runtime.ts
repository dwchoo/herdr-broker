import { createConnection } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { BrokerError } from './herdr.js';

interface ConsoleCore { socketPath: string; close(): Promise<void>; summary(): object }
export function startConsole(core: ConsoleCore, input: Readable, output: Writable) {
  let buffer = '';
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    input.off('data', onData);
    input.destroy();
    await core.close();
  };
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    if (buffer.length > 1024) { buffer = ''; output.write('{"error":"console_input_too_large"}\n'); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const command = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (command === 'quit') { void close(); return; }
      output.write(JSON.stringify(command === 'status' ? core.summary() : { commands: ['status', 'help', 'quit'], action_supported: false }) + '\n');
    }
  };
  input.on('data', onData);
  input.once('end', () => void close());
  input.once('error', () => void close());
  output.write(JSON.stringify({ status: 'ready', socket: core.socketPath, commands: ['status', 'help', 'quit'] }) + '\n');
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
