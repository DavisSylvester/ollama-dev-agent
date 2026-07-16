import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEntry, categorizeTask, formatForPrompt, generalizeText, generalizePrompt, loadKnowledgeBase } from '../../src/knowledge-base/index.mts';
import type { KBEntry, Task, KnowledgeBase } from '../../src/types/index.mts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-001',
    name: 'Test task',
    description: 'Do something',
    acceptanceCriteria: 'It works',
    testCommand: 'bun test',
    dependsOn: [],
    domain: 'services',
    status: 'pending',
    iterationCount: 0,
    ...overrides,
  };
}

describe('categorizeTask', () => {
  it('classifies Angular/UI tasks as ui', () => {
    expect(categorizeTask(makeTask({ name: 'Build CreateUser Angular component', description: 'standalone component with a form' }))).toBe('ui');
  });

  it('classifies Elysia/endpoint tasks as api', () => {
    expect(categorizeTask(makeTask({ name: 'Scaffold Elysia API', description: 'http endpoints and routes' }))).toBe('api');
  });

  it('classifies database tasks as database', () => {
    expect(categorizeTask(makeTask({ name: 'Create repository', description: 'postgres persistence layer with migrations' }))).toBe('database');
  });

  it('classifies auth0/token tasks as auth', () => {
    expect(categorizeTask(makeTask({ name: 'Implement createUser', description: 'auth0 management api, password and token handling' }))).toBe('auth');
  });

  it('classifies GitHub Actions / CI tasks as github-actions', () => {
    expect(categorizeTask(makeTask({ name: 'Add deploy workflow', description: 'GitHub Actions workflow_dispatch pipeline on a self-hosted runner' }))).toBe('github-actions');
  });

  it('classifies Terraform / IaC tasks as terraform', () => {
    expect(categorizeTask(makeTask({ name: 'Provision Container App', description: 'terraform azurerm module with required_providers' }))).toBe('terraform');
  });

  it('routes a CI workflow that deploys terraform to github-actions (CI signal wins)', () => {
    expect(categorizeTask(makeTask({ name: 'CI/CD pipeline', description: 'a github actions workflow that runs terraform apply' }))).toBe('github-actions');
  });

  it('defaults to api when nothing matches', () => {
    expect(categorizeTask(makeTask({ name: 'Misc', description: 'general work' }))).toBe('api');
  });
});

describe('formatForPrompt', () => {
  const kb: KnowledgeBase = {
    ui: [],
    api: [{ issue: 'missing onError hook', actual_prompt: 'p', actual_resolution: 'add Elysia onError in apps/api/index.mts', generalized_prompt: 'api situation', generalized_resolution: 'Use a centralized error hook', metadata: {} }],
    database: [],
    auth: [{ issue: '.mjs import used', actual_prompt: 'p', model: 'kimi-k2.6', actual_resolution: 'use .mts in ./auth0-config', generalized_prompt: 'auth situation', generalized_resolution: 'Use the required import extension, not .mjs', metadata: {} }],
    terraform: [],
    'github-actions': [],
  };

  it('returns empty string when the knowledge base has no entries', () => {
    expect(formatForPrompt({ ui: [], api: [], database: [], auth: [], terraform: [], 'github-actions': [] }, 'auth')).toBe('');
  });

  it('feeds the generalized lesson (transferable across projects)', () => {
    const out = formatForPrompt(kb, 'auth');
    expect(out).toContain('Lessons from prior runs');
    expect(out).toContain('.mjs import used');
    expect(out).toContain('Use the required import extension, not .mjs'); // generalized, not actual
    expect(out).toContain('Use a centralized error hook');
  });

  it('puts the primary category first', () => {
    const out = formatForPrompt(kb, 'auth');
    expect(out.indexOf('### AUTH')).toBeLessThan(out.indexOf('### API'));
  });

  it('annotates the model when present', () => {
    expect(formatForPrompt(kb, 'auth')).toContain('model: kimi-k2.6');
  });

  it('surfaces proven solutions (status=resolved) separately from pitfalls', () => {
    const split: KnowledgeBase = {
      ui: [],
      api: [
        { issue: 'shipped store service', actual_prompt: 'p', actual_resolution: 'r', generalized_prompt: 'g', generalized_resolution: 'Define types first, then a singleton store', metadata: { status: 'resolved' } },
        { issue: 'reviewer requested changes', actual_prompt: 'p', actual_resolution: 'r', generalized_prompt: 'g', generalized_resolution: 'Run the test command before declaring done', metadata: { status: 'revise' } },
      ],
      database: [],
      auth: [],
      terraform: [],
      'github-actions': [],
    };
    const out = formatForPrompt(split, 'api');
    expect(out).toContain('Proven solutions');
    expect(out).toContain('Pitfalls');
    // The proven section must come before the pitfalls section.
    expect(out.indexOf('Proven solutions')).toBeLessThan(out.indexOf('Pitfalls'));
    // The resolved lesson lands in the proven half, the revise lesson in pitfalls.
    expect(out.indexOf('Define types first')).toBeLessThan(out.indexOf('Run the test command'));
  });

  it('omits the proven section entirely when there are no resolved entries', () => {
    const out = formatForPrompt(kb, 'auth'); // all entries have empty metadata (no status)
    expect(out).not.toContain('Proven solutions');
    expect(out).toContain('Pitfalls');
  });
});

