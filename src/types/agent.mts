import type { Task, ReviewDecision } from './task.mts';
import type { PRD } from './prd.mts';

export type AgentPhase =
  | 'initializing'
  | 'generating_prd'
  | 'sizing_plan'
  | 'awaiting_approval'
  | 'executing_tasks'
  | 'worker_running'
  | 'lint_running'
  | 'reviewer_running'
  | 'generating_results'
  | 'complete'
  | 'failed';

export interface AgentState {
  readonly userPrompt: string;
  readonly workingDirectory: string;
  prd: PRD | null;
  featureName: string;
  featureSlug: string;
  tasks: Task[];
  currentTaskIndex: number;
  currentIteration: number;
  maxIterations: number;
  workerOutput: string;
  reviewerFeedback: string;
  lastDecision: ReviewDecision | null;
  phase: AgentPhase;
  error: string | null;
  completedTaskIds: string[];
}

export interface AgentConfig {
  readonly workingDirectory: string;
  readonly maxIterations?: number;
  readonly maxReactSteps?: number;
  readonly prdFile?: string;
  readonly fresh?: boolean;
  readonly docsDir?: string;
}

export type AgentEventType =
  | 'phase_changed'
  | 'prd_generated'
  | 'plan_sized'
  | 'run_resumed'
  | 'docs_collected'
  | 'doc_summarized'
  | 'sizing_started'
  | 'task_sized'
  | 'debate_started'
  | 'persona_stance'
  | 'debate_decided'
  | 'prd_approved'
  | 'task_started'
  | 'task_complete'
  | 'task_failed'
  | 'iteration_started'
  | 'worker_output'
  | 'lint_complete'
  | 'reviewer_decision'
  | 'results_generated'
  | 'error';

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
}
