import { describe, it, expect } from 'bun:test';
import { splitTask, applySplit, canSplit, canSplitForSize, MAX_SPLIT_DEPTH } from '../../../src/prd/splitter.mts';
import type { Task } from '../../../src/types/index.mts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-009',
    name: 'Scaffold Elysia API',
    description: 'app + health + ready + onError + typebox',
    acceptanceCriteria: 'server boots; /health 200; validation works',
    testCommand: 'bun test',
    dependsOn: [],
    domain: 'api',
    status: 'failed',
    iterationCount: 4,
    ...overrides,
  };
}

const SUBTASK_MARKDOWN = `
- [ ] **TASK-1**: App entrypoint + /health + /ready
  - **Description**: Create the Elysia app and liveness/readiness routes
  - **Acceptance**: /health and /ready return 200
  - **Test Command**: \`bun test apps/api/health.test.mts\`

- [ ] **TASK-2**: Centralized onError hook
  - **Description**: Add onError and the error envelope
  - **Acceptance**: errors return ApiResponse shape
  - **Test Command**: \`bun test apps/api/error.test.mts\`
`;

describe('canSplit', () => {
  it('allows splitting an original failed task', () => {
    expect(canSplit(makeTask({ splitDepth: 0 }))).toBe(true);
    expect(canSplit(makeTask())).toBe(true); // undefined depth = 0
  });

  it('refuses splitting a task already at max depth', () => {
    expect(canSplit(makeTask({ splitDepth: MAX_SPLIT_DEPTH }))).toBe(false);
  });
});

describe('splitTask', () => {
  it('decomposes a failed task into re-IDed sub-tasks', async () => {
    const subs = await splitTask(makeTask(), 'timed out 4x', {
      invokeFn: async () => SUBTASK_MARKDOWN,
    });

    expect(subs).toHaveLength(2);
    expect(subs[0]!.id).toBe('TASK-009-1');
    expect(subs[1]!.id).toBe('TASK-009-2');
    expect(subs[0]!.name).toContain('App entrypoint');
    // foundation-first: sub-1 inherits parent deps, sub-2 depends on sub-1
    expect(subs[0]!.dependsOn).toEqual([]);
    expect(subs[1]!.dependsOn).toEqual(['TASK-009-1']);
    expect(subs.every((s) => s.splitDepth === 1)).toBe(true);
    expect(subs.every((s) => s.status === 'pending')).toBe(true);
  });

  it('first sub-task inherits the parent external dependencies', async () => {
    const subs = await splitTask(makeTask({ dependsOn: ['TASK-002'] }), '', {
      invokeFn: async () => SUBTASK_MARKDOWN,
    });
    expect(subs[0]!.dependsOn).toEqual(['TASK-002']);
    expect(subs[1]!.dependsOn).toEqual(['TASK-009-1']);
  });

  it('returns [] when decomposition yields no tasks', async () => {
    const subs = await splitTask(makeTask(), '', { invokeFn: async () => 'no tasks here' });
    expect(subs).toEqual([]);
  });
});

function parent(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-003',
    name: 'big task',
    description: 'lots of work',
    acceptanceCriteria: 'many things',
    testCommand: 'bun test',
    dependsOn: [],
    domain: 'database',
    status: 'pending',
    iterationCount: 0,
    ...overrides,
  };
}

describe('splitTask — domain inheritance', () => {
  it('gives every child the parent domain', async () => {
    const children = await splitTask(parent(), '', {
      invokeFn: async () =>
        [
          '- [ ] **TASK-1**: schema',
          '  - **Description**: define schema',
          '  - **Acceptance**: schema exists',
          '  - **Test Command**: `bun test`',
          '- [ ] **TASK-2**: repo',
          '  - **Description**: build repo',
          '  - **Acceptance**: repo works',
          '  - **Test Command**: `bun test`',
        ].join('\n'),
    });
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.domain === 'database')).toBe(true);
    expect(children.every((c) => c.size === undefined)).toBe(true);
  });
});

describe('canSplitForSize', () => {
  it('allows splitting an original task', () => {
    expect(canSplitForSize(parent())).toBe(true);
  });
  it('refuses once split depth is reached', () => {
    expect(canSplitForSize(parent({ splitDepth: 1 }))).toBe(false);
  });
});

describe('applySplit', () => {
  it('replaces the parent with sub-tasks and re-points dependents', () => {
    const tasks: Task[] = [
      makeTask({ id: 'TASK-009', status: 'failed', dependsOn: [] }),
      makeTask({ id: 'TASK-010', status: 'pending', dependsOn: ['TASK-009'], name: 'endpoints' }),
    ];
    const subs: Task[] = [
      makeTask({ id: 'TASK-009-1', status: 'pending', dependsOn: [] }),
      makeTask({ id: 'TASK-009-2', status: 'pending', dependsOn: ['TASK-009-1'] }),
    ];

    const out = applySplit(tasks, 'TASK-009', subs);

    expect(out.map((t) => t.id)).toEqual(['TASK-009-1', 'TASK-009-2', 'TASK-010']);
    // TASK-010 now depends on ALL sub-tasks instead of the parent
    const t010 = out.find((t) => t.id === 'TASK-010')!;
    expect(t010.dependsOn).toEqual(['TASK-009-1', 'TASK-009-2']);
  });

  it('is a no-op when there are no sub-tasks', () => {
    const tasks = [makeTask()];
    expect(applySplit(tasks, 'TASK-009', [])).toBe(tasks);
  });
});
