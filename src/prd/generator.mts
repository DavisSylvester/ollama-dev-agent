import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PRD } from '../types/index.mts';
import { createChatModel } from '../models/index.mts';
import { createPlannerTools } from '../tools/index.mts';
import { runReactAgent, REACT_TIMEOUT_SENTINEL } from '../models/react-agent.mts';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { buildPRDGenerationPrompt } from './prompts.mts';
import { extractFeatureName, extractFeatureSlug, parseTasks } from './parser.mts';

// Injected agent runner — lets tests drive PRD generation without a live model.
export interface PRDGeneratorDeps {
  readonly runAgentFn?: typeof runReactAgent;
}

export async function generatePRD(
  userPrompt: string,
  workingDirectory: string,
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void,
  deps?: PRDGeneratorDeps,
): Promise<PRD> {
  const runAgent = deps?.runAgentFn ?? runReactAgent;
  const research = env.RESEARCH_PLANNING;
  const model = createChatModel(env.PLANNER_MODEL);
  // Research mode gives the planner read-only tools; otherwise a tool-less
  // single-shot call (the ReAct loop returns on the first tool-less answer).
  const tools = research ? createPlannerTools(workingDirectory, env.BRAVE_API_KEY) : [];

  const systemPrompt = buildPRDGenerationPrompt(userPrompt, research);

  const rawMarkdown = await runAgent(
    model,
    tools,
    systemPrompt,
    userPrompt,
    env.PLANNER_MAX_STEPS,
    onToolCall,
  );

  // If the planner exhausted its research budget without producing a final PRD,
  // fail loudly rather than handing the parser a sentinel string to mangle.
  if (rawMarkdown.startsWith(REACT_TIMEOUT_SENTINEL)) {
    logger.error(
      { plannerMaxSteps: env.PLANNER_MAX_STEPS },
      'prd.generation_timeout: planner exhausted its step budget without producing a PRD',
    );
    throw new Error(
      `PRD generation failed: the planner used all ${env.PLANNER_MAX_STEPS} research steps ` +
      `without producing a final PRD. Try a more specific prompt or raise PLANNER_MAX_STEPS.`,
    );
  }

  const featureName = extractFeatureName(rawMarkdown);
  const featureSlug = extractFeatureSlug(rawMarkdown);
  const tasks = parseTasks(rawMarkdown);

  // Parse optional PRD sections for the structured object
  const overview = extractSection(rawMarkdown, 'Overview');
  const technicalApproach = extractSection(rawMarkdown, 'Technical Approach');
  const goals = extractBulletList(rawMarkdown, 'Goals');
  const acceptanceCriteria = extractBulletList(rawMarkdown, 'Acceptance Criteria');
  const outOfScope = extractBulletList(rawMarkdown, 'Out of Scope');

  // Persist to .ai/planning/<featureSlug>/
  const planningDir = join(workingDirectory, '.ai', 'planning', featureSlug);
  await mkdir(planningDir, { recursive: true });

  await writeFile(join(planningDir, 'prd.md'), rawMarkdown, 'utf-8');

  const taskMarkdown = tasks
    .map(
      (t) =>
        `## ${t.id}: ${t.name}\n\n` +
        `**Status**: ${t.status}\n` +
        `**Description**: ${t.description}\n` +
        `**Acceptance**: ${t.acceptanceCriteria}\n` +
        `**Test Command**: \`${t.testCommand}\`\n`,
    )
    .join('\n---\n\n');

  await writeFile(join(planningDir, 'tasks.md'), taskMarkdown, 'utf-8');

  return {
    featureName,
    featureSlug,
    overview,
    goals,
    technicalApproach,
    tasks,
    acceptanceCriteria,
    outOfScope,
    rawMarkdown,
  };
}

export async function loadPRDFromFile(filePath: string): Promise<PRD> {
  const rawMarkdown = await readFile(resolve(filePath), 'utf-8');

  const featureName = extractFeatureName(rawMarkdown);
  const featureSlug = extractFeatureSlug(rawMarkdown);
  const tasks = parseTasks(rawMarkdown);
  const overview = extractSection(rawMarkdown, 'Overview');
  const technicalApproach = extractSection(rawMarkdown, 'Technical Approach');
  const goals = extractBulletList(rawMarkdown, 'Goals');
  const acceptanceCriteria = extractBulletList(rawMarkdown, 'Acceptance Criteria');
  const outOfScope = extractBulletList(rawMarkdown, 'Out of Scope');

  return {
    featureName,
    featureSlug,
    overview,
    goals,
    technicalApproach,
    tasks,
    acceptanceCriteria,
    outOfScope,
    rawMarkdown,
  };
}

// --- helpers ---

function extractSection(markdown: string, heading: string): string {
  const pattern = new RegExp(
    `## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? '';
}

function extractBulletList(markdown: string, heading: string): readonly string[] {
  const section = extractSection(markdown, heading);
  return section
    .split('\n')
    .map((line) => line.replace(/^-\s*(\[[ x]\]\s*)?/, '').trim())
    .filter((line) => line.length > 0);
}
