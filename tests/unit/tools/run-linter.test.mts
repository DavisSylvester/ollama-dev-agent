import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// ---------------------------------------------------------------------------
// execa mock — captured per test so we can assert the args/flags passed.
// ---------------------------------------------------------------------------

interface ExecaCall {
  readonly file: string;
  readonly args: readonly string[];
}

let execaCalls: ExecaCall[] = [];
let execaImpl: (file: string, args: readonly string[]) => Promise<{
  exitCode: number;
  all?: string;
  stdout: string;
  stderr: string;
}>;

mock.module('execa', () => ({
  execa: async (file: string, args: readonly string[]) => {
    execaCalls.push({ file, args });
    return execaImpl(file, args);
  },
}));

// Imported after the mock is registered.
const { runLint } = await import('../../../src/tools/run-linter.mts');

beforeEach(() => {
  execaCalls = [];
  execaImpl = async () => ({ exitCode: 0, all: 'No lint issues found.', stdout: '', stderr: '' });
});

afterEach(() => {
  mock.restore();
});

describe('runLint', () => {
  it('reports clean when eslint exits 0', async () => {
    execaImpl = async () => ({ exitCode: 0, all: '', stdout: '', stderr: '' });

    const result = await runLint('/some/dir', false);

    expect(result.clean).toBe(true);
    expect(result.output).toBe('No lint issues found.');
  });

  it('reports not clean when eslint exits non-zero', async () => {
    execaImpl = async () => ({
      exitCode: 1,
      all: "src/foo.mts\n  1:1  error  'x' is unused",
      stdout: '',
      stderr: '',
    });

    const result = await runLint('/some/dir', false);

    expect(result.clean).toBe(false);
    expect(result.output).toContain('unused');
  });

  it('does not pass --fix when fix is false', async () => {
    await runLint('/some/dir', false);

    expect(execaCalls).toHaveLength(1);
    expect(execaCalls[0]!.args).not.toContain('--fix');
  });

  it('passes --fix when fix is true', async () => {
    await runLint('/some/dir', true);

    expect(execaCalls).toHaveLength(1);
    expect(execaCalls[0]!.args).toContain('--fix');
  });

  it('reports clean when eslint finds no matching files (monorepo / empty layout)', async () => {
    execaImpl = async () => ({
      exitCode: 1,
      all: 'Oops! Something went wrong! :(\n\nESLint: 9.39.4\n\nNo files matching the pattern "**/*.{mts,tsx}" were found.',
      stdout: '',
      stderr: '',
    });

    const result = await runLint('/some/dir', false);

    // "no files matched" is not a code-quality failure — must not block.
    expect(result.clean).toBe(true);
    expect(result.output).toBe('No lint-eligible files found.');
  });

  it('targets eslint with a recursive source glob (covers monorepos)', async () => {
    await runLint('/some/dir', false);

    expect(execaCalls[0]!.args[0]).toBe('eslint');
    expect(execaCalls[0]!.args).toContain('**/*.{mts,tsx}');
  });

  it('treats a thrown execution error as not clean', async () => {
    execaImpl = async () => { throw new Error('eslint binary missing'); };

    const result = await runLint('/some/dir', false);

    expect(result.clean).toBe(false);
    expect(result.output).toContain('eslint binary missing');
  });

  it('falls back to stdout/stderr when all is undefined', async () => {
    execaImpl = async () => ({
      exitCode: 1,
      stdout: 'some output',
      stderr: '',
    } as { exitCode: number; all?: string; stdout: string; stderr: string });

    const result = await runLint('/some/dir', false);

    expect(result.clean).toBe(false);
    expect(result.output).toContain('some output');
  });
});
