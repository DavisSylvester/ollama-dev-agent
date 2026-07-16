import { describe, expect, it } from 'bun:test';
import { buildSizingReport } from '../../../src/prd/sizing-report.mts';
import type { SizedPlanResult } from '../../../src/prd/sizer.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, domain: Task['domain'], size: Task['size']): Task {
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
    };
    const md = buildSizingReport('Notes App', 'notes-app', result);
    expect(md).toContain('# Sizing: Notes App');
    expect(md).toContain('| S | 1 |');
    expect(md).toContain('TASK-001-1');
    expect(md).toContain('TASK-001 → TASK-001-1, TASK-001-2');
  });
});
