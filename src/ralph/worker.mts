import type { StructuredTool } from '@langchain/core/tools';
import type { Task } from '../types/index.mts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createChatModel, resolveCoderModel } from '../models/index.mts';
import { runReactAgent } from '../models/index.mts';
import { buildWorkerPrompt } from '../prd/index.mts';
import { loadKnowledgeBase, categorizeTask, formatForPrompt } from '../knowledge-base/index.mts';
import { env } from '../env.mts';

const LISTING_IGNORE = new Set(['.ai', 'node_modules', '.git', 'dist', '.cache', 'coverage']);

async function readAvailablePackages(workingDirectory: string): Promise<string> {
  try {
    const pkgPath = join(workingDirectory, 'package.json');
    const raw = await Bun.file(pkgPath).text();
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    const lines: string[] = [];
    if (deps.length > 0) lines.push(`dependencies:    ${deps.join(', ')}`);
    if (devDeps.length > 0) lines.push(`devDependencies: ${devDeps.join(', ')}`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function buildDirectoryListing(dir: string, depth: number = 3, indent: string = ''): Promise<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const lines: string[] = [];
    for (const entry of entries) {
      if (LISTING_IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      lines.push(`${indent}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory() && depth > 1) {
        const sub = await buildDirectoryListing(join(dir, entry.name), depth - 1, indent + '  ');
        if (sub) lines.push(sub);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

interface WorkerParams {
  readonly task: Task;
  readonly featureName: string;
  readonly featureSlug: string;
  readonly workingDirectory: string;
  readonly iteration: number;
  readonly reviewerFeedback: string;
  readonly activityLog: string;
  readonly tools: StructuredTool[];
  readonly onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  readonly onOutput?: (chunk: string) => void;
}

export async function runWorker(params: WorkerParams): Promise<string> {
  const {
    task,
    featureName,
    workingDirectory,
    iteration,
    reviewerFeedback,
    activityLog,
    tools,
    onToolCall,
  } = params;

  const [directoryListing, availablePackages, kb] = await Promise.all([
    buildDirectoryListing(workingDirectory),
    readAvailablePackages(workingDirectory),
    loadKnowledgeBase(),
  ]);

  // Feed prior known issues + resolutions (most relevant category first) so the
  // worker can avoid repeating errors we have already solved.
  const knowledgeBase = formatForPrompt(kb, categorizeTask(task));

  const systemPrompt = buildWorkerPrompt(
    task,
    iteration,
    reviewerFeedback,
    featureName,
    workingDirectory,
    activityLog,
    directoryListing,
    availablePackages,
    knowledgeBase,
  );

  const userPrompt =
    `Implement ${task.id}: ${task.name}\n\n` +
    `Working directory: ${workingDirectory}\n` +
    `Test command to pass: ${task.testCommand}`;

  const coderModel = await resolveCoderModel();
  const model = createChatModel(coderModel);

  return runReactAgent(
    model,
    tools,
    systemPrompt,
    userPrompt,
    env.MAX_REACT_STEPS,
    onToolCall,
  );
}
