import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextManager } from '../../../src/ralph/context-manager.mts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let manager: ContextManager;

const FEATURE_SLUG = 'my-feature';
const TASK_ID = 'TASK-001';

function taskDir(): string {
  return join(tmpDir, '.ai', 'activity', FEATURE_SLUG, TASK_ID);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'oda-test-'));
  manager = new ContextManager(tmpDir, FEATURE_SLUG);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// saveWorkerOutput
// ---------------------------------------------------------------------------

describe('ContextManager.saveWorkerOutput', () => {
  it('creates the task directory and writes the file', async () => {
    await manager.saveWorkerOutput(TASK_ID, 1, 'worker output');
    const content = await readFile(join(taskDir(), 'worker-1.md'), 'utf-8');
    expect(content).toBe('worker output');
  });

  it('writes different files per iteration', async () => {
    await manager.saveWorkerOutput(TASK_ID, 1, 'iteration 1');
    await manager.saveWorkerOutput(TASK_ID, 2, 'iteration 2');

    const c1 = await readFile(join(taskDir(), 'worker-1.md'), 'utf-8');
    const c2 = await readFile(join(taskDir(), 'worker-2.md'), 'utf-8');

    expect(c1).toBe('iteration 1');
    expect(c2).toBe('iteration 2');
  });

  it('overwrites an existing file for the same iteration', async () => {
    await manager.saveWorkerOutput(TASK_ID, 1, 'first write');
    await manager.saveWorkerOutput(TASK_ID, 1, 'second write');
    const content = await readFile(join(taskDir(), 'worker-1.md'), 'utf-8');
    expect(content).toBe('second write');
  });
});

// ---------------------------------------------------------------------------
// saveReviewerFeedback
// ---------------------------------------------------------------------------

describe('ContextManager.saveReviewerFeedback', () => {
  it('creates the task directory and writes the reviewer file', async () => {
    await manager.saveReviewerFeedback(TASK_ID, 1, 'reviewer feedback');
    const content = await readFile(join(taskDir(), 'reviewer-1.md'), 'utf-8');
    expect(content).toBe('reviewer feedback');
  });

  it('writes different files per iteration', async () => {
    await manager.saveReviewerFeedback(TASK_ID, 1, 'feedback 1');
    await manager.saveReviewerFeedback(TASK_ID, 2, 'feedback 2');

    const c1 = await readFile(join(taskDir(), 'reviewer-1.md'), 'utf-8');
    const c2 = await readFile(join(taskDir(), 'reviewer-2.md'), 'utf-8');

    expect(c1).toBe('feedback 1');
    expect(c2).toBe('feedback 2');
  });
});

// ---------------------------------------------------------------------------
// markTaskComplete / isTaskComplete
// ---------------------------------------------------------------------------

