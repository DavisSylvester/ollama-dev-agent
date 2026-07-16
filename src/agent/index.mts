import { buildAgentGraph } from './graph.mts';
import { emitAgentEvent } from './events.mts';
import { loadPRDFromFile } from '../prd/index.mts';
import { assertOllamaReachable } from '../models/index.mts';
import { env } from '../env.mts';
import type { AgentConfig } from '../types/index.mts';

export class DevAgent {

  constructor(private readonly config: AgentConfig) {}

  async run(prompt: string): Promise<void> {
    // Fail fast on a dead endpoint instead of burning the iteration budget on
    // failed model calls (every worker/reviewer call would otherwise be caught
    // and silently turned into a REVISE).
    await assertOllamaReachable();

    const graph = buildAgentGraph();
    const initialState: Record<string, unknown> = {
      userPrompt: prompt,
      workingDirectory: this.config.workingDirectory,
      maxIterations: this.config.maxIterations ?? env.MAX_ITERATIONS,
    };

    if (this.config.prdFile) {
      const prd = await loadPRDFromFile(this.config.prdFile);
      initialState['prd'] = prd;
      initialState['featureName'] = prd.featureName;
      initialState['featureSlug'] = prd.featureSlug;
      initialState['tasks'] = prd.tasks;
      emitAgentEvent('prd_generated', {
        prd,
        featureName: prd.featureName,
        featureSlug: prd.featureSlug,
        taskCount: prd.tasks.length,
        prdMarkdown: prd.rawMarkdown,
      });
    }

    // LangGraph defaults recursionLimit to 25 supersteps, which a real
    // multi-task run blows past (the run_task node loops once per ready batch).
    // Scale the budget to the task count with a generous floor; for generated
    // PRDs the task list isn't known yet at this point, so the floor governs.
    const taskCount = Array.isArray(initialState['tasks'])
      ? (initialState['tasks'] as unknown[]).length
      : 0;
    const recursionLimit = Math.max(100, taskCount * 6 + 20);

    await graph.invoke(initialState, { recursionLimit });
  }
}

export { buildAgentGraph } from './graph.mts';
export {
  agentEvents,
  uiEvents,
  emitAgentEvent,
  waitForPRDApproval,
} from './events.mts';
