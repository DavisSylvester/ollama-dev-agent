import { Type } from '@sinclair/typebox';
import type { StructuredTool } from '@langchain/core/tools';
import { defineTool } from './define-tool.mts';
import { execa } from 'execa';

export function createRunTestsTool(workingDirectory: string): StructuredTool {
  return defineTool(
    async ({ test_path }: { test_path?: string }): Promise<string> => {
      try {
        const args = ['test'];
        if (test_path) {
          args.push(test_path);
        }

        const proc = await execa('bun', args, {
          cwd: workingDirectory,
          reject: false,
          all: true,
        });

        const output = proc.all ?? `${proc.stdout}\n${proc.stderr}`.trim();
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
