# Restart / Resume + Realtime Progress Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On restart, the agent auto-detects a prior incomplete run, reloads its plan and task statuses from `feature-results/<slug>/state.json`, skips the planning phase, and executes only the tasks that are not already complete. In parallel, a realtime master task board (`feature-results/<slug>/PROGRESS.md`) shows per-task status glyphs and start/completed times across all domains, updated live on every task transition.

**Architecture:** A new pure module `src/agent/run-state.mts` owns the on-disk state (`saveRunState`/`loadRunState`/`findResumableRun`) plus two pure helpers (`normalizeResumedTasks`, `buildRunState`). `DevAgent.run` calls `findResumableRun` before planning; on a hit it seeds the graph with the saved plan and a `resumed` flag. The three planning nodes early-return when `resumed`, so no PRD regeneration / re-size / re-debate happens; the graph flows straight into `run_task`, where the existing `.complete` markers and dependency logic take over. State is persisted after planning and after each task batch. A separate `src/agent/progress-board.mts` renders `PROGRESS.md`; a `ProgressBoard` subscriber attached to `agentEvents` in `DevAgent.run` keeps an event-driven task projection and rewrites the board on every task transition. The graph stamps `startedAt`/`completedAt` onto tasks (persisted in `state.json`) and carries them in event payloads, so `state.json` and `PROGRESS.md` share one source of truth.

**Tech Stack:** BunJS, TypeScript strict, `@langchain/langgraph` state graph, Luxon, `bun test`.

**Reference:** design spec `docs/superpowers/specs/2026-07-16-restart-resume-design.md`.

---

## Conventions (read once)

- `.mts` everywhere; imports include `.mts`; kebab-case filenames; no `any`; explicit return types on exports.
- State files live under `feature-results/<slug>/` (relative to the process cwd), consistent with the existing `SIZING.md` / `RESULTS.md` writes in `graph.mts`.
- Type check: `bunx tsc --noEmit` (baseline is 16 pre-existing unrelated errors in `src/tools/*.mts` and `tests/unit/models/react-agent.test.mts` — add no new ones).

---

## File Structure

- **Create** `src/agent/run-state.mts` — `RunState`, `RUN_STATE_VERSION`, `saveRunState`, `loadRunState`, `findResumableRun`, `normalizeResumedTasks`, `buildRunState`.
- **Create** `tests/unit/agent/run-state.test.mts`.
- **Modify** `src/types/agent.mts` — add `'run_resumed'` to `AgentEventType`; add `fresh?: boolean` to `AgentConfig`.
- **Modify** `src/agent/state.mts` — add `resumed` and `prdFile` annotations.
- **Modify** `src/agent/graph.mts` — export the three planning nodes; early-return them on `resumed`; persist state after planning and after each batch.
- **Modify** `src/agent/index.mts` — resume detection + seeding + `prdFile` in state + `fresh`; attach the `ProgressBoard` subscriber.
- **Modify** `src/index.mts` — `--fresh` CLI flag.
- **Modify** `src/types/task.mts` — add `startedAt` / `completedAt` to `Task`.
- **Create** `src/agent/progress-board.mts` — `buildProgressBoard` renderer + `ProgressBoard` subscriber.
- **Create** `tests/unit/agent/progress-board.test.mts`.
- **Modify** `src/agent/graph.mts` (again, Tasks 11/13) — stamp `startedAt`/`completedAt`; enrich `plan_sized` / `task_split` / `task_started` / `task_complete` / `task_failed` payloads.
- **Modify** `src/types/agent.mts` (again, Task 13) — no new event types needed beyond `run_resumed`.

---

## Task 1: RunState type + save/load round-trip

**Files:**
- Create: `src/agent/run-state.mts`
- Test: `tests/unit/agent/run-state.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/run-state.test.mts`:

```ts
import { describe, expect, it, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { saveRunState, loadRunState, RUN_STATE_VERSION, type RunState } from '../../../src/agent/run-state.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, status: Task['status']): Task {
  return {
    id, name: `name ${id}`, description: 'd', acceptanceCriteria: 'a',
    testCommand: 'bun test', dependsOn: [], domain: 'services', status, iterationCount: 0,
  };
}

function makeState(over: Partial<RunState> = {}): RunState {
  return {
    version: RUN_STATE_VERSION,
    featureSlug: 'notes-app',
    featureName: 'Notes App',
    userPrompt: 'build a notes app',
    prdFile: null,
    workingDirectory: 'C:/proj',
    createdAt: '2026-07-16T12:00:00.000Z',
    updatedAt: '2026-07-16T12:00:00.000Z',
    prd: null as unknown as RunState['prd'],
    tasks: [task('TASK-001', 'complete'), task('TASK-002', 'pending')],
    ...over,
  };
}

afterEach(async () => {
  await rm(join('feature-results', 'notes-app'), { recursive: true, force: true });
});

describe('saveRunState / loadRunState', () => {
  it('round-trips a run state to feature-results/<slug>/state.json', async () => {
    await saveRunState(makeState());
    const loaded = await loadRunState('notes-app');
    expect(loaded).not.toBeNull();
    expect(loaded!.featureSlug).toBe('notes-app');
    expect(loaded!.tasks.map((t) => t.status)).toEqual(['complete', 'pending']);
  });

  it('returns null for a missing state file', async () => {
    expect(await loadRunState('does-not-exist')).toBeNull();
  });

  it('preserves the original createdAt across saves and updates updatedAt', async () => {
    await saveRunState(makeState({ createdAt: '2026-01-01T00:00:00.000Z' }));
    await saveRunState(makeState({ createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' }));
    const loaded = await loadRunState('notes-app');
    expect(loaded!.createdAt).toBe('2026-01-01T00:00:00.000Z'); // first write wins
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent/run-state.test.mts`
Expected: FAIL — cannot find module `run-state.mts`.

