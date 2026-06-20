import { describe, it, expect, afterEach } from 'bun:test';
import { env, applyEnvOverrides } from '../../src/env.mts';

// Snapshot/restore the fields these tests mutate so they stay isolated.
const ORIGINAL = {
  PLANNER_MODEL: env.PLANNER_MODEL,
  CODER_MODEL: env.CODER_MODEL,
  OLLAMA_BASE_URL: env.OLLAMA_BASE_URL,
  PLANNER_MAX_STEPS: env.PLANNER_MAX_STEPS,
  RESEARCH_PLANNING: env.RESEARCH_PLANNING,
};

afterEach(() => {
  applyEnvOverrides(ORIGINAL);
});

describe('applyEnvOverrides', () => {
  it('applies defined overrides onto the env singleton', () => {
    applyEnvOverrides({ PLANNER_MODEL: 'gpt-oss:120b', OLLAMA_BASE_URL: 'https://ollama.com' });

    expect(env.PLANNER_MODEL).toBe('gpt-oss:120b');
    expect(env.OLLAMA_BASE_URL).toBe('https://ollama.com');
  });

  it('ignores undefined values (leaves existing config intact)', () => {
    const before = env.CODER_MODEL;
    applyEnvOverrides({ CODER_MODEL: undefined });

    expect(env.CODER_MODEL).toBe(before);
  });

  it('overrides numeric and boolean fields', () => {
    applyEnvOverrides({ PLANNER_MAX_STEPS: 25, RESEARCH_PLANNING: false });

    expect(env.PLANNER_MAX_STEPS).toBe(25);
    expect(env.RESEARCH_PLANNING).toBe(false);
  });
});
