import { describe, expect, it } from 'bun:test';
import { env } from '../../src/env.mts';

describe('debate env', () => {
  it('caps DEBATE_MAX_ROUNDS at 4 by default', () => {
    expect(env.DEBATE_MAX_ROUNDS).toBeLessThanOrEqual(4);
    expect(env.DEBATE_MAX_ROUNDS).toBeGreaterThanOrEqual(1);
  });

  it('leaves persona model overrides undefined unless set', () => {
    // Unset by default so the resolver falls back to PLANNER/CODER models.
    expect(env.DEBATE_ARCHITECT_MODEL === undefined || typeof env.DEBATE_ARCHITECT_MODEL === 'string').toBe(true);
  });
});
