import type { Task, TaskSize, TaskDomain } from '../types/index.mts';
import { TASK_DOMAINS, DOMAIN_KEYWORDS } from '../types/index.mts';
import { env } from '../env.mts';
import { createChatModel } from '../models/index.mts';
import { buildSizingPrompt, buildSplitRecommendationPrompt } from './prompts.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { logger } from '../logger.mts';
import { splitTask, applySplit, canSplitForSize, buildChildTasks } from './splitter.mts';
import { runDebate, type DebateResult, type DebateDeps } from './debate.mts';

export interface SizingSignals {
  readonly criteriaCount: number;
  readonly domainMentions: number;
}

export interface SizeRecommendation {
  readonly taskId: string;
  readonly taskName: string;
  readonly reasons: readonly string[];
  readonly recommendation: string;
}

// A task genuinely spanning at least this many distinct functional areas is
// almost certainly too big for one pass. Kept high because DOMAIN_KEYWORDS uses
// distinctive tokens — incidental single-keyword overlap must not trip the floor.
const MULTI_DOMAIN_THRESHOLD = 3;

// Derive countable signals from a task's free-text fields. These are a
// conservative backstop to the model's judgment, not a replacement — they must
// only fire on genuinely oversized tasks, never on ordinary prose.
export function computeSignals(task: Task): SizingSignals {
  // Split acceptance criteria into discrete clauses on newlines, semicolons, and
  // sentence boundaries so multi-sentence criteria are counted, not collapsed.
  const criteriaCount = task.acceptanceCriteria
    .split(/[\n;]+|\.\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  const haystack = `${task.description} ${task.acceptanceCriteria}`.toLowerCase();
  const domainMentions = TASK_DOMAINS.filter((domain) =>
    DOMAIN_KEYWORDS[domain].some((kw) => haystack.includes(kw)),
  ).length;

  return { criteriaCount, domainMentions };
}

function detectedDomains(task: Task): TaskDomain[] {
  const haystack = `${task.description} ${task.acceptanceCriteria}`.toLowerCase();
  return TASK_DOMAINS.filter((domain) =>
    DOMAIN_KEYWORDS[domain].some((kw) => haystack.includes(kw)),
  );
}

// Explain why a task is oversized and recommend a concrete way to shrink it.
// Deterministic: derived from the same signals the floor uses, so it is always
// available even when no model is reachable.
export function explainOversize(task: Task): { reasons: string[]; recommendation: string } {
  const { criteriaCount, domainMentions } = computeSignals(task);
  const overCriteria = criteriaCount > env.SIZE_MAX_CRITERIA;
  const multiDomain = domainMentions >= MULTI_DOMAIN_THRESHOLD;
  const domains = detectedDomains(task);

  const reasons: string[] = [];
  if (multiDomain) {
    reasons.push(`Spans ${domains.length} distinct domains (${domains.join(', ')}).`);
  }
  if (overCriteria) {
    reasons.push(`Has ${criteriaCount} acceptance-criteria clauses (more than ${env.SIZE_MAX_CRITERIA}).`);
  }
  if (reasons.length === 0) {
    reasons.push('The sizer model judged this task too large for one focused pass.');
  }

  let recommendation: string;
  if (multiDomain) {
    recommendation =
      `Separate into one task per functional area — ${domains.join(', ')} — so each child is single-domain.`;
  } else if (overCriteria) {
    recommendation =
      `Split by acceptance-criteria groups: cluster the ${criteriaCount} criteria into related groups and make each group its own task.`;
  } else {
    recommendation =
      'Decompose into module-plus-test units: one focused module, endpoint, or component (with its test) per task.';
  }

  return { reasons, recommendation };
}

export interface RecommendDeps {
  readonly invokeFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

// Always returns a recommendation: deterministic by default, upgraded with the
// planner model's richer decomposition approach when the model is reachable.
export async function recommendSplitApproach(
  task: Task,
  deps?: RecommendDeps,
): Promise<SizeRecommendation> {
  const { reasons, recommendation } = explainOversize(task);
  let finalRecommendation = recommendation;

  try {
    const systemPrompt = buildSplitRecommendationPrompt(task, reasons);
    const userPrompt = 'Recommend a decomposition approach now.';
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
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      finalRecommendation = trimmed;
    }
  } catch (err) {
    logger.warn(
      { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      'sizer.recommend_model_failed',
    );
  }

  return { taskId: task.id, taskName: task.name, reasons, recommendation: finalRecommendation };
}

// Force-promote to `L` when a hard signal is exceeded; otherwise keep the
// model's size. The floor only ever raises size, never lowers it, and is tuned
// to defer to the model except on unambiguous over-sizing.
export function applyDeterministicFloor(task: Task, modelSize: TaskSize): TaskSize {
  const { criteriaCount, domainMentions } = computeSignals(task);
  const overCriteria = criteriaCount > env.SIZE_MAX_CRITERIA;
  const multiDomain = domainMentions >= MULTI_DOMAIN_THRESHOLD;

  if (overCriteria || multiDomain) {
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

export interface DebateSplitDeps extends DebateDeps {
  // Override the whole debate (unit tests inject a canned DebateResult).
  debateFn?: (task: Task) => Promise<DebateResult>;
  // Deterministic fallback splitter (defaults to splitTask).
  splitFn?: typeof splitTask;
}

export interface DebateSplitResult {
  children: Task[];
  recommendation: SizeRecommendation;
}

function summarizeDebate(task: Task, result: DebateResult): SizeRecommendation {
  const { reasons } = explainOversize(task);
  const stories = result.finalStories.map((s, i) => `${i + 1}. ${s.name} — ${s.description}`).join('\n');
  const recommendation =
    `Decided by ${result.decidedBy} after ${result.rounds.length} round(s). Split into:\n${stories}`;
  return { taskId: task.id, taskName: task.name, reasons, recommendation };
}

function deterministicRecommendation(task: Task): SizeRecommendation {
  const { reasons, recommendation } = explainOversize(task);
  return { taskId: task.id, taskName: task.name, reasons, recommendation };
}

// Run the debate to drive the split. Retries the debate once, then falls back
// to the deterministic splitter + recommendation so the run never stalls on a
// flaky model.
export async function debateSplit(task: Task, deps?: DebateSplitDeps): Promise<DebateSplitResult> {
  const debate = deps?.debateFn ?? ((t: Task) => runDebate(t, deps));
  const split = deps?.splitFn ?? splitTask;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await debate(task);
      const children = buildChildTasks(task, result.finalStories);
      if (children.length === 0) throw new Error('debate produced no stories');
      return { children, recommendation: summarizeDebate(task, result) };
    } catch (err) {
      logger.warn(
        { taskId: task.id, attempt, err: err instanceof Error ? err.message : String(err) },
        'sizer.debate_failed',
      );
    }
  }

  const children = await split(task, '');
  return { children, recommendation: deterministicRecommendation(task) };
}

export interface SizedPlanResult {
  readonly tasks: Task[];
  readonly distribution: Record<TaskSize, number>;
  readonly splits: Array<{ parentId: string; childIds: string[] }>;
  readonly recommendations: readonly SizeRecommendation[];
}

// Thrown when a task remains `L` and cannot be split further while the gate is
// enforced. Aborts the run rather than executing an oversized task.
export class SizeGateError extends Error {
  constructor(
    public readonly unsplittableIds: string[],
    public readonly recommendations: readonly SizeRecommendation[] = [],
  ) {
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
  readonly recommendFn?: (task: Task) => Promise<SizeRecommendation>;
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
  const recommend = deps?.recommendFn ?? ((t: Task) => recommendSplitApproach(t));

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
  const recMap = new Map<string, SizeRecommendation>();

  for (let pass = 0; pass < MAX_SIZE_PASSES; pass++) {
    const oversized = current.filter((t) => t.size === 'L');

    for (const t of oversized) {
      if (!recMap.has(t.id)) {
        recMap.set(t.id, await recommend(t));
      }
    }
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

  const recommendations = [...recMap.values()];
  const stillLarge = current.filter((t) => t.size === 'L').map((t) => t.id);
  if (stillLarge.length > 0 && env.SIZE_ENFORCE_GATE) {
    throw new SizeGateError(
      stillLarge,
      recommendations.filter((r) => stillLarge.includes(r.taskId)),
    );
  }

  return { tasks: current, distribution: countSizes(current), splits, recommendations };
}
