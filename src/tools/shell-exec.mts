import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execa } from 'execa';

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

export function createShellExecTool(workingDirectory: string): StructuredTool {
  return tool(
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

      try {
        const proc = await execa(command, {
          shell: true,
          cwd: workingDirectory,
          timeout: timeout_ms ?? 60000,
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
        'Execute a shell command in the working directory and return stdout, stderr, and exit code',
      schema: z.object({
        command: z.string().describe('Shell command to execute'),
        timeout_ms: z
          .number()
          .default(60000)
          .optional()
          .describe('Timeout in milliseconds (default: 60000)'),
      }),
    },
  );
}
