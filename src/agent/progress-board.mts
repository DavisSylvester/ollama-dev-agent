import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { TASK_DOMAINS } from '../types/index.mts';
import type { Task } from '../types/index.mts';

const GLYPH: Record<Task['status'], string> = {
  pending: '[ ]',
  in_progress: '[-]',
  complete: '[✓]',
  failed: '[X]',
};

function nowIso(): string {
  return DateTime.utc().toISO() ?? '';
}

export function stampStarted(task: Task): Task {
  return { ...task, status: 'in_progress', startedAt: nowIso() };
}

export function stampFinished(task: Task, status: 'complete' | 'failed'): Task {
  return { ...task, status, completedAt: nowIso() };
}

function row(t: Task): string {
  const times = [
    t.startedAt ? `started ${t.startedAt}` : '',
    t.completedAt ? `done ${t.completedAt}` : '',
  ]
    .filter((s) => s.length > 0)
    .join('  ');
  const suffix = times.length > 0 ? `  ${times}` : '';
  return `- ${GLYPH[t.status]} ${t.id}  ${t.name}${suffix}`;
}

// Pure renderer for feature-results/<slug>/PROGRESS.md: one section per domain
// (in TASK_DOMAINS order, empty domains omitted) plus a summary line.
export function buildProgressBoard(
  featureName: string,
  featureSlug: string,
  tasks: readonly Task[],
): string {
  const complete = tasks.filter((t) => t.status === 'complete').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;

  const sections = TASK_DOMAINS.map((domain) => {
    const inDomain = tasks.filter((t) => t.domain === domain);
    if (inDomain.length === 0) return '';
    return `## ${domain}\n\n${inDomain.map(row).join('\n')}`;
  }).filter((s) => s.length > 0);

  return `# Progress: ${featureName}

**Feature Slug**: ${featureSlug}
**Updated**: ${nowIso()}

✓ ${complete} / ${tasks.length} complete · ${inProgress} in-progress · ${failed} failed

${sections.join('\n\n')}
`;
}

export async function writeProgressBoard(
  featureName: string,
  featureSlug: string,
  tasks: readonly Task[],
): Promise<void> {
  const dir = join('feature-results', featureSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'PROGRESS.md'), buildProgressBoard(featureName, featureSlug, tasks), 'utf-8');
}
