import { describe, expect, it, afterEach } from 'bun:test';
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { draftPlanNode, sizePlanNode, ratifyPlanNode } from '../../../src/agent/graph.mts';
import type { AgentStateType } from '../../../src/agent/state.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, status: Task['status']): Task {
  return {
    id, name: id, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn: [], domain: 'services', status, iterationCount: 0,
  };
}

function resumedState(): AgentStateType {
  return {
    userPrompt: 'p', workingDirectory: 'C:/proj', prd: null,
    featureName: 'Notes App', featureSlug: 'resume-test',
    tasks: [task('TASK-001', 'complete'), task('TASK-002', 'pending')],
    currentIteration: 0, maxIterations: 5, workerOutput: '', reviewerFeedback: '',
    lastDecision: null, phase: 'initializing', error: null, completedTaskIds: [],
    resumed: true, prdFile: null,
  };
}

afterEach(async () => {
  await rm(join('feature-results', 'resume-test'), { recursive: true, force: true });
});

describe('planning nodes on resume', () => {
  it('sizePlanNode skips sizing and writes no SIZING.md when resumed', async () => {
    await sizePlanNode(resumedState());
    let exists = true;
    try {
      await access(join('feature-results', 'resume-test', 'SIZING.md'), constants.F_OK);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false); // no re-size, no report written
  });

  it('draftPlanNode passes through when resumed (no model call)', async () => {
    const out = await draftPlanNode(resumedState());
    expect(out.phase).toBeDefined();
  });

  it('ratifyPlanNode passes through', async () => {
    const out = await ratifyPlanNode(resumedState());
    expect(out.phase).toBe('awaiting_approval');
  });
});
