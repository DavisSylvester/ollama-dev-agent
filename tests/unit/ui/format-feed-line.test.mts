import { describe, expect, it } from 'bun:test';
import { formatFeedLine } from '../../../src/ui/lib/format-feed-line.mts';

describe('formatFeedLine', () => {
  it('formats sizing_started', () => {
    expect(formatFeedLine('sizing_started', { taskCount: 14 })).toContain('14');
  });
  it('formats task_sized', () => {
    expect(formatFeedLine('task_sized', { taskId: 'TASK-001', size: 'M' })).toBe('TASK-001 = M');
  });
  it('formats debate_started with the task name', () => {
    expect(formatFeedLine('debate_started', { taskId: 'TASK-005', taskName: 'photo upload' })).toContain('TASK-005');
  });
  it('formats persona_stance with a display name and truncates long comments', () => {
    const line = formatFeedLine('persona_stance', {
      taskId: 'T', round: 1, persona: 'scrum_master', verdict: 'revise', comments: 'x'.repeat(200),
    });
    expect(line).toContain('Scrum Master');
    expect(line).toContain('revise');
    expect(line!.length).toBeLessThan(120);
    expect(line).toContain('…');
  });
  it('formats debate_decided', () => {
    expect(formatFeedLine('debate_decided', { taskId: 'T', decidedBy: 'architect', storyCount: 3 })).toContain('3 stories');
  });
  it('returns null for an unrecognized event', () => {
    expect(formatFeedLine('tool_called', { toolName: 'read_file' })).toBeNull();
  });
});
