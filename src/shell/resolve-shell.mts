import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

// ---------------------------------------------------------------------------
// The one shell oda runs commands in, chosen for the OS. Ported from silo
// (ollama-cli/src/shell) so both tools behave the same:
//   Windows: Git Bash → PowerShell 7 → Windows PowerShell (never WSL, never cmd)
//   macOS / Linux: bash → /bin/sh
// ODA_SHELL overrides the choice.
// ---------------------------------------------------------------------------

export const SHELL_KIND = {
  bash: 'bash',
  sh: 'sh',
  pwsh: 'pwsh',
  powershell: 'powershell',
} as const;

export type ShellKind = (typeof SHELL_KIND)[keyof typeof SHELL_KIND];

export interface ShellInfo {
  kind: ShellKind;
  // Executable, e.g. C:\Program Files\Git\bin\bash.exe or /bin/bash
  path: string;
  // For people and for the model: "Git Bash", "PowerShell 7", "bash", …
  name: string;
}

// What resolveShell needs to know about the machine; injected so every OS can be tested anywhere.
export interface ShellProbe {
  platform: string;
  env: Record<string, string | undefined>;
  which: (command: string) => string | null;
  exists: (path: string) => boolean;
  // `git --exec-path`, e.g. C:/Program Files/Git/mingw64/libexec/git-core; null without git
  gitExecPath: () => string | null;
}

export type ShellResolution = { ok: true; shell: ShellInfo } | { ok: false; error: string };

/**
 * The WSL launchers. On Windows, C:\Windows\System32 comes early on PATH, so a
 * bare `bash` is WSL: a Linux machine that can't run the Windows bun, git or
 * node the project uses. oda never runs commands there.
 */
export function isWslLauncher(path: string): boolean {
  const normalized = path.replace(/\//g, '\\').toLowerCase();
  return /\\windows\\(system32|sysnative)\\(bash|wsl)\.exe$/.test(normalized) ||
    /\\windowsapps\\(.*\\)?(bash|wsl)\.exe$/.test(normalized);
}

function kindOf(path: string): ShellKind | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  switch (name) {
    case 'bash':
    case 'zsh':
      return SHELL_KIND.bash;
    case 'sh':
    case 'dash':
      return SHELL_KIND.sh;
    case 'pwsh':
      return SHELL_KIND.pwsh;
    case 'powershell':
      return SHELL_KIND.powershell;
    default:
      return null;
  }
}

const NAMES: Record<ShellKind, string> = {
  [SHELL_KIND.bash]: 'bash',
  [SHELL_KIND.sh]: 'sh',
  [SHELL_KIND.pwsh]: 'PowerShell 7',
  [SHELL_KIND.powershell]: 'Windows PowerShell 5.1',
};

function shellOf(kind: ShellKind, path: string, windows: boolean): ShellInfo {
  return { kind, path, name: windows && kind === SHELL_KIND.bash ? 'Git Bash' : NAMES[kind] };
}

function fromOverride(probe: ShellProbe, windows: boolean): ShellResolution | null {
  const override = probe.env['ODA_SHELL']?.trim();
  if (!override) return null;

  const path = probe.exists(override) ? override : probe.which(override);
  const kind = path ? kindOf(path) : null;
  if (!path || !kind) {
    return { ok: false, error: `ODA_SHELL=${override}: not a bash, sh, pwsh or powershell executable that exists` };
  }
  if (windows && isWslLauncher(path)) {
    return { ok: false, error: `ODA_SHELL=${override} is the WSL launcher; oda can't run the project's Windows tools there` };
  }
  return { ok: true, shell: shellOf(kind, path, windows) };
}

