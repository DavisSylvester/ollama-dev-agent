import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { saveRunState, findResumableRun, normalizeResumedTasks, RUN_STATE_VERSION } from '../src/agent/run-state.mts';
import type { Task } from '../src/types/index.mts';

function task(id: string, status: Task['status'], dependsOn: string[] = []): Task {
  return {
    id, name: id, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn, domain: 'services', status, iterationCount: 0,
  };
}

async function main(): Promise<void> {
  const slug = 'resume-smoke';
  await rm(join('feature-results', slug), { recursive: true, force: true });

  await saveRunState({
    version: RUN_STATE_VERSION,
    featureSlug: slug, featureName: 'Resume Smoke', userPrompt: 'resume smoke prompt',
    prdFile: null, workingDirectory: process.cwd(),
    createdAt: '', updatedAt: '', prd: null,
    tasks: [task('TASK-001', 'complete'), task('TASK-002', 'failed', ['TASK-001'])],
  });

  const found = await findResumableRun(process.cwd(), 'resume smoke prompt', null);
  if (!found) throw new Error('expected a resumable run');

  const normalized = normalizeResumedTasks(found.tasks);
  const remaining = normalized.filter((t) => t.status !== 'complete').map((t) => t.id);
  console.log('Resumable slug:', found.featureSlug);
  console.log('Remaining tasks:', remaining.join(', '));

  if (remaining.length !== 1 || remaining[0] !== 'TASK-002') {
    throw new Error(`expected only TASK-002 to remain, got: ${remaining.join(', ')}`);
  }

  await rm(join('feature-results', slug), { recursive: true, force: true });
  console.log('Resume smoke OK');
}

main().catch((err) => {
  console.error('Resume smoke FAILED:', err);
  process.exit(1);
});
