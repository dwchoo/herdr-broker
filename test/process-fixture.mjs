// Test-only construction seam; never included in the installed package.
import { startCore } from '../dist/core.js';
import { startConsole, connectFacade } from '../dist/runtime.js';
const [mode, endpoint, stateRoot] = process.argv.slice(2);
try {
  if (mode === 'serve') {
    const core = await startCore({ endpoint, stateRoot });
    startConsole(core, process.stdin, process.stdout);
    process.once('SIGTERM', () => void core.close());
  } else await connectFacade(endpoint, process.stdin, process.stdout);
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
