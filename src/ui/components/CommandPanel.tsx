import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface CommandView {
  readonly taskId: string;
  readonly command: string;
  readonly output: readonly string[];
  readonly running: boolean;
  readonly failed?: boolean;
}

interface CommandPanelProps {
  readonly commands: readonly CommandView[];
}

/**
 * The command each running task is executing right now, with the last few
 * lines of its output. One row per task, since several tasks run in parallel.
 */
export function CommandPanel({ commands }: CommandPanelProps): React.ReactElement | null {
  if (commands.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="gray">Commands</Text>
      {commands.map((c) => (
        <Box key={c.taskId} flexDirection="column">
          <Box gap={1}>
            <Text color="yellow">{c.taskId}</Text>
            {c.running
              ? <Text color="cyan"><Spinner type="dots" /></Text>
              : c.failed ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}
            <Text color="white" wrap="truncate-end">$ {c.command}</Text>
          </Box>
          {c.output.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">  {line}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
