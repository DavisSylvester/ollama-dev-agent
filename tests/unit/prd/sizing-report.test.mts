import { describe, expect, it } from 'bun:test';
import { buildSizingReport } from '../../../src/prd/sizing-report.mts';
import type { SizedPlanResult } from '../../../src/prd/sizer.mts';
import type { Task, TaskDomain, TaskSize } from '../../../src/types/index.mts';

function task(id: string, domain: TaskDomain, size: TaskSize): Task {
  return {
    id, name: `name ${id}`, description: '', acceptanceCriteria: '',
    testCommand: 'bun test', dependsOn: [], domain, size,
    status: 'pending', iterationCount: 0,
  };
}

describe('buildSizingReport', () => {
  it('renders the distribution, a per-task table, and the split tree', () => {
    const result: SizedPlanResult = {
      tasks: [task('TASK-001-1', 'database', 'M'), task('TASK-002', 'ui', 'S')],
      distribution: { S: 1, M: 1, L: 0 },
      splits: [{ parentId: 'TASK-001', childIds: ['TASK-001-1', 'TASK-001-2'] }],
      recommendations: [],
      oversized: [],
    };
    const md = buildSizingReport('Notes App', 'notes-app', result);
    expect(md).toContain('# Sizing: Notes App');
    expect(md).toContain('| S | 1 |');
    expect(md).toContain('TASK-001-1');
    expect(md).toContain('TASK-001 → TASK-001-1, TASK-001-2');
  });

  it('renders a debate-sourced recommendation with the decision maker', () => {
    const result: SizedPlanResult = {
      tasks: [task('TASK-001', 'database', 'L')],
      distribution: { S: 0, M: 0, L: 1 },
      splits: [],
      recommendations: [
        {
          taskId: 'TASK-001',
          taskName: 'big task',
          reasons: ['Spans 3 distinct domains.'],
          recommendation: 'Decided by consensus after 2 round(s). Split into:\n1. schema — d\n2. repo — d',
        },
      ],
      oversized: [],
    };
    const md = buildSizingReport('Notes App', 'notes-app', result);
    expect(md).toContain('## Recommendations for Oversized Tasks');
    expect(md).toContain('Decided by consensus');
    expect(md).toContain('Debate outcome'); // new label
  });

  it('flags tasks that remain L and are allowed to run oversized', () => {
    const result: SizedPlanResult = {
      tasks: [task('TASK-009', 'api', 'L')],
      distribution: { S: 0, M: 0, L: 1 },
      splits: [],
      recommendations: [],
      oversized: ['TASK-009'],
    };
    const md = buildSizingReport('Notes App', 'notes-app', result);
    expect(md).toContain('Allowed to run oversized');
    expect(md).toContain('TASK-009');
  });
});
