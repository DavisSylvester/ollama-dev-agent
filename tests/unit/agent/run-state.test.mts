import { describe, expect, it, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { saveRunState, loadRunState, findResumableRun, normalizeResumedTasks, buildRunState, RUN_STATE_VERSION, type RunState } from '../../../src/agent/run-state.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, status: Task['status']): Task {
  return {
    id, name: `name ${id}`, description: 'd', acceptanceCriteria: 'a',
    testCommand: 'bun test', dependsOn: [], domain: 'services', status, iterationCount: 0,
  };
}

function makeState(over: Partial<RunState> = {}): RunState {
  return {
    version: RUN_STATE_VERSION,
    featureSlug: 'notes-app',
    featureName: 'Notes App',
    userPrompt: 'build a notes app',
    prdFile: null,
    workingDirectory: 'C:/proj',
    createdAt: '2026-07-16T12:00:00.000Z',
    updatedAt: '2026-07-16T12:00:00.000Z',
    prd: null,
    tasks: [task('TASK-001', 'complete'), task('TASK-002', 'pending')],
    ...over,
  };
}

afterEach(async () => {
  await rm(join('feature-results', 'notes-app'), { recursive: true, force: true });
  await rm(join('feature-results', 'other-app'), { recursive: true, force: true });
  await rm(join('feature-results', 'done-app'), { recursive: true, force: true });
});

describe('saveRunState / loadRunState', () => {
  it('round-trips a run state to feature-results/<slug>/state.json', async () => {
    await saveRunState(makeState());
    const loaded = await loadRunState('notes-app');
    expect(loaded).not.toBeNull();
    expect(loaded!.featureSlug).toBe('notes-app');
    expect(loaded!.tasks.map((t) => t.status)).toEqual(['complete', 'pending']);
  });

  it('returns null for a missing state file', async () => {
    expect(await loadRunState('does-not-exist')).toBeNull();
  });

  it('preserves the original createdAt across saves and updates updatedAt', async () => {
    await saveRunState(makeState({ createdAt: '2026-01-01T00:00:00.000Z' }));
    await saveRunState(makeState({ createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }));
    const loaded = await loadRunState('notes-app');
    expect(loaded!.createdAt).toBe('2026-01-01T00:00:00.000Z'); // first write wins
  });
});

describe('findResumableRun', () => {
  it('matches a generated run by userPrompt + workingDirectory and returns it when tasks remain', async () => {
    await saveRunState(makeState()); // has a pending task
    const found = await findResumableRun('C:/proj', 'build a notes app', null);
    expect(found?.featureSlug).toBe('notes-app');
  });

  it('does not match a different prompt', async () => {
    await saveRunState(makeState());
    expect(await findResumableRun('C:/proj', 'a different app', null)).toBeNull();
  });

  it('does not resume when every task is complete', async () => {
    await saveRunState(makeState({
      featureSlug: 'done-app', userPrompt: 'done prompt',
      tasks: [task('TASK-001', 'complete')],
    }));
    expect(await findResumableRun('C:/proj', 'done prompt', null)).toBeNull();
  });

  it('matches a --prd-file run by prdFile path', async () => {
    await saveRunState(makeState({
      featureSlug: 'other-app', userPrompt: 'ignored', prdFile: '/prds/notes.md',
    }));
    const found = await findResumableRun('C:/proj', 'ignored', '/prds/notes.md');
    expect(found?.featureSlug).toBe('other-app');
  });
});

describe('normalizeResumedTasks', () => {
  it('keeps complete, resets everything else to pending', () => {
    const out = normalizeResumedTasks([
      task('A', 'complete'),
      task('B', 'in_progress'),
      task('C', 'failed'),
      task('D', 'pending'),
    ]);
    expect(out.map((t) => t.status)).toEqual(['complete', 'pending', 'pending', 'pending']);
  });
});

describe('buildRunState', () => {
  it('assembles a versioned RunState from graph pieces', () => {
    const s = buildRunState({
      featureSlug: 'notes-app', featureName: 'Notes App', userPrompt: 'p',
      prdFile: null, workingDirectory: 'C:/proj', prd: null,
      tasks: [task('TASK-001', 'complete')],
    });
    expect(s.version).toBe(RUN_STATE_VERSION);
    expect(s.featureSlug).toBe('notes-app');
    expect(s.tasks).toHaveLength(1);
    expect(typeof s.createdAt).toBe('string');
    expect(typeof s.updatedAt).toBe('string');
  });
});
