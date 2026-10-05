import React from 'react';
import { Box, Static, Text } from 'ink';
import type { StartupState, StartupSummary } from '../lib/startup-summary.mts';

interface StartupPanelProps {
  readonly featureName: string;
  readonly summary: StartupSummary | null;
}

const GLYPH: Record<StartupState, { mark: string; color: string; label: string }> = {
  done: { mark: '✓', color: 'green', label: 'done' },
  retry: { mark: '↻', color: 'red', label: 'retry' },
  ready: { mark: '▶', color: 'cyan', label: 'ready' },
  waiting: { mark: '○', color: 'gray', label: 'waiting' },
};

/**
 * The status of every task when the run starts, printed once (Ink <Static>)
 * so it stays in the terminal's scrollback above the live view.
 */
export function StartupPanel({ featureName, summary }: StartupPanelProps): React.ReactElement | null {
  if (!summary) return null;
  const { counts } = summary;
  return (
    <Static items={[summary]}>
      {(s) => (
        <Box key="startup" flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginX={1}>
          <Text bold color="cyan">
            {s.resumed ? 'Resuming' : 'Starting'} {featureName || 'run'} — {s.rows.length} tasks
          </Text>
          <Text>
            <Text color="green">{counts.done} done</Text>
            <Text dimColor> · </Text>
            <Text color="red">{counts.retry} to retry</Text>
            <Text dimColor> · </Text>
            <Text color="cyan">{counts.ready} ready now</Text>
            <Text dimColor> · </Text>
            <Text>{counts.waiting} waiting on other tasks</Text>
          </Text>
          <Text> </Text>
          {s.rows.map((row) => {
            const g = GLYPH[row.state];
            return (
              <Text key={row.id} wrap="truncate-end">
                <Text color={g.color}>{g.mark} {g.label.padEnd(7)}</Text>
                <Text> {row.id.padEnd(12)} </Text>
                <Text dimColor={row.state === 'done'}>{row.name}</Text>
                {row.note ? <Text dimColor> — {row.note}</Text> : null}
              </Text>
            );
          })}
        </Box>
      )}
    </Static>
  );
}
