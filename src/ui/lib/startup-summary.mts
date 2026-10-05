import { readyTaskIds, resolveSplitDependencies } from '../../agent/task-graph.mts';
import type { Task } from '../../types/index.mts';

// The status table printed once when a run starts: every task, what state it
// is in, and what happens to it in this run.

export type StartupState = 'done' | 'retry' | 'ready' | 'waiting';

export interface StartupRow {
  id: string;
  name: string;
  state: StartupState;
  // Why: the previous failure reason, or the unfinished tasks it waits on.
  note: string;
}

export interface StartupSummary {
  resumed: boolean;
  rows: StartupRow[];
  counts: Record<StartupState, number>;
}

/**
 * Build the start-of-run table. `previous` holds the statuses the last run
 * left (failed/blocked) before a resume reset them to pending; pass [] for a
 * fresh run. Split-parent dependencies are resolved the way the scheduler
 * resolves them, so "ready" and "waiting on" match what will actually run.
 */
export function buildStartupSummary(tasks: readonly Task[], previous: readonly Task[], resumed: boolean): StartupSummary {
  const resolved = resolveSplitDependencies(tasks);
  const ready = readyTaskIds(resolved);
  const before = new Map(previous.map((t) => [t.id, t]));
  const complete = new Set(resolved.filter((t) => t.status === 'complete').map((t) => t.id));

  const rows = resolved.map((task): StartupRow => {
    if (task.status === 'complete') return { id: task.id, name: task.name, state: 'done', note: '' };

    const prior = before.get(task.id);
    if (prior?.status === 'failed') {
      return { id: task.id, name: task.name, state: 'retry', note: prior.failureReason ?? 'failed in the last run' };
    }
    if (ready.has(task.id)) {
      const note = prior?.status === 'blocked' ? 'was blocked — its dependencies are now done' : '';
      return { id: task.id, name: task.name, state: 'ready', note };
    }
    const waitingOn = task.dependsOn.filter((dep) => !complete.has(dep));
    return { id: task.id, name: task.name, state: 'waiting', note: waitingOn.length > 0 ? `waits on ${waitingOn.join(', ')}` : '' };
  });

  const counts: Record<StartupState, number> = { done: 0, retry: 0, ready: 0, waiting: 0 };
  for (const row of rows) counts[row.state]++;
  return { resumed, rows, counts };
}
