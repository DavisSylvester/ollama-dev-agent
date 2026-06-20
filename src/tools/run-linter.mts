import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execa } from 'execa';

export interface LintResult {
  readonly clean: boolean;
  readonly output: string;
}

// Glob covers both flat projects (top-level src/) and monorepos
// (libs/*/src, apps/*/src). ESLint ignores node_modules by default, so the
// recursive ** does not descend into dependencies.
const LINT_GLOB = '**/*.{mts,tsx}';

// ESLint exits non-zero when the glob matches no files. That is NOT a code
// quality failure — there is simply nothing to lint (e.g. early tasks, or a
// layout the glob doesn't cover) — so we treat it as clean.
function isNoFilesMatched(output: string): boolean {
  return /No files matching the pattern/i.test(output);
}

export async function runLint(workingDirectory: string, fix: boolean): Promise<LintResult> {
  try {
    const args = ['eslint', LINT_GLOB];
    if (fix) {
      args.push('--fix');
    }

    const proc = await execa('bunx', args, {
      cwd: workingDirectory,
      reject: false,
      all: true,
    });

    const output = proc.all ?? `${proc.stdout}\n${proc.stderr}`.trim();

    if (isNoFilesMatched(output)) {
      return { clean: true, output: 'No lint-eligible files found.' };
    }

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
