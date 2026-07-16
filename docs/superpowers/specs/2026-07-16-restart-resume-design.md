# Restart / Resume + Realtime Progress Board — Design Spec

**Date:** 2026-07-16
**Status:** Approved

## 1. Problem

When the ODA agent is restarted, it starts a full rerun: `DevAgent.run` regenerates the PRD (unless `--prd-file`), re-sizes and re-debates the plan, and re-executes every task from `pending`. A per-task `.complete` marker already lets `RalphLoop.runTask` short-circuit a finished task (`src/ralph/loop.mts:54-60`), but on a *generated* PRD the regenerated plan is non-deterministic, so task IDs and the feature slug can drift and the markers no longer match. The planning phase always re-runs regardless. The result is wasted work and, for generated PRDs, effectively a full rerun.

## 2. Goal

On restart, the agent detects a prior incomplete run for the same work, reloads its plan and task statuses, skips the planning phase, and executes only the tasks that are not already complete.

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Trigger | **Auto-detect** a resumable run on startup; `--fresh` forces a clean rerun that ignores/overwrites saved state. |
| 2 | Skip scope | **Skip planning + completed tasks.** Reload the persisted sized/split plan (no PRD regen, no re-size, no re-debate); run only non-complete tasks. |
| 3 | Task-state semantics | **Only `complete` is terminal.** On resume, `in_progress`, `failed`, and `pending` all normalize to `pending` and get a fresh attempt. |
| 4 | State storage | `feature-results/<slug>/state.json` — human-readable JSON alongside `RESULTS.md` and `SIZING.md`. |
| 5 | Identity | Match a saved run by identical `userPrompt` + `workingDirectory`; when `--prd-file` was used, match by the deterministic `featureSlug`. Resume only if the match has at least one non-complete task; newest wins if several match. |

## 4. State file

`feature-results/<slug>/state.json`:

```jsonc
{
  "version": 1,
  "featureSlug": "notes-app",
  "featureName": "Notes App",
  "userPrompt": "build a notes app",   // the resume key for generated PRDs
  "prdFile": null,                       // set when started via --prd-file
  "workingDirectory": "C:/path/to/project",
  "createdAt": "2026-07-16T12:00:00.000Z",
  "updatedAt": "2026-07-16T12:03:00.000Z",
  "prd": { /* full PRD object */ },
  "tasks": [ /* full sized/split Task[] with current status */ ]
}
```

The `tasks` array always reflects the *current, post-split* task list, so IDs stay stable across restarts. `version` gates schema compatibility.

## 5. New module: `src/agent/run-state.mts`

```ts
export interface RunState {
  version: number;
  featureSlug: string;
  featureName: string;
  userPrompt: string;
  prdFile: string | null;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
  prd: PRD;
  tasks: Task[];
}

export const RUN_STATE_VERSION = 1;

// Write/overwrite feature-results/<slug>/state.json (updates updatedAt).
export function saveRunState(state: RunState): Promise<void>;

// Read + parse one state file; returns null on missing/unreadable/version-mismatch.
export function loadRunState(featureSlug: string): Promise<RunState | null>;

// Scan feature-results/*/state.json for a resumable match. Returns the newest
// match (by updatedAt) that has >=1 non-complete task, or null.
export function findResumableRun(
  workingDirectory: string,
  userPrompt: string,
  prdFile: string | null,
): Promise<RunState | null>;
```

- `findResumableRun` matches on `prdFile ? featureSlug : (userPrompt && workingDirectory)`. A run whose tasks are all `complete` is not resumable (nothing to do).
- All reads degrade gracefully: a malformed or version-mismatched file is skipped with a `logger.warn`, never thrown.

## 6. Resume flow

### `src/agent/index.mts` (`DevAgent.run`)

1. If not `--fresh`, call `findResumableRun(workingDirectory, prompt, prdFile)`.
2. On a hit, seed `initialState` from the saved run: `prd`, `featureName`, `featureSlug`, `tasks` (status-normalized — see below), and `resumed: true`. Emit a `run_resumed` event with the slug and the count of remaining tasks. Skip the normal `--prd-file` seeding branch.
3. On a miss (or `--fresh`), proceed exactly as today.

**Status normalization** (applied when seeding a resumed run): `complete` stays `complete`; every other status → `pending`. `iterationCount` is retained for reporting.

### State annotation (`src/agent/state.mts`)

Add two fields so the nodes can persist a complete `state.json`:
- `resumed: Annotation<boolean>({ default: () => false, reducer: (_, b) => b })`
- `prdFile: Annotation<string | null>({ default: () => null, reducer: (_, b) => b })` — seeded from `AgentConfig.prdFile` in `DevAgent.run` (needed as the resume key and to persist it in state).

### Planning nodes (`src/agent/graph.mts`)

`draftPlanNode`, `sizePlanNode`, `ratifyPlanNode` each early-return a pass-through when `state.resumed` is true (no PRD generation, no sizing, no debate, no SIZING.md rewrite). `draftPlanNode` already has a skip branch for a pre-loaded PRD; extend that condition to include `resumed`. The graph wiring is unchanged; the resumed plan flows straight through to `run_task`, and `findReadyTasks` selects the non-complete tasks respecting `dependsOn`.

### Persistence points

