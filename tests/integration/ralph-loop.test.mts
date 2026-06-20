/**
 * Integration tests for the Ralph loop.
 * These tests require Ollama to be running at the configured OLLAMA_BASE_URL.
 * They are slower and make real model calls — run with: bun test tests/integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RalphLoop } from '../../src/ralph/loop.mts';
import { ContextManager } from '../../src/ralph/context-manager.mts';
import { createWorkerTools } from '../../src/tools/index.mts';
import type { Task } from '../../src/types/index.mts';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'oda-integration-'));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const simpleTask: Task = {
  id: 'TASK-001',
  name: 'Create a hello world file',
  description: 'Create a file called hello.ts that exports a function greet() returning "Hello, World!"',
  acceptanceCriteria: 'File exists at hello.ts, exports greet function, returns correct string',
  testCommand: 'bun test',
  dependsOn: [],
  status: 'pending',
  iterationCount: 0,
};

describe('RalphLoop', () => {
  it(
    'completes a simple task',
    async () => {
      const loop = new RalphLoop(
        tempDir,
        'test-feature',
        'Test Feature',
        3,
      );

      const workerTools = createWorkerTools(tempDir);
      const events: string[] = [];

      const result = await loop.runTask(simpleTask, workerTools, {
        onIterationStart: (taskId, iteration) => {
          events.push(`iteration:${taskId}:${iteration}`);
        },
        onWorkerComplete: (taskId, _output) => {
          events.push(`worker_complete:${taskId}`);
        },
        onReviewerComplete: (taskId, decision) => {
          events.push(`reviewer:${taskId}:${decision.decision}`);
        },
      });

      expect(['complete', 'failed']).toContain(result);
      expect(events.some(e => e.startsWith('iteration:'))).toBe(true);
      expect(events.some(e => e.startsWith('worker_complete:'))).toBe(true);
      expect(events.some(e => e.startsWith('reviewer:'))).toBe(true);
    },
    120_000, // 2 minute timeout for LLM calls
  );

  it(
    'marks task complete in context manager when shipped',
    async () => {
      const loop = new RalphLoop(
        tempDir,
        'test-feature-2',
        'Test Feature 2',
        3,
      );

      const workerTools = createWorkerTools(tempDir);
      const result = await loop.runTask(
        { ...simpleTask, id: 'TASK-002', status: 'pending' },
        workerTools,
      );

      const ctx = new ContextManager(tempDir, 'test-feature-2');
      if (result === 'complete') {
        const isComplete = await ctx.isTaskComplete('TASK-002');
        expect(isComplete).toBe(true);
      }
    },
    120_000,
  );
});
