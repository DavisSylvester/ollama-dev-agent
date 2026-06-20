import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execa } from 'execa';

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

      try {
        const proc = await execa(command, {
          shell: true,
          cwd: workingDirectory,
          timeout: timeout_ms ?? 60000,
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
