import { describe, expect, it } from 'bun:test';
import { computeSignals, applyDeterministicFloor } from '../../../src/prd/sizer.mts';
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
