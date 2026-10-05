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

// Version enforcement moved out of the prompts into oda's dependency preflight
// (src/deps): the reviewer used to REVISE over a typescript pin the worker never
// bumped, so tasks could not pass. The prompts now state the policy and facts.
describe('prompts — dependency version policy', () => {
  const pinned = 'Pinned below latest by oda, deliberately: `typescript` 6.2.1 (latest 7.0.2: typecheck failures rose).';

  it('tells the worker versions are managed and not to change them', () => {
    const prompt = buildWorkerPrompt(TASK, 1, '', 'Feature', '/dir', '', '', '', '', pinned);
    expect(prompt).toContain('Dependency versions are managed by oda');
    expect(prompt).toContain('Do **not** change the version of a package already listed');
    expect(prompt).toContain('`typescript` 6.2.1 (latest 7.0.2');
  });

  it('tells the reviewer not to REVISE over versions, and why a pin exists', () => {
    const prompt = buildReviewerPrompt(TASK, 'done', 'Feature', [], pinned);
    expect(prompt).toContain('Do **NOT** REVISE over dependency versions');
    expect(prompt).toContain('`typescript` 6.2.1 (latest 7.0.2');
    expect(prompt).not.toContain('pins `typescript` below');
  });

  it('still states the policy when no preflight report exists yet', () => {
    const prompt = buildReviewerPrompt(TASK, 'done', 'Feature');
    expect(prompt).toContain('docs/DEPENDENCIES.md');
  });
});
