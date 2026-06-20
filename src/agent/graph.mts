import { StateGraph, START, END } from '@langchain/langgraph';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { AgentStateAnnotation } from './state.mts';
import { emitAgentEvent } from './events.mts';
import { generatePRD } from '../prd/index.mts';
import { RalphLoop } from '../ralph/index.mts';
import { createWorkerTools } from '../tools/index.mts';
import { env } from '../env.mts';
import type { AgentStateType } from './state.mts';
import type { Task } from '../types/index.mts';

// --- Node: generate_prd ---

async function generatePRDNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // Skip generation if a PRD was pre-loaded (e.g. via --prd-file)
  if (state.prd !== null) {
    return { phase: 'awaiting_approval' };
  }

  emitAgentEvent('phase_changed', { phase: 'generating_prd' });

  const prd = await generatePRD(state.userPrompt, state.workingDirectory);

  emitAgentEvent('prd_generated', {
    prd,
    featureName: prd.featureName,
    featureSlug: prd.featureSlug,
    taskCount: prd.tasks.length,
    prdMarkdown: prd.rawMarkdown,
  });

  return {
    prd,
    featureName: prd.featureName,
    featureSlug: prd.featureSlug,
    tasks: prd.tasks,
    phase: 'awaiting_approval',
  };
}

// --- Node: run_task ---
//
// Finds all "ready" tasks — pending tasks whose dependsOn are all complete —
// and runs them in parallel. One call to this node processes one batch of
// ready tasks, then the conditional edge loops back if more remain.

async function runTaskNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const readyTasks = findReadyTasks(state.tasks);

  if (readyTasks.length === 0) {
    // Nothing ready — all remaining tasks are either blocked or there are none
    return { phase: 'executing_tasks' };
  }

  // Mark ready tasks as in_progress before launching
  const tasksWithProgress: Task[] = state.tasks.map((t) =>
    readyTasks.some((r) => r.id === t.id) ? { ...t, status: 'in_progress' as const } : t,
  );

  emitAgentEvent('phase_changed', { phase: 'executing_tasks' });

  // Run all ready tasks in parallel
  const results = await Promise.allSettled(
    readyTasks.map((task) =>
      runSingleTask(task, state, tasksWithProgress),
    ),
  );

  // Merge settled results back into the full task list
  let mergedTasks: Task[] = tasksWithProgress;
  const completedIds: string[] = [];

  for (let i = 0; i < readyTasks.length; i++) {
    const task = readyTasks[i]!;
    const result = results[i]!;

    if (result.status === 'fulfilled') {
      mergedTasks = mergedTasks.map((t) =>
        t.id === task.id ? result.value : t,
      );
      if (result.value.status === 'complete') completedIds.push(task.id);
    } else {
      // Unexpected error from runSingleTask itself — mark failed
      mergedTasks = mergedTasks.map((t) =>
        t.id === task.id ? { ...t, status: 'failed' as const } : t,
      );
    }
  }

  return {
    tasks: mergedTasks,
    completedTaskIds: completedIds,
    phase: 'executing_tasks',
  };
}

async function runSingleTask(
  task: Task,
  state: AgentStateType,
  currentTasks: Task[],
): Promise<Task> {
  emitAgentEvent('task_started', {
    taskId: task.id,
    taskName: task.name,
    taskIndex: currentTasks.findIndex((t) => t.id === task.id),
    totalTasks: currentTasks.length,
  });

  const workerTools = createWorkerTools(state.workingDirectory, env.BRAVE_API_KEY);

  const ralph = new RalphLoop(
    state.workingDirectory,
    state.featureSlug,
    state.featureName,
    state.maxIterations,
  );

  let lastIterationCount = 0;

  const finalStatus = await ralph.runTask(
    task,
    workerTools,
    {
      onIterationStart: (taskId, iteration) => {
        lastIterationCount = iteration;
        emitAgentEvent('iteration_started', {
          taskId,
          iteration,
          maxIterations: state.maxIterations,
        });
      },
      onWorkerComplete: (taskId, output) => {
        emitAgentEvent('worker_output', {
          taskId,
          output,
          iteration: lastIterationCount,
        });
      },
      onLintComplete: (taskId, clean, output) => {
        emitAgentEvent('lint_complete', {
          taskId,
          clean,
          output,
          iteration: lastIterationCount,
        });
      },
      onReviewerComplete: (taskId, decision) => {
        emitAgentEvent('reviewer_decision', {
          taskId,
          decision,
          iteration: lastIterationCount,
        });
      },
      onToolCall: (toolName, args) => {
        emitAgentEvent('tool_called', { toolName, args, taskId: task.id });
      },
    },
  );

  if (finalStatus === 'complete') {
    emitAgentEvent('task_complete', {
      taskId: task.id,
      taskName: task.name,
      iterations: lastIterationCount,
    });
  } else {
    emitAgentEvent('task_failed', {
      taskId: task.id,
      taskName: task.name,
      iterations: lastIterationCount,
      reason: `Exhausted ${state.maxIterations} iterations without SHIP decision`,
    });
  }

  return { ...task, status: finalStatus, iterationCount: lastIterationCount };
}

