import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RalphLoop as RealRalphLoop } from '../../../src/ralph/loop.mts';
import { QuotaExceededError } from '../../../src/models/ollama-client.mts';
import { env } from '../../../src/env.mts';
import type { AgentStateType } from '../../../src/agent/state.mts';
import type { Task } from '../../../src/types/index.mts';

// What the stubbed RalphLoop.runTask does while a test in this file is active.
// `null` means "behave like the real loop", so other test files that run in the
// same process are unaffected by this module mock.
type Behaviour = (task: Task) => Promise<'complete' | 'failed'>;
const control: { behaviour: Behaviour | null } = { behaviour: null };

mock.module('../../../src/ralph/index.mts', () => {
  class StubRalphLoop extends RealRalphLoop {

    public override async runTask(...args: Parameters<RealRalphLoop['runTask']>): ReturnType<RealRalphLoop['runTask']> {
      if (control.behaviour) return control.behaviour(args[0]);
      return super.runTask(...args);
    }
  }
  return {
    RalphLoop: StubRalphLoop,
    runWorker: async (): Promise<string> => '',
    runReviewer: async (): Promise<never> => { throw new Error('not used'); },
    ContextManager: class {},
  };
});

const { runTaskNode, QuotaPauseExceededError, setQuotaSleepForTests, resetQuotaPauseForTests } = await import(
  '../../../src/agent/graph.mts'
);

const SLUG = 'quota-test';
const sleeps: number[] = [];
const savedPause = { pause: env.QUOTA_PAUSE_MINUTES, max: env.QUOTA_MAX_PAUSE_MINUTES };

function task(id: string, dependsOn: string[] = []): Task {
  return {
    id, name: id, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn, domain: 'services', status: 'pending', iterationCount: 0,
  };
}

function state(tasks: Task[]): AgentStateType {
  return {
    userPrompt: 'p', workingDirectory: 'C:/proj', prd: null,
    featureName: 'Quota', featureSlug: SLUG,
    tasks, currentIteration: 0, maxIterations: 3, workerOutput: '', reviewerFeedback: '',
    lastDecision: null, phase: 'executing_tasks', error: null, completedTaskIds: [],
    resumed: false, prdFile: null, docsDir: null,
  };
}

beforeEach(() => {
  sleeps.length = 0;
  resetQuotaPauseForTests();
  setQuotaSleepForTests(async (ms) => { sleeps.push(ms); });
  const target = env as Record<string, unknown>;
  target['QUOTA_PAUSE_MINUTES'] = 15;
  target['QUOTA_MAX_PAUSE_MINUTES'] = 360;
});

afterEach(async () => {
  control.behaviour = null;
  await rm(join('feature-results', SLUG), { recursive: true, force: true });
});

afterAll(() => {
  const target = env as Record<string, unknown>;
  target['QUOTA_PAUSE_MINUTES'] = savedPause.pause;
  target['QUOTA_MAX_PAUSE_MINUTES'] = savedPause.max;
  setQuotaSleepForTests((ms) => Bun.sleep(ms));
});

describe('runTaskNode — quota exhaustion', () => {
  it('puts the task back to pending and pauses instead of failing it', async () => {
    control.behaviour = async () => { throw new QuotaExceededError('You reached your Pro 5-hour limit'); };

    const out = await runTaskNode(state([task('TASK-001'), task('TASK-002', ['TASK-001'])]));

    const byId = new Map((out.tasks ?? []).map((t) => [t.id, t.status]));
    expect(byId.get('TASK-001')).toBe('pending');
    expect(byId.get('TASK-002')).toBe('pending'); // dependent is not failed either
    expect(sleeps).toEqual([15 * 60_000]);
  });

  it('does not pause when no task hit the quota', async () => {
    control.behaviour = async () => 'complete';
    const out = await runTaskNode(state([task('TASK-001')]));
    expect(out.tasks?.[0]?.status).toBe('complete');
    expect(sleeps).toEqual([]);
  });

  it('stops with a resumable error once the total pause exceeds the cap', async () => {
    (env as Record<string, unknown>)['QUOTA_MAX_PAUSE_MINUTES'] = 0;
    control.behaviour = async () => { throw new QuotaExceededError('429 Too Many Requests'); };

    await expect(runTaskNode(state([task('TASK-001')]))).rejects.toBeInstanceOf(QuotaPauseExceededError);
  });

  it('still fails a task that crashes for a non-quota reason', async () => {
    control.behaviour = async () => { throw new Error('disk full'); };
    const out = await runTaskNode(state([task('TASK-001')]));
    expect(out.tasks?.[0]?.status).toBe('failed');
    expect(out.tasks?.[0]?.completedAt).toBeDefined();
    expect(sleeps).toEqual([]);
  });
});
