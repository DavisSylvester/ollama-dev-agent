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

describe('formatFeedLine — execution feedback', () => {
  it('describes a model retry with the wait', () => {
    expect(formatFeedLine('model_retry', { error: 'Model call timed out after 180s', attempt: 2, maxRetries: 3, delayMs: 4000 }))
      .toBe('⟳ model call failed (Model call timed out after 180s) — retry 2/3 in 4s');
  });

  it('describes a retry after runaway thinking', () => {
    expect(formatFeedLine('model_retry', { error: 'Model thought for ~8k tokens without acting', attempt: 1, maxRetries: 3, delayMs: 2000 }))
      .toBe('⟳ Model thought for ~8k tokens without acting — retry 1/3 in 2s, told to act');
  });

  it('describes each attempt outcome', () => {
    expect(formatFeedLine('iteration_finished', { taskId: 'TASK-003-2', iteration: 2, maxIterations: 5, outcome: 'worker_error', detail: 'Worker encountered an unexpected error: Model call timed out after 180s' }))
      .toBe('  TASK-003-2 attempt 2/5: model call failed — Model call timed out after 180s');
    expect(formatFeedLine('iteration_finished', { taskId: 'T', iteration: 1, maxIterations: 5, outcome: 'ship', detail: '' }))
      .toBe('  T attempt 1/5: SHIP ✓');
  });

  it('describes quota pauses, failures and completions', () => {
    expect(formatFeedLine('quota_paused', { waitMinutes: 15, taskIds: ['A'] })).toContain('pausing 15 min');
    expect(formatFeedLine('task_failed', { taskId: 'A', reason: '5 attempts: 5× model call failed' })).toBe('✗ A failed — 5 attempts: 5× model call failed');
    expect(formatFeedLine('task_complete', { taskId: 'A', iterations: 2 })).toBe('✓ A complete after 2 attempt(s)');
  });
});
