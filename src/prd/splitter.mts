import type { Task } from '../types/index.mts';
import { createChatModel } from '../models/index.mts';
import { parseTasks } from './parser.mts';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';

// Only split an original task once — a sub-task that still fails is a genuine
// failure, not an over-sizing problem.
export const MAX_SPLIT_DEPTH = 1;
const MAX_SUB_TASKS = 4;

// Injected for tests — bypasses the live planner model.
export interface SplitterDeps {
  readonly invokeFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export function canSplit(task: Task): boolean {
  return env.AUTO_SPLIT_ON_FAILURE && (task.splitDepth ?? 0) < MAX_SPLIT_DEPTH;
}

function buildSplitPrompt(task: Task, failureContext: string): string {
  return `You are decomposing a software task that FAILED because it was too large to complete in one focused pass.

## The failed task
**${task.id}**: ${task.name}
**Description**: ${task.description}
**Acceptance**: ${task.acceptanceCriteria}
**Test Command**: \`${task.testCommand}\`

## Why it failed
${failureContext || 'It exhausted its iteration budget without shipping — almost certainly too many concerns in one task.'}

## Your job
Split this into **2 to ${MAX_SUB_TASKS} smaller sub-tasks**, each completable in one focused pass (roughly one module plus its test). Together the sub-tasks must fully cover the original task's acceptance criteria.

Output ONLY the sub-tasks in EXACTLY this format (use sequential TASK-1, TASK-2, ... ids):

- [ ] **TASK-1**: <sub-task name>
  - **Description**: <what to implement — one focused concern>
  - **Acceptance**: <specific, verifiable criteria>
  - **Test Command**: \`<bun test command>\`

- [ ] **TASK-2**: <sub-task name>
  - **Description**: ...
  - **Acceptance**: ...
  - **Test Command**: \`...\`

Order them so the foundation comes first. Do not output anything except the task list.`;
}

function extractContent(aiMessage: AIMessage): string {
  const content = aiMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : typeof b === 'object' && b !== null && 'text' in b && typeof (b as { text: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
      )
      .join('');
  }
  return String(content);
}

/**
 * Ask the planner to decompose a failed task into smaller sub-tasks.
 * Returns re-IDed sub-tasks (`<parentId>-1`, `-2`, …): the first inherits the
 * parent's external dependencies; the rest depend on the first (foundation
 * first, followers parallelize). Returns [] if decomposition produced nothing.
 */
export async function splitTask(
  task: Task,
  failureContext: string,
  deps?: SplitterDeps,
): Promise<Task[]> {
  const systemPrompt = buildSplitPrompt(task, failureContext);
  const userPrompt = `Decompose ${task.id} into smaller sub-tasks now.`;

  let raw: string;
  if (deps?.invokeFn) {
    raw = await deps.invokeFn(systemPrompt, userPrompt);
  } else {
    const model = createChatModel(env.PLANNER_MODEL);
    const res = (await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ])) as AIMessage;
    raw = extractContent(res);
  }

  const parsed = parseTasks(raw).slice(0, MAX_SUB_TASKS);
  if (parsed.length === 0) {
    logger.warn({ taskId: task.id }, 'splitter.no_subtasks');
    return [];
  }

  const depth = (task.splitDepth ?? 0) + 1;
  const firstId = `${task.id}-1`;
  const subTasks: Task[] = parsed.map((sub, i) => ({
    ...sub,
    id: `${task.id}-${i + 1}`,
    dependsOn: i === 0 ? [...task.dependsOn] : [firstId],
    status: 'pending' as const,
    iterationCount: 0,
    splitDepth: depth,
  }));

  logger.info({ taskId: task.id, subTasks: subTasks.map((s) => s.id) }, 'splitter.split');
  return subTasks;
}

/**
 * Replace a failed parent task with its sub-tasks in the task list, and
 * re-point any task that depended on the parent to depend on ALL sub-tasks
 * (so dependents wait for the whole decomposed unit). Pure function.
 */
export function applySplit(tasks: Task[], parentId: string, subTasks: Task[]): Task[] {
  if (subTasks.length === 0) return tasks;
  const subIds = subTasks.map((s) => s.id);
  const out: Task[] = [];
  for (const t of tasks) {
    if (t.id === parentId) {
      out.push(...subTasks); // replace parent with sub-tasks
      continue;
    }
    if (t.dependsOn.includes(parentId)) {
      const rewired = [...t.dependsOn.filter((d) => d !== parentId), ...subIds];
      out.push({ ...t, dependsOn: rewired });
    } else {
      out.push(t);
    }
  }
  return out;
}
