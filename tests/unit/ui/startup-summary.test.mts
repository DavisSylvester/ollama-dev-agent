import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { buildStartupSummary } from '../../../src/ui/lib/startup-summary.mts';
import { App } from '../../../src/ui/App.tsx';
import { emitAgentEvent } from '../../../src/agent/events.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, status: Task['status'], dependsOn: string[] = [], extra: Partial<Task> = {}): Task {
  return {
    id, name: `${id} name`, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn, domain: 'services', status, iterationCount: 0, ...extra,
  };
}

describe('buildStartupSummary', () => {
  it('classifies every task for a resumed run', () => {
    const previous = [
      task('A', 'complete'),
      task('B', 'failed', [], { failureReason: '5 attempts: 5× model call failed' }),
      task('C-1', 'complete'),
      task('D', 'blocked', ['C'], { blockedBy: ['B'] }),
      task('E', 'blocked', ['B']),
    ];
    // What the resume hands the scheduler: everything not complete reset to pending.
    const tasks = previous.map((t) => (t.status === 'complete' ? t : { ...t, status: 'pending' as const }));

    const s = buildStartupSummary(tasks, previous, true);
    const byId = new Map(s.rows.map((r) => [r.id, r]));

    expect(byId.get('A')?.state).toBe('done');
    expect(byId.get('B')).toMatchObject({ state: 'retry', note: '5 attempts: 5× model call failed' });
    // D depended on split parent C, whose child C-1 is done: ready now.
    expect(byId.get('D')).toMatchObject({ state: 'ready', note: 'was blocked — its dependencies are now done' });
    expect(byId.get('E')).toMatchObject({ state: 'waiting', note: 'waits on B' });
    expect(s.counts).toEqual({ done: 2, retry: 1, ready: 1, waiting: 1 });
  });

  it('marks independent tasks ready on a fresh run', () => {
    const s = buildStartupSummary([task('A', 'pending'), task('B', 'pending', ['A'])], [], false);
    expect(s.rows.map((r) => r.state)).toEqual(['ready', 'waiting']);
  });
});

class FakeStdout extends EventEmitter {

  public columns = 120;
  public rows = 60;
  public frames: string[] = [];

  public write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }
}

describe('App start-of-run status', () => {
  it('prints the status of every task when a run resumes', async () => {
    const stdout = new FakeStdout();
    const app = render(React.createElement(App, { version: '0.1.0', onAgentStart: () => {}, autoApprove: true }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    });
    await Bun.sleep(50);
    const previous = [task('TASK-001', 'complete'), task('TASK-002', 'failed', [], { failureReason: 'model timed out' }), task('TASK-003', 'pending', ['TASK-002'])];
    emitAgentEvent('run_resumed', {
      featureName: 'Notes',
      featureSlug: 'notes',
      tasks: previous.map((t) => (t.status === 'complete' ? t : { ...t, status: 'pending' as const })),
      previousTasks: previous,
    });
    await Bun.sleep(50);
    const all = stdout.frames.join('');
    app.unmount();

    expect(all).toContain('Resuming Notes — 3 tasks');
    expect(all).toContain('1 done · 1 to retry · 0 ready now · 1 waiting on other tasks');
    expect(all).toContain('TASK-002');
    expect(all).toContain('model timed out');
    expect(all).toContain('waits on TASK-002');
  });
});
