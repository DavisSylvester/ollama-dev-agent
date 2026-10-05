import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { commandFailed, commandOutputText, describeToolCall, tailLines } from '../../../src/ui/lib/format-command.mts';
import { CommandPanel } from '../../../src/ui/components/CommandPanel.tsx';

describe('describeToolCall', () => {
  it('shows the shell command itself', () => {
    expect(describeToolCall('shell_exec', { command: 'bun run typecheck' })).toBe('bun run typecheck');
  });

  it('renders test, lint and install tools as the commands they run', () => {
    expect(describeToolCall('run_tests', {})).toBe('bun test');
    expect(describeToolCall('run_tests', { test_path: 'apps/api' })).toBe('bun test apps/api');
    expect(describeToolCall('run_linter', { fix: true })).toBe('bunx eslint --fix');
    expect(describeToolCall('install_package', { packages: ['winston', 'luxon'], dev: false })).toBe('bun add winston luxon');
    expect(describeToolCall('install_package', { packages: ['@types/luxon'], dev: true })).toBe('bun add -d @types/luxon');
  });

  it('names file tools with their path', () => {
    expect(describeToolCall('write_file', { path: 'packages/logger/src/index.mts' })).toBe('write_file packages/logger/src/index.mts');
    expect(describeToolCall('list_directory', {})).toBe('list_directory .');
  });

  it('falls back to the tool name', () => {
    expect(describeToolCall('todo_read', {})).toBe('todo_read');
  });
});

describe('tailLines', () => {
  it('keeps only the last three non-empty lines', () => {
    const out = 'one\n\ntwo\nthree\n\nfour\n';
    expect(tailLines(out)).toEqual(['two', 'three', 'four']);
  });

  it('strips terminal colour codes', () => {
    expect(tailLines('\u001b[32m 12 pass\u001b[0m\n\u001b[31m 0 fail\u001b[0m')).toEqual([' 12 pass', ' 0 fail']);
  });

  it('cuts long lines so the panel never wraps', () => {
    const [line] = tailLines('x'.repeat(300), 3, 20);
    expect(line).toHaveLength(20);
    expect(line?.endsWith('…')).toBe(true);
  });

  it('handles CRLF output and empty output', () => {
    expect(tailLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(tailLines('')).toEqual([]);
  });
});

// Minimal stdout stand-in so Ink can render a frame without a real terminal.
class FakeStdout extends EventEmitter {

  public columns = 100;
  public rows = 40;
  public frames: string[] = [];

  public write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }
}

describe('CommandPanel', () => {
  it('shows each task with its command and output lines', () => {
    const stdout = new FakeStdout();
    const app = render(
      React.createElement(CommandPanel, {
        commands: [
          { taskId: 'TASK-003-2', command: 'bun test packages/logger', output: ['3 pass', '0 fail'], running: false },
          { taskId: 'TASK-012-1', command: 'bunx eslint --fix', output: [], running: true },
        ],
      }),
      { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false },
    );
    const frame = stdout.frames.join('');
    app.unmount();

    expect(frame).toContain('Commands');
    expect(frame).toContain('TASK-003-2');
    expect(frame).toContain('$ bun test packages/logger');
    expect(frame).toContain('3 pass');
    expect(frame).toContain('$ bunx eslint --fix');
  });

  it('renders nothing when no command has run', () => {
    const stdout = new FakeStdout();
    const app = render(React.createElement(CommandPanel, { commands: [] }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    });
    const frame = stdout.frames.join('');
    app.unmount();
    expect(frame).not.toContain('Commands');
  });
});

describe('commandOutputText', () => {
  it('unwraps shell_exec JSON into its stdout and stderr', () => {
    const json = JSON.stringify({ stdout: '1.4.2\ngit version 2.53.0', stderr: '', exitCode: 0 });
    expect(tailLines(commandOutputText(json))).toEqual(['1.4.2', 'git version 2.53.0']);
  });

  it('adds the exit code when the command failed', () => {
    const json = JSON.stringify({ stdout: '', stderr: 'error: tsc not found', exitCode: 127 });
    expect(tailLines(commandOutputText(json))).toEqual(['error: tsc not found', 'exit code 127']);
  });

  it('leaves plain text and unrelated JSON alone', () => {
    expect(commandOutputText('File written: a.mts')).toBe('File written: a.mts');
    expect(commandOutputText('{"name":"x"}')).toBe('{"name":"x"}');
  });
});

describe('commandFailed', () => {
  it('reads the exit code from shell_exec JSON', () => {
    expect(commandFailed(JSON.stringify({ stdout: '', stderr: 'x', exitCode: 1 }))).toBe(true);
    expect(commandFailed(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0 }))).toBe(false);
  });

  it('treats an "Error ..." tool message as a failure', () => {
    expect(commandFailed('Error reading file: File not found: a.mts')).toBe(true);
    expect(commandFailed('File written: a.mts')).toBe(false);
  });
});
