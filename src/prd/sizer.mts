import type { Task, TaskSize } from '../types/index.mts';
import { TASK_DOMAINS, DOMAIN_KEYWORDS } from '../types/index.mts';
import { env } from '../env.mts';

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
