import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { AgentPhase } from '../../types/index.mts';

interface StatusBarProps {
  readonly phase: AgentPhase;
  readonly model?: string | undefined;
  readonly currentTool?: string | undefined;
  readonly iteration?: number | undefined;
}

const PHASE_LABELS: Record<AgentPhase, string> = {
  initializing: 'Initializing',
  generating_prd: 'Generating PRD',
  awaiting_approval: 'Awaiting Approval',
  executing_tasks: 'Executing Tasks',
  worker_running: 'Worker Running',
  lint_running: 'Linting Code',
  reviewer_running: 'Reviewer Running',
  generating_results: 'Generating Results',
  complete: 'Complete',
  failed: 'Failed',
};

const ACTIVE_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>([
  'initializing',
  'generating_prd',
  'executing_tasks',
  'worker_running',
  'lint_running',
  'reviewer_running',
  'generating_results',
]);

function phaseColor(phase: AgentPhase): string {
  if (phase === 'complete') return 'green';
  if (phase === 'failed') return 'red';
  if (phase === 'awaiting_approval') return 'yellow';
  return 'cyan';
}

export function StatusBar({
  phase,
  model,
  currentTool,
  iteration,
}: StatusBarProps): React.ReactElement {
  const isActive = ACTIVE_PHASES.has(phase);
  const label = PHASE_LABELS[phase];
  const color = phaseColor(phase);

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      gap={2}
    >
      <Box gap={1}>
        {isActive && <Text color={color}><Spinner type="dots" /></Text>}
        <Text bold color={color}>{label}</Text>
      </Box>

      {model && (
        <Box gap={1}>
          <Text dimColor>model:</Text>
          <Text color="magenta">{model}</Text>
        </Box>
      )}

      {currentTool && (
        <Box gap={1}>
          <Text dimColor>tool:</Text>
          <Text color="blue">{currentTool}</Text>
        </Box>
      )}

      {iteration !== undefined && iteration > 0 && (
        <Box gap={1}>
          <Text dimColor>iter:</Text>
          <Text color="yellow">{iteration}</Text>
        </Box>
      )}
    </Box>
  );
}
