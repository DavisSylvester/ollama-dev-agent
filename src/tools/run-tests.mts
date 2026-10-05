import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { execa } from 'execa';

const RUN_TESTS_TIMEOUT_MS = 300_000;

export function createRunTestsTool(workingDirectory: string): StructuredTool {
  return defineTool(
    async ({ test_path }: { test_path?: string }): Promise<string> => {
      try {
        const args = ['test'];
        if (test_path) {
          args.push(test_path);
        }

        // Without a timeout, a test that never exits (an open server handle, a
        // watcher) blocks the worker until its whole iteration deadline.
        const proc = await execa('bun', args, {
          cwd: workingDirectory,
          reject: false,
          all: true,
          timeout: RUN_TESTS_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          windowsHide: true,
        });

        const output = proc.all ?? `${proc.stdout}\n${proc.stderr}`.trim();
        if (proc.timedOut === true) {
          return (
            `Tests timed out after ${RUN_TESTS_TIMEOUT_MS / 1000}s and were killed. ` +
            `A test is probably leaving a server, timer or connection open — close it in afterAll.\n${output}`
          );
        }
        return output;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error running tests: ${message}`;
      }
    },
    {
      name: 'run_tests',
      description: 'Run the project tests using `bun test`, optionally targeting a specific file or directory',
      schema: Type.Object({
        test_path: Type.Optional(
          Type.String({ description: 'Optional: specific test file or directory to run' }),
        ),
      }),
    },
  );
}
