import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Header } from './components/Header.tsx';
import { TaskList } from './components/TaskList.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { PRDPreview } from './components/PRDPreview.tsx';
import { agentEvents, uiEvents } from '../agent/events.mts';
import type { Task, AgentPhase, PRD } from '../types/index.mts';

interface AppProps {
  readonly version: string;
  readonly onAgentStart: () => void;
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
};

export function App({ version, onAgentStart }: AppProps): React.ReactElement {
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
      }));
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

    const handleLintComplete = (): void => {
      setState((prev) => ({ ...prev, phase: 'lint_running' }));
    };

    const handleReviewerDecision = (): void => {
      setState((prev) => ({ ...prev, phase: 'reviewer_running' }));
    };

    const handleToolCalled = (event: unknown): void => {
      const e = event as { payload: { toolName: string } };
      setState((prev) => ({
        ...prev,
        currentTool: e.payload.toolName,
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

    agentEvents.on('phase_changed', handlePhaseChanged);
    agentEvents.on('prd_generated', handlePRDGenerated);
    agentEvents.on('task_started', handleTaskStarted);
    agentEvents.on('task_complete', handleTaskComplete);
    agentEvents.on('iteration_started', handleIterationStarted);
    agentEvents.on('worker_output', handleWorkerOutput);
    agentEvents.on('lint_complete', handleLintComplete);
    agentEvents.on('reviewer_decision', handleReviewerDecision);
    agentEvents.on('tool_called', handleToolCalled);
    agentEvents.on('complete', handleComplete);
    agentEvents.on('error', handleError);

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
      agentEvents.off('complete', handleComplete);
      agentEvents.off('error', handleError);
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

  if (state.phase === 'awaiting_approval' && state.prd) {
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
    </Box>
  );
}