- [ ] **Step 3: Create the module (types + save/load)**

Create `src/agent/run-state.mts`:

```ts
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { logger } from '../logger.mts';
import type { PRD, Task } from '../types/index.mts';

export const RUN_STATE_VERSION = 1;

export interface RunState {
  version: number;
  featureSlug: string;
  featureName: string;
  userPrompt: string;
  prdFile: string | null;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
  prd: PRD | null;
  tasks: Task[];
}

function stateDir(featureSlug: string): string {
  return join('feature-results', featureSlug);
}

function statePath(featureSlug: string): string {
  return join(stateDir(featureSlug), 'state.json');
}

// Write state.json. Preserves the createdAt of any existing file so the first
// write's timestamp survives later batch updates; always refreshes updatedAt.
export async function saveRunState(state: RunState): Promise<void> {
  const dir = stateDir(state.featureSlug);
  await mkdir(dir, { recursive: true });

  let createdAt = state.createdAt;
  const existing = await loadRunState(state.featureSlug);
  if (existing) createdAt = existing.createdAt;

  const toWrite: RunState = {
    ...state,
    version: RUN_STATE_VERSION,
    createdAt,
    updatedAt: DateTime.utc().toISO() ?? state.updatedAt,
  };
  await writeFile(statePath(state.featureSlug), JSON.stringify(toWrite, null, 2), 'utf-8');
}

// Read + parse one state file. Returns null on missing/unreadable/malformed or
// version-mismatched content — never throws.
export async function loadRunState(featureSlug: string): Promise<RunState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(featureSlug), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RunState;
    if (parsed.version !== RUN_STATE_VERSION) {
      logger.warn({ featureSlug, version: parsed.version }, 'run_state.version_mismatch');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn({ featureSlug, err: err instanceof Error ? err.message : String(err) }, 'run_state.parse_failed');
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent/run-state.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/run-state.mts tests/unit/agent/run-state.test.mts
git commit -m "feat: run-state persistence (save/load) for resume"
```

---

## Task 2: `findResumableRun`

**Files:**
- Modify: `src/agent/run-state.mts`
- Test: `tests/unit/agent/run-state.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent/run-state.test.mts` (add `findResumableRun` to the import from `run-state.mts`, and extend the `afterEach` cleanup to also remove the extra slugs used below):

```ts
// NOTE: update imports: add findResumableRun
// NOTE: update afterEach to also rm feature-results/other-app and feature-results/done-app

describe('findResumableRun', () => {
  it('matches a generated run by userPrompt + workingDirectory and returns it when tasks remain', async () => {
    await saveRunState(makeState()); // has a pending task
    const found = await findResumableRun('C:/proj', 'build a notes app', null);
    expect(found?.featureSlug).toBe('notes-app');
  });

  it('does not match a different prompt', async () => {
    await saveRunState(makeState());
    expect(await findResumableRun('C:/proj', 'a different app', null)).toBeNull();
  });

  it('does not resume when every task is complete', async () => {
    await saveRunState(makeState({
      featureSlug: 'done-app', userPrompt: 'done prompt',
      tasks: [task('TASK-001', 'complete')],
    }));
    expect(await findResumableRun('C:/proj', 'done prompt', null)).toBeNull();
  });

  it('matches a --prd-file run by prdFile path', async () => {
    await saveRunState(makeState({
      featureSlug: 'other-app', userPrompt: 'ignored', prdFile: '/prds/notes.md',
    }));
    const found = await findResumableRun('C:/proj', 'ignored', '/prds/notes.md');
    expect(found?.featureSlug).toBe('other-app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent/run-state.test.mts`
Expected: FAIL — `findResumableRun` is not exported.

- [ ] **Step 3: Implement `findResumableRun`**

Add to `src/agent/run-state.mts` (and add `readdir` to the `node:fs/promises` import):

```ts
// Scan feature-results/*/state.json for a resumable match: same working dir,
// same identity (prdFile path when given, else userPrompt), and at least one
// task not yet complete. Returns the newest match by updatedAt, or null.
export async function findResumableRun(
  workingDirectory: string,
  userPrompt: string,
  prdFile: string | null,
): Promise<RunState | null> {
  let slugs: string[];
  try {
    slugs = await readdir('feature-results');
  } catch {
    return null;
  }

  const candidates: RunState[] = [];
  for (const slug of slugs) {
    const state = await loadRunState(slug);
    if (!state) continue;

    const sameDir = state.workingDirectory === workingDirectory;
    const idMatch = prdFile != null ? state.prdFile === prdFile : state.userPrompt === userPrompt;
    const hasWork = state.tasks.some((t) => t.status !== 'complete');
    if (sameDir && idMatch && hasWork) candidates.push(state);
  }

  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent/run-state.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/run-state.mts tests/unit/agent/run-state.test.mts
git commit -m "feat: findResumableRun scan for resumable runs"
```

---

## Task 3: `normalizeResumedTasks` + `buildRunState`

**Files:**
- Modify: `src/agent/run-state.mts`
- Test: `tests/unit/agent/run-state.test.mts`

- [ ] **Step 1: Write the failing test**

Append (add `normalizeResumedTasks, buildRunState` to the import):

