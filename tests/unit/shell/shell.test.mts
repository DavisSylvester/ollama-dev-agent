import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShell, shellGuide, type ShellInfo, type ShellProbe } from '../../../src/shell/resolve-shell.mts';
import { checkCommand, programOf, splitSegments, type CommandCheckDeps } from '../../../src/shell/command-check.mts';
import { createShellExecTool } from '../../../src/tools/shell-exec.mts';

function probe(overrides: Partial<ShellProbe> & { files?: string[]; onPath?: Record<string, string> }): ShellProbe {
  const files = new Set(overrides.files ?? []);
  return {
    platform: overrides.platform ?? 'win32',
    env: overrides.env ?? { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    which: (cmd) => overrides.onPath?.[cmd] ?? null,
    exists: (path) => files.has(path),
    gitExecPath: overrides.gitExecPath ?? (() => null),
  };
}

describe('resolveShell', () => {
  it('prefers Git Bash on Windows, found through git itself', () => {
    const r = resolveShell(probe({
      gitExecPath: () => 'C:/Tools/Git/mingw64/libexec/git-core',
      files: ['C:\\Tools\\Git\\bin\\bash.exe'],
    }));
    expect(r.ok && r.shell).toMatchObject({ kind: 'bash', name: 'Git Bash', path: 'C:\\Tools\\Git\\bin\\bash.exe' });
  });

  it('never uses the WSL bash launcher on Windows', () => {
    const r = resolveShell(probe({ onPath: { bash: 'C:\\Windows\\System32\\bash.exe', pwsh: 'C:\\pwsh\\pwsh.exe' } }));
    expect(r.ok && r.shell.kind).toBe('pwsh');
  });

  it('falls back to Windows PowerShell 5.1 when nothing else exists', () => {
    const r = resolveShell(probe({ files: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] }));
    expect(r.ok && r.shell).toMatchObject({ kind: 'powershell', name: 'Windows PowerShell 5.1' });
  });

  it('uses bash on Linux and macOS, then /bin/sh', () => {
    expect(resolveShell(probe({ platform: 'linux', onPath: { bash: '/usr/bin/bash' } }))).toMatchObject({ ok: true, shell: { kind: 'bash', name: 'bash' } });
    expect(resolveShell(probe({ platform: 'darwin', files: ['/bin/sh'] }))).toMatchObject({ ok: true, shell: { kind: 'sh' } });
  });

  it('honours ODA_SHELL, and rejects one that is not a shell', () => {
    const ok = resolveShell(probe({ env: { ODA_SHELL: 'pwsh' }, onPath: { pwsh: 'C:\\pwsh\\pwsh.exe' } }));
    expect(ok.ok && ok.shell.kind).toBe('pwsh');
    const bad = resolveShell(probe({ env: { ODA_SHELL: 'notepad' }, onPath: { notepad: 'C:\\Windows\\notepad.exe' } }));
    expect(bad.ok).toBe(false);
  });

  it('reports a clear error when no shell exists', () => {
    const r = resolveShell(probe({ env: {} }));
    expect(r.ok).toBe(false);
  });
});

describe('shellGuide', () => {
  it('tells the model which dialect to write', () => {
    expect(shellGuide({ kind: 'bash', name: 'Git Bash', path: 'bash.exe' }, 'win32')).toContain('Never cmd.exe syntax');
    expect(shellGuide({ kind: 'powershell', name: 'Windows PowerShell 5.1', path: 'powershell.exe' }, 'win32')).toContain('5.1 has no &&');
  });
});

describe('splitSegments / programOf', () => {
  it('splits on separators but not inside quotes', () => {
    expect(splitSegments('bun test && echo "a && b"; git status | head -1')).toEqual(['bun test', 'echo "a && b"', 'git status', 'head -1']);
  });

  it('skips inline env assignments when finding the program', () => {
    expect(programOf('NODE_ENV=test bun test')).toBe('bun');
    expect(programOf('(cd apps/api')).toBe('cd');
  });
});

const GIT_BASH: ShellInfo = { kind: 'bash', name: 'Git Bash', path: 'bash.exe' };
const PWSH: ShellInfo = { kind: 'pwsh', name: 'PowerShell 7', path: 'pwsh.exe' };
const PS51: ShellInfo = { kind: 'powershell', name: 'Windows PowerShell 5.1', path: 'powershell.exe' };

