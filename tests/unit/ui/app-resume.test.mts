import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { App } from '../../../src/ui/App.tsx';
import { emitAgentEvent } from '../../../src/agent/events.mts';
import type { Task } from '../../../src/types/index.mts';

class FakeStdout extends EventEmitter {

  public columns = 110;
  public rows = 60;
  public last = '';

  public write(chunk: string): boolean {
    this.last = chunk;
    return true;
  }
}

function task(id: string, status: Task['status']): Task {
  return {
    id, name: `${id} name`, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn: [], domain: 'services', status, iterationCount: 0,
  };
}

async function mountApp(): Promise<{ stdout: FakeStdout; unmount: () => void }> {
  const stdout = new FakeStdout();
  const app = render(React.createElement(App, { version: '0.1.0', onAgentStart: () => {}, autoApprove: true }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  await Bun.sleep(50); // let the App subscribe to agent events
  return { stdout, unmount: () => app.unmount() };
}

describe('App on a resumed run', () => {
  it('shows the saved plan from run_resumed (prd_generated never fires on resume)', async () => {
    const { stdout, unmount } = await mountApp();
    emitAgentEvent('run_resumed', {
      featureName: 'Equipment Resale App',
      featureSlug: 'equipment-resale-app',
      tasks: [task('TASK-001', 'complete'), task('TASK-002', 'pending')],
    });
    await Bun.sleep(50);
    const frame = stdout.last;
    unmount();

    expect(frame).toContain('Feature: Equipment Resale App');
    expect(frame).toContain('TASK-001');
    expect(frame).toContain('TASK-002');
  });

  it('reports the real counts, flags an incomplete run, and uses the slug for the results path', async () => {
    const { stdout, unmount } = await mountApp();
    emitAgentEvent('run_resumed', { featureName: 'Equipment Resale App', featureSlug: 'equipment-resale-app', tasks: [] });
    emitAgentEvent('complete', { featureName: 'Equipment Resale App', featureSlug: 'equipment-resale-app', completedCount: 11, failedCount: 41 });
    await Bun.sleep(50);
    const frame = stdout.last;
    unmount();

    expect(frame).toContain('Run Finished — Not Complete');
    expect(frame).toContain('11');
    expect(frame).toContain('41');
    expect(frame).toContain('feature-results/equipment-resale-app/RESULTS.md');
    expect(frame).not.toContain('feature-results//');
  });

  it('still says Feature Complete when nothing failed', async () => {
    const { stdout, unmount } = await mountApp();
    emitAgentEvent('complete', { featureName: 'Notes', featureSlug: 'notes', completedCount: 3, failedCount: 0 });
    await Bun.sleep(50);
    const frame = stdout.last;
    unmount();
    expect(frame).toContain('Feature Complete');
  });
});

describe('App feedback while running and at the end', () => {
  it('lists failed tasks with reasons, the blocked count and the command to retry', async () => {
    const { stdout, unmount } = await mountApp();
    emitAgentEvent('complete', {
      featureName: 'Equipment Resale App',
      featureSlug: 'equipment-resale-app',
      completedCount: 11,
      failedCount: 2,
      blockedCount: 39,
      totalCount: 52,
      failed: [
        { id: 'TASK-003-2', name: 'logger package', reason: '5 attempts: 5× model call failed — last: Model call timed out after 180s' },
        { id: 'TASK-012-1', name: 'receipts', reason: '5 attempts: 4× model call failed, 1× timed out' },
      ],
      blockers: ['TASK-003-2', 'TASK-012-1'],
      userPrompt: 'implement the app described in prd.md',
    });
    await Bun.sleep(50);
    const frame = stdout.last;
    unmount();

    expect(frame).toContain('11 of 52 tasks completed');
    expect(frame).toContain('2 failed');
    expect(frame).toContain('39 blocked (never ran)');
    expect(frame).toContain('✗ TASK-003-2');
    expect(frame).toContain('Model call timed out after 180s');
    expect(frame).toContain('never ran because TASK-003-2, TASK-012-1 failed');
    expect(frame).toContain('oda "implement the app described in prd.md"');
  });

  it('shows what the agent is doing in the status bar', async () => {
    const { stdout, unmount } = await mountApp();
    emitAgentEvent('phase_changed', { phase: 'executing_tasks' });
    emitAgentEvent('model_retry', { label: 'worker.invoke', attempt: 1, maxRetries: 3, delayMs: 2000, error: 'Model call timed out after 180s' });
    await Bun.sleep(50);
    const frame = stdout.last;
    unmount();

    expect(frame).toContain('model call failed — retry 1/3');
    expect(frame).toContain('⟳ model call failed (Model call timed out after 180s)');
  });
});
