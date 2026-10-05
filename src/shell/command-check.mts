import { posix, win32 } from 'node:path';
import { SHELL_KIND, type ShellInfo } from './resolve-shell.mts';

// ---------------------------------------------------------------------------
// Pre-flight check for a shell_exec command: is it written for the shell oda
// will run it in, and does every program it calls exist on this machine?
// A command that fails the check is not run; the model gets the reason and
// the equivalent to use instead.
// ---------------------------------------------------------------------------

export interface CommandCheckDeps {
  platform: string;
  cwd: string;
  which: (command: string) => string | null;
  exists: (path: string) => boolean;
}

const POSIX_BUILTINS: ReadonlySet<string> = new Set([
  'cd', 'echo', 'export', 'unset', 'set', 'source', '.', 'test', '[', '[[', 'true', 'false', 'exit',
  'printf', 'pwd', 'read', 'alias', 'type', 'command', 'eval', 'exec', 'shift', 'wait', 'trap',
  'umask', 'ulimit', 'local', 'declare', 'readonly', 'let', 'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'time', '!', '{', '}', 'kill',
  'jobs', 'hash', 'pushd', 'popd', 'return', 'break', 'continue', 'getopts',
]);

const POWERSHELL_BUILTINS: ReadonlySet<string> = new Set([
  'cd', 'ls', 'dir', 'cat', 'echo', 'rm', 'cp', 'mv', 'mkdir', 'md', 'pwd', 'type', 'del', 'copy',
  'move', 'ren', 'set', 'clear', 'cls', 'where', 'sort', 'select', 'gc', 'gci', 'sl', 'sleep', 'start',
  'write', 'foreach', '%', '?', 'if', 'else', 'elseif', 'for', 'while', 'do', 'try', 'catch', 'finally',
  'switch', 'function', 'param', 'return', 'exit', 'throw', '&', '.', 'iwr', 'irm', 'ni', 'ri',
]);

// cmd.exe commands and what to use instead in bash.
const CMD_ONLY: Readonly<Record<string, string>> = {
  dir: 'ls', del: 'rm', erase: 'rm', copy: 'cp', xcopy: 'cp -r', robocopy: 'cp -r', move: 'mv',
  ren: 'mv', rd: 'rm -r', cls: 'clear', findstr: 'grep',
};

/** Split on && || ; | and newlines, ignoring separators inside quotes. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Whitespace-separated words, keeping quoted words together (quotes removed). */
function words(segment: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of segment.matchAll(pattern)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program a segment runs, skipping `VAR=value` prefixes and grouping characters. */
export function programOf(segment: string): string | null {
  const tokens = words(segment.replace(/^[({\s]+/, ''));
  const first = tokens.find((t) => !ENV_ASSIGNMENT.test(t));
  return first ?? null;
}

function isPowerShell(shell: ShellInfo): boolean {
  return shell.kind === SHELL_KIND.pwsh || shell.kind === SHELL_KIND.powershell;
}

/** Syntax written for a different shell than the one that will run it. */
function dialectProblems(command: string, shell: ShellInfo): string[] {
  const problems: string[] = [];
  if (isPowerShell(shell)) {
    if (/\b2>\s*\/dev\/null/.test(command)) problems.push('`2>/dev/null` is bash syntax; in PowerShell use `2>$null`.');
    if (/\brm\s+-(rf|fr|r\s+-f)\b/.test(command)) problems.push('`rm -rf` is bash syntax; in PowerShell use `Remove-Item -Recurse -Force <path>`.');
    if (/\bmkdir\s+-p\b/.test(command)) problems.push('`mkdir -p` is bash syntax; in PowerShell use `New-Item -ItemType Directory -Force <path>`.');
    if (/<<-?\s*['"]?\w+/.test(command)) problems.push('Here-documents (`<<EOF`) are bash syntax; PowerShell uses `@\'...\'@` here-strings.');
    for (const segment of splitSegments(command)) {
      const first = words(segment)[0] ?? '';
      if (first === 'export' || first === 'unset' || first === 'source') {
        problems.push(`\`${first}\` is bash; in PowerShell set variables with \`$env:NAME = 'value'\`.`);
      } else if (ENV_ASSIGNMENT.test(first)) {
        problems.push(`\`${first} <command>\` (inline env var) is bash; in PowerShell use \`$env:${first.split('=')[0]} = '...'; <command>\`.`);
      }
    }
    if (shell.kind === SHELL_KIND.powershell && /&&|\|\|/.test(command.replace(/(["'])(?:(?!\1).)*\1/g, ''))) {
      problems.push('Windows PowerShell 5.1 has no `&&` / `||`; use `A; if ($?) { B }`.');
    }
  } else {
    if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) problems.push('`%VAR%` is cmd.exe syntax; in bash use `$VAR`.');
    if (/\b2?>\s*nul\b(?![/\w])/i.test(command)) problems.push('`>nul` is cmd.exe syntax; in bash redirect to `/dev/null`.');
    for (const segment of splitSegments(command)) {
      const first = (words(segment)[0] ?? '').toLowerCase();
      const instead = CMD_ONLY[first];
      if (instead) problems.push(`\`${first}\` is a cmd.exe command; in bash use \`${instead}\`.`);
      else if (/^[A-Z][a-z]+-[A-Z][A-Za-z]+$/.test(words(segment)[0] ?? '')) {
        problems.push(`\`${words(segment)[0]}\` is a PowerShell cmdlet; ${shell.name} cannot run it — use the bash equivalent.`);
      }
    }
  }
  return problems;
}

function programExists(program: string, shell: ShellInfo, deps: CommandCheckDeps): boolean {
  const lower = program.toLowerCase();
  if (isPowerShell(shell)) {
    if (POWERSHELL_BUILTINS.has(lower) || /^[A-Za-z]+-[A-Za-z]+$/.test(program) || program.startsWith('$')) return true;
  } else if (POSIX_BUILTINS.has(program)) {
    return true;
  }
  if (/[\\/]/.test(program)) {
    // Resolve with the target platform's path rules, not the host's.
    const path = deps.platform === 'win32' ? win32 : posix;
    const full = path.isAbsolute(program) ? program : path.resolve(deps.cwd, program);
    if (deps.exists(full)) return true;
    return deps.platform === 'win32' && ['.exe', '.cmd', '.bat', '.ps1'].some((ext) => deps.exists(`${full}${ext}`));
  }
  return deps.which(program) !== null;
}

/**
 * Problems that would make `command` fail on this OS/shell, or [] if it looks
 * runnable. Checks dialect first (the clearer message), then that every
 * program the command calls is installed.
 */
export function checkCommand(command: string, shell: ShellInfo, deps: CommandCheckDeps): string[] {
  const dialect = dialectProblems(command, shell);
  if (dialect.length > 0) return dialect;

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const segment of splitSegments(command)) {
    const program = programOf(segment);
    if (!program || seen.has(program)) continue;
    seen.add(program);
    if (!programExists(program, shell, deps)) {
      problems.push(`\`${program}\` is not installed or not on PATH on this machine (${deps.platform}, ${shell.name}).`);
    }
  }
  return problems;
}
