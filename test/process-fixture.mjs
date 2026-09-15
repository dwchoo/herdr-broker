// Test-only construction seam; never included in the installed package.
import { readFileSync } from 'node:fs';
import { startCore } from '../dist/core.js';
import { startConsole, connectFacade } from '../dist/runtime.js';
const [mode, endpoint, stateRoot, clockPath] = process.argv.slice(2);
try {
  if (mode === 'doctor') {
    const { doctor } = await import('../dist/doctor.js');
    const report = await doctor({ endpoint, stateRoot });
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = report.ok ? 0 : 1;
  } else if (mode === 'serve') {
    const core = await startCore({ endpoint, stateRoot, ...(clockPath && { now: () => Number(readFileSync(clockPath, 'utf8')) }), ...(process.env.HB_TEST_REDACTION && { redactionPatterns: JSON.parse(process.env.HB_TEST_REDACTION) }), ...(process.env.HB_TEST_OBSERVATION_MS && { observationMs: Number(process.env.HB_TEST_OBSERVATION_MS) }), fault: point => {
      if (process.env.HB_TEST_FAULT === point) process.kill(process.pid, 'SIGKILL');
      if (point === 'before_wire' && process.env.HB_TEST_BEFORE_WIRE_CONSOLE) {
        const command = readFileSync(process.env.HB_TEST_BEFORE_WIRE_CONSOLE);
        // Schedule a console line after intent but before the asynchronous socket connects.
        queueMicrotask(() => process.stdin.emit('data', command));
      }
    } });
    startConsole(core, process.stdin, process.stdout);
    process.once('SIGTERM', () => void core.close());
  } else await connectFacade(endpoint, process.stdin, process.stdout);
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
