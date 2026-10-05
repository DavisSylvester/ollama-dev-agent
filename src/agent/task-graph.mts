import type { Task } from '../types/index.mts';

// Pure dependency-graph helpers shared by the scheduler (graph.mts) and the UI.
// No runtime imports, so the UI can use them without loading the agent.

/**
 * For each pending task that can never run, the failed tasks at the root of
 * its dependency chain (following pending dependencies through). A task whose
 * dependency is unknown or part of a cycle names that dependency instead.
 */
export function blockingRootCauses(tasks: readonly Task[]): Map<string, string[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, string[]>();

  const visit = (id: string, seen: Set<string>): string[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    const task = byId.get(id);
    if (!task || seen.has(id)) return [id];
    if (task.status === 'failed') return [id];
    if (task.status === 'complete') return [];
    seen.add(id);
    const roots = new Set<string>();
    for (const dep of task.dependsOn) {
      for (const root of visit(dep, seen)) roots.add(root);
    }
    seen.delete(id);
    const result = [...roots].sort();
    memo.set(id, result);
    return result;
  };

  const out = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    const roots = new Set<string>();
    for (const dep of task.dependsOn) {
      for (const root of visit(dep, new Set([task.id]))) roots.add(root);
    }
    out.set(task.id, [...roots].sort());
  }
  return out;
}

/**
 * Rewrite dependencies on tasks that no longer exist because they were split.
 * A split replaces TASK-002 with TASK-002-1..n, but tasks that depended on
 * TASK-002 (including the children of other splits, which inherit their
 * parent's dependencies) still name it — and since no task with that id can
 * ever complete, they would never become ready. A dependency on a split
 * parent means "all of its children". A child never depends on its own parent.
 * Ids with no task and no children are left as-is (reported as blockers).
 */
export function resolveSplitDependencies(tasks: readonly Task[]): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.map((task) => {
    if (task.dependsOn.every((dep) => ids.has(dep))) return task;
    const resolved = new Set<string>();
    for (const dep of task.dependsOn) {
      if (ids.has(dep)) {
        resolved.add(dep);
        continue;
      }
      if (task.id.startsWith(`${dep}-`)) continue; // own (former) parent
      const children = tasks.filter((t) => t.id.startsWith(`${dep}-`)).map((t) => t.id);
      if (children.length === 0) {
        resolved.add(dep);
        continue;
      }
      for (const child of children) resolved.add(child);
    }
    resolved.delete(task.id);
    return { ...task, dependsOn: [...resolved] };
  });
}

/** Pending tasks whose dependencies are all complete. */
export function readyTaskIds(tasks: readonly Task[]): Set<string> {
  const done = new Set(tasks.filter((t) => t.status === 'complete').map((t) => t.id));
  return new Set(tasks.filter((t) => t.status === 'pending' && t.dependsOn.every((d) => done.has(d))).map((t) => t.id));
}
