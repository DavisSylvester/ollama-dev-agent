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
// recursive ** does not descend into dependencies. Used as a fallback when no
// explicit file list is supplied (e.g. the worker calls run_linter manually).
const LINT_GLOB = '**/*.{mts,tsx}';

// Only these extensions are lint-eligible in this project.
const LINT_EXT = /\.(mts|tsx)$/;

// ESLint exits non-zero when the glob matches no files. That is NOT a code
// quality failure — there is simply nothing to lint (e.g. early tasks, or a
// layout the glob doesn't cover) — so we treat it as clean.
function isNoFilesMatched(output: string): boolean {
  return /No files matching the pattern/i.test(output);
}

/**
 * Run ESLint in `workingDirectory`.
 *
 * When `files` is provided, lint ONLY those files — this scopes the gate to the
 * files a single task's worker actually wrote, so parallel tasks aren't held
 * responsible for each other's (or the whole repo's) lint state. Non-eligible
 * extensions are filtered out; if nothing eligible remains, the result is clean.
 *
 * When `files` is omitted, fall back to linting the whole project via the glob.
 */
export async function runLint(
  workingDirectory: string,
  fix: boolean,
  files?: readonly string[],
): Promise<LintResult> {
  try {
    let targets: string[];
    if (files !== undefined) {
      targets = files.filter((f) => LINT_EXT.test(f));
      if (targets.length === 0) {
        return { clean: true, output: 'No lint-eligible files changed.' };
      }
    } else {
      targets = [LINT_GLOB];
    }

    const args = ['eslint', ...targets];
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