```ts
describe('normalizeResumedTasks', () => {
  it('keeps complete, resets everything else to pending', () => {
    const out = normalizeResumedTasks([
      task('A', 'complete'),
      task('B', 'in_progress'),
      task('C', 'failed'),
      task('D', 'pending'),
    ]);
    expect(out.map((t) => t.status)).toEqual(['complete', 'pending', 'pending', 'pending']);
  });
});

describe('buildRunState', () => {
  it('assembles a versioned RunState from graph pieces', () => {
    const s = buildRunState({
      featureSlug: 'notes-app', featureName: 'Notes App', userPrompt: 'p',
      prdFile: null, workingDirectory: 'C:/proj', prd: null,
      tasks: [task('TASK-001', 'complete')],
    });
    expect(s.version).toBe(RUN_STATE_VERSION);
    expect(s.featureSlug).toBe('notes-app');
    expect(s.tasks).toHaveLength(1);
    expect(typeof s.createdAt).toBe('string');
    expect(typeof s.updatedAt).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent/run-state.test.mts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers**

Add to `src/agent/run-state.mts`:

```ts
// On resume, only `complete` is terminal — every other status gets a fresh
// attempt. iterationCount is retained for reporting.
export function normalizeResumedTasks(tasks: readonly Task[]): Task[] {
  return tasks.map((t) => (t.status === 'complete' ? t : { ...t, status: 'pending' as const }));
}

export interface BuildRunStateArgs {
  featureSlug: string;
  featureName: string;
  userPrompt: string;
  prdFile: string | null;
  workingDirectory: string;
  prd: PRD | null;
  tasks: Task[];
}