- **After planning:** at the end of `sizePlanNode` (plan finalized), write `state.json` with the full sized task list (all `pending`). On a resumed run this node is skipped, so a resume does not rewrite the plan.
- **After each `run_task` batch:** at the end of `runTaskNode`, write `state.json` with the merged task list (statuses + any auto-split children). This makes a crash resumable to the last completed batch.

`RalphLoop`'s existing `.complete` short-circuit remains as a second line of defence: even if a `complete` task were re-queued, the worker/reviewer would not re-run.

## 7. CLI

Add a `--fresh` flag (alias `--no-resume`) to the agent entrypoint, threaded into `AgentConfig` as `fresh?: boolean`. Default false (auto-detect on).

## 8. Error handling

- Missing/malformed/version-mismatched `state.json` → warn and treat as no match (fresh run).
- `feature-results/` absent → no match.
- A write failure on `state.json` is logged but non-fatal — it degrades resumability, it must not abort a run.

## 9. Testing

Unit tests (inject fakes; no live model):

- `findResumableRun`: matches by `userPrompt`+`workingDirectory`; matches by `featureSlug` when `prdFile` set; returns null when all tasks complete; returns null when no file; newest-by-`updatedAt` wins among several; skips a version-mismatched file.
- Status normalization: `complete` survives; `in_progress`/`failed`/`pending` all become `pending`.
- `saveRunState`/`loadRunState` round-trip (including the `tasks` status and split children).
- Planning-node skip: with `resumed: true`, `draftPlanNode`/`sizePlanNode`/`ratifyPlanNode` return pass-through and perform no model calls / no file writes for the plan.
- Persistence: `runTaskNode` writes `state.json` after a batch (assert file contents reflect the merged statuses) — using an injected fake task runner so no live model is needed.
- A resumed run executes only the non-complete tasks (assert the fake runner is invoked only for those IDs).

## 10. Realtime progress board

A human-readable master task board, written live to `feature-results/<slug>/PROGRESS.md`, so the operator can watch status across all domains in real time.

### 10.1 Task timestamps

`Task` gains two nullable fields: `startedAt?: string | null` and `completedAt?: string | null` (ISO 8601 via Luxon). The graph stamps them:
- `startedAt` when a task is marked `in_progress` in `runTaskNode` (the `tasksWithProgress` map).
- `completedAt` in `runSingleTask`'s return (on `complete` or `failed`), and on the blocked-dependency failure path in `runTaskNode`.

Because these live on the `Task`, they are written to `state.json` and survive resume — a task already `complete` shows its original times after a restart.

### 10.2 Glyphs and layout

`PROGRESS.md` is grouped into a section per domain (in the fixed `TASK_DOMAINS` order). Each task is a checklist row:

```
## database
- [✓] TASK-001-1  schema        started 12:00:03Z  done 12:00:41Z
- [-] TASK-001-2  repository     started 12:00:41Z
- [ ] TASK-002    seed data
```

Glyphs: `[ ]` pending, `[-]` in_progress, `[✓]` complete, `[X]` failed. A summary line at the top reads e.g. `✓ 3 / 8 complete · 1 in-progress · 1 failed`. Empty domains are omitted.

### 10.3 Pure renderer

`src/agent/progress-board.mts` exports `buildProgressBoard(featureName: string, featureSlug: string, tasks: readonly Task[]): string` — a pure function producing the markdown above. Unit-tested directly.

### 10.4 Realtime writer

A `ProgressBoard` subscriber attaches to `agentEvents` in `DevAgent.run` for the whole run and rewrites `PROGRESS.md` on every task transition. It keeps its own ordered task projection so it never depends on graph state:

- **Seed / replace** on `prd_generated` (`payload.prd.tasks`), `plan_sized` (enriched with `payload.tasks = result.tasks`, the post-split list), and `run_resumed` (enriched with `payload.tasks`). It also captures `featureName` / `featureSlug` from these payloads.
- **Update by id** on `task_started` (→ `in_progress`, set `startedAt` from payload), `task_complete` (→ `complete`, `completedAt`), `task_failed` (→ `failed`, `completedAt`).
- **Restructure** on `task_split` (enriched with `payload.children = [{ id, name, domain }]`): remove the parent, insert the children as `pending`.

The graph stamps the times and includes them in the event payloads, so `state.json` and `PROGRESS.md` share a single source of truth. Writes are best-effort (a failure is logged, never fatal).

### 10.5 Event payload enrichment

To feed the projection without reading graph state, these payloads gain fields:
- `plan_sized`: `tasks: Task[]`
- `run_resumed`: `tasks: Task[]` (already carried for the resume event)
- `task_split`: `children: Array<{ id: string; name: string; domain: TaskDomain }>`
- `task_started`: `startedAt: string`
- `task_complete` / `task_failed`: `completedAt: string`

### 10.6 Testing

- `buildProgressBoard`: renders each glyph; groups by domain; omits empty domains; shows start/end times; summary counts correct.
- `ProgressBoard` projection: seeds from `prd_generated`/`plan_sized`/`run_resumed`; flips status + times on task events; applies a split (parent replaced by children); writes `PROGRESS.md` on each event (assert file contents) — driven by emitted events, no live model.

## 11. Out of scope

- LangGraph SQLite checkpointer / mid-superstep resume (rejected in favour of the human-readable state file).
- Resuming a single task mid-iteration (task granularity is the resume unit).
- Cross-machine / remote resume (state is local to `feature-results/`).
- Automatic pruning of old `state.json` files.
