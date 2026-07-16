import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { TASK_DOMAINS } from '../types/index.mts';
import { agentEvents } from './events.mts';
import type { Task, TaskDomain } from '../types/index.mts';

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

interface AgentEventEnvelope {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Subscribe to the agent event stream and rewrite PROGRESS.md live on every
// task transition. Keeps its own task projection so it never reads graph state.
export function startProgressBoard(): { stop: () => void } {
  let featureName = '';
  let featureSlug = '';
  let tasks: Task[] = [];

  const flush = (): void => {
    if (featureSlug.length === 0) return;
    void writeProgressBoard(featureName, featureSlug, tasks).catch(() => {
      // best-effort — a board write must never disrupt the run
    });
  };

  const seed = (evt: AgentEventEnvelope): void => {
    const p = evt.payload;
    if (typeof p['featureName'] === 'string') featureName = p['featureName'];
    if (typeof p['featureSlug'] === 'string') featureSlug = p['featureSlug'];
    const list = (p['tasks'] as Task[] | undefined) ??
      ((p['prd'] as { tasks?: Task[] } | undefined)?.tasks);
    if (Array.isArray(list)) tasks = list.map((t) => ({ ...t }));
    flush();
  };

  const update = (id: string, patch: Partial<Task>): void => {
    tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
    flush();
  };

  const onStarted = (e: AgentEventEnvelope): void =>
    update(String(e.payload['taskId']), { status: 'in_progress', startedAt: (e.payload['startedAt'] as string) ?? null });
  const onComplete = (e: AgentEventEnvelope): void =>
    update(String(e.payload['taskId']), { status: 'complete', completedAt: (e.payload['completedAt'] as string) ?? null });
  const onFailed = (e: AgentEventEnvelope): void =>
    update(String(e.payload['taskId']), { status: 'failed', completedAt: (e.payload['completedAt'] as string) ?? null });
  const onSplit = (e: AgentEventEnvelope): void => {
    const parentId = String(e.payload['taskId']);
    const children = (e.payload['children'] as Array<{ id: string; name: string; domain: TaskDomain }>) ?? [];
    const idx = tasks.findIndex((t) => t.id === parentId);
    const childTasks: Task[] = children.map((c) => ({
      id: c.id, name: c.name, description: '', acceptanceCriteria: '', testCommand: '',
      dependsOn: [], domain: c.domain, status: 'pending', iterationCount: 0,
    }));
    if (idx >= 0) tasks = [...tasks.slice(0, idx), ...childTasks, ...tasks.slice(idx + 1)];
    else tasks = [...tasks, ...childTasks];
    flush();
  };

  agentEvents.on('prd_generated', seed);
  agentEvents.on('plan_sized', seed);
  agentEvents.on('run_resumed', seed);
  agentEvents.on('task_started', onStarted);
  agentEvents.on('task_complete', onComplete);
  agentEvents.on('task_failed', onFailed);
  agentEvents.on('task_split', onSplit);

  return {
    stop: (): void => {
      agentEvents.off('prd_generated', seed);
      agentEvents.off('plan_sized', seed);
      agentEvents.off('run_resumed', seed);
      agentEvents.off('task_started', onStarted);
      agentEvents.off('task_complete', onComplete);
      agentEvents.off('task_failed', onFailed);
      agentEvents.off('task_split', onSplit);
    },
  };
}
