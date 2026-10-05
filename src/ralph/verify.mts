import { execa } from 'execa';
import { getShell, shellArgv } from '../shell/resolve-shell.mts';

export interface VerifyResult {
  readonly passed: boolean;
  readonly output: string;
}

// Long enough for a real test suite, short enough that a hung test (an open
// server handle, a watcher) can't stall the loop.
const VERIFY_TIMEOUT_MS = 300_000;

// Keep the tail: test runners print the summary and failures last.
const MAX_OUTPUT_CHARS = 4000;

/**
 * Run a task's test command in the working directory, in this OS's resolved
 * shell. Used to salvage a worker that ran out of steps after writing its
 * files: if the tests pass, the work goes on to lint and review instead of
 * being thrown away.
 */
export async function runTestCommand(
  workingDirectory: string,
  command: string,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<VerifyResult> {
  if (command.trim().length === 0) {
    return { passed: false, output: 'No test command.' };
  }
  const resolved = getShell();
  if (!resolved.ok) {
    return { passed: false, output: `No usable shell: ${resolved.error}` };
  }
  try {
    const proc = await execa(resolved.shell.path, shellArgv(resolved.shell, command), {
      cwd: workingDirectory,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      reject: false,
      all: true,
    });
    const output = (proc.all ?? '').slice(-MAX_OUTPUT_CHARS);
    if (proc.timedOut) {
      return { passed: false, output: `Timed out after ${Math.round(timeoutMs / 1000)}s.\n${output}` };
    }
    return { passed: proc.exitCode === 0, output };
  } catch (err) {
    return { passed: false, output: err instanceof Error ? err.message : String(err) };
  }
}
