import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PRD } from '../types/index.mts';
import { createChatModel } from '../models/index.mts';
import { createPlannerTools } from '../tools/index.mts';
import { runReactAgent, REACT_TIMEOUT_SENTINEL } from '../models/react-agent.mts';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { buildPRDGenerationPrompt, buildDocsPRDSynthesisPrompt } from './prompts.mts';
import { extractFeatureName, extractFeatureSlug, parseTasks } from './parser.mts';
import { collectDocFiles } from './doc-ingest.mts';
import { summarizeDocs, reduceSummaries, type DocSummary, type SummarizeDeps } from './doc-summarizer.mts';

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

  return buildPRDFromMarkdown(rawMarkdown, workingDirectory);
}

// Parse a raw PRD markdown into the structured PRD object and persist it to
// .ai/planning/<featureSlug>/. Shared by generatePRD and generatePRDFromDocs.
export async function buildPRDFromMarkdown(rawMarkdown: string, workingDirectory: string): Promise<PRD> {
  const featureName = extractFeatureName(rawMarkdown);
  const featureSlug = extractFeatureSlug(rawMarkdown);
  const tasks = parseTasks(rawMarkdown);

  const overview = extractSection(rawMarkdown, 'Overview');
  const technicalApproach = extractSection(rawMarkdown, 'Technical Approach');
  const goals = extractBulletList(rawMarkdown, 'Goals');
  const acceptanceCriteria = extractBulletList(rawMarkdown, 'Acceptance Criteria');
  const outOfScope = extractBulletList(rawMarkdown, 'Out of Scope');

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

export interface PRDFromDocsDeps {
  collectFn?: (docsDir: string) => Promise<string[]>;
  summarizeFn?: (docsDir: string, files: readonly string[], deps?: SummarizeDeps) => Promise<DocSummary[]>;
  reduceFn?: (summaries: DocSummary[], deps?: SummarizeDeps) => Promise<DocSummary[]>;
  runAgentFn?: typeof runReactAgent;
}

// Ingest a docs directory -> per-file summaries -> a PRD grounded in them plus
// an optional directive. onEvent surfaces progress (docs_collected/doc_summarized).
export async function generatePRDFromDocs(
  docsDir: string,
  directive: string,
  workingDirectory: string,
  onEvent?: (type: string, payload: Record<string, unknown>) => void,
  deps?: PRDFromDocsDeps,
): Promise<PRD> {
  const collect = deps?.collectFn ?? collectDocFiles;
  const summarize = deps?.summarizeFn ?? summarizeDocs;
  const reduce = deps?.reduceFn ?? reduceSummaries;
  const runAgent = deps?.runAgentFn ?? runReactAgent;

  const files = await collect(docsDir);
  if (files.length === 0) {
    throw new Error(`No documentation files found under ${docsDir}`);
  }
  onEvent?.('docs_collected', { count: files.length });

  const cacheDir = join(workingDirectory, '.ai', 'planning', 'doc-summaries');
  const summaries = await summarize(docsDir, files, {
    cacheDir,
    onProgress: (done, total, relPath) => onEvent?.('doc_summarized', { relPath, done, total }),
  });
  const grounded = await reduce(summaries, {});

  const research = env.RESEARCH_PLANNING;
  const model = createChatModel(env.PLANNER_MODEL);
  const tools = research ? createPlannerTools(workingDirectory, env.BRAVE_API_KEY) : [];
  const systemPrompt = buildDocsPRDSynthesisPrompt(directive, grounded, research);
  const userPrompt =
    directive.trim().length > 0 ? directive : 'Generate the PRD grounded in the documentation summaries above.';

  const rawMarkdown = await runAgent(
    model,
    tools,
    systemPrompt,
    userPrompt,
    env.PLANNER_MAX_STEPS,
    (toolName, args) => onEvent?.('tool_called', { toolName, args, phase: 'generating_prd' }),
  );

  if (rawMarkdown.startsWith(REACT_TIMEOUT_SENTINEL)) {
    logger.error({ plannerMaxSteps: env.PLANNER_MAX_STEPS }, 'prd.docs_generation_timeout');
    throw new Error(
      `PRD generation from docs failed: the planner used all ${env.PLANNER_MAX_STEPS} steps without producing a PRD.`,
    );
  }

  return buildPRDFromMarkdown(rawMarkdown, workingDirectory);
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
