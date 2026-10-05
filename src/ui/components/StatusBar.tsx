import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { AgentPhase } from '../../types/index.mts';

interface StatusBarProps {
  readonly phase: AgentPhase;
  readonly model?: string | undefined;
  readonly currentTool?: string | undefined;
  readonly iteration?: number | undefined;
  // What the agent is doing now, and for how long — ticks every second.
  readonly activity?: string | undefined;
  readonly activitySeconds?: number | undefined;
}

// After this long without a new event, say so explicitly: the agent is still
// alive, the model (or a command) is just slow.
const SLOW_SECONDS = 120;

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const PHASE_LABELS: Record<AgentPhase, string> = {
  initializing: 'Initializing',
  generating_prd: 'Generating PRD',
  sizing_plan: 'Sizing Plan',
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
  'sizing_plan',
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
  activity,
  activitySeconds,
}: StatusBarProps): React.ReactElement {
  const isActive = ACTIVE_PHASES.has(phase);
  const label = PHASE_LABELS[phase];
  const color = phaseColor(phase);
  const slow = (activitySeconds ?? 0) >= SLOW_SECONDS;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
    <Box
      flexDirection="row"
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
    {isActive && activity && (
      <Text color={slow ? 'yellow' : 'gray'} wrap="truncate-end">
        {activity} · {formatElapsed(activitySeconds ?? 0)}
        {slow ? '  (still waiting — the model or command is slow, not stuck)' : ''}
      </Text>
    )}
    </Box>
  );
}
