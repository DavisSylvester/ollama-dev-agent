import { describe, it, expect } from 'bun:test';
import {
  extractFeatureSlug,
  extractFeatureName,
  parseTasks,
  updateTaskStatus,
} from '../../../src/prd/parser.mts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_PRD = `# PRD: Kanban Board API
**Feature Slug**: kanban-board-api

## Overview
A kanban board.

## Tasks
- [ ] **TASK-001**: Initialize project
  - **Description**: Set up the directory structure and tsconfig
  - **Acceptance**: tsconfig.json exists with strict mode enabled
  - **Test Command**: \`bun run build\`

- [x] **TASK-002**: Define domain types
  - **Description**: Create TypeScript interfaces for Card and Column
  - **Acceptance**: No any types; barrel export present
  - **Test Command**: \`bun test src/types/board.test.mts\`

- [ ] **TASK-003**: Implement store service
  - **Description**: Singleton in-memory store
  - **Acceptance**: getBoard returns initial empty state
  - **Test Command**: \`bun test src/services/store.test.mts\`
`;

const MINIMAL_PRD = `# PRD: Simple Feature
**Feature Slug**: simple-feature

## Tasks
- [ ] **TASK-001**: Do the thing
  - **Description**: Just do it
  - **Acceptance**: It is done
  - **Test Command**: \`bun test\`
`;

// ---------------------------------------------------------------------------
// extractFeatureSlug
// ---------------------------------------------------------------------------

describe('extractFeatureSlug', () => {
  it('extracts the explicit slug from Feature Slug field', () => {
    expect(extractFeatureSlug(FULL_PRD)).toBe('kanban-board-api');
  });

  it('trims whitespace around the slug', () => {
    const prd = '**Feature Slug**:   my-slug   \n';
    expect(extractFeatureSlug(prd)).toBe('my-slug');
  });

  it('falls back to slugifying the PRD heading when no slug field present', () => {
    const prd = '# PRD: My Cool Feature\n\n## Tasks\n';
    expect(extractFeatureSlug(prd)).toBe('my-cool-feature');
  });

  it('returns unknown-feature when neither slug nor heading is present', () => {
    expect(extractFeatureSlug('No headings here')).toBe('unknown-feature');
  });

  it('slugifies special characters in the heading fallback', () => {
    const prd = '# PRD: Hello, World! (v2)\n';
    // Special chars stripped, spaces → dashes
    expect(extractFeatureSlug(prd)).toBe('hello-world-v2');
  });
});

// ---------------------------------------------------------------------------
// extractFeatureName
// ---------------------------------------------------------------------------

describe('extractFeatureName', () => {
  it('extracts the name from the PRD heading', () => {
    expect(extractFeatureName(FULL_PRD)).toBe('Kanban Board API');
  });

  it('trims whitespace', () => {
    const prd = '# PRD:   Trimmed Name   \n';
    expect(extractFeatureName(prd)).toBe('Trimmed Name');
  });

  it('returns Unknown Feature when no heading matches', () => {
    expect(extractFeatureName('## Not a PRD heading\n')).toBe('Unknown Feature');
  });
});

// ---------------------------------------------------------------------------
// parseTasks
// ---------------------------------------------------------------------------

describe('parseTasks', () => {
  it('parses all tasks from a full PRD', () => {
    const tasks = parseTasks(FULL_PRD);
    expect(tasks).toHaveLength(3);
  });

  it('assigns correct ids and names', () => {
    const tasks = parseTasks(FULL_PRD);
    expect(tasks[0]?.id).toBe('TASK-001');
    expect(tasks[0]?.name).toBe('Initialize project');
    expect(tasks[1]?.id).toBe('TASK-002');
    expect(tasks[2]?.id).toBe('TASK-003');
  });

  it('extracts description, acceptanceCriteria, and testCommand', () => {
    const tasks = parseTasks(FULL_PRD);
    const t = tasks[0]!;
    expect(t.description).toBe('Set up the directory structure and tsconfig');
    expect(t.acceptanceCriteria).toBe('tsconfig.json exists with strict mode enabled');
    expect(t.testCommand).toBe('bun run build');
  });

  it('marks unchecked tasks as pending', () => {
    const tasks = parseTasks(FULL_PRD);
    expect(tasks[0]?.status).toBe('pending');
    expect(tasks[2]?.status).toBe('pending');
  });

  it('marks checked tasks as complete', () => {
    const tasks = parseTasks(FULL_PRD);
    expect(tasks[1]?.status).toBe('complete');
  });

  it('initialises iterationCount to 0', () => {
    const tasks = parseTasks(FULL_PRD);
    tasks.forEach((t) => expect(t.iterationCount).toBe(0));
  });

  it('returns an empty array when there are no tasks', () => {
    expect(parseTasks('# PRD: No Tasks\n\n## Overview\nNothing here.\n')).toHaveLength(0);
  });

  it('parses a single-task PRD correctly', () => {
    const tasks = parseTasks(MINIMAL_PRD);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('TASK-001');
    expect(tasks[0]?.testCommand).toBe('bun test');
  });

  it('falls back to empty string for missing sub-bullets', () => {
    const prd = '# PRD: Sparse\n\n## Tasks\n- [ ] **TASK-001**: Sparse task\n';
    const tasks = parseTasks(prd);
    expect(tasks[0]?.description).toBe('');
    expect(tasks[0]?.acceptanceCriteria).toBe('');
    expect(tasks[0]?.testCommand).toBe('');
  });

  it('handles plain (non-backtick) test commands via fallback', () => {
    const prd =
      '# PRD: X\n\n## Tasks\n- [ ] **TASK-001**: T\n  - **Test Command**: bun run verify\n';
    const tasks = parseTasks(prd);
    expect(tasks[0]?.testCommand).toBe('bun run verify');
  });
});

// ---------------------------------------------------------------------------
// updateTaskStatus
// ---------------------------------------------------------------------------

describe('updateTaskStatus', () => {
  it('marks a pending task as complete', () => {
    const updated = updateTaskStatus(FULL_PRD, 'TASK-001', true);
    expect(updated).toContain('- [x] **TASK-001**');
    expect(updated).not.toContain('- [ ] **TASK-001**');
  });

  it('marks a complete task back to pending', () => {
    const updated = updateTaskStatus(FULL_PRD, 'TASK-002', false);
    expect(updated).toContain('- [ ] **TASK-002**');
    expect(updated).not.toContain('- [x] **TASK-002**');
  });

  it('does not modify other tasks', () => {
    const updated = updateTaskStatus(FULL_PRD, 'TASK-001', true);
    // TASK-002 was already [x], TASK-003 was [ ]
    expect(updated).toContain('- [x] **TASK-002**');
    expect(updated).toContain('- [ ] **TASK-003**');
  });

  it('returns the original string unchanged when the task id is not found', () => {
    const updated = updateTaskStatus(FULL_PRD, 'TASK-999', true);
    expect(updated).toBe(FULL_PRD);
  });
});
