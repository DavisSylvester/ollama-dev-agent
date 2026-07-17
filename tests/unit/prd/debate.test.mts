import { describe, expect, it } from 'bun:test';
import { DEBATE_PERSONAS, personaModel, parseStories, parseStance, runDebate, DebateError, type DebateDeps } from '../../../src/prd/debate.mts';
import type { Task } from '../../../src/types/index.mts';

describe('personaModel', () => {
  it('maps SA and SME to the planner model, Scrum and Dev to the coder model (defaults)', () => {
    expect(personaModel('solution_architect')).toBe(personaModel('sme'));
    expect(personaModel('scrum_master')).toBe(personaModel('developer'));
    expect(personaModel('solution_architect')).not.toBe(personaModel('developer'));
  });
  it('exposes the four personas', () => {
    expect([...DEBATE_PERSONAS]).toEqual(['scrum_master', 'solution_architect', 'sme', 'developer']);
  });
});

describe('parseStories', () => {
  it('parses a fenced JSON array of stories', () => {
    const raw = '```json\n[{"name":"schema","description":"d","acceptanceCriteria":"a"}]\n```';
    const stories = parseStories(raw);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.name).toBe('schema');
  });
  it('returns [] for unparseable output', () => {
    expect(parseStories('no json here')).toEqual([]);
  });
});

describe('parseStance', () => {
  it('parses a verdict and comments', () => {
    const s = parseStance('developer', '{"verdict":"agree","comments":"looks fine"}');
    expect(s.persona).toBe('developer');
    expect(s.verdict).toBe('agree');
  });
  it('defaults a garbled stance to revise', () => {
    expect(parseStance('sme', 'garbage').verdict).toBe('revise');
  });
});

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'TASK-001', name: 'big', description: 'd', acceptanceCriteria: 'a; b; c',
    testCommand: 'bun test', dependsOn: [], domain: 'database', status: 'pending',
    iterationCount: 0, ...over,
  };
}

const twoStories = '[{"name":"schema","description":"d","acceptanceCriteria":"a"},{"name":"repo","description":"d","acceptanceCriteria":"b"}]';

describe('runDebate', () => {
  it('ends in round 1 by consensus when all personas agree', async () => {
    const deps: DebateDeps = {
      proposeFn: async () => twoStories,
      critiqueFn: async () => '{"verdict":"agree","comments":"ok"}',
      synthesizeFn: async () => { throw new Error('should not synthesize on consensus'); },
    };
    const result = await runDebate(makeTask(), deps);
    expect(result.decidedBy).toBe('consensus');
    expect(result.rounds).toHaveLength(1);
    expect(result.finalStories).toHaveLength(2);
  });

  it('runs to the round cap then the architect decides', async () => {
    const deps: DebateDeps = {
      proposeFn: async () => twoStories,
      critiqueFn: async () => '{"verdict":"revise","comments":"nope"}',
      synthesizeFn: async () => twoStories,
    };
    const result = await runDebate(makeTask(), deps);
    expect(result.decidedBy).toBe('architect');
    expect(result.rounds).toHaveLength(4); // DEBATE_MAX_ROUNDS
  });

  it('throws DebateError when the opening proposal has no stories', async () => {
    const deps: DebateDeps = {
      proposeFn: async () => 'not json',
      critiqueFn: async () => '{"verdict":"agree","comments":"ok"}',
    };
    await expect(runDebate(makeTask(), deps)).rejects.toBeInstanceOf(DebateError);
  });
});

describe('runDebate feedback events', () => {
  it('emits debate_started, one persona_stance per persona per round, and debate_decided', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await runDebate(makeTask(), {
      proposeFn: async () => twoStories,
      critiqueFn: async () => '{"verdict":"agree","comments":"ok"}',
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    expect(events.some((e) => e.type === 'debate_started')).toBe(true);
    expect(events.filter((e) => e.type === 'persona_stance')).toHaveLength(4);
    const decided = events.find((e) => e.type === 'debate_decided');
    expect(decided?.payload.decidedBy).toBe('consensus');
    expect(decided?.payload.storyCount).toBe(2);
  });
});
