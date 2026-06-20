import React from 'react';
import { Box, Text, useInput } from 'ink';

interface PRDPreviewProps {
  readonly prd: string;
  readonly taskCount: number;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}

const MAX_PREVIEW_LINES = 30;

export function PRDPreview({
  prd,
  taskCount,
  onApprove,
  onReject,
}: PRDPreviewProps): React.ReactElement {
  const lines = prd.split('\n');
  const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
  const truncated = lines.length > MAX_PREVIEW_LINES;

  useInput((input, key) => {
    if (key.return) {
      onApprove();
    } else if (input === 'q' || input === 'Q') {
      onReject();
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">PRD Preview</Text>
        <Box flexDirection="column" marginTop={1}>
          {previewLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          {truncated && (
            <Text dimColor>... ({lines.length - MAX_PREVIEW_LINES} more lines)</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" gap={1} paddingX={1}>
        <Text color="yellow">{taskCount} task{taskCount !== 1 ? 's' : ''} identified</Text>
        <Box gap={2}>
          <Text bold color="green">[ENTER] Approve</Text>
          <Text bold color="red">[q] Quit</Text>
        </Box>
      </Box>
    </Box>
  );
}
