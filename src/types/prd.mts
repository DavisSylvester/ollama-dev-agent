import type { Task } from './task.mts';

export interface PRD {
  readonly featureName: string;
  readonly featureSlug: string;
  readonly overview: string;
  readonly goals: readonly string[];
  readonly technicalApproach: string;
  readonly tasks: Task[];
  readonly acceptanceCriteria: readonly string[];
  readonly outOfScope: readonly string[];
  readonly rawMarkdown: string;
}
