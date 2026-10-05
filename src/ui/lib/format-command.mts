// Formatting for the TUI's live command panel: what a tool call runs, and the
// last few lines it printed.

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The command line (or a short action) a worker tool call represents. */
export function describeToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'shell_exec':
      return str(args['command']) || 'shell_exec';
    case 'run_tests':
      return `bun test${str(args['test_path']) ? ` ${str(args['test_path'])}` : ''}`;
    case 'run_linter':
      return `bunx eslint${args['fix'] === true ? ' --fix' : ''}`;
    case 'install_package': {
      const packages = Array.isArray(args['packages']) ? args['packages'].filter((p) => typeof p === 'string') : [];
      return `bun add${args['dev'] === true ? ' -d' : ''} ${packages.join(' ')}`.trimEnd();
    }
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return `${toolName} ${str(args['path'])}`.trimEnd();
    case 'list_directory':
      return `list_directory ${str(args['path']) || '.'}`;
    case 'glob_search':
    case 'grep_search':
      return `${toolName} ${str(args['pattern'])}`.trimEnd();
    case 'web_search_ddg':
    case 'web_search_brave':
      return `${toolName} "${str(args['query'])}"`;
    default:
      return toolName;
  }
}

/**
 * The printable text of a tool result. `shell_exec` returns JSON
 * (`{ stdout, stderr, exitCode }`) on one line; unwrap it so the panel shows
 * the command's actual output, plus the exit code when it failed.
 */
export function commandOutputText(result: string): string {
  const trimmed = result.trim();
  if (!trimmed.startsWith('{')) return result;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return result;
    const { stdout, stderr, exitCode } = parsed as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    if (typeof stdout !== 'string' && typeof stderr !== 'string') return result;
    const parts: string[] = [];
    if (typeof stdout === 'string') parts.push(stdout);
    if (typeof stderr === 'string') parts.push(stderr);
    if (typeof exitCode === 'number' && exitCode !== 0) parts.push(`exit code ${exitCode}`);
    return parts.join('\n');
  } catch {
    return result;
  }
}

/** True when a tool result reports failure (non-zero exit code or an error). */
export function commandFailed(result: string): boolean {
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && 'exitCode' in parsed) {
        const { exitCode } = parsed as { exitCode?: unknown };
        return typeof exitCode === 'number' && exitCode !== 0;
      }
    } catch {
      // Not JSON — fall through to the text check.
    }
  }
  return /^Error\b/.test(trimmed);
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * The last `count` non-empty lines of `output`, with terminal colour codes
 * removed and each line cut to `maxWidth` characters so the panel never wraps.
 */
export function tailLines(output: string, count: number = 3, maxWidth: number = 140): string[] {
  return output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .map((line) => (line.length > maxWidth ? `${line.slice(0, maxWidth - 1)}…` : line));
}
