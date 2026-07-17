import { describe, expect, it, afterEach } from 'bun:test';
import { computeSignals, applyDeterministicFloor, getModelSizes, sizePlan, SizeGateError, explainOversize, debateSplit } from '../../../src/prd/sizer.mts';
import { applyEnvOverrides } from '../../../src/env.mts';
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

  it('defers to the model for an already-split child even with many criteria', () => {
    // A well-scoped child can still have >4 acceptance-criteria sentences; the
    // floor must not force it back to L (that dead-ends at max split depth).
    const child = makeTask({
      splitDepth: 1,
      acceptanceCriteria: 'a. b. c. d. e. f.',
    });
    expect(applyDeterministicFloor(child, 'M')).toBe('M');
    expect(applyDeterministicFloor(child, 'S')).toBe('S');
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
  const cannedSplit = async () => ({
    children: [
      { ...makeTask({ id: 'TASK-001-1', domain: 'database', splitDepth: 1 }), size: 'M' as const },
      { ...makeTask({ id: 'TASK-001-2', domain: 'database', splitDepth: 1, dependsOn: ['TASK-001-1'] }), size: 'M' as const },
    ],
    recommendation: { taskId: 'TASK-001', taskName: 'x', reasons: ['big'], recommendation: 'Decided by consensus' },
  });

  it('splits an L task into sized children and leaves no L', async () => {
    const tasks = [makeTask({ id: 'TASK-001', domain: 'database' })];
    const result = await sizePlan(tasks, {
      sizeFn: async () => new Map([['TASK-001', 'L']]),
      debateFn: cannedSplit,
    });
    expect(result.tasks.some((t) => t.size === 'L')).toBe(false);
    expect(result.tasks.map((t) => t.id)).toEqual(['TASK-001-1', 'TASK-001-2']);
    expect(result.tasks.every((t) => t.size === 'S' || t.size === 'M')).toBe(true);
    expect(result.recommendations).toHaveLength(1);
  });

  it('allows an unsplittable L to stay L by default (no abort)', async () => {
    const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })]; // already at max depth
    const result = await sizePlan(tasks, { sizeFn: async () => new Map([['TASK-001', 'L']]) });
    expect(result.tasks[0]!.size).toBe('L');
    expect(result.oversized).toEqual(['TASK-001']);
  });

  it('emits sizing_started and a task_sized per task', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await sizePlan([makeTask({ id: 'TASK-001' }), makeTask({ id: 'TASK-002' })], {
      sizeFn: async () => new Map([['TASK-001', 'M'], ['TASK-002', 'S']]),
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    expect(events[0]?.type).toBe('sizing_started');
    expect(events[0]?.payload.taskCount).toBe(2);
    const sized = events.filter((e) => e.type === 'task_sized').map((e) => e.payload.taskId);
    expect(sized).toContain('TASK-001');
    expect(sized).toContain('TASK-002');
  });

  describe('strict gate (SIZE_ENFORCE_GATE=true)', () => {
    afterEach(() => applyEnvOverrides({ SIZE_ENFORCE_GATE: false }));

    it('hard-stops when an L cannot be split further', async () => {
      applyEnvOverrides({ SIZE_ENFORCE_GATE: true });
      const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })];
      await expect(
        sizePlan(tasks, { sizeFn: async () => new Map([['TASK-001', 'L']]) }),
      ).rejects.toBeInstanceOf(SizeGateError);
    });

    it('includes recommendations in the gate error for unsplittable L tasks', async () => {
      applyEnvOverrides({ SIZE_ENFORCE_GATE: true });
      const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })];
      try {
        await sizePlan(tasks, { sizeFn: async () => new Map([['TASK-001', 'L']]) });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SizeGateError);
        expect((err as SizeGateError).recommendations).toHaveLength(1);
      }
    });
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

describe('debateSplit', () => {
  it('builds sized-ready children and a recommendation from a successful debate', async () => {
    const parent = makeTask({ id: 'TASK-050', domain: 'database' });
    const out = await debateSplit(parent, {
      debateFn: async () => ({
        taskId: parent.id, taskName: parent.name, rounds: [], decidedBy: 'consensus' as const,
        transcript: 't',
        finalStories: [
          { name: 'schema', description: 'd', acceptanceCriteria: 'a' },
          { name: 'repo', description: 'd', acceptanceCriteria: 'b' },
        ],
      }),
    });
    expect(out.children.map((c) => c.id)).toEqual(['TASK-050-1', 'TASK-050-2']);
    expect(out.children.every((c) => c.domain === 'database')).toBe(true);
    expect(out.recommendation.taskId).toBe('TASK-050');
    expect(out.recommendation.recommendation.toLowerCase()).toContain('consensus');
  });

  it('retries once then falls back to the deterministic split on repeated debate failure', async () => {
    const parent = makeTask({ id: 'TASK-051', acceptanceCriteria: 'a\nb\nc\nd\ne\nf' });
    let calls = 0;
    const out = await debateSplit(parent, {
      debateFn: async () => { calls++; throw new Error('ollama down'); },
      splitFn: async () => [
        { ...makeTask({ id: 'TASK-051-1', splitDepth: 1 }), size: 'M' as const },
      ],
    });
    expect(calls).toBe(2); // initial + one retry
    expect(out.children.map((c) => c.id)).toEqual(['TASK-051-1']);
    expect(out.recommendation.recommendation.toLowerCase()).toContain('acceptance-criteria'); // deterministic text
  });
});