describe('ContextManager.isTaskComplete', () => {
  it('returns false when no .complete marker exists', async () => {
    expect(await manager.isTaskComplete(TASK_ID)).toBe(false);
  });

  it('returns true after markTaskComplete is called', async () => {
    await manager.markTaskComplete(TASK_ID);
    expect(await manager.isTaskComplete(TASK_ID)).toBe(true);
  });

  it('writes an ISO timestamp into the .complete file', async () => {
    const before = Date.now();
    await manager.markTaskComplete(TASK_ID);
    const content = await readFile(join(taskDir(), '.complete'), 'utf-8');
    const ts = new Date(content).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('returns false for a different task when one task is complete', async () => {
    await manager.markTaskComplete(TASK_ID);
    expect(await manager.isTaskComplete('TASK-002')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadLastReviewerFeedback
// ---------------------------------------------------------------------------

describe('ContextManager.loadLastReviewerFeedback', () => {
  it('returns empty string when no reviewer files exist', async () => {
    const result = await manager.loadLastReviewerFeedback(TASK_ID);
    expect(result).toBe('');
  });

  it('returns empty string when the task directory does not exist', async () => {
    const result = await manager.loadLastReviewerFeedback('TASK-MISSING');
    expect(result).toBe('');
  });

  it('returns the single feedback when there is one iteration', async () => {
    await manager.saveReviewerFeedback(TASK_ID, 1, 'only feedback');
    const result = await manager.loadLastReviewerFeedback(TASK_ID);
    expect(result).toBe('only feedback');
  });

  it('returns the highest-numbered iteration feedback', async () => {
    await manager.saveReviewerFeedback(TASK_ID, 1, 'old feedback');
    await manager.saveReviewerFeedback(TASK_ID, 2, 'new feedback');
    await manager.saveReviewerFeedback(TASK_ID, 3, 'newest feedback');
    const result = await manager.loadLastReviewerFeedback(TASK_ID);
    expect(result).toBe('newest feedback');
  });

  it('ignores non-reviewer files in the task directory', async () => {
    await manager.saveWorkerOutput(TASK_ID, 1, 'worker stuff');
    const result = await manager.loadLastReviewerFeedback(TASK_ID);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// saveActivityEntry / loadActivityLog
// ---------------------------------------------------------------------------

describe('ContextManager.saveActivityEntry / loadActivityLog', () => {
  it('returns empty string when no activity file exists', async () => {
    const result = await manager.loadActivityLog(TASK_ID);
    expect(result).toBe('');
  });

  it('creates the file with a header on first entry', async () => {
    await manager.saveActivityEntry(TASK_ID, '## Iteration 1 — TIMED OUT\n\n');
    const content = await manager.loadActivityLog(TASK_ID);
    expect(content).toContain('Failed Iteration Activity Log');
    expect(content).toContain('## Iteration 1 — TIMED OUT');
  });

  it('appends subsequent entries without duplicating the header', async () => {
    await manager.saveActivityEntry(TASK_ID, '## Iteration 1 — TIMED OUT\n\n');
    await manager.saveActivityEntry(TASK_ID, '## Iteration 2 — REVISE\n\n');
    const content = await manager.loadActivityLog(TASK_ID);
    const headerCount = (content.match(/Failed Iteration Activity Log/g) ?? []).length;
    expect(headerCount).toBe(1);
    expect(content).toContain('## Iteration 1 — TIMED OUT');
    expect(content).toContain('## Iteration 2 — REVISE');
  });

  it('creates the task directory if it does not exist', async () => {
    await manager.saveActivityEntry('TASK-NEW', 'entry\n');
    const content = await manager.loadActivityLog('TASK-NEW');
    expect(content).toContain('entry');
  });
});

// ---------------------------------------------------------------------------
// saveReviewerNoData
// ---------------------------------------------------------------------------

describe('ContextManager.saveReviewerNoData', () => {
  it('creates the task directory and writes a no-data file', async () => {
    await manager.saveReviewerNoData(TASK_ID, 2, 'Worker timed out.');
    const content = await readFile(join(taskDir(), 'reviewer-2-no-data.md'), 'utf-8');
    expect(content).toContain('# Reviewer — No Data');
    expect(content).toContain('Worker timed out.');
  });

  it('includes task ID and iteration in the file', async () => {
    await manager.saveReviewerNoData(TASK_ID, 3, 'Step budget exhausted.');
    const content = await readFile(join(taskDir(), 'reviewer-3-no-data.md'), 'utf-8');
    expect(content).toContain(TASK_ID);
    expect(content).toContain('3');
  });

  it('writes different files per iteration', async () => {
    await manager.saveReviewerNoData(TASK_ID, 1, 'reason A');
    await manager.saveReviewerNoData(TASK_ID, 2, 'reason B');
    const c1 = await readFile(join(taskDir(), 'reviewer-1-no-data.md'), 'utf-8');
    const c2 = await readFile(join(taskDir(), 'reviewer-2-no-data.md'), 'utf-8');
    expect(c1).toContain('reason A');
    expect(c2).toContain('reason B');
  });
});

// ---------------------------------------------------------------------------
// listIterations
// ---------------------------------------------------------------------------

describe('ContextManager.listIterations', () => {
  it('returns an empty array when the task directory does not exist', async () => {
    const result = await manager.listIterations(TASK_ID);
    expect(result).toEqual([]);
  });

  it('returns an empty array when there are no worker files', async () => {
    await manager.saveReviewerFeedback(TASK_ID, 1, 'feedback only');
    const result = await manager.listIterations(TASK_ID);
    expect(result).toEqual([]);
  });

  it('returns sorted iteration numbers', async () => {
    await manager.saveWorkerOutput(TASK_ID, 3, 'c');
    await manager.saveWorkerOutput(TASK_ID, 1, 'a');
    await manager.saveWorkerOutput(TASK_ID, 2, 'b');
    const result = await manager.listIterations(TASK_ID);
    expect(result).toEqual([1, 2, 3]);
  });
});