describe('generalizeText', () => {
  it('strips relative file paths', () => {
    expect(generalizeText('Fix apps/api/src/index.mts and libs/x/y.tsx')).not.toContain('apps/api/src/index.mts');
    expect(generalizeText('Fix apps/api/src/index.mts')).toContain('<file>');
  });

  it('strips task IDs, iteration refs, and line:col positions', () => {
    const out = generalizeText('TASK-009 failed on iteration 3 at 12:5');
    expect(out).not.toContain('TASK-009');
    expect(out).not.toContain('iteration 3');
    expect(out).not.toContain('12:5');
    expect(out).toContain('the task');
  });

  it('keeps the transferable lesson intact', () => {
    const out = generalizeText("Remove unused import 'WritableSignal'; use import type");
    expect(out).toContain('Remove unused import');
    expect(out).toContain('import type');
  });
});

describe('generalizePrompt', () => {
  it('returns a project-agnostic situation per category', () => {
    expect(generalizePrompt('ui')).toMatch(/UI|component/i);
    expect(generalizePrompt('api')).toMatch(/API|server/i);
    expect(generalizePrompt('database')).toMatch(/persistence|repository|data/i);
    expect(generalizePrompt('auth')).toMatch(/auth/i);
  });
});

describe('appendEntry dedup', () => {
  let kbDir: string;

  function makeEntry(overrides: Partial<KBEntry> = {}): KBEntry {
    return {
      issue: 'reviewer requested changes',
      actual_prompt: 'p',
      actual_resolution: 'r',
      generalized_prompt: 'g',
      generalized_resolution: 'Run the test command before declaring done',
      metadata: { status: 'revise' },
      ...overrides,
    };
  }

  beforeEach(() => {
    kbDir = mkdtempSync(join(tmpdir(), 'oda-kb-'));
    process.env['ODA_KB_DIR'] = kbDir;
  });

  afterEach(() => {
    delete process.env['ODA_KB_DIR'];
    rmSync(kbDir, { recursive: true, force: true });
  });

  it('does not store a second equivalent lesson', async () => {
    await appendEntry('api', makeEntry());
    await appendEntry('api', makeEntry()); // identical
    const kb = await loadKnowledgeBase();
    expect(kb.api).toHaveLength(1);
  });

  it('stores entries that differ in their generalized lesson', async () => {
    await appendEntry('api', makeEntry());
    await appendEntry('api', makeEntry({ generalized_resolution: 'A genuinely different lesson' }));
    const kb = await loadKnowledgeBase();
    expect(kb.api).toHaveLength(2);
  });
});
