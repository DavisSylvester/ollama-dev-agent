import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { Header } from './components/Header.tsx';
import { TaskList } from './components/TaskList.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { PRDPreview } from './components/PRDPreview.tsx';
import { ActivityFeed } from './components/ActivityFeed.tsx';
import { CommandPanel, type CommandView } from './components/CommandPanel.tsx';
import { StartupPanel } from './components/StartupPanel.tsx';
import { buildStartupSummary, type StartupSummary } from './lib/startup-summary.mts';
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
  featureSlug: string;
  tasks: Task[];
  currentTaskIndex: number;
  currentIteration: number;
  currentModel: string;
  currentTool: string;
  prd: PRD | null;
  prdMarkdown: string;
  error: string | null;
  feed: string[];
  // Final result reported by the scheduler's `complete` event.
  summary: RunSummary | null;
  // Latest command per running task, most recent first.
  commands: CommandView[];
  // What the agent is doing right now and since when, so a long wait (a slow
  // model call, a quota pause) shows as a ticking timer, not a frozen screen.
  activity: { label: string; since: number };
  // Status of every task when execution began, printed once.
  startup: StartupSummary | null;
}

interface RunSummary {
  completed: number;
  failed: number;
  blocked: number;
  total: number;
  failedTasks: Array<{ id: string; name: string; reason: string }>;
  blockers: string[];
  userPrompt: string;
}

// Events that add a line to the Activity feed.
const FEED_EVENTS: readonly string[] = [
  'sizing_started', 'task_sized', 'debate_started', 'persona_stance', 'debate_decided',
  'task_started', 'iteration_finished', 'model_retry', 'quota_paused', 'dependencies_checked',
  'task_complete', 'task_failed', 'task_split', 'reviewer_decision',
];

// What the status bar says the agent is doing after each event.
function activityLabel(type: string, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'iteration_started':
      return `${String(payload['taskId'])}: waiting for the model (attempt ${String(payload['iteration'])})`;
    case 'tool_called':
      return `${String(payload['taskId'])}: running ${describeToolCall(String(payload['toolName']), (payload['args'] as Record<string, unknown> | undefined) ?? {})}`;
    case 'tool_result':
      return `${String(payload['taskId'])}: waiting for the model`;
    case 'lint_complete':
      return `${String(payload['taskId'])}: reviewing`;
    case 'model_retry':
      return `model call failed — retry ${String(payload['attempt'])}/${String(payload['maxRetries'])}`;
    case 'model_progress':
      return modelProgressLabel(payload);
    case 'quota_paused':
      return `paused: model quota reached (${String(payload['waitMinutes'])} min)`;
    case 'task_started':
      return `${String(payload['taskId'])}: starting`;
    case 'dependencies_checked':
      return 'checking dependencies';
    default:
      return null;
  }
}

// A running model call: whether it is still waiting, thinking or writing.
export function modelProgressLabel(payload: Record<string, unknown>): string {
  const who = String(payload['label'] ?? '').startsWith('reviewer') ? 'reviewer' : 'worker';
  const k = (tokens: unknown): string => `${(Number(tokens ?? 0) / 1000).toFixed(1)}k`;
  switch (payload['phase']) {
    case 'thinking':
      return `${who} model thinking… ~${k(payload['thinkingTokens'])} tokens`;
    case 'writing':
      return `${who} model writing… ~${k(payload['outputTokens'])} tokens`;
    default:
      return `${who} model: waiting for the first response`;
  }
}

const ACTIVITY_EVENTS: readonly string[] = [
  'iteration_started', 'tool_called', 'tool_result', 'lint_complete', 'model_retry',
  'quota_paused', 'task_started', 'dependencies_checked', 'model_progress',
];

// Lines of command output shown per task, and how many tasks to show.
const OUTPUT_LINES = 3;
const MAX_COMMAND_ROWS = 4;

function upsertCommand(commands: CommandView[], next: CommandView): CommandView[] {
  return [next, ...commands.filter((c) => c.taskId !== next.taskId)].slice(0, MAX_COMMAND_ROWS);
}

