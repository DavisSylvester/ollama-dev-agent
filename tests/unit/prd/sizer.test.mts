import { describe, expect, it } from 'bun:test';
import { computeSignals, applyDeterministicFloor, getModelSizes, sizePlan, SizeGateError, explainOversize, recommendSplitApproach } from '../../../src/prd/sizer.mts';
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

  it('detects distinct domains via distinctive keywords', () => {
    const task = makeTask({
      description: 'add an Elysia route handler and an Angular standalone component',
    });
    expect(computeSignals(task).domainMentions).toBeGreaterThan(1);
  });

  it('does not treat generic prose words as domain mentions', () => {
    // "service", "schema", "route", "test" are ordinary words, not distinctive
    // domain tokens — they must not inflate the multi-domain signal.
    const task = makeTask({
      description: 'write a service that validates the schema and routes the test',
    });
    expect(computeSignals(task).domainMentions).toBe(0);
  });
});

describe('applyDeterministicFloor', () => {
  it('keeps the model size when no signal is exceeded', () => {
    expect(applyDeterministicFloor(makeTask(), 'S')).toBe('S');
  });

  it('keeps the model size for an ordinary single-domain task', () => {
    const task = makeTask({
      description: 'implement the Elysia route handler for creating a card',
      acceptanceCriteria: 'returns 201 on success. validates the body.',
    });
    expect(applyDeterministicFloor(task, 'M')).toBe('M');
  });

  it('force-promotes to L when criteria count exceeds the threshold', () => {
    const task = makeTask({ acceptanceCriteria: 'a\nb\nc\nd\ne' });
    expect(applyDeterministicFloor(task, 'S')).toBe('L');
  });

  it('force-promotes to L when three or more distinct domains are present', () => {
    const task = makeTask({
      description:
        'build an Angular standalone component backed by a Mongo repository port and an Elysia route handler',
    });
    expect(applyDeterministicFloor(task, 'M')).toBe('L');
  });

  it('does NOT promote a two-domain task (below the multi-domain threshold)', () => {
    const task = makeTask({
      description: 'call the Elysia route handler from an Angular standalone component',
    });
    expect(applyDeterministicFloor(task, 'S')).toBe('S');
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
      recommendFn: async (t) => ({ taskId: t.id, taskName: t.name, reasons: ['big'], recommendation: 'split it' }),
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
      sizePlan(tasks, {
        sizeFn: async () => new Map([['TASK-001', 'L']]),
        recommendFn: async (t) => ({ taskId: t.id, taskName: t.name, reasons: ['big'], recommendation: 'split it' }),
      }),
    ).rejects.toBeInstanceOf(SizeGateError);
  });

  it('collects a recommendation for each L task', async () => {
    const tasks = [makeTask({ id: 'TASK-001', domain: 'database' })];
    const result = await sizePlan(tasks, {
      sizeFn: async () => new Map([['TASK-001', 'L']]),
      recommendFn: async (t) => ({ taskId: t.id, taskName: t.name, reasons: ['big'], recommendation: 'split it' }),
      splitFn: async () => [
        { ...makeTask({ id: 'TASK-001-1', domain: 'database', splitDepth: 1 }), size: 'M' as const },
        { ...makeTask({ id: 'TASK-001-2', domain: 'database', splitDepth: 1, dependsOn: ['TASK-001-1'] }), size: 'M' as const },
      ],
    });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.taskId).toBe('TASK-001');
  });

  it('includes recommendations in the gate error for unsplittable L tasks', async () => {
    const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })];
    try {
      await sizePlan(tasks, {
        sizeFn: async () => new Map([['TASK-001', 'L']]),
        recommendFn: async (t) => ({ taskId: t.id, taskName: t.name, reasons: ['big'], recommendation: 'split it' }),
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SizeGateError);
      expect((err as SizeGateError).recommendations).toHaveLength(1);
    }
  });
});

describe('explainOversize', () => {
  it('recommends single-domain separation for a multi-domain task', () => {
    const task = makeTask({
      description:
        'build an Angular standalone component backed by a Mongo repository port and an Elysia route handler',
    });
    const { reasons, recommendation } = explainOversize(task);
    expect(reasons.join(' ')).toContain('domains');
    expect(recommendation.toLowerCase()).toContain('per functional area');
  });

  it('recommends criteria grouping when there are too many criteria', () => {
    const task = makeTask({ acceptanceCriteria: 'a\nb\nc\nd\ne\nf' });
    const { recommendation } = explainOversize(task);
    expect(recommendation.toLowerCase()).toContain('acceptance-criteria');
  });

  it('falls back to module+test guidance when no hard signal fired', () => {
    const { reasons, recommendation } = explainOversize(makeTask());
    expect(reasons.join(' ').toLowerCase()).toContain('model');
    expect(recommendation.toLowerCase()).toContain('module');
  });
});

describe('recommendSplitApproach', () => {
  it('uses the model text when the model succeeds', async () => {
    const rec = await recommendSplitApproach(makeTask({ id: 'TASK-9' }), {
      invokeFn: async () => 'Break it into: (1) schema, (2) repository, (3) service.',
    });
    expect(rec.taskId).toBe('TASK-9');
    expect(rec.recommendation).toContain('schema');
    expect(rec.reasons.length).toBeGreaterThan(0);
  });

  it('falls back to the deterministic recommendation on model error', async () => {
    const rec = await recommendSplitApproach(
      makeTask({ acceptanceCriteria: 'a\nb\nc\nd\ne\nf' }),
      { invokeFn: async () => { throw new Error('ollama down'); } },
    );
    expect(rec.recommendation.toLowerCase()).toContain('acceptance-criteria');
  });
});
