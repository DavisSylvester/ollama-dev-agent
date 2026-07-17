# Sizing & Debate Live Feedback — Design Spec

**Date:** 2026-07-16
**Status:** Approved

## 1. Problem

During the `size_plan` phase the TUI shows only a spinner labelled "Sizing Plan". `sizePlan` and `runDebate` are silent (they only call `logger`), so nothing streams to the screen between `phase_changed` and `plan_sized`. On local Ollama, sizing a plan and running per-`L` debates can take many minutes, and the operator cannot tell whether the agent is working or stuck.

## 2. Goal

Stream live, per-task feedback during sizing — at the start and end of each task's cycle — and, when a task is being debated, show each persona's verdict and a short comment. Surface it in a live activity-feed panel in the TUI.

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Surface | A live activity-feed panel (last ~8 lines) below the status bar. |
| 2 | Cycle unit | Per task — a line per task's size, plus debate detail for `L` tasks. |
| 3 | Persona detail | Verdict + a short comment (truncated to ~80 chars). |

## 4. Events

Five new event types (added to `AgentEventType`), emitted via `emitAgentEvent`:

| Event | Payload | When |
|-------|---------|------|
| `sizing_started` | `{ taskCount: number }` | start of `sizePlan` |
| `task_sized` | `{ taskId: string; size: TaskSize }` | after each task's model+floor size is decided |
| `debate_started` | `{ taskId: string; taskName: string }` | an `L` task enters the debate |
| `persona_stance` | `{ taskId: string; round: number; persona: DebatePersona; verdict: 'agree' \| 'revise'; comments: string }` | as each persona responds, every round |
| `debate_decided` | `{ taskId: string; decidedBy: 'consensus' \| 'architect'; storyCount: number }` | debate concludes |

`plan_sized` remains the overall end-of-phase event.

## 5. Threading

Reuse the existing dependency-injection pattern; the default is a no-op so tests and the reactive backstop are unaffected.

- `SizePlanDeps` gains `onEvent?: (type: string, payload: Record<string, unknown>) => void`.
- `DebateDeps` gains the same `onEvent?`.
- `sizePlanNode` calls `sizePlan(state.tasks, { onEvent: (t, p) => emitAgentEvent(t, p) })`.
- `sizePlan`:
  - emits `sizing_started` `{ taskCount: tasks.length }` at the top;
  - emits `task_sized` `{ taskId, size }` for each task after `sizeOne` (both the initial sizing and freshly-sized split children);
  - forwards `onEvent` into the debate: the default `debateFn` becomes `(t) => debateSplit(t, { onEvent })`.
- `debateSplit` forwards its deps (which carry `onEvent`) into `runDebate`.
- `runDebate`:
  - emits `debate_started` `{ taskId, taskName }` after the opening proposal parses;
  - emits `persona_stance` right after each stance is parsed in the per-persona loop;
  - emits `debate_decided` `{ taskId, decidedBy, storyCount: finalStories.length }` before returning.

## 6. TUI

- **`src/ui/lib/format-feed-line.mts`** — pure `formatFeedLine(type: string, payload: Record<string, unknown>): string | null`. Returns a formatted line for the five events (and `null` for anything else). Persona keys map to display names via a `PERSONA_LABELS` record; comments are truncated to 80 chars with an ellipsis. Examples:
  - `sizing_started` → `Sizing 14 tasks…`
  - `task_sized` → `TASK-001 = M`
  - `debate_started` → `Debating TASK-005 (photo upload)…`
  - `persona_stance` → `  Scrum Master: revise — story 1 bundles schema+UI, split it`
  - `debate_decided` → `TASK-005: decided by architect → 3 stories`
- **`src/ui/components/ActivityFeed.tsx`** — renders a bordered panel titled "Activity" showing the provided lines (already capped by the caller). Renders nothing when there are no lines.
- **`src/ui/App.tsx`** — adds `feed: string[]` to `UIState` (default `[]`); one handler subscribes to the five events, calls `formatFeedLine`, and appends non-null lines, keeping only the last 8. `ActivityFeed` renders below `StatusBar` in the main view. Handlers are registered/unregistered alongside the existing ones.

## 7. Error handling

- `onEvent` is optional everywhere; a missing callback is a no-op.
- `formatFeedLine` returns `null` for unknown/ malformed events; the caller ignores nulls.
- Emitting is best-effort and never throws into the sizing logic.

## 8. Testing

- `sizePlan`: with an injected `onEvent`, asserts one `sizing_started` and one `task_sized` per task (using injected `sizeFn`/`debateFn` so no model runs).
- `runDebate`: with injected `onEvent` and canned persona/proposal functions, asserts `debate_started`, one `persona_stance` per persona per round, and `debate_decided`.
- `formatFeedLine`: one assertion per event type; a long persona comment is truncated to 80 chars + `…`; an unknown event returns `null`.
- `ActivityFeed`/`App` wiring: verified by `tsc` and a manual run (ink render tests are brittle; formatting logic lives in the tested `formatFeedLine`).

## 9. Out of scope

- Feedback for the worker/reviewer execution phase (already partly covered by existing events).
- Persisting the feed to disk (the log file already captures `logger` output).
- Configurable feed length or verbosity (fixed at 8 lines / 80-char comments).