const INITIAL_STATE: UIState = {
  phase: 'initializing',
  featureName: '',
  featureSlug: '',
  tasks: [],
  currentTaskIndex: 0,
  currentIteration: 0,
  currentModel: '',
  currentTool: '',
  prd: null,
  prdMarkdown: '',
  error: null,
  feed: [],
  summary: null,
  commands: [],
  activity: { label: 'starting', since: Date.now() },
  startup: null,
};

export function App({ version, onAgentStart, autoApprove = false }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<UIState>(INITIAL_STATE);
  // Re-render once a second so the activity timer ticks even when no event arrives.
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    if (state.phase === 'complete' || state.phase === 'failed') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return (): void => clearInterval(timer);
  }, [state.phase]);

  useEffect(() => {
    const handlePhaseChanged = (event: unknown): void => {
      const e = event as { payload: { phase: AgentPhase } };
      setState((prev) => ({
        ...prev,
        phase: e.payload.phase,
        // Fresh run: snapshot the plan the first time execution starts.
        startup: prev.startup ?? (e.payload.phase === 'executing_tasks' && prev.tasks.length > 0
          ? buildStartupSummary(prev.tasks, [], false)
          : null),
      }));
    };

    const handlePRDGenerated = (event: unknown): void => {
      const e = event as {
        payload: {
          prd: PRD;
          featureName: string;
          featureSlug?: string;
          prdMarkdown: string;
        };
      };
      setState((prev) => ({
        ...prev,
        prd: e.payload.prd,
        prdMarkdown: e.payload.prdMarkdown,
        featureName: e.payload.featureName,
        featureSlug: e.payload.featureSlug ?? prev.featureSlug,
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
      const e = event as { payload: { taskId: string; reason?: string } };
      setState((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === e.payload.taskId ? { ...t, status: 'failed' as const, ...(e.payload.reason ? { failureReason: e.payload.reason } : {}) } : t,
        ),
        commands: prev.commands.filter((c) => c.taskId !== e.payload.taskId),
      }));
    };

    // A resumed run skips planning, so prd_generated never fires: take the plan
    // and its saved statuses from run_resumed instead.
    const handleRunResumed = (event: unknown): void => {
      const e = event as { payload: { featureName: string; featureSlug: string; tasks: Task[]; previousTasks?: Task[] } };
      setState((prev) => ({
        ...prev,
        featureName: e.payload.featureName,
        featureSlug: e.payload.featureSlug,
        tasks: e.payload.tasks,
        phase: 'executing_tasks',
        startup: buildStartupSummary(e.payload.tasks, e.payload.previousTasks ?? [], true),
      }));
    };

    const handleTasksUpdated = (event: unknown): void => {
      const e = event as { payload: { tasks: Task[] } };
      setState((prev) => ({ ...prev, tasks: e.payload.tasks }));
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

    const handleComplete = (event: unknown): void => {
      const e = event as {
        payload: {
          featureName?: string;
          featureSlug?: string;
          completedCount?: number;
          failedCount?: number;
          blockedCount?: number;
          totalCount?: number;
          failed?: Array<{ id: string; name: string; reason: string }>;
          blockers?: string[];
          userPrompt?: string;
        };
      };
      setState((prev) => {
        const count = (status: Task['status']): number => prev.tasks.filter((t) => t.status === status).length;
        return {
          ...prev,
          phase: 'complete',
          featureName: e.payload.featureName ?? prev.featureName,
          featureSlug: e.payload.featureSlug ?? prev.featureSlug,
          summary: {
            completed: e.payload.completedCount ?? count('complete'),
            failed: e.payload.failedCount ?? count('failed'),
            blocked: e.payload.blockedCount ?? count('blocked'),
            total: e.payload.totalCount
              ?? Math.max(prev.tasks.length, (e.payload.completedCount ?? 0) + (e.payload.failedCount ?? 0) + (e.payload.blockedCount ?? 0)),
            failedTasks: e.payload.failed
              ?? prev.tasks.filter((t) => t.status === 'failed').map((t) => ({ id: t.id, name: t.name, reason: t.failureReason ?? '' })),
            blockers: e.payload.blockers ?? [],
            userPrompt: e.payload.userPrompt ?? '',
          },
        };
      });
      setTimeout(() => exit(), 500);
    };

    const handleActivity = (event: unknown): void => {
      const e = event as { type: string; payload: Record<string, unknown> };
      const label = activityLabel(e.type, e.payload);
      if (label === null) return;
      // Progress updates of one call keep its timer running instead of resetting it.
      const elapsed = e.type === 'model_progress' ? Number(e.payload['elapsedSeconds'] ?? 0) * 1000 : 0;
      setState((prev) => ({ ...prev, activity: { label, since: Date.now() - elapsed } }));
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
    agentEvents.on('run_resumed', handleRunResumed);
    agentEvents.on('tasks_updated', handleTasksUpdated);
    agentEvents.on('task_failed', handleTaskFailed);
    agentEvents.on('complete', handleComplete);
    agentEvents.on('error', handleError);
    for (const type of FEED_EVENTS) agentEvents.on(type, handleFeedEvent);
    for (const type of ACTIVITY_EVENTS) agentEvents.on(type, handleActivity);

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
      agentEvents.off('run_resumed', handleRunResumed);
      agentEvents.off('tasks_updated', handleTasksUpdated);
      agentEvents.off('task_failed', handleTaskFailed);
      agentEvents.off('complete', handleComplete);
      agentEvents.off('error', handleError);
      for (const type of FEED_EVENTS) agentEvents.off(type, handleFeedEvent);
      for (const type of ACTIVITY_EVENTS) agentEvents.off(type, handleActivity);
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
    const s = state.summary;
    const completed = s?.completed ?? 0;
    const failed = s?.failed ?? 0;
    const blocked = s?.blocked ?? 0;
    const total = s?.total ?? state.tasks.length;
    const allDone = failed === 0 && blocked === 0 && completed === total;
    const resultsPath = `feature-results/${state.featureSlug || 'unknown'}/RESULTS.md`;
    const failedTasks = s?.failedTasks ?? [];
    const rerun = s?.userPrompt ? `oda "${s.userPrompt}"` : 're-run the same oda command';

    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header version={version} featureName={state.featureName} />
        <Box flexDirection="column" borderStyle="round" borderColor={allDone ? 'green' : 'yellow'} paddingX={1}>
          <Text bold color={allDone ? 'green' : 'yellow'}>{allDone ? 'Feature Complete' : 'Run Finished — Not Complete'}</Text>
          <Text>
            <Text bold color="green">{completed}</Text> of {total} tasks completed
            {failed > 0 && <Text> · <Text bold color="red">{failed}</Text> failed</Text>}
            {blocked > 0 && <Text> · <Text bold color="magenta">{blocked}</Text> blocked (never ran)</Text>}
          </Text>

          {failedTasks.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="red">Failed</Text>
              {failedTasks.slice(0, 8).map((t) => (
                <Box key={t.id} flexDirection="column">
                  <Text wrap="truncate-end"><Text color="red">✗ {t.id}</Text> {t.name}</Text>
                  {t.reason ? <Text dimColor wrap="truncate-end">    {t.reason}</Text> : null}
                </Box>
              ))}
              {failedTasks.length > 8 && <Text dimColor>…and {failedTasks.length - 8} more (see results)</Text>}
            </Box>
          )}

          {blocked > 0 && (
            <Box marginTop={1}>
              <Text color="magenta" wrap="wrap">
                ⊘ {blocked} task{blocked === 1 ? '' : 's'} never ran because {s?.blockers.length ? s.blockers.join(', ') : 'a task they depend on'} failed.
              </Text>
            </Box>
          )}

          {!allDone && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Next step</Text>
              <Text>Re-run to retry the failed tasks and everything they block (completed work is kept):</Text>
              <Text color="cyan">  {rerun}</Text>
            </Box>
          )}
          <Text dimColor>Results written to {resultsPath}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <StartupPanel featureName={state.featureName} summary={state.startup} />
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
        activity={state.activity.label}
        activitySeconds={Math.max(0, Math.floor((now - state.activity.since) / 1000))}
      />
      <CommandPanel commands={state.commands} />
      <ActivityFeed lines={state.feed} />
    </Box>
  );
}
