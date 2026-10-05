import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Header } from './components/Header.tsx';
import { TaskList } from './components/TaskList.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { PRDPreview } from './components/PRDPreview.tsx';
import { ActivityFeed } from './components/ActivityFeed.tsx';
import { CommandPanel, type CommandView } from './components/CommandPanel.tsx';
import { formatFeedLine } from './lib/format-feed-line.mts';
import { commandFailed, commandOutputText, describeToolCall, tailLines } from './lib/format-command.mts';
import { agentEvents, uiEvents } from '../agent/events.mts';
import type { Task, AgentPhase, PRD } from '../types/index.mts';

interface AppProps {
  readonly version: string;
  readonly onAgentStart: () => void;
  // When true, the PRD is auto-approved and the interactive PRD preview is
  // never mounted — required for non-interactive / non-TTY runs where Ink's
  // useInput would throw "Raw mode is not supported".
  readonly autoApprove?: boolean;
}

interface UIState {
  phase: AgentPhase;
  featureName: string;
  tasks: Task[];
  currentTaskIndex: number;
  currentIteration: number;
  currentModel: string;
  currentTool: string;
  prd: PRD | null;
  prdMarkdown: string;
  error: string | null;
  feed: string[];
  // Latest command per running task, most recent first.
  commands: CommandView[];
}

// Lines of command output shown per task, and how many tasks to show.
const OUTPUT_LINES = 3;
const MAX_COMMAND_ROWS = 4;

function upsertCommand(commands: CommandView[], next: CommandView): CommandView[] {
  return [next, ...commands.filter((c) => c.taskId !== next.taskId)].slice(0, MAX_COMMAND_ROWS);
}

const INITIAL_STATE: UIState = {
  phase: 'initializing',
  featureName: '',
  tasks: [],
  currentTaskIndex: 0,
  currentIteration: 0,
  currentModel: '',
  currentTool: '',
  prd: null,
  prdMarkdown: '',
  error: null,
  feed: [],
  commands: [],
};

