import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMergeConflict } from '../../../src/agent/graph.mts';
import { ContextManager } from '../../../src/ralph/context-manager.mts';
import type { AgentStateType } from '../../../src/agent/state.mts';
import type { Task } from '../../../src/types/index.mts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oda-conflict-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function completedTask(conflicts?: number): Task {
  return {
    id: 'TASK-007',
    name: 'Add route',
    description: 'd',
    acceptanceCriteria: 'a',
    testCommand: 'bun test',
    dependsOn: [],
    domain: 'api',
    status: 'complete',
    iterationCount: 2,
    completedAt: '2026-10-05T00:00:00.000Z',
    ...(conflicts !== undefined ? { isolationConflicts: conflicts } : {}),
  };
}

function stateFor(workingDirectory: string): AgentStateType {
  return {
    userPrompt: 'p', workingDirectory, prd: null,
    featureName: 'Feat', featureSlug: 'feat',
    tasks: [], currentIteration: 0, maxIterations: 3, workerOutput: '', reviewerFeedback: '',
    lastDecision: null, phase: 'executing_tasks', error: null, completedTaskIds: [],
    resumed: false, prdFile: null, docsDir: null,
  };
}

describe('handleMergeConflict', () => {
  it('puts the task back to pending and clears its completion marker', async () => {
    const ctx = new ContextManager(dir, 'feat');
    await ctx.markTaskComplete('TASK-007');

    const rerun = await handleMergeConflict(completedTask(), 'patch does not apply', stateFor(dir));

    expect(rerun.status).toBe('pending');
    expect(rerun.isolationConflicts).toBe(1);
    expect(rerun.completedAt).toBeNull();
    // Otherwise the re-run would short-circuit as "already complete".
    expect(await ctx.isTaskComplete('TASK-007')).toBe(false);
  });

  it('fails the task once it has conflicted more than twice', async () => {
    const failed = await handleMergeConflict(completedTask(2), 'patch does not apply', stateFor(dir));

    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('conflicted with parallel tasks 3 times');
  });
});
