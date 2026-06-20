import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PRD } from '../types/index.mts';
import { createChatModel } from '../models/index.mts';
import { env } from '../env.mts';
import { buildPRDGenerationPrompt } from './prompts.mts';
import { extractFeatureName, extractFeatureSlug, parseTasks } from './parser.mts';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export async function generatePRD(
  userPrompt: string,
  workingDirectory: string,
): Promise<PRD> {
  const model = createChatModel(env.PLANNER_MODEL);

  const systemPrompt = buildPRDGenerationPrompt(userPrompt);

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  const rawMarkdown =
    typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((block) => {
              if (typeof block === 'string') return block;
              if (
                typeof block === 'object' &&
                block !== null &&
                'text' in block &&
                typeof (block as { text: unknown }).text === 'string'
              ) {
                return (block as { text: string }).text;
              }
              return '';
            })
            .join('')
        : String(response.content);

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
