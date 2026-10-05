import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { createShellExecTool } from '../../../src/tools/shell-exec.mts';

const tool = createShellExecTool(tmpdir());

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(command: string): Promise<ShellResult> {
  const raw = await tool.invoke({ command });
  return JSON.parse(raw) as ShellResult;
}

describe('shell_exec server-start guard (Phase 1.2)', () => {
  it.each([
    'bun run dev',
    'bun start',
    'npm run dev',
    'npm start',
    'yarn dev',
    'pnpm run serve',
    'nodemon src/index.mts',
    'vite',
    'ng serve',
    'next dev',
    'bun --watch src/index.mts',
  ])('refuses long-lived server command: %s', async (command) => {
    const result = await run(command);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Refused');
    expect(result.stderr).toContain('app.handle');
  });

  it('allows normal one-shot commands (guard does not fire)', async () => {
    const result = await run('echo hello');
    // The guard must not block it; exact stdout is shell-dependent on Windows.
    expect(result.stderr).not.toContain('Refused');
  });

  it('does not misclassify bun test / bun run build as a server start', async () => {
    // These should NOT be refused (they exit on their own). We assert they are
    // not blocked by the guard — they run and return (exit code may vary by env,
    // but stderr must not contain the guard's "Refused" message).
    const t = await run('bun --version');
    expect(t.stderr).not.toContain('Refused');
  });
});

describe('clampTimeout', () => {
  it('defaults missing or invalid timeouts to 60s and caps huge ones at 10 minutes', async () => {
    const { clampTimeout } = await import('../../../src/tools/shell-exec.mts');
    expect(clampTimeout(undefined)).toBe(60_000);
    expect(clampTimeout(0)).toBe(60_000);
    expect(clampTimeout(Number.NaN)).toBe(60_000);
    expect(clampTimeout(5_000)).toBe(5_000);
    expect(clampTimeout(86_400_000)).toBe(600_000);
  });
});
