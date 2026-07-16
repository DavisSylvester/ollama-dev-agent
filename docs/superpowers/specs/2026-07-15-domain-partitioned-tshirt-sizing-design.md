# Design: Domain-Partitioned, T-Shirt-Sized Planning

**Date:** 2026-07-15
**Status:** Approved (design) — awaiting implementation plan
**Component:** `src/prd/*`, `src/agent/graph.mts`, `src/types/task.mts`

## Problem

ODA's planner generates a PRD in a **single model call** (`src/prd/generator.mts` +
`buildPRDGenerationPrompt` in `src/prd/prompts.mts`). Each task has `dependsOn` and
prose sizing guidance ("one module + test"), but:

- there is **no explicit size field** — sizing is advisory prose the model may ignore;
- there is **no functional-area / domain tag** on tasks;
- oversized tasks are only caught **reactively** — a task is auto-split *after* it
  fails and burns its full iteration budget (`runTaskNode` in `src/agent/graph.mts`).

The result: oversized tasks routinely time out before the reactive split rescues them,
and work is not partitioned by functional area.

The reference project `C:\projects\davisSylvester\claude-single-shot-agent` solves this
with **separation of powers**: `project-owner` drafts a domain-partitioned backlog,
`story-sizer` owns S/M/L sizing and proposes splits, `planning-council` ratifies.

## Goals

1. Every task is tagged with exactly one **functional area (domain)**.
2. Every task is assigned a **T-shirt size** (S/M/L).
3. **No task larger than Medium may execute** — any `L` is split into `S`/`M` children
   *before* the run starts (proactive), with the existing post-failure split kept as a
   backstop.
4. Planning follows a **separation-of-powers pipeline** (drafter → sizer → ratifier),
   built in phases.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Pipeline | Full council (drafter → sizer → ratifier), built **phased**: drafter+sizer first, council second. |
| Domains | Hybrid taxonomy: `ui, api, services, database, auth, iac, e2e, ci`. |
| Size gate | **Proactive** split (deterministic gate refuses to run an `L`) **+** existing reactive auto-split as backstop. |
| Scale | `S/M/L`; `L` = "too big for one pass, must split." |
| Sizing basis | **Model judgment + deterministic floor** (force-promote to `L` on hard signals). |
| One domain per task | Enforced. A task spanning >1 domain is auto-`L` and must be split. |

## Architecture

### 1. Data model (`src/types/task.mts`)

```ts
export type TaskSize = 'S' | 'M' | 'L';
export type TaskDomain =
  | 'ui' | 'api' | 'services' | 'database'
  | 'auth' | 'iac' | 'e2e' | 'ci';
```

Add to `Task`:
- `domain: TaskDomain` — required; exactly one functional area per task.
- `size?: TaskSize` — assigned by the sizer; absent until the `size_plan` node runs.

Split children **inherit** the parent's `domain` and are born `S`/`M`.

One type per file per project convention: `task-size.mts`, `task-domain.mts`,
re-barrelled through `src/types/index.mts`.

### 2. Planning pipeline (`src/agent/graph.mts`)

The single `generate_prd` node becomes a planning sub-pipeline:

```
START → draft_plan → size_plan → [ratify_plan (Phase B stub)] → awaiting_approval → run_task ⇄ → generate_results
```

- **draft_plan** — existing `generatePRD`, prompt updated to require **domain-first
  partitioning** and a `**Domain**:` tag per task. Sizing is explicitly *not* the
  drafter's job.
- **size_plan** — new node calling the sizer. Writes `SIZING.md`. Enforces the proactive
  gate.
- **ratify_plan** — Phase B; a **pass-through stub** in Phase A.
- Human approval (`waitForPRDApproval`, unchanged mechanics) now runs on the **sized** plan.

### 3. Sizer + deterministic floor (`src/prd/sizer.mts`, new)

Two-step:

1. **Model judgment** — one call sizes every task `S/M/L` against the "one focused pass"
   bar (reuses language already in `prompts.mts`).
2. **Deterministic floor** — force-promote to `L` when hard signals exceed thresholds,
   regardless of the model's guess. Initial thresholds (tunable via `env`):
   - acceptance-criteria bullet count **> 4**
   - task references **more than one domain**
   - estimated files/modules **> 3**, or endpoints/schemas/components **> 3**
3. **Proactive split** — every `L` (and its children, recursively, capped by `splitDepth`)
   is decomposed via the existing `splitTask` / `applySplit` in `src/prd/splitter.mts`
   until all tasks are `S`/`M`.

### 4. The gate + backstop

- **Proactive gate** (in `size_plan`): after splitting, assert no task remains `L`. If one
  does (split could not reduce it), it is a **hard stop** — escalate as an open question
  rather than silently running an oversized task.
- **Reactive backstop**: the existing post-failure auto-split in `runTaskNode` stays,
  now propagating `domain` / `size` to children.

### 5. Artifacts & events

- `SIZING.md` written to `feature-results/<slug>/` alongside `RESULTS.md`: size
  distribution, per-task `domain` + `size`, and the split tree (mirrors the reference
  `docs/SIZING.md`).
- New agent event `plan_sized` (distribution + splits) so the UI can render sizes.

### 6. Parser (`src/prd/parser.mts`)

Parse `**Domain**:` on each task block. `**Size**:` is produced by the sizer output, not
the drafter. Fallback domain inference only with a logged warning.

## Phasing

- **Phase A** (this plan): types, drafter prompt + parser, `sizer.mts`, `size_plan` node,
  proactive gate, `SIZING.md`, backstop `domain`/`size` propagation, tests.
  `ratify_plan` is a pass-through stub.
- **Phase B** (follow-up): replace the stub with the ratifying council pass
  (mirrors `planning-council`).

## Testing

Unit tests (bun test, `.mts`, one-interface-per-file conventions) for:
- deterministic-floor threshold behavior (each signal individually promotes to `L`);
- `L → S/M` split convergence (recursive, respects `splitDepth`);
- the "no `L` may run" gate — hard-stop path when a split cannot reduce a task;
- `domain` / `size` inheritance on both proactive and reactive splits;
- parser round-trip for `**Domain**:`.

## Out of scope

- The ratifying council (Phase B).
- Changing the reactive auto-split's own logic (only extended to carry `domain`/`size`).
- Re-sizing mid-run based on observed execution time.
