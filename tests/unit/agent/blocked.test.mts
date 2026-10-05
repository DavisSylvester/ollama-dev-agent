import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { blockingRootCauses, resolveSplitDependencies, runTaskNode, setRalphLoopFactoryForTests } from '../../../src/agent/graph.mts';
import { env } from '../../../src/env.mts';
import { agentEvents } from '../../../src/agent/events.mts';
import { summarizeOutcomes } from '../../../src/ralph/loop.mts';
import type { AgentStateType } from '../../../src/agent/state.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, status: Task['status'], dependsOn: string[] = []): Task {
  return {
    id, name: `${id} name`, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn, domain: 'services', status, iterationCount: 0,
  };
}

describe('blockingRootCauses', () => {
  it('names the failed task at the root of a chain of pending tasks', () => {
    const tasks = [
      task('A', 'failed'),
      task('B', 'pending', ['A']),
      task('C', 'pending', ['B']),
      task('D', 'complete'),
      task('E', 'pending', ['D', 'C']),
    ];
    const roots = blockingRootCauses(tasks);
    expect(roots.get('B')).toEqual(['A']);
    expect(roots.get('C')).toEqual(['A']);
    expect(roots.get('E')).toEqual(['A']);
  });

  it('collects several roots and reports unknown or cyclic dependencies by id', () => {
    const tasks = [
      task('A', 'failed'),
      task('X', 'failed'),
      task('B', 'pending', ['A', 'X']),
      task('U', 'pending', ['MISSING']),
      task('P', 'pending', ['Q']),
      task('Q', 'pending', ['P']),
    ];
    const roots = blockingRootCauses(tasks);
    expect(roots.get('B')).toEqual(['A', 'X']);
    expect(roots.get('U')).toEqual(['MISSING']);
    expect(roots.get('P')).toEqual(['P']);
  });
});

describe('runTaskNode when nothing can run', () => {
  const SLUG = 'blocked-test';

  afterEach(async () => {
    await rm(join('feature-results', SLUG), { recursive: true, force: true });
  });

  it('marks unrunnable tasks blocked (not failed), with what blocks them', async () => {
    const events: Array<{ taskId: string; blockedBy: string[] }> = [];
    const onBlocked = (e: { payload: { taskId: string; blockedBy: string[] } }): void => {
      events.push(e.payload);
    };
    agentEvents.on('task_blocked', onBlocked);

    const state: AgentStateType = {
      userPrompt: 'p', workingDirectory: 'C:/proj', prd: null, featureName: 'F', featureSlug: SLUG,
      tasks: [task('A', 'failed'), task('B', 'pending', ['A']), task('C', 'pending', ['B'])],
      currentIteration: 0, maxIterations: 3, workerOutput: '', reviewerFeedback: '', lastDecision: null,
      phase: 'executing_tasks', error: null, completedTaskIds: [], resumed: false, prdFile: null, docsDir: null,
    };
    const out = await runTaskNode(state);
    agentEvents.off('task_blocked', onBlocked);

    const byId = new Map((out.tasks ?? []).map((t) => [t.id, t]));
    expect(byId.get('A')?.status).toBe('failed');
    expect(byId.get('B')).toMatchObject({ status: 'blocked', blockedBy: ['A'] });
    expect(byId.get('C')).toMatchObject({ status: 'blocked', blockedBy: ['A'] });
    expect(events.map((e) => e.taskId).sort()).toEqual(['B', 'C']);
  });
});

describe('summarizeOutcomes', () => {
  it('counts each kind of attempt result and quotes the last detail', () => {
    const reason = summarizeOutcomes([
      { kind: 'worker_error', detail: 'Worker encountered an unexpected error: Model call timed out after 180s' },
      { kind: 'revise', detail: 'missing tests' },
      { kind: 'worker_error', detail: 'Worker encountered an unexpected error: Model call timed out after 180s' },
    ]);
    expect(reason).toBe('3 attempts: 2× model call failed, 1× REVISE — last: Model call timed out after 180s');
  });

  it('handles no attempts', () => {
    expect(summarizeOutcomes([])).toBe('no attempts completed');
  });
});

describe('resolveSplitDependencies', () => {
  it('turns a dependency on a split parent into its children', () => {
    const tasks = [
      task('TASK-002-1', 'complete'), task('TASK-002-2', 'complete'),
      task('TASK-006-1', 'pending', ['TASK-002']),
    ];
    const resolved = resolveSplitDependencies(tasks);
    expect(resolved.find((t) => t.id === 'TASK-006-1')?.dependsOn.toSorted()).toEqual(['TASK-002-1', 'TASK-002-2']);
  });

  it('never makes a child depend on its own former parent or itself', () => {
    const tasks = [task('TASK-003-1', 'complete'), task('TASK-003-2', 'pending', ['TASK-003', 'TASK-003-1'])];
    expect(resolveSplitDependencies(tasks).find((t) => t.id === 'TASK-003-2')?.dependsOn).toEqual(['TASK-003-1']);
  });

  it('leaves valid and truly unknown dependencies alone', () => {
    const tasks = [task('A', 'complete'), task('B', 'pending', ['A', 'GHOST'])];
    expect(resolveSplitDependencies(tasks)[1]?.dependsOn).toEqual(['A', 'GHOST']);
  });

  it('lets a starved task run once its split parent is resolved', async () => {
    const state: AgentStateType = {
      userPrompt: 'p', workingDirectory: 'C:/proj', prd: null, featureName: 'F', featureSlug: 'resolve-test',
      tasks: [task('TASK-002-1', 'complete'), task('TASK-006-1', 'pending', ['TASK-002'])],
      currentIteration: 0, maxIterations: 3, workerOutput: '', reviewerFeedback: '', lastDecision: null,
      phase: 'executing_tasks', error: null, completedTaskIds: [], resumed: false, prdFile: null, docsDir: null,
    };
    setRalphLoopFactoryForTests(() => ({ runTask: async () => 'complete' }));
    const target = env as Record<string, unknown>;
    const savedDep = target['DEP_UPGRADE'];
    target['DEP_UPGRADE'] = false;
    try {
      const out = await runTaskNode(state);
      expect(out.tasks?.find((t) => t.id === 'TASK-006-1')?.status).toBe('complete');
    } finally {
      setRalphLoopFactoryForTests(null);
      target['DEP_UPGRADE'] = savedDep;
      await rm(join('feature-results', 'resolve-test'), { recursive: true, force: true });
    }
  });
});
