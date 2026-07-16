import type { Task, TaskSize } from '../types/index.mts';
import { TASK_DOMAINS, DOMAIN_KEYWORDS } from '../types/index.mts';
import { env } from '../env.mts';
import { createChatModel } from '../models/index.mts';
import { buildSizingPrompt } from './prompts.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { logger } from '../logger.mts';
import { splitTask, applySplit, canSplitForSize } from './splitter.mts';

export interface SizingSignals {
  readonly criteriaCount: number;
  readonly domainMentions: number;
  readonly concernCount: number;
}

// Derive countable signals from a task's free-text fields.
export function computeSignals(task: Task): SizingSignals {
  const criteriaCount = task.acceptanceCriteria
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  const haystack = `${task.description} ${task.acceptanceCriteria}`.toLowerCase();
  const domainMentions = TASK_DOMAINS.filter((domain) =>
    DOMAIN_KEYWORDS[domain].some((kw) => haystack.includes(kw)),
  ).length;

  const andCount = (task.description.toLowerCase().match(/\band\b/g) ?? []).length;
  const commaCount = (task.description.match(/,/g) ?? []).length;
  const concernCount = andCount + commaCount;

  return { criteriaCount, domainMentions, concernCount };
}

// Force-promote to `L` when any hard signal is exceeded; otherwise keep the
// model's size. The floor only ever raises size, never lowers it.
export function applyDeterministicFloor(task: Task, modelSize: TaskSize): TaskSize {
  const { criteriaCount, domainMentions, concernCount } = computeSignals(task);
  const overCriteria = criteriaCount > env.SIZE_MAX_CRITERIA;
  const multiDomain = domainMentions > 1;
  const overConcerns = concernCount > env.SIZE_MAX_CONCERNS;

  if (overCriteria || multiDomain || overConcerns) {
    return 'L';
  }
  return modelSize;
}

export interface SizerDeps {
  readonly invokeFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
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

function parseSize(raw: string): TaskSize | null {
  const v = raw.trim().toUpperCase();
  return v === 'S' || v === 'M' || v === 'L' ? v : null;
}

// Ask the planner to size each task. Returns id -> TaskSize; any task the model
// omits or garbles defaults to 'M' (the deterministic floor still applies later).
export async function getModelSizes(
  tasks: readonly Task[],
  deps?: SizerDeps,
): Promise<Map<string, TaskSize>> {
  const systemPrompt = buildSizingPrompt(tasks);
  const userPrompt = 'Size every task now.';

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

  const sizes = new Map<string, TaskSize>();
  const linePattern = /(TASK-[\w-]+)\s*:\s*([SML])/gi;
  let m: RegExpExecArray | null;
  while ((m = linePattern.exec(raw)) !== null) {
    const size = parseSize(m[2]!);
    if (size) sizes.set(m[1]!, size);
  }

  for (const task of tasks) {
    if (!sizes.has(task.id)) {
      logger.warn({ taskId: task.id }, 'sizer.model_size_missing_defaulted');
      sizes.set(task.id, 'M');
    }
  }

  return sizes;
}

export interface SizedPlanResult {
  readonly tasks: Task[];
  readonly distribution: Record<TaskSize, number>;
  readonly splits: Array<{ parentId: string; childIds: string[] }>;
}

// Thrown when a task remains `L` and cannot be split further while the gate is
// enforced. Aborts the run rather than executing an oversized task.
export class SizeGateError extends Error {
  constructor(public readonly unsplittableIds: string[]) {
    super(
      `Sizing gate failed: ${unsplittableIds.length} task(s) remain size L and ` +
        `cannot be split further: ${unsplittableIds.join(', ')}`,
    );
    this.name = 'SizeGateError';
  }
}

export interface SizePlanDeps {
  readonly sizeFn?: (tasks: readonly Task[]) => Promise<Map<string, TaskSize>>;
  readonly splitFn?: typeof splitTask;
}

// Cap on how many split passes we run so a pathological model can't loop forever.
const MAX_SIZE_PASSES = 5;

// Assign a size to one task: model size raised by the deterministic floor.
function sizeOne(task: Task, modelSizes: Map<string, TaskSize>): Task {
  const modelSize = modelSizes.get(task.id) ?? 'M';
  return { ...task, size: applyDeterministicFloor(task, modelSize) };
}

function countSizes(tasks: readonly Task[]): Record<TaskSize, number> {
  const dist: Record<TaskSize, number> = { S: 0, M: 0, L: 0 };
  for (const t of tasks) {
    if (t.size) dist[t.size]++;
  }
  return dist;
}

export async function sizePlan(
  tasks: Task[],
  deps?: SizePlanDeps,
): Promise<SizedPlanResult> {
  const sizeFn = deps?.sizeFn ?? ((t: readonly Task[]) => getModelSizes(t));
  const split = deps?.splitFn ?? splitTask;

  // Size freshly-split children: reuse an existing child size when present,
  // otherwise run the model + floor on the unsized ones.
  const sizeChildren = async (children: Task[]): Promise<Task[]> => {
    const unsized = children.filter((c) => !c.size);
    if (unsized.length === 0) return children;
    const childSizes = await sizeFn(unsized);
    return children.map((c) => (c.size ? c : sizeOne(c, childSizes)));
  };

  const modelSizes = await sizeFn(tasks);
  let current: Task[] = tasks.map((t) => sizeOne(t, modelSizes));
  const splits: Array<{ parentId: string; childIds: string[] }> = [];

  for (let pass = 0; pass < MAX_SIZE_PASSES; pass++) {
    const oversized = current.filter((t) => t.size === 'L');
    if (oversized.length === 0) break;

    const splittable = oversized.filter((t) => canSplitForSize(t));
    if (splittable.length === 0) break; // nothing more we can do — gate decides

    for (const parentTask of splittable) {
      const children = await split(parentTask, '');
      if (children.length === 0) continue;
      const sizedChildren = await sizeChildren(children);
      current = applySplit(current, parentTask.id, sizedChildren);
      splits.push({ parentId: parentTask.id, childIds: sizedChildren.map((c) => c.id) });
    }
  }

  const stillLarge = current.filter((t) => t.size === 'L').map((t) => t.id);
  if (stillLarge.length > 0 && env.SIZE_ENFORCE_GATE) {
    throw new SizeGateError(stillLarge);
  }

  return { tasks: current, distribution: countSizes(current), splits };
}
