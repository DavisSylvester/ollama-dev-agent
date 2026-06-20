export interface Task {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly testCommand: string;
  readonly dependsOn: readonly string[];
  status: TaskStatus;
  iterationCount: number;
}

export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'failed';

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
