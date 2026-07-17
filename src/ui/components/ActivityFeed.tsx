import React from 'react';
import { Box, Text } from 'ink';

interface ActivityFeedProps {
  readonly lines: readonly string[];
}

export function ActivityFeed({ lines }: ActivityFeedProps): React.ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="gray">Activity</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>{line}</Text>
      ))}
    </Box>
  );
}
