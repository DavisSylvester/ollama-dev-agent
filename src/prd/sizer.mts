import type { Task, TaskSize } from '../types/index.mts';
import { TASK_DOMAINS, DOMAIN_KEYWORDS } from '../types/index.mts';
import { env } from '../env.mts';
import { createChatModel } from '../models/index.mts';
import { buildSizingPrompt } from './prompts.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { logger } from '../logger.mts';

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