function deps(installed: string[] = ['bun', 'git', 'grep'], files: string[] = []): CommandCheckDeps {
  return {
    platform: 'win32',
    cwd: 'C:\\proj',
    which: (cmd) => (installed.includes(cmd) ? `C:\\bin\\${cmd}.exe` : null),
    exists: (path) => files.includes(path),
  };
}

describe('checkCommand — bash', () => {
  it('accepts normal bash using installed programs and builtins', () => {
    expect(checkCommand('cd apps/api && bun test 2>/dev/null | grep pass', GIT_BASH, deps())).toEqual([]);
    expect(checkCommand('export CI=1; NODE_ENV=test bun test', GIT_BASH, deps())).toEqual([]);
  });

  it('refuses cmd.exe syntax with the bash equivalent', () => {
    expect(checkCommand('dir /s src', GIT_BASH, deps())[0]).toContain('use `ls`');
    expect(checkCommand('del dist\\out.js', GIT_BASH, deps())[0]).toContain('use `rm`');
    expect(checkCommand('echo %PATH%', GIT_BASH, deps())[0]).toContain('$VAR');
    expect(checkCommand('bun test 2>nul', GIT_BASH, deps())[0]).toContain('/dev/null');
  });

  it('refuses PowerShell cmdlets', () => {
    expect(checkCommand('Get-ChildItem src', GIT_BASH, deps())[0]).toContain('PowerShell cmdlet');
  });

  it('refuses a program that is not installed', () => {
    expect(checkCommand('jq .name package.json', GIT_BASH, deps())[0]).toContain('`jq` is not installed');
  });

  it('accepts a relative script that exists (including .cmd on Windows)', () => {
    expect(checkCommand('./scripts/build.sh', GIT_BASH, deps([], ['C:\\proj\\scripts\\build.sh']))).toEqual([]);
    expect(checkCommand('node_modules/.bin/tsc --noEmit', GIT_BASH, deps([], ['C:\\proj\\node_modules\\.bin\\tsc.cmd']))).toEqual([]);
  });
});

describe('checkCommand — PowerShell', () => {
  it('accepts cmdlets, aliases and installed programs', () => {
    expect(checkCommand('Get-ChildItem src; bun test', PWSH, deps())).toEqual([]);
    expect(checkCommand("$env:CI = '1'; bun test", PWSH, deps())).toEqual([]);
  });

  it('refuses bash syntax with the PowerShell equivalent', () => {
    expect(checkCommand('rm -rf dist', PWSH, deps())[0]).toContain('Remove-Item -Recurse -Force');
    expect(checkCommand('mkdir -p out', PWSH, deps())[0]).toContain('New-Item -ItemType Directory');
    expect(checkCommand('export CI=1', PWSH, deps())[0]).toContain('$env:NAME');
    expect(checkCommand('CI=1 bun test', PWSH, deps())[0]).toContain('$env:CI');
    expect(checkCommand('bun test 2>/dev/null', PWSH, deps())[0]).toContain('2>$null');
  });

  it('refuses && only in Windows PowerShell 5.1', () => {
    expect(checkCommand('bun install && bun test', PWSH, deps())).toEqual([]);
    expect(checkCommand('bun install && bun test', PS51, deps())[0]).toContain('no `&&`');
    expect(checkCommand('echo "a && b"', PS51, deps())).toEqual([]);
  });
});

describe('shell_exec on this machine', () => {
  const run = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const dir = await mkdtemp(join(tmpdir(), 'oda-shell-'));
    try {
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf-8');
      const tool = createShellExecTool(dir);
      return JSON.parse(String(await tool.invoke({ command }))) as { stdout: string; stderr: string; exitCode: number };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('runs a command with quotes and chaining in the resolved shell', async () => {
    const out = await run('echo "two words" && echo done');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('two words');
    expect(out.stdout).toContain('done');
  });

  it('refuses, without running, a program that is not installed', async () => {
    const out = await run('definitely-not-a-real-tool-xyz --version');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Not run');
    expect(out.stderr).toContain('not installed');
  });
});

describe('checkCommand — script paths follow the target platform', () => {
  it('resolves a relative script against a POSIX cwd on Linux', () => {
    const linux: CommandCheckDeps = { platform: 'linux', cwd: '/srv/proj', which: () => null, exists: (p) => p === '/srv/proj/scripts/build.sh' };
    expect(checkCommand('./scripts/build.sh', { kind: 'bash', name: 'bash', path: '/bin/bash' }, linux)).toEqual([]);
  });
});
