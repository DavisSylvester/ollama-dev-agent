import { Annotation } from '@langchain/langgraph';
import type { Task, ReviewDecision, PRD, AgentPhase } from '../types/index.mts';

export const AgentStateAnnotation = Annotation.Root({
  userPrompt: Annotation<string>(),
  workingDirectory: Annotation<string>(),
  prd: Annotation<PRD | null>({ default: () => null, reducer: (_, b) => b }),
  featureName: Annotation<string>({ default: () => '', reducer: (_, b) => b }),
  featureSlug: Annotation<string>({ default: () => '', reducer: (_, b) => b }),
  tasks: Annotation<Task[]>({ default: () => [], reducer: (_, b) => b }),
  currentIteration: Annotation<number>({ default: () => 0, reducer: (_, b) => b }),
  maxIterations: Annotation<number>({ default: () => 5, reducer: (_, b) => b }),
  workerOutput: Annotation<string>({ default: () => '', reducer: (_, b) => b }),
  reviewerFeedback: Annotation<string>({ default: () => '', reducer: (_, b) => b }),
  lastDecision: Annotation<ReviewDecision | null>({ default: () => null, reducer: (_, b) => b }),
  phase: Annotation<AgentPhase>({ default: () => 'initializing' as AgentPhase, reducer: (_, b) => b }),
  error: Annotation<string | null>({ default: () => null, reducer: (_, b) => b }),
  completedTaskIds: Annotation<string[]>({ default: () => [], reducer: (a, b) => [...new Set([...a, ...b])] }),
  resumed: Annotation<boolean>({ default: () => false, reducer: (_, b) => b }),
  prdFile: Annotation<string | null>({ default: () => null, reducer: (_, b) => b }),
});

export type AgentStateType = typeof AgentStateAnnotation.State;
