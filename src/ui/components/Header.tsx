import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  readonly version: string;
  readonly featureName?: string | undefined;
}

export function Header({ version, featureName }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">⚡ ODA — Ollama Dev Agent</Text>
        <Text dimColor>v{version}</Text>
      </Box>
      {featureName && (
        <Text color="white">Feature: <Text bold color="yellow">{featureName}</Text></Text>
      )}
    </Box>
  );
}
