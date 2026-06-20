import { buildAgentGraph } from './graph.mts';
import { emitAgentEvent } from './events.mts';
import { loadPRDFromFile } from '../prd/index.mts';
import { env } from '../env.mts';
import type { AgentConfig } from '../types/index.mts';

export class DevAgent {

  constructor(private readonly config: AgentConfig) {}

  async run(prompt: string): Promise<void> {
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

    await graph.invoke(initialState);
  }
}

export { buildAgentGraph } from './graph.mts';
export {
  agentEvents,
  uiEvents,
  emitAgentEvent,
  waitForPRDApproval,
} from './events.mts';
