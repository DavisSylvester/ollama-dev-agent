import type { TaskSize } from './task-size.mts';
import type { TaskDomain } from './task-domain.mts';

export interface Task {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly testCommand: string;
  readonly dependsOn: readonly string[];
  // Functional area. Defaults to 'services' with a warning if the drafter omits it.
  readonly domain: TaskDomain;
  // T-shirt size assigned by the sizer. Absent until size_plan runs.
  size?: TaskSize;
  status: TaskStatus;
  iterationCount: number;
  // How many times this task's lineage has been auto-split (0 = original task).
  // Caps recursive splitting when a task repeatedly fails.
  splitDepth?: number;
  // Wall-clock timestamps for the progress board. startedAt is stamped when the
  // task enters in_progress; completedAt when it reaches complete/failed.
  startedAt?: string | null;
  completedAt?: string | null;
  // Why the task failed, in one line (e.g. "5 attempts: 3× model timeout, 2× REVISE").
  failureReason?: string;
  // For a blocked task: the failed/blocked tasks it was waiting on.
  blockedBy?: string[];
}

// blocked = never ran because a task it depends on failed (or is itself blocked).
export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'blocked';

export interface RalphIteration {
  readonly taskId: string;
  readonly iterationNumber: number;
  readonly workerOutput: string;
  readonly reviewerFeedback: string;
  readonly decision: ReviewDecision;
  readonly timestamp: string;
}

export interface ChecklistItem {
  readonly criterion: string;
  readonly met: boolean;
}

export interface ReviewDecision {
  readonly decision: 'ship' | 'revise';
  readonly feedback: string;
  readonly issues: readonly string[];
  // Per-acceptance-criterion verification from the reviewer (pre-completion
  // checklist). Empty when the reviewer produced no checklist.
  readonly checklist?: readonly ChecklistItem[];
}
