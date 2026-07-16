import { describe, expect, it } from 'bun:test';
import { DEBATE_PERSONAS, personaModel, parseStories, parseStance } from '../../../src/prd/debate.mts';

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
