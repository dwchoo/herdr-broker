import { createConnection } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { isatty } from 'node:tty';
import type { Actions } from './actions.js';
import { BrokerError } from './herdr.js';

const encodeConsole = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

interface ConsoleCore { socketPath: string; close(): Promise<void>; summary(): object; purge(id: string): object; actions?: Actions }
export function startConsole(core: ConsoleCore, input: Readable, output: Writable) {
  const commands = ['status', 'purge <job_id>', 'purge all', 'review <proposal_id>', 'approve <proposal_id>', 'reject <proposal_id>', 'revoke <proposal_id>', 'mode <session_id> <1|2|3>', 'inspect <pane_id>', 'recover <original_proposal_id> <new objective>', 'help', 'quit'];
  let buffer = '';
  let reviewed: { id: string; digest: string } | undefined;
  let inspected: Awaited<ReturnType<Actions['inspect']>> | undefined;
  let pending = Promise.resolve();
  const interactive = input === process.stdin && output === process.stdout && isatty(0) && isatty(1);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    input.off('data', onData);
    input.destroy();
    await core.close();
  };
  const run = async (command: string) => {
      if (closing) return;
      if (command === 'quit') { await close(); return; }
      const purge = /^purge (all|[0-9a-f-]{36})$/.exec(command);
      try {
        const inspect = /^inspect (\S{1,256})$/.exec(command);
        const recover = /^recover ([0-9a-f-]{36}) (.+)$/.exec(command);
        if (inspect || recover) {
          if (!interactive || !core.actions) throw new BrokerError('interactive_console_required');
          let response;
          if (inspect) { inspected = await core.actions.inspect(inspect[1]!); response = inspected; }
          else {
            if (!inspected) throw new BrokerError('inspect_required');
            const previous = inspected; inspected = undefined; reviewed = undefined;
            response = await core.actions.recover(previous, recover![1]!, recover![2]!);
          }
          output.write(encodeConsole(response) + '\n');
          return;
        }
        const action = /^(review|approve|reject|revoke|mode) ([0-9a-f-]{36})(?: ([123]))?$/.exec(command);
        if (action) {
          if (!interactive || !core.actions) throw new BrokerError('interactive_console_required');
          let response;
          const [, operation, id, mode] = action;
          if (operation === 'review') { response = core.actions.review(id!); reviewed = { id: id!, digest: response.payload_digest }; }
          else if (operation === 'mode' && mode) { response = core.actions.mode(id!, Number(mode)); reviewed = undefined; }
          else if (operation === 'revoke') { response = core.actions.revoke(id!); reviewed = undefined; }
          else if (['approve', 'reject'].includes(operation!) && reviewed && reviewed.id === id) { response = core.actions.approve(id!, reviewed.digest, operation === 'reject'); reviewed = undefined; }
          else throw new BrokerError('review_required');
          output.write(encodeConsole(response) + '\n');
          return;
        }
        output.write(encodeConsole(command === 'status' ? core.summary() : purge ? core.purge(purge[1]!) : { commands, action_supported: !!core.actions, modes: { default: 2, user_approval: 1, agent_risk_review: 2, autonomous: 3 }, recovery: 'inspect the current pane, then recover the original held proposal with a new objective' }) + '\n');
      } catch (error) { output.write(encodeConsole({ error: error instanceof BrokerError ? error.code : 'internal_error' }) + '\n'); }
  };
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    if (buffer.length > 1024) { buffer = ''; output.write('{"error":"console_input_too_large"}\n'); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const command = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      pending = pending.then(() => run(command));
    }
  };
  input.on('data', onData);
  input.once('end', () => void pending.then(close));
  input.once('error', () => void close());
  output.write(encodeConsole({ status: 'ready', socket: core.socketPath, commands }) + '\n');
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
