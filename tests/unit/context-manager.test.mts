import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '../../src/ralph/context-manager.mts';

let tempDir: string;
let contextManager: ContextManager;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'oda-ctx-test-'));
  contextManager = new ContextManager(tempDir, 'test-feature');
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ContextManager', () => {
  describe('saveWorkerOutput', () => {
    it('saves worker output for iteration 1', async () => {
      await contextManager.saveWorkerOutput('TASK-001', 1, 'Worker iteration 1 output');
    });

    it('saves worker output for iteration 2', async () => {
      await contextManager.saveWorkerOutput('TASK-001', 2, 'Worker iteration 2 output');
    });
  });

  describe('saveReviewerFeedback', () => {
    it('saves reviewer feedback for iteration 1', async () => {
      await contextManager.saveReviewerFeedback('TASK-001', 1, 'DECISION: REVISE\nISSUES:\n- Missing tests');
    });
  });

  describe('isTaskComplete', () => {
    it('returns false for incomplete task', async () => {
      const complete = await contextManager.isTaskComplete('TASK-001');
      expect(complete).toBe(false);
    });

    it('returns true after markTaskComplete', async () => {
      await contextManager.markTaskComplete('TASK-001');
      const complete = await contextManager.isTaskComplete('TASK-001');
      expect(complete).toBe(true);
    });
  });

  describe('loadLastReviewerFeedback', () => {
    it('returns the last reviewer feedback', async () => {
      const feedback = await contextManager.loadLastReviewerFeedback('TASK-001');
      expect(feedback).toContain('REVISE');
    });

    it('returns empty string when no feedback exists', async () => {
      const feedback = await contextManager.loadLastReviewerFeedback('TASK-NOEXIST');
      expect(feedback).toBe('');
    });
  });

  describe('listIterations', () => {
    it('returns list of saved iteration numbers', async () => {
      const iterations = await contextManager.listIterations('TASK-001');
      expect(iterations).toContain(1);
      expect(iterations).toContain(2);
    });

    it('returns empty array for unknown task', async () => {
      const iterations = await contextManager.listIterations('TASK-UNKNOWN');
      expect(iterations).toHaveLength(0);
    });
  });
});
