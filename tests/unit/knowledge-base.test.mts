import { describe, it, expect } from 'bun:test';
import { categorizeTask, formatForPrompt } from '../../src/knowledge-base/index.mts';
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
    api: [{ issue: 'missing onError hook', prompt: 'p', resolution: 'add Elysia onError', metadata: {} }],
    database: [],
    auth: [{ issue: '.mjs import used', prompt: 'p', model: 'kimi-k2.6', resolution: 'use .mts', metadata: {} }],
  };

  it('returns empty string when the knowledge base has no entries', () => {
    expect(formatForPrompt({ ui: [], api: [], database: [], auth: [] }, 'auth')).toBe('');
  });

  it('includes issues and resolutions', () => {
    const out = formatForPrompt(kb, 'auth');
    expect(out).toContain('Known Issues & Resolutions');
    expect(out).toContain('.mjs import used');
    expect(out).toContain('use .mts');
    expect(out).toContain('add Elysia onError');
  });

  it('puts the primary category first', () => {
    const out = formatForPrompt(kb, 'auth');
    expect(out.indexOf('### AUTH')).toBeLessThan(out.indexOf('### API'));
  });

  it('annotates the model when present', () => {
    expect(formatForPrompt(kb, 'auth')).toContain('model: kimi-k2.6');
  });
});
