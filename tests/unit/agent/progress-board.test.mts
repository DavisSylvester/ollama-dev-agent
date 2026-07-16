import { describe, expect, it } from 'bun:test';
import { buildProgressBoard, stampStarted, stampFinished } from '../../../src/agent/progress-board.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, domain: Task['domain'], status: Task['status'], over: Partial<Task> = {}): Task {
  return {
    id, name: `name ${id}`, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn: [], domain, status, iterationCount: 0, ...over,
  };
}

describe('buildProgressBoard', () => {
  const tasks = [
    task('TASK-001', 'database', 'complete', { startedAt: '2026-07-16T12:00:03.000Z', completedAt: '2026-07-16T12:00:41.000Z' }),
    task('TASK-002', 'database', 'in_progress', { startedAt: '2026-07-16T12:00:41.000Z' }),
    task('TASK-003', 'ui', 'pending'),
    task('TASK-004', 'api', 'failed', { startedAt: '2026-07-16T12:01:00.000Z', completedAt: '2026-07-16T12:02:00.000Z' }),
  ];

  it('renders each glyph, groups by domain, and shows times', () => {
    const md = buildProgressBoard('Notes App', 'notes-app', tasks);
    expect(md).toContain('[✓] TASK-001');
    expect(md).toContain('[-] TASK-002');
    expect(md).toContain('[ ] TASK-003');
    expect(md).toContain('[X] TASK-004');
    expect(md).toContain('## database');
    expect(md).toContain('## ui');
    expect(md).toContain('started 2026-07-16T12:00:03.000Z');
    expect(md).toContain('done 2026-07-16T12:00:41.000Z');
  });

  it('renders a summary line with the counts', () => {
    const md = buildProgressBoard('Notes App', 'notes-app', tasks);
    expect(md).toContain('1 / 4 complete');
    expect(md).toContain('1 in-progress');
    expect(md).toContain('1 failed');
  });

  it('omits domains that have no tasks', () => {
    const md = buildProgressBoard('X', 'x', [task('T1', 'ui', 'pending')]);
    expect(md).toContain('## ui');
    expect(md).not.toContain('## database');
  });
});

describe('stampStarted / stampFinished', () => {
  it('stampStarted sets in_progress and a startedAt', () => {
    const t = stampStarted(task('T1', 'ui', 'pending'));
    expect(t.status).toBe('in_progress');
    expect(typeof t.startedAt).toBe('string');
  });
  it('stampFinished sets the status and a completedAt', () => {
    const t = stampFinished(task('T1', 'ui', 'in_progress'), 'complete');
    expect(t.status).toBe('complete');
    expect(typeof t.completedAt).toBe('string');
  });
});