// Returns all pending tasks whose dependencies are fully satisfied
function findReadyTasks(tasks: Task[]): Task[] {
  const completedIds = new Set(
    tasks.filter((t) => t.status === 'complete').map((t) => t.id),
  );

  return tasks.filter(
    (t) =>
      t.status === 'pending' &&
      t.dependsOn.every((dep) => completedIds.has(dep)),
  );
}

// --- Node: generate_results ---

async function generateResultsNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  emitAgentEvent('phase_changed', { phase: 'generating_results' });

  const completedTasks = state.tasks.filter((t) => t.status === 'complete');
  const failedTasks = state.tasks.filter((t) => t.status === 'failed');

  const taskRows = state.tasks
    .map((t) => {
      const icon = t.status === 'complete' ? '✓' : t.status === 'failed' ? '✗' : '○';
      return `| ${icon} | ${t.id} | ${t.name} | ${t.status} | ${t.iterationCount} |`;
    })
    .join('\n');

  const resultsMarkdown = `# Results: ${state.featureName}

**Feature Slug**: ${state.featureSlug}
**Generated**: ${DateTime.utc().toISO()}

## Summary

- **Total Tasks**: ${state.tasks.length}
- **Completed**: ${completedTasks.length}
- **Failed**: ${failedTasks.length}

## Task Results

| Status | ID | Name | Result | Iterations |
|--------|----|------|--------|------------|
${taskRows}

## Completed Tasks

${completedTasks.length > 0 ? completedTasks.map((t) => `- **${t.id}**: ${t.name}`).join('\n') : '_None_'}

## Failed Tasks

${failedTasks.length > 0 ? failedTasks.map((t) => `- **${t.id}**: ${t.name}`).join('\n') : '_None_'}
`;

  const resultsDir = join('feature-results', state.featureSlug);
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, 'RESULTS.md'), resultsMarkdown, 'utf-8');

  emitAgentEvent('results_generated', {
    featureName: state.featureName,
    featureSlug: state.featureSlug,
    completedCount: completedTasks.length,
    failedCount: failedTasks.length,
    totalCount: state.tasks.length,
  });

  emitAgentEvent('complete', {
    featureName: state.featureName,
    featureSlug: state.featureSlug,
    completedCount: completedTasks.length,
    failedCount: failedTasks.length,
  });

  return { phase: 'complete' };
}

// --- Conditional edge: routeAfterTask ---

function routeAfterTask(
  state: AgentStateType,
): 'run_task' | 'generate_results' {
  const hasPending = state.tasks.some((t) => t.status === 'pending');
  const hasInProgress = state.tasks.some((t) => t.status === 'in_progress');
  if (hasPending || hasInProgress) return 'run_task';
  return 'generate_results';
}

// --- Graph builder ---

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- LangGraph compile() return type is complex and inferred
export function buildAgentGraph() {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('generate_prd', generatePRDNode)
    .addNode('run_task', runTaskNode)
    .addNode('generate_results', generateResultsNode)
    .addEdge(START, 'generate_prd')
    .addEdge('generate_prd', 'run_task')
    .addConditionalEdges('run_task', routeAfterTask, {
      run_task: 'run_task',
      generate_results: 'generate_results',
    })
    .addEdge('generate_results', END);

  return graph.compile();
}
