import { describe, expect, it } from 'bun:test';
import { computeSignals, applyDeterministicFloor, getModelSizes, sizePlan, SizeGateError } from '../../../src/prd/sizer.mts';
import type { Task } from '../../../src/types/index.mts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-001',
    name: 'sample',
    description: 'do a thing',
    acceptanceCriteria: 'it works',
    testCommand: 'bun test',
    dependsOn: [],
    domain: 'services',
    status: 'pending',
    iterationCount: 0,
    ...overrides,
  };
}

describe('computeSignals', () => {
  it('counts acceptance-criteria clauses split on newline and semicolon', () => {
    const task = makeTask({ acceptanceCriteria: 'a; b\nc; d; e' });
    expect(computeSignals(task).criteriaCount).toBe(5);
  });

  it('detects more than one domain mentioned in the text', () => {
    const task = makeTask({
      description: 'add an Elysia endpoint and an Angular component',
    });
    expect(computeSignals(task).domainMentions).toBeGreaterThan(1);
  });

  it('counts concerns via "and" / commas in the description', () => {
    const task = makeTask({ description: 'scaffold, wire, validate and test' });
    expect(computeSignals(task).concernCount).toBeGreaterThanOrEqual(3);
  });
});

describe('applyDeterministicFloor', () => {
  it('keeps the model size when no signal is exceeded', () => {
    expect(applyDeterministicFloor(makeTask(), 'S')).toBe('S');
  });

  it('force-promotes to L when criteria count exceeds the threshold', () => {
    const task = makeTask({ acceptanceCriteria: 'a\nb\nc\nd\ne' });
    expect(applyDeterministicFloor(task, 'S')).toBe('L');
  });

  it('force-promotes to L when more than one domain is present', () => {
    const task = makeTask({
      description: 'build an Angular component and a Mongo repository',
    });
    expect(applyDeterministicFloor(task, 'M')).toBe('L');
  });
});

describe('getModelSizes', () => {
  it('parses TASK-ID: SIZE lines from the model output', async () => {
    const tasks = [
      makeTask({ id: 'TASK-001' }),
      makeTask({ id: 'TASK-002' }),
    ];
    const sizes = await getModelSizes(tasks, {
      invokeFn: async () => 'TASK-001: S\nTASK-002: M',
    });
    expect(sizes.get('TASK-001')).toBe('S');
    expect(sizes.get('TASK-002')).toBe('M');
  });

  it('defaults an unparseable/absent task to M', async () => {
    const tasks = [makeTask({ id: 'TASK-001' })];
    const sizes = await getModelSizes(tasks, { invokeFn: async () => 'garbage' });
    expect(sizes.get('TASK-001')).toBe('M');
  });
});

describe('sizePlan', () => {
  it('splits an L task into sized children and leaves no L', async () => {
    const tasks = [makeTask({ id: 'TASK-001', domain: 'database' })];
    const result = await sizePlan(tasks, {
      sizeFn: async () => new Map([['TASK-001', 'L']]),
      splitFn: async () => [
        { ...makeTask({ id: 'TASK-001-1', domain: 'database', splitDepth: 1 }), size: 'M' as const },
        { ...makeTask({ id: 'TASK-001-2', domain: 'database', splitDepth: 1, dependsOn: ['TASK-001-1'] }), size: 'M' as const },
      ],
    });
    expect(result.tasks.some((t) => t.size === 'L')).toBe(false);
    expect(result.tasks.map((t) => t.id)).toEqual(['TASK-001-1', 'TASK-001-2']);
    expect(result.tasks.every((t) => t.size === 'S' || t.size === 'M')).toBe(true);
  });

  it('hard-stops when an L cannot be split further', async () => {
    const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })]; // already at max depth
    await expect(
      sizePlan(tasks, { sizeFn: async () => new Map([['TASK-001', 'L']]) }),
    ).rejects.toBeInstanceOf(SizeGateError);
  });
});