/** Git for Windows' bash, found through git itself rather than PATH order. */
function gitBash(probe: ShellProbe): string | null {
  const candidates: string[] = [];
  const execPath = probe.gitExecPath();
  if (execPath) {
    // <git root>/mingw64/libexec/git-core -> <git root>
    const root = win32.resolve(execPath, '..', '..', '..');
    candidates.push(win32.join(root, 'bin', 'bash.exe'), win32.join(root, 'usr', 'bin', 'bash.exe'));
  }
  for (const base of [probe.env['ProgramFiles'], probe.env['ProgramW6432'], probe.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(win32.join(base, 'Git', 'bin', 'bash.exe'));
  }
  const localAppData = probe.env['LOCALAPPDATA'];
  if (localAppData) candidates.push(win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
  const onPath = probe.which('bash');
  if (onPath && !isWslLauncher(onPath)) candidates.push(onPath);

  return candidates.find((candidate) => probe.exists(candidate)) ?? null;
}

function windowsShell(probe: ShellProbe): ShellResolution {
  const bash = gitBash(probe);
  if (bash) return { ok: true, shell: shellOf(SHELL_KIND.bash, bash, true) };

  const pwsh = probe.which('pwsh');
  if (pwsh) return { ok: true, shell: shellOf(SHELL_KIND.pwsh, pwsh, true) };

  const systemRoot = probe.env['SystemRoot'] ?? 'C:\\Windows';
  const builtIn = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const powershell = probe.which('powershell') ?? (probe.exists(builtIn) ? builtIn : null);
  if (powershell) return { ok: true, shell: shellOf(SHELL_KIND.powershell, powershell, true) };

  return { ok: false, error: 'no shell found: install Git for Windows (Git Bash) or PowerShell 7, or set ODA_SHELL' };
}

function unixShell(probe: ShellProbe): ShellResolution {
  const bash = probe.which('bash') ?? ['/bin/bash', '/usr/bin/bash'].find((path) => probe.exists(path));
  if (bash) return { ok: true, shell: shellOf(SHELL_KIND.bash, bash, false) };
  return probe.exists('/bin/sh')
    ? { ok: true, shell: shellOf(SHELL_KIND.sh, '/bin/sh', false) }
    : { ok: false, error: 'no shell found (bash or /bin/sh)' };
}

export function resolveShell(probe: ShellProbe): ShellResolution {
  const windows = probe.platform === 'win32';
  return fromOverride(probe, windows) ?? (windows ? windowsShell(probe) : unixShell(probe));
}

/** The real machine. */
export const SYSTEM_PROBE: ShellProbe = {
  platform: process.platform,
  env: Bun.env,
  which: (command) => Bun.which(command),
  exists: (path) => existsSync(path),
  gitExecPath: () => {
    try {
      const result = Bun.spawnSync(['git', '--exec-path'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
      return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
    } catch {
      return null;
    }
  },
};

let cached: ShellResolution | undefined;

/** This machine's shell, resolved once per process. */
export function getShell(): ShellResolution {
  cached ??= resolveShell(SYSTEM_PROBE);
  return cached;
}

/** The argv that runs `command` in `shell`. */
export function shellArgv(shell: ShellInfo, command: string): string[] {
  return shell.kind === SHELL_KIND.pwsh || shell.kind === SHELL_KIND.powershell
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-c', command];
}

/** One line for the model: which shell its commands run in and the syntax to use. */
export function shellGuide(shell: ShellInfo, platform: string = process.platform): string {
  switch (shell.kind) {
    case SHELL_KIND.pwsh:
      return `\`shell_exec\` runs in **PowerShell 7** on ${platform}: use PowerShell syntax ($env:NAME, Get-ChildItem, Test-Path, Remove-Item -Recurse -Force); chain with && or ;. Never bash syntax (rm -rf, export X=1, 2>/dev/null).`;
    case SHELL_KIND.powershell:
      return `\`shell_exec\` runs in **Windows PowerShell 5.1** on ${platform}: use PowerShell syntax ($env:NAME, Get-ChildItem, Test-Path, Remove-Item -Recurse -Force); chain with ; because 5.1 has no &&. Never bash syntax (rm -rf, export X=1, 2>/dev/null).`;
    case SHELL_KIND.sh:
      return `\`shell_exec\` runs in **POSIX sh** on ${platform}: no bash-only syntax ([[ ]], arrays, <<<).`;
    default:
      return platform === 'win32'
        ? '`shell_exec` runs in **Git Bash** on Windows: use bash syntax (&&, |, $VAR, 2>/dev/null) with forward-slash paths. Never cmd.exe syntax (dir, del, type, %VAR%, 2>nul). The Windows tools (bun, git, node) are on PATH.'
        : `\`shell_exec\` runs in **bash** on ${platform}.`;
  }
}