// Assemble a RunState. createdAt/updatedAt are set to now; saveRunState
// preserves the original createdAt if a file already exists.
export function buildRunState(args: BuildRunStateArgs): RunState {
  const now = DateTime.utc().toISO() ?? '';
  return {
    version: RUN_STATE_VERSION,
    featureSlug: args.featureSlug,
    featureName: args.featureName,
    userPrompt: args.userPrompt,
    prdFile: args.prdFile,
    workingDirectory: args.workingDirectory,
    createdAt: now,
    updatedAt: now,
    prd: args.prd,
    tasks: args.tasks,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent/run-state.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/run-state.mts tests/unit/agent/run-state.test.mts
git commit -m "feat: normalizeResumedTasks and buildRunState helpers"
```

---

## Task 4: State annotation — `resumed` + `prdFile`

**Files:**
- Modify: `src/agent/state.mts:17-18`

- [ ] **Step 1: Add the annotations**

In `src/agent/state.mts`, inside `AgentStateAnnotation`, after the `error` line, add:

```ts
  resumed: Annotation<boolean>({ default: () => false, reducer: (_, b) => b }),
  prdFile: Annotation<string | null>({ default: () => null, reducer: (_, b) => b }),
```

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: no new errors. `AgentStateType` now carries `resumed` and `prdFile`.

- [ ] **Step 3: Commit**

```bash
git add src/agent/state.mts
git commit -m "feat: add resumed and prdFile to agent state"
```

---

## Task 5: Types — `run_resumed` event + `AgentConfig.fresh`

**Files:**
- Modify: `src/types/agent.mts:35-55`

- [ ] **Step 1: Add the type members**

In `src/types/agent.mts`, add `fresh?: boolean;` to `AgentConfig`:

```ts
export interface AgentConfig {
  readonly workingDirectory: string;
  readonly maxIterations?: number;
  readonly maxReactSteps?: number;
  readonly prdFile?: string;
  readonly fresh?: boolean;
}
```

And add `'run_resumed'` to `AgentEventType`:

```ts
export type AgentEventType =
  | 'phase_changed'
  | 'prd_generated'
  | 'plan_sized'
  | 'run_resumed'
  | 'prd_approved'
  | 'task_started'
  | 'task_complete'
  | 'task_failed'
  | 'iteration_started'
  | 'worker_output'
  | 'lint_complete'
  | 'reviewer_decision'
  | 'results_generated'
  | 'error';
```

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/agent.mts
git commit -m "feat: run_resumed event type and AgentConfig.fresh"
```

---

## Task 6: Planning nodes skip on resume (exported for test)

**Files:**
- Modify: `src/agent/graph.mts:20-109`
- Test: `tests/unit/agent/graph-resume.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/graph-resume.test.mts`:

```ts
import { describe, expect, it, afterEach } from 'bun:test';
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { draftPlanNode, sizePlanNode, ratifyPlanNode } from '../../../src/agent/graph.mts';
import type { AgentStateType } from '../../../src/agent/state.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, status: Task['status']): Task {
  return {
    id, name: id, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn: [], domain: 'services', status, iterationCount: 0,
  };
}

function resumedState(): AgentStateType {
  return {
    userPrompt: 'p', workingDirectory: 'C:/proj', prd: null,
    featureName: 'Notes App', featureSlug: 'resume-test',
    tasks: [task('TASK-001', 'complete'), task('TASK-002', 'pending')],
    currentIteration: 0, maxIterations: 5, workerOutput: '', reviewerFeedback: '',
    lastDecision: null, phase: 'initializing', error: null, completedTaskIds: [],
    resumed: true, prdFile: null,
  };
}

afterEach(async () => {
  await rm(join('feature-results', 'resume-test'), { recursive: true, force: true });
});

describe('planning nodes on resume', () => {
  it('sizePlanNode skips sizing and writes no SIZING.md when resumed', async () => {
    await sizePlanNode(resumedState());
    let exists = true;
    try {
      await access(join('feature-results', 'resume-test', 'SIZING.md'), constants.F_OK);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false); // no re-size, no report written
  });

  it('draftPlanNode passes through when resumed (no model call)', async () => {
    const out = await draftPlanNode(resumedState());
    expect(out.phase).toBeDefined();
  });

  it('ratifyPlanNode passes through', async () => {
    const out = await ratifyPlanNode(resumedState());
    expect(out.phase).toBe('awaiting_approval');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent/graph-resume.test.mts`
Expected: FAIL — nodes are not exported.

- [ ] **Step 3: Export the nodes and add the resume guards**

In `src/agent/graph.mts`:

Change `async function draftPlanNode` → `export async function draftPlanNode`, and widen its skip condition:

```ts
export async function draftPlanNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // Skip generation on resume, or if a PRD was pre-loaded (e.g. via --prd-file)
  if (state.resumed || state.prd !== null) {
    return { phase: 'sizing_plan' };
  }
  // ... unchanged
```

Change `async function sizePlanNode` → `export async function sizePlanNode`, and add a resume guard at the very top (before `emitAgentEvent`):

```ts
export async function sizePlanNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // On resume the plan is already sized/split and loaded from state.json —
  // do not re-size, re-debate, or rewrite SIZING.md.
  if (state.resumed) {
    return { phase: 'awaiting_approval' };
  }

  emitAgentEvent('phase_changed', { phase: 'sizing_plan' });
  // ... unchanged
```

Change `async function ratifyPlanNode` → `export async function ratifyPlanNode` (body unchanged — it is already a pass-through).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent/graph-resume.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/graph.mts tests/unit/agent/graph-resume.test.mts
git commit -m "feat: skip planning nodes on resume"
```

---

## Task 7: Persist state after planning and after each batch

**Files:**
- Modify: `src/agent/graph.mts` (`sizePlanNode` end, `runTaskNode` end)

- [ ] **Step 1: Add the imports**

In `src/agent/graph.mts`, add near the other imports:

```ts
import { saveRunState, buildRunState } from './run-state.mts';
```

- [ ] **Step 2: Persist after planning**

At the end of `sizePlanNode` (the non-resumed path), replace the final `return { tasks: result.tasks, phase: 'awaiting_approval' };` with a persist-then-return:

```ts
  await saveRunState(
    buildRunState({
      featureSlug: state.featureSlug,
      featureName: state.featureName,
      userPrompt: state.userPrompt,
      prdFile: state.prdFile,
      workingDirectory: state.workingDirectory,
      prd: state.prd,
      tasks: result.tasks,
    }),
  ).catch(() => {
    // Persistence is best-effort — a write failure must not abort the run.
  });

  return { tasks: result.tasks, phase: 'awaiting_approval' };
```

- [ ] **Step 3: Persist after each task batch**

At the end of `runTaskNode`, replace the final `return { tasks: mergedTasks, completedTaskIds: completedIds, phase: 'executing_tasks' };` with:

```ts
  await saveRunState(
    buildRunState({
      featureSlug: state.featureSlug,
      featureName: state.featureName,
      userPrompt: state.userPrompt,
      prdFile: state.prdFile,
      workingDirectory: state.workingDirectory,
      prd: state.prd,
      tasks: mergedTasks,
    }),
  ).catch(() => {
    // Best-effort — do not abort the run on a state write failure.
  });

  return { tasks: mergedTasks, completedTaskIds: completedIds, phase: 'executing_tasks' };
```

(There are two `return` sites in `runTaskNode`: the early "nothing ready / blocked" return and the main return. Add the persist block only before the **main** return shown above. The blocked-return path changes no statuses that need a fresh write.)

- [ ] **Step 4: Type check + existing suites**

Run: `bunx tsc --noEmit` — no new errors.
Run: `bun test tests/unit/agent/ tests/unit/prd/` — all green (buildRunState/saveRunState already covered in Task 1/3; this task is thin glue).

- [ ] **Step 5: Commit**

```bash
git add src/agent/graph.mts
git commit -m "feat: persist run state after planning and each task batch"
```

---

## Task 8: Resume wiring in `DevAgent.run`

**Files:**
- Modify: `src/agent/index.mts:12-50`

- [ ] **Step 1: Add resume detection and seeding**

In `src/agent/index.mts`, add imports:

```ts
import { findResumableRun, normalizeResumedTasks } from './run-state.mts';
```

Then, inside `run`, after `await assertOllamaReachable();` and building `const graph`, replace the `initialState` construction block with resume-aware seeding:

```ts
    const prdFile = this.config.prdFile ?? null;

    const initialState: Record<string, unknown> = {
      userPrompt: prompt,
      workingDirectory: this.config.workingDirectory,
      maxIterations: this.config.maxIterations ?? env.MAX_ITERATIONS,
      prdFile,
    };

    // Resume: unless --fresh, look for a prior incomplete run for this work and
    // reload its plan + statuses, skipping the planning phase entirely.
    const resumable = this.config.fresh
      ? null
      : await findResumableRun(this.config.workingDirectory, prompt, prdFile);

    if (resumable) {
      const tasks = normalizeResumedTasks(resumable.tasks);
      initialState['resumed'] = true;
      initialState['prd'] = resumable.prd;
      initialState['featureName'] = resumable.featureName;
      initialState['featureSlug'] = resumable.featureSlug;
      initialState['tasks'] = tasks;
      emitAgentEvent('run_resumed', {
        featureSlug: resumable.featureSlug,
        featureName: resumable.featureName,
        totalTasks: tasks.length,
        remainingTasks: tasks.filter((t) => t.status !== 'complete').length,
      });
    } else if (this.config.prdFile) {
      const prd = await loadPRDFromFile(this.config.prdFile);
      initialState['prd'] = prd;
      initialState['featureName'] = prd.featureName;
      initialState['featureSlug'] = prd.featureSlug;
      initialState['tasks'] = prd.tasks;
      emitAgentEvent('prd_generated', {
        prd,
        featureName: prd.featureName,
        featureSlug: prd.featureSlug,
        taskCount: prd.tasks.length,
        prdMarkdown: prd.rawMarkdown,
      });
    }
```

Leave the `recursionLimit` calculation and `graph.invoke` as-is (they already read `initialState['tasks']`).

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Manual resume verification (documented)**

This node-level glue is covered indirectly by the Task 1–3 unit tests (`findResumableRun`, `normalizeResumedTasks`) and the Task 6 skip tests. A full live resume is verified by the smoke in Task 10.

- [ ] **Step 4: Commit**

```bash
git add src/agent/index.mts
git commit -m "feat: auto-detect and resume a prior run in DevAgent"
```

---

## Task 9: `--fresh` CLI flag

**Files:**
- Modify: `src/index.mts:30-76`

- [ ] **Step 1: Add the option and thread it into config**

In `src/index.mts`, add the option in the `.option(...)` chain (near `--no-research`):

```ts
  .option('--fresh', 'Ignore any saved state and start a clean run (no resume)')
```

Add `fresh?: boolean;` to the `opts` type in the `program.opts<{...}>()` generic.

Add `fresh` to the `config` object:

```ts
const config: AgentConfig = {
  workingDirectory,
  maxIterations,
  ...(opts.prdFile ? { prdFile: opts.prdFile } : {}),
  ...(opts.fresh ? { fresh: true } : {}),
};
```

- [ ] **Step 2: Verify the flag parses**

Run: `bun run src/index.mts --help 2>&1 | grep -i fresh`
Expected: the `--fresh` line appears.
Run: `bunx tsc --noEmit` — no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.mts
git commit -m "feat: --fresh flag to bypass resume"
```

---

## Task 10: Resume smoke script

Proves end-to-end that a saved state with a completed task is detected and only the remaining task is scheduled — without invoking any model.

**Files:**
- Create: `scripts/resume-smoke.mts`

- [ ] **Step 1: Write the script**

Create `scripts/resume-smoke.mts`:

```ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { saveRunState, findResumableRun, normalizeResumedTasks, RUN_STATE_VERSION } from '../src/agent/run-state.mts';
import type { Task } from '../src/types/index.mts';

function task(id: string, status: Task['status'], dependsOn: string[] = []): Task {
  return {
    id, name: id, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn, domain: 'services', status, iterationCount: 0,
  };
}

async function main(): Promise<void> {
  const slug = 'resume-smoke';
  await rm(join('feature-results', slug), { recursive: true, force: true });

  await saveRunState({
    version: RUN_STATE_VERSION,
    featureSlug: slug, featureName: 'Resume Smoke', userPrompt: 'resume smoke prompt',
    prdFile: null, workingDirectory: process.cwd(),
    createdAt: '', updatedAt: '', prd: null,
    tasks: [task('TASK-001', 'complete'), task('TASK-002', 'failed', ['TASK-001'])],
  });

  const found = await findResumableRun(process.cwd(), 'resume smoke prompt', null);
  if (!found) throw new Error('expected a resumable run');

  const normalized = normalizeResumedTasks(found.tasks);
  const remaining = normalized.filter((t) => t.status !== 'complete').map((t) => t.id);
  console.log('Resumable slug:', found.featureSlug);
  console.log('Remaining tasks:', remaining.join(', '));

  if (remaining.length !== 1 || remaining[0] !== 'TASK-002') {
    throw new Error(`expected only TASK-002 to remain, got: ${remaining.join(', ')}`);
  }

  await rm(join('feature-results', slug), { recursive: true, force: true });
  console.log('Resume smoke OK');
}

main().catch((err) => {
  console.error('Resume smoke FAILED:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `bun run scripts/resume-smoke.mts`
Expected: prints `Remaining tasks: TASK-002` and `Resume smoke OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/resume-smoke.mts
git commit -m "test: resume detection smoke script"
```

---

## Task 11: `startedAt` / `completedAt` on `Task`

**Files:**
- Modify: `src/types/task.mts`

- [ ] **Step 1: Add the fields**

In `src/types/task.mts`, add to the `Task` interface (after `iterationCount`):

```ts
  startedAt?: string | null;
  completedAt?: string | null;
```

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: no new errors (fields are optional; existing task literals still compile).

- [ ] **Step 3: Commit**

```bash
git add src/types/task.mts
git commit -m "feat: add startedAt/completedAt to Task"
```

---

## Task 12: Progress-board renderer + timing helpers

**Files:**
- Create: `src/agent/progress-board.mts`
- Test: `tests/unit/agent/progress-board.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/progress-board.test.mts`:

```ts
import { describe, expect, it } from 'bun:test';
import { buildProgressBoard, stampStarted, stampFinished } from '../../../src/agent/progress-board.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, domain: Task['domain'], status: Task['status'], over: Partial<Task> = {}): Task {
  return {
    id, name: `name ${id}`, description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn: [], domain, status, iterationCount: 0, ...over,
  };
}

describe('buildProgressBoard', () => {
  const tasks = [
    task('TASK-001', 'database', 'complete', { startedAt: '2026-07-16T12:00:03.000Z', completedAt: '2026-07-16T12:00:41.000Z' }),
    task('TASK-002', 'database', 'in_progress', { startedAt: '2026-07-16T12:00:41.000Z' }),
    task('TASK-003', 'ui', 'pending'),
    task('TASK-004', 'api', 'failed', { startedAt: '2026-07-16T12:01:00.000Z', completedAt: '2026-07-16T12:02:00.000Z' }),
  ];

  it('renders each glyph, groups by domain, and shows times', () => {
    const md = buildProgressBoard('Notes App', 'notes-app', tasks);
    expect(md).toContain('[✓] TASK-001');
    expect(md).toContain('[-] TASK-002');
    expect(md).toContain('[ ] TASK-003');
    expect(md).toContain('[X] TASK-004');
    expect(md).toContain('## database');
    expect(md).toContain('## ui');
    expect(md).toContain('started 2026-07-16T12:00:03.000Z');
    expect(md).toContain('done 2026-07-16T12:00:41.000Z');
  });

  it('renders a summary line with the counts', () => {
    const md = buildProgressBoard('Notes App', 'notes-app', tasks);
    expect(md).toContain('1 / 4 complete');
    expect(md).toContain('1 in-progress');
    expect(md).toContain('1 failed');
  });

  it('omits domains that have no tasks', () => {
    const md = buildProgressBoard('X', 'x', [task('T1', 'ui', 'pending')]);
    expect(md).toContain('## ui');
    expect(md).not.toContain('## database');
  });
});

describe('stampStarted / stampFinished', () => {
  it('stampStarted sets in_progress and a startedAt', () => {
    const t = stampStarted(task('T1', 'ui', 'pending'));
    expect(t.status).toBe('in_progress');
    expect(typeof t.startedAt).toBe('string');
  });
  it('stampFinished sets the status and a completedAt', () => {
    const t = stampFinished(task('T1', 'ui', 'in_progress'), 'complete');
    expect(t.status).toBe('complete');
    expect(typeof t.completedAt).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent/progress-board.test.mts`
Expected: FAIL — cannot find module `progress-board.mts`.

- [ ] **Step 3: Implement the renderer + helpers**

Create `src/agent/progress-board.mts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { TASK_DOMAINS } from '../types/index.mts';
import type { Task } from '../types/index.mts';

const GLYPH: Record<Task['status'], string> = {
  pending: '[ ]',
  in_progress: '[-]',
  complete: '[✓]',
  failed: '[X]',
};

function nowIso(): string {
  return DateTime.utc().toISO() ?? '';
}

export function stampStarted(task: Task): Task {
  return { ...task, status: 'in_progress', startedAt: nowIso() };
}

export function stampFinished(task: Task, status: 'complete' | 'failed'): Task {
  return { ...task, status, completedAt: nowIso() };
}

function row(t: Task): string {
  const times = [
    t.startedAt ? `started ${t.startedAt}` : '',
    t.completedAt ? `done ${t.completedAt}` : '',
  ]
    .filter((s) => s.length > 0)
    .join('  ');
  const suffix = times.length > 0 ? `  ${times}` : '';
  return `- ${GLYPH[t.status]} ${t.id}  ${t.name}${suffix}`;
}

// Pure renderer for feature-results/<slug>/PROGRESS.md: one section per domain
// (in TASK_DOMAINS order, empty domains omitted) plus a summary line.
export function buildProgressBoard(
  featureName: string,
  featureSlug: string,
  tasks: readonly Task[],
): string {
  const complete = tasks.filter((t) => t.status === 'complete').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;

  const sections = TASK_DOMAINS.map((domain) => {
    const inDomain = tasks.filter((t) => t.domain === domain);
    if (inDomain.length === 0) return '';
    return `## ${domain}\n\n${inDomain.map(row).join('\n')}`;
  }).filter((s) => s.length > 0);

  return `# Progress: ${featureName}

**Feature Slug**: ${featureSlug}
**Updated**: ${nowIso()}

✓ ${complete} / ${tasks.length} complete · ${inProgress} in-progress · ${failed} failed

${sections.join('\n\n')}
`;
}

export async function writeProgressBoard(
  featureName: string,
  featureSlug: string,
  tasks: readonly Task[],
): Promise<void> {
  const dir = join('feature-results', featureSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'PROGRESS.md'), buildProgressBoard(featureName, featureSlug, tasks), 'utf-8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent/progress-board.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/progress-board.mts tests/unit/agent/progress-board.test.mts
git commit -m "feat: progress-board renderer and task timing helpers"
```

---

## Task 13: Stamp times + enrich event payloads in the graph

**Files:**
- Modify: `src/agent/graph.mts` (`runTaskNode`, `runSingleTask`, `sizePlanNode`)
- Modify: `src/agent/index.mts` (`run_resumed` payload — add `tasks`)

- [ ] **Step 1: Add the import**

In `src/agent/graph.mts`, add:

```ts
import { stampStarted, stampFinished } from './progress-board.mts';
```

- [ ] **Step 2: Stamp `startedAt` on ready tasks and pass the stamped tasks to the runner**

In `runTaskNode`, replace the `tasksWithProgress` map and the `Promise.allSettled` call:

```ts
  // Mark ready tasks as in_progress (stamping startedAt) before launching
  const tasksWithProgress: Task[] = state.tasks.map((t) =>
    readyTasks.some((r) => r.id === t.id) ? stampStarted(t) : t,
  );
  const stampedReady = tasksWithProgress.filter((t) => readyTasks.some((r) => r.id === t.id));

  emitAgentEvent('phase_changed', { phase: 'executing_tasks' });

  // Run all ready tasks in parallel
  const results = await Promise.allSettled(
    stampedReady.map((task) => runSingleTask(task, state, tasksWithProgress)),
  );
```

Then replace every remaining use of `readyTasks[i]` in the merge loop and the auto-split loop with `stampedReady[i]` (the ids are identical, but `stampedReady` carries `startedAt`). Concretely, in both `for (let i = 0; i < readyTasks.length; i++)` loops change the bound to `stampedReady.length` and the element access to `stampedReady[i]!`.

- [ ] **Step 3: Stamp `completedAt` and enrich task events in `runSingleTask`**

In `runSingleTask`, replace the `task_started` emit, the completion emits, and the return:

```ts
  emitAgentEvent('task_started', {
    taskId: task.id,
    taskName: task.name,
    startedAt: task.startedAt ?? null,
    taskIndex: currentTasks.findIndex((t) => t.id === task.id),
    totalTasks: currentTasks.length,
  });
```

```ts
  const finished = stampFinished(task, finalStatus === 'complete' ? 'complete' : 'failed');

  if (finalStatus === 'complete') {
    emitAgentEvent('task_complete', {
      taskId: task.id,
      taskName: task.name,
      iterations: lastIterationCount,
      completedAt: finished.completedAt ?? null,
    });
  } else {
    emitAgentEvent('task_failed', {
      taskId: task.id,
      taskName: task.name,
      iterations: lastIterationCount,
      reason: `Exhausted ${state.maxIterations} iterations without SHIP decision`,
      completedAt: finished.completedAt ?? null,
    });
  }

  return { ...finished, iterationCount: lastIterationCount };
```

- [ ] **Step 4: Stamp + enrich the blocked-dependency path and the auto-split event**

In `runTaskNode`'s blocked branch, stamp the failed tasks and add `completedAt`:

```ts
    const blockedIds = new Set(blocked.map((t) => t.id));
    const mergedTasks: Task[] = state.tasks.map((t) =>
      blockedIds.has(t.id) ? stampFinished(t, 'failed') : t,
    );

    for (const t of blocked) {
      emitAgentEvent('task_failed', {
        taskId: t.id,
        taskName: t.name,
        iterations: 0,
        reason: 'Blocked by a failed dependency',
        completedAt: nowIsoOrNull(mergedTasks, t.id),
      });
    }
```

Add this small helper near the top of `graph.mts` (module scope):

```ts
function nowIsoOrNull(tasks: Task[], id: string): string | null {
  return tasks.find((t) => t.id === id)?.completedAt ?? null;
}
```

In the auto-split loop, enrich the `task_split` emit with child rows:

```ts
        emitAgentEvent('task_split', {
          taskId: failed.id,
          subTaskIds: subTasks.map((s) => s.id),
          count: subTasks.length,
          children: subTasks.map((s) => ({ id: s.id, name: s.name, domain: s.domain })),
        });
```

- [ ] **Step 5: Enrich `plan_sized` and `run_resumed`**

In `sizePlanNode`, add `tasks` to the `plan_sized` emit:

```ts
  emitAgentEvent('plan_sized', {
    distribution: result.distribution,
    splits: result.splits,
    recommendations: result.recommendations,
    taskCount: result.tasks.length,
    tasks: result.tasks,
  });
```

In `src/agent/index.mts`, add `tasks` to the `run_resumed` emit (from Task 8):

```ts
      emitAgentEvent('run_resumed', {
        featureSlug: resumable.featureSlug,
        featureName: resumable.featureName,
        totalTasks: tasks.length,
        remainingTasks: tasks.filter((t) => t.status !== 'complete').length,
        tasks,
      });
```

- [ ] **Step 6: Verify**

Run: `bunx tsc --noEmit` — no new errors.
Run: `bun test tests/unit/agent/ tests/unit/prd/` — green (Task 6 graph-resume tests still pass; stamping does not run on the resumed skip path).

- [ ] **Step 7: Commit**

```bash
git add src/agent/graph.mts src/agent/index.mts
git commit -m "feat: stamp task times and enrich events for the progress board"
```

---

## Task 14: Realtime `ProgressBoard` subscriber + wiring

**Files:**
- Modify: `src/agent/progress-board.mts` (add `startProgressBoard`)
- Modify: `src/agent/index.mts` (attach in `run`)
- Test: `tests/unit/agent/progress-board.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agent/progress-board.test.mts`:

```ts
import { afterEach } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startProgressBoard } from '../../../src/agent/progress-board.mts';
import { emitAgentEvent } from '../../../src/agent/events.mts';

afterEach(async () => {
  await rm(join('feature-results', 'board-test'), { recursive: true, force: true });
});

async function readBoard(): Promise<string> {
  return readFile(join('feature-results', 'board-test', 'PROGRESS.md'), 'utf-8');
}

describe('startProgressBoard (realtime)', () => {
  it('writes PROGRESS.md and updates it on task events', async () => {
    const board = startProgressBoard();
    try {
      emitAgentEvent('prd_generated', {
        featureName: 'Board Test',
        featureSlug: 'board-test',
        prd: { tasks: [task('TASK-001', 'services', 'pending'), task('TASK-002', 'services', 'pending')] },
      });
      // let the async file writes settle
      await new Promise((r) => setTimeout(r, 20));
      expect(await readBoard()).toContain('[ ] TASK-001');

      emitAgentEvent('task_started', { taskId: 'TASK-001', startedAt: '2026-07-16T12:00:00.000Z' });
      await new Promise((r) => setTimeout(r, 20));
      expect(await readBoard()).toContain('[-] TASK-001');

      emitAgentEvent('task_complete', { taskId: 'TASK-001', completedAt: '2026-07-16T12:00:30.000Z' });
      await new Promise((r) => setTimeout(r, 20));
      const md = await readBoard();
      expect(md).toContain('[✓] TASK-001');
      expect(md).toContain('done 2026-07-16T12:00:30.000Z');
    } finally {
      board.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent/progress-board.test.mts`
Expected: FAIL — `startProgressBoard` is not exported.

- [ ] **Step 3: Implement `startProgressBoard`**

Add to `src/agent/progress-board.mts` (add the imports for the event emitter and types):

```ts
import { agentEvents } from './events.mts';
import type { TaskDomain } from '../types/index.mts';

interface AgentEventEnvelope {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Subscribe to the agent event stream and rewrite PROGRESS.md live on every
// task transition. Keeps its own task projection so it never reads graph state.
export function startProgressBoard(): { stop: () => void } {
  let featureName = '';
  let featureSlug = '';
  let tasks: Task[] = [];

  const flush = (): void => {
    if (featureSlug.length === 0) return;
    void writeProgressBoard(featureName, featureSlug, tasks).catch(() => {
      // best-effort — a board write must never disrupt the run
    });
  };

  const seed = (evt: AgentEventEnvelope): void => {
    const p = evt.payload;
    if (typeof p['featureName'] === 'string') featureName = p['featureName'];
    if (typeof p['featureSlug'] === 'string') featureSlug = p['featureSlug'];
    const list = (p['tasks'] as Task[] | undefined) ??
      ((p['prd'] as { tasks?: Task[] } | undefined)?.tasks);
    if (Array.isArray(list)) tasks = list.map((t) => ({ ...t }));
    flush();
  };

  const update = (id: string, patch: Partial<Task>): void => {
    tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
    flush();
  };

  const onStarted = (e: AgentEventEnvelope): void =>
    update(String(e.payload['taskId']), { status: 'in_progress', startedAt: (e.payload['startedAt'] as string) ?? null });
  const onComplete = (e: AgentEventEnvelope): void =>
    update(String(e.payload['taskId']), { status: 'complete', completedAt: (e.payload['completedAt'] as string) ?? null });
  const onFailed = (e: AgentEventEnvelope): void =>
    update(String(e.payload['taskId']), { status: 'failed', completedAt: (e.payload['completedAt'] as string) ?? null });
  const onSplit = (e: AgentEventEnvelope): void => {
    const parentId = String(e.payload['taskId']);
    const children = (e.payload['children'] as Array<{ id: string; name: string; domain: TaskDomain }>) ?? [];
    const idx = tasks.findIndex((t) => t.id === parentId);
    const childTasks: Task[] = children.map((c) => ({
      id: c.id, name: c.name, description: '', acceptanceCriteria: '', testCommand: '',
      dependsOn: [], domain: c.domain, status: 'pending', iterationCount: 0,
    }));
    if (idx >= 0) tasks = [...tasks.slice(0, idx), ...childTasks, ...tasks.slice(idx + 1)];
    else tasks = [...tasks, ...childTasks];
    flush();
  };

  agentEvents.on('prd_generated', seed);
  agentEvents.on('plan_sized', seed);
  agentEvents.on('run_resumed', seed);
  agentEvents.on('task_started', onStarted);
  agentEvents.on('task_complete', onComplete);
  agentEvents.on('task_failed', onFailed);
  agentEvents.on('task_split', onSplit);

  return {
    stop: (): void => {
      agentEvents.off('prd_generated', seed);
      agentEvents.off('plan_sized', seed);
      agentEvents.off('run_resumed', seed);
      agentEvents.off('task_started', onStarted);
      agentEvents.off('task_complete', onComplete);
      agentEvents.off('task_failed', onFailed);
      agentEvents.off('task_split', onSplit);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/agent/progress-board.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Wire it into `DevAgent.run`**

In `src/agent/index.mts`, import and attach the board around `graph.invoke`:

```ts
import { startProgressBoard } from './progress-board.mts';
```

```ts
    const board = startProgressBoard();
    try {
      await graph.invoke(initialState, { recursionLimit });
    } finally {
      board.stop();
    }
```

- [ ] **Step 6: Verify**

Run: `bunx tsc --noEmit` — no new errors.
Run: `bun test tests/unit/agent/` — all green.

- [ ] **Step 7: Commit**

```bash
git add src/agent/progress-board.mts src/agent/index.mts
git commit -m "feat: realtime PROGRESS.md board driven by agent events"
```

---

## Final Verification

- [ ] `bun test tests/unit/agent/` — all green.
- [ ] `bun run scripts/resume-smoke.mts` — `Resume smoke OK`.
- [ ] `bunx tsc --noEmit` — only the 16 pre-existing baseline errors.
- [ ] Manual: run the agent with `--prd-file <p>`; while it runs, open `feature-results/<slug>/PROGRESS.md` and confirm tasks flip `[ ] → [-] → [✓]`/`[X]` in real time with start/done times, grouped by domain. Kill it after 1–2 tasks complete, re-run the same command — confirm a `run_resumed` event, that completed tasks are not re-executed, and that `PROGRESS.md` shows the completed tasks with their prior times immediately. Re-run with `--fresh` — confirm a clean full run.
