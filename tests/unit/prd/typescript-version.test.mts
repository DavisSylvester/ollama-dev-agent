import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import {
  resolveLatestTypeScriptVersion,
  resetTypeScriptVersionCache,
  formatTypeScriptVersionRule,
} from '../../../src/prd/typescript-version.mts';
import { buildWorkerPrompt, buildReviewerPrompt } from '../../../src/prd/prompts.mts';
import type { Task } from '../../../src/types/index.mts';

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetTypeScriptVersionCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetTypeScriptVersionCache();
});

const TASK: Task = {
  id: 'TASK-001',
  name: 'Example',
  description: 'Example task',
  acceptanceCriteria: 'It works',
  testCommand: 'bun test',
  dependsOn: [],
  domain: 'services',
  status: 'pending',
  iterationCount: 0,
};

describe('resolveLatestTypeScriptVersion', () => {

  it('returns the version the npm registry reports as latest', async () => {
    globalThis.fetch = (async () =>
      new Response('{"version":"9.1.2"}', { status: 200 })) as unknown as typeof fetch;

    expect(await resolveLatestTypeScriptVersion()).toBe('9.1.2');
  });

  it('looks the version up only once per process', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{"version":"9.1.2"}', { status: 200 });
    }) as unknown as typeof fetch;

    await resolveLatestTypeScriptVersion();
    await resolveLatestTypeScriptVersion();
    expect(calls).toBe(1);
  });

  it('returns null when the registry responds with an error status', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;

    expect(await resolveLatestTypeScriptVersion()).toBeNull();
  });

  it('returns null when the registry is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Unable to connect');
    }) as unknown as typeof fetch;

    expect(await resolveLatestTypeScriptVersion()).toBeNull();
  });

  it('returns null for a pre-release or malformed version', async () => {
    globalThis.fetch = (async () =>
      new Response('{"version":"9.2.0-beta"}', { status: 200 })) as unknown as typeof fetch;

    expect(await resolveLatestTypeScriptVersion()).toBeNull();
  });
});

describe('formatTypeScriptVersionRule', () => {

  it('pins the resolved version and the install command', () => {
    const rule = formatTypeScriptVersionRule('9.1.2');
    expect(rule).toContain('**9.1.2**');
    expect(rule).toContain('`^9.1.2`');
    expect(rule).toContain('bun add -d typescript@9.1.2');
  });

  it('still demands the latest when no version could be resolved', () => {
    const rule = formatTypeScriptVersionRule(null);
    expect(rule).toContain('bun pm view typescript version');
    expect(rule).toContain('bun add -d typescript@latest');
  });

  it('keeps the compatibility fallback', () => {
    expect(formatTypeScriptVersionRule('9.1.2')).toContain('Compatibility fallback only');
  });
});

describe('prompts — TypeScript version rule', () => {

  it('puts the resolved version in the worker prompt', () => {
    const prompt = buildWorkerPrompt(TASK, 1, '', 'Feature', '/dir', '', '', '', '', '9.1.2');
    expect(prompt).toContain('bun add -d typescript@9.1.2');
  });

  it('tells the reviewer to REVISE a typescript pin below the resolved version', () => {
    const prompt = buildReviewerPrompt(TASK, 'done', 'Feature', [], '9.1.2');
    expect(prompt).toContain('pins `typescript` below `9.1.2`');
  });

  it('falls back to "the newest stable release" in the reviewer without a version', () => {
    const prompt = buildReviewerPrompt(TASK, 'done', 'Feature');
    expect(prompt).toContain('pins `typescript` below the newest stable release');
  });
});
