import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { execa } from 'execa';
import { checkCommand } from '../shell/command-check.mts';
import { getShell, shellArgv, SYSTEM_PROBE } from '../shell/resolve-shell.mts';

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Commands that start a long-lived process (dev servers, watchers). These never
// exit on their own, so running them blocks shell_exec for the full timeout and
// burns the worker's step budget. Refuse them with a hint instead of running.
const SERVER_START_PATTERN =
  /(\b(bun|npm|pnpm|yarn|node)\s+(run\s+)?(dev|start|serve)\b|\bnodemon\b|\bvite\b|\bng\s+serve\b|\bnext\s+dev\b|\b--watch\b|\bbun\s+--watch\b|\bserve\b)/i;

function isServerStartCommand(command: string): boolean {
  return SERVER_START_PATTERN.test(command);
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

export function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

export function createShellExecTool(workingDirectory: string): StructuredTool {
  return defineTool(
    async ({
      command,
      timeout_ms,
    }: {
      command: string;
      timeout_ms?: number;
    }): Promise<string> => {
      const result: ShellResult = {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };

      // Guard: do not start long-lived servers to "verify" — they hang.
      if (isServerStartCommand(command)) {
        return JSON.stringify({
          stdout: '',
          stderr:
            `Refused: "${command}" starts a long-lived server/watcher that never exits, ` +
            `which would block and waste your step budget. ` +
            `Do NOT start a server to verify it. Instead import the app and call ` +
            `app.handle(new Request('http://localhost/...')) inside a bun:test test, then run that test.`,
          exitCode: 1,
        } satisfies ShellResult);
      }

      // Run in the one shell resolved for this OS (Git Bash / PowerShell on
      // Windows, bash / sh elsewhere) — never whatever execa's shell:true picks.
      const resolved = getShell();
      if (!resolved.ok) {
        return JSON.stringify({ stdout: '', stderr: `Not run: ${resolved.error}`, exitCode: 1 } satisfies ShellResult);
      }
      const shell = resolved.shell;

      // Guard: the command must be written for this shell and only call
      // programs that exist here. Otherwise explain instead of running it.
      const problems = checkCommand(command, shell, {
        platform: process.platform,
        cwd: workingDirectory,
        which: SYSTEM_PROBE.which,
        exists: SYSTEM_PROBE.exists,
      });
      if (problems.length > 0) {
        return JSON.stringify({
          stdout: '',
          stderr:
            `Not run: this command won't work in ${shell.name} on ${process.platform}.\n` +
            problems.map((p) => `- ${p}`).join('\n') +
            `\nRewrite it for ${shell.name}, or use the dedicated tools (read_file, write_file, list_directory, run_tests, install_package).`,
          exitCode: 1,
        } satisfies ShellResult);
      }

      try {
        const proc = await execa(shell.path, shellArgv(shell, command), {
          cwd: workingDirectory,
          windowsHide: true,
          // Clamp the model-chosen timeout: a huge or invalid value would let
          // one command hang the worker for its whole iteration.
          timeout: clampTimeout(timeout_ms),
          killSignal: 'SIGKILL', // hard-kill on timeout so children don't linger
          reject: false,
          all: false,
        });

        result.stdout = proc.stdout ?? '';
        result.stderr = proc.stderr ?? '';
        result.exitCode = proc.exitCode ?? 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.stderr = message;
        result.exitCode = 1;
      }

      return JSON.stringify(result);
    },
    {
      name: 'shell_exec',
      description:
        'Execute a shell command in the working directory and return stdout, stderr, and exit code. ' +
        'Commands run in the shell oda resolved for this OS (see the prompt); a command written for a ' +
        'different shell, or one that calls a program not installed here, is refused with the reason.',
      schema: Type.Object({
        command: Type.String({ description: 'Shell command to execute' }),
        timeout_ms: Type.Number({ default: 60000, description: 'Timeout in milliseconds (default: 60000)' }),
      }),
    },
  );
}
