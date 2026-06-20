import { describe, it, expect } from 'bun:test';
import {
  extractFeatureName,
  extractFeatureSlug,
  parseTasks,
  updateTaskStatus,
} from '../../src/prd/parser.mts';

const samplePRD = `# PRD: Auth0 Wrapper Library

**Feature Slug**: auth0-wrapper-library

## Overview
A BunJS wrapper library for the Auth0 Management SDK.

## Goals
- Wrap all Auth0 user management functions
- Wrap all organization management functions

## Technical Approach
Use the Auth0 Node.js SDK and expose a clean typed interface.

## Tasks

- [ ] **TASK-001**: Setup project structure
  - **Description**: Create package.json, tsconfig.json, and directory scaffolding
  - **Acceptance**: \`bun install\` succeeds and TypeScript compiles
  - **Test Command**: \`bun run tsc --noEmit\`

- [ ] **TASK-002**: Implement user management wrapper
  - **Description**: Wrap getUser, createUser, updateUser, deleteUser functions
  - **Acceptance**: All user operations return typed results
  - **Test Command**: \`bun test tests/users.test.mts\`

- [x] **TASK-003**: Write integration tests
  - **Description**: Test all wrappers against Auth0 Management API
  - **Acceptance**: All tests pass
  - **Test Command**: \`bun test tests/integration\`

## Acceptance Criteria
- All functions return typed Result<T> values
- No any types in the codebase

## Out of Scope
- Auth0 Deploy CLI integration
- Custom domain management
`;

describe('extractFeatureName', () => {
  it('extracts feature name from PRD heading', () => {
    expect(extractFeatureName(samplePRD)).toBe('Auth0 Wrapper Library');
  });

  it('returns fallback string when no heading found', () => {
    expect(extractFeatureName('No heading here')).toBe('Unknown Feature');
  });
});

describe('extractFeatureSlug', () => {
  it('extracts slug from Feature Slug line', () => {
    expect(extractFeatureSlug(samplePRD)).toBe('auth0-wrapper-library');
  });

  it('falls back to slugifying feature name', () => {
    const prdWithoutSlug = '# PRD: My Feature Name\n\n## Overview\nSome content.';
    const slug = extractFeatureSlug(prdWithoutSlug);
    expect(slug).toBe('my-feature-name');
  });
});

describe('parseTasks', () => {
  it('parses all tasks from PRD', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks).toHaveLength(3);
  });

  it('extracts task IDs correctly', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[0]?.id).toBe('TASK-001');
    expect(tasks[1]?.id).toBe('TASK-002');
    expect(tasks[2]?.id).toBe('TASK-003');
  });

  it('extracts task names', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[0]?.name).toBe('Setup project structure');
    expect(tasks[1]?.name).toBe('Implement user management wrapper');
  });

  it('extracts descriptions', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[0]?.description).toContain('package.json');
  });

  it('extracts acceptance criteria', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[0]?.acceptanceCriteria).toContain('bun install');
  });

  it('extracts test commands', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[0]?.testCommand).toContain('tsc');
    expect(tasks[1]?.testCommand).toContain('bun test');
  });

  it('sets pending status for unchecked tasks', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[0]?.status).toBe('pending');
    expect(tasks[1]?.status).toBe('pending');
  });

  it('sets complete status for checked tasks', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[2]?.status).toBe('complete');
  });

  it('sets iterationCount to 0', () => {
    const tasks = parseTasks(samplePRD);
    expect(tasks[0]?.iterationCount).toBe(0);
  });
});

describe('updateTaskStatus', () => {
  it('marks a task as complete', () => {
    const updated = updateTaskStatus(samplePRD, 'TASK-001', true);
    expect(updated).toContain('[x] **TASK-001**');
  });

  it('marks a task as incomplete', () => {
    const updated = updateTaskStatus(samplePRD, 'TASK-003', false);
    expect(updated).toContain('[ ] **TASK-003**');
  });

  it('does not modify other tasks', () => {
    const updated = updateTaskStatus(samplePRD, 'TASK-001', true);
    expect(updated).toContain('[ ] **TASK-002**');
  });
});
