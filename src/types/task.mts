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

export interface ReviewDecision {
  readonly decision: 'ship' | 'revise';
  readonly feedback: string;
  readonly issues: readonly string[];
}