export function App({ version, onAgentStart, autoApprove = false }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<UIState>(INITIAL_STATE);

  useEffect(() => {
    const handlePhaseChanged = (event: unknown): void => {
      const e = event as { payload: { phase: AgentPhase } };
      setState((prev) => ({ ...prev, phase: e.payload.phase }));
    };

    const handlePRDGenerated = (event: unknown): void => {
      const e = event as {
        payload: {
          prd: PRD;
          featureName: string;
          prdMarkdown: string;
        };
      };
      setState((prev) => ({
        ...prev,
        prd: e.payload.prd,
        prdMarkdown: e.payload.prdMarkdown,
        featureName: e.payload.featureName,
        tasks: e.payload.prd.tasks,
        phase: 'awaiting_approval',
      }));
    };

    const handleTaskStarted = (event: unknown): void => {
      const e = event as { payload: { taskIndex: number } };
      setState((prev) => ({
        ...prev,
        currentTaskIndex: e.payload.taskIndex,
        phase: 'executing_tasks',
        currentTool: '',
      }));
    };

    const handleTaskComplete = (event: unknown): void => {
      const e = event as { payload: { taskId: string } };
      setState((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === e.payload.taskId ? { ...t, status: 'complete' as const } : t,
        ),
        commands: prev.commands.filter((c) => c.taskId !== e.payload.taskId),
      }));
    };

    const handleTaskFailed = (event: unknown): void => {
      const e = event as { payload: { taskId: string } };
      setState((prev) => ({ ...prev, commands: prev.commands.filter((c) => c.taskId !== e.payload.taskId) }));
    };

    const handleIterationStarted = (event: unknown): void => {
      const e = event as { payload: { iteration: number } };
      setState((prev) => ({
        ...prev,
        currentIteration: e.payload.iteration,
      }));
    };

    const handleWorkerOutput = (): void => {
      setState((prev) => ({ ...prev, phase: 'worker_running' }));
    };

    const handleLintComplete = (event: unknown): void => {
      const e = event as { payload: { taskId?: string; clean?: boolean; output?: string } };
      setState((prev) => ({
        ...prev,
        phase: 'lint_running',
        commands: e.payload.taskId
          ? upsertCommand(prev.commands, {
              taskId: e.payload.taskId,
              command: `bunx eslint (lint gate: ${e.payload.clean ? 'clean' : 'errors'})`,
              output: tailLines(e.payload.output ?? '', OUTPUT_LINES),
              running: false,
              failed: e.payload.clean === false,
            })
          : prev.commands,
      }));
    };

    const handleReviewerDecision = (): void => {
      setState((prev) => ({ ...prev, phase: 'reviewer_running' }));
    };

    const handleToolCalled = (event: unknown): void => {
      const e = event as { payload: { toolName: string; args?: Record<string, unknown>; taskId?: string } };
      setState((prev) => ({
        ...prev,
        currentTool: e.payload.toolName,
        commands: e.payload.taskId
          ? upsertCommand(prev.commands, {
              taskId: e.payload.taskId,
              command: describeToolCall(e.payload.toolName, e.payload.args ?? {}),
              output: [],
              running: true,
            })
          : prev.commands,
      }));
    };

    const handleToolResult = (event: unknown): void => {
      const e = event as { payload: { toolName: string; args?: Record<string, unknown>; taskId?: string; output?: string } };
      const taskId = e.payload.taskId;
      if (!taskId) return;
      setState((prev) => ({
        ...prev,
        commands: upsertCommand(prev.commands, {
          taskId,
          command: describeToolCall(e.payload.toolName, e.payload.args ?? {}),
          output: tailLines(commandOutputText(e.payload.output ?? ''), OUTPUT_LINES),
          running: false,
          failed: commandFailed(e.payload.output ?? ''),
        }),
      }));
    };

    const handleComplete = (): void => {
      setState((prev) => ({ ...prev, phase: 'complete' }));
      setTimeout(() => exit(), 500);
    };

    const handleError = (event: unknown): void => {
      const e = event as { payload: { message?: string | undefined; error?: string | undefined } };
      const message = e.payload.message ?? e.payload.error ?? 'Unknown error';
      setState((prev) => ({ ...prev, error: message, phase: 'failed' }));
      setTimeout(() => exit(), 1000);
    };

    const handleFeedEvent = (event: unknown): void => {
      const e = event as { type: string; payload: Record<string, unknown> };
      const line = formatFeedLine(e.type, e.payload);
      if (line === null) return;
      setState((prev) => ({ ...prev, feed: [...prev.feed, line].slice(-8) }));
    };

    agentEvents.on('phase_changed', handlePhaseChanged);
    agentEvents.on('prd_generated', handlePRDGenerated);
    agentEvents.on('task_started', handleTaskStarted);
    agentEvents.on('task_complete', handleTaskComplete);
    agentEvents.on('iteration_started', handleIterationStarted);
    agentEvents.on('worker_output', handleWorkerOutput);
    agentEvents.on('lint_complete', handleLintComplete);
    agentEvents.on('reviewer_decision', handleReviewerDecision);
    agentEvents.on('tool_called', handleToolCalled);
    agentEvents.on('tool_result', handleToolResult);
    agentEvents.on('task_failed', handleTaskFailed);
    agentEvents.on('complete', handleComplete);
    agentEvents.on('error', handleError);
    agentEvents.on('sizing_started', handleFeedEvent);
    agentEvents.on('task_sized', handleFeedEvent);
    agentEvents.on('debate_started', handleFeedEvent);
    agentEvents.on('persona_stance', handleFeedEvent);
    agentEvents.on('debate_decided', handleFeedEvent);

    onAgentStart();

    return (): void => {
      agentEvents.off('phase_changed', handlePhaseChanged);
      agentEvents.off('prd_generated', handlePRDGenerated);
      agentEvents.off('task_started', handleTaskStarted);
      agentEvents.off('task_complete', handleTaskComplete);
      agentEvents.off('iteration_started', handleIterationStarted);
      agentEvents.off('worker_output', handleWorkerOutput);
      agentEvents.off('lint_complete', handleLintComplete);
      agentEvents.off('reviewer_decision', handleReviewerDecision);
      agentEvents.off('tool_called', handleToolCalled);
      agentEvents.off('tool_result', handleToolResult);
      agentEvents.off('task_failed', handleTaskFailed);
      agentEvents.off('complete', handleComplete);
      agentEvents.off('error', handleError);
      agentEvents.off('sizing_started', handleFeedEvent);
      agentEvents.off('task_sized', handleFeedEvent);
      agentEvents.off('debate_started', handleFeedEvent);
      agentEvents.off('persona_stance', handleFeedEvent);
      agentEvents.off('debate_decided', handleFeedEvent);
    };
  }, [exit, onAgentStart]);

  const handlePRDApprove = (): void => {
    uiEvents.emit('prd_approved');
  };

  const handlePRDReject = (): void => {
    uiEvents.emit('prd_rejected');
    exit();
  };

  if (state.error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">Error</Text>
        <Text color="red">{state.error}</Text>
      </Box>
    );
  }

  // Only mount the interactive PRD preview when a human review is expected.
  // With autoApprove (--no-prd-review), index.mts approves via an event and we
  // must NOT mount PRDPreview — its useInput throws in non-TTY environments.
  if (state.phase === 'awaiting_approval' && state.prd && !autoApprove) {
    return (
      <PRDPreview
        prd={state.prdMarkdown}
        taskCount={state.tasks.length}
        onApprove={handlePRDApprove}
        onReject={handlePRDReject}
      />
    );
  }

  if (state.phase === 'complete') {
    const completedCount = state.tasks.filter((t) => t.status === 'complete').length;
    const failedCount = state.tasks.filter((t) => t.status === 'failed').length;

    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header version={version} featureName={state.featureName} />
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
          <Text bold color="green">Feature Complete</Text>
          <Text color="white">
            <Text bold color="green">{completedCount}</Text> tasks completed,{' '}
            <Text bold color={failedCount > 0 ? 'red' : 'green'}>{failedCount}</Text> failed
          </Text>
          <Text dimColor>Results written to feature-results/{state.featureName}/RESULTS.md</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Header version={version} featureName={state.featureName || undefined} />
      {state.tasks.length > 0 && (
        <TaskList
          tasks={state.tasks}
          currentTaskIndex={state.currentTaskIndex}
        />
      )}
      <StatusBar
        phase={state.phase}
        model={state.currentModel || undefined}
        currentTool={state.currentTool || undefined}
        iteration={state.currentIteration}
      />
      <CommandPanel commands={state.commands} />
      <ActivityFeed lines={state.feed} />
    </Box>
  );
}
