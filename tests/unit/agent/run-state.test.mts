import { describe, expect, it, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { saveRunState, loadRunState, RUN_STATE_VERSION, type RunState } from '../../../src/agent/run-state.mts';
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
