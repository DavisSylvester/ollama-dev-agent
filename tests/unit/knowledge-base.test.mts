import { describe, it, expect } from 'bun:test';
import { categorizeTask, formatForPrompt, generalizeText, generalizePrompt } from '../../src/knowledge-base/index.mts';
import type { Task, KnowledgeBase } from '../../src/types/index.mts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-001',
    name: 'Test task',
    description: 'Do something',
    acceptanceCriteria: 'It works',
    testCommand: 'bun test',
    dependsOn: [],
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
  };

  it('returns empty string when the knowledge base has no entries', () => {
    expect(formatForPrompt({ ui: [], api: [], database: [], auth: [] }, 'auth')).toBe('');
  });

  it('feeds the generalized lesson (transferable across projects)', () => {
    const out = formatForPrompt(kb, 'auth');
    expect(out).toContain('Known Issues & Resolutions');
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
