import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execa } from 'execa';

export interface LintResult {
  readonly clean: boolean;
  readonly output: string;
}

export async function runLint(workingDirectory: string, fix: boolean): Promise<LintResult> {
  try {
    const args = ['eslint', 'src/**/*.{mts,tsx}'];
    if (fix) {
      args.push('--fix');
    }

    const proc = await execa('bunx', args, {
      cwd: workingDirectory,
      reject: false,
      all: true,
    });

    const output = proc.all ?? `${proc.stdout}\n${proc.stderr}`.trim();
    const outputText = output || 'No lint issues found.';
    const clean = proc.exitCode === 0;

    return { clean, output: outputText };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { clean: false, output: `Error running linter: ${message}` };
  }
}

export function createRunLinterTool(workingDirectory: string): StructuredTool {
  return tool(
    async ({ fix }: { fix: boolean }): Promise<string> => {
      const result = await runLint(workingDirectory, fix);
      return result.output;
    },
    {
      name: 'run_linter',
      description: 'Run ESLint on the project source files, optionally with --fix to auto-correct issues',
      schema: z.object({
        fix: z.boolean().default(false).describe('Pass --fix to auto-correct fixable lint errors'),
      }),
    },
  );
}
