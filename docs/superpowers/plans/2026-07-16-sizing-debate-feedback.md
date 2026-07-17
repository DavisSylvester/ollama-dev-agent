# Sizing & Debate Live Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream live per-task feedback during the sizing phase (each task's size, plus each persona's verdict + short comment when a task is debated) into a TUI activity-feed panel, so the operator can see the agent is working and not stuck.

**Architecture:** An optional `onEvent` callback is threaded through `runDebate` and `sizePlan` (default no-op). `sizePlanNode` wires it to `emitAgentEvent`, producing five new events. A pure `formatFeedLine` turns each event into a display line; `App.tsx` keeps the last 8 lines and renders them in a new `ActivityFeed` panel below the status bar.

**Tech Stack:** BunJS, TypeScript strict, React + Ink (TUI), `bun test`.

**Reference:** spec `docs/superpowers/specs/2026-07-16-sizing-debate-feedback-design.md`.

---

## Conventions (read once)

- `.mts` for logic, `.tsx` for Ink components; imports include the extension; no `any`; explicit return types on exports.
- Type check: `bunx tsc --noEmit` (baseline is 16 pre-existing unrelated errors in `src/tools/*.mts` and `tests/unit/models/react-agent.test.mts` — add no new ones).

---

## File Structure

- **Modify** `src/types/agent.mts` — add five event types to `AgentEventType`.
- **Modify** `src/prd/debate.mts` — `DebateDeps.onEvent`; emit `debate_started` / `persona_stance` / `debate_decided` in `runDebate`.
- **Modify** `src/prd/sizer.mts` — `SizePlanDeps.onEvent`; emit `sizing_started` / `task_sized`; forward `onEvent` into the default debate.
- **Modify** `src/agent/graph.mts` — `sizePlanNode` passes `onEvent` into `sizePlan`.
- **Create** `src/ui/lib/format-feed-line.mts` — pure `formatFeedLine`.
- **Create** `src/ui/components/ActivityFeed.tsx` — the feed panel.
- **Modify** `src/ui/App.tsx` — feed state + handlers + render.
- **Create** `tests/unit/ui/format-feed-line.test.mts`; extend `tests/unit/prd/debate.test.mts`, `tests/unit/prd/sizer.test.mts`.

---

## Task 1: Event types

**Files:**
- Modify: `src/types/agent.mts`

- [ ] **Step 1: Add the event members**

In `src/types/agent.mts`, add to `AgentEventType` (after `doc_summarized`):

```ts
  | 'sizing_started'
  | 'task_sized'
  | 'debate_started'
  | 'persona_stance'
  | 'debate_decided'
```

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/agent.mts
git commit -m "feat: sizing/debate feedback event types"
```

---

## Task 2: `runDebate` emits debate events

**Files:**
- Modify: `src/prd/debate.mts`
- Test: `tests/unit/prd/debate.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/debate.test.mts` (inside the existing `describe('runDebate', ...)` block, or as a new describe reusing the file's `makeTask`/`twoStories`):

```ts
describe('runDebate feedback events', () => {
  it('emits debate_started, one persona_stance per persona per round, and debate_decided', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await runDebate(makeTask(), {
      proposeFn: async () => twoStories,
      critiqueFn: async () => '{"verdict":"agree","comments":"ok"}',
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    expect(events.some((e) => e.type === 'debate_started')).toBe(true);
    // consensus in round 1 => exactly 4 persona_stance events
    expect(events.filter((e) => e.type === 'persona_stance')).toHaveLength(4);
    const decided = events.find((e) => e.type === 'debate_decided');
    expect(decided?.payload.decidedBy).toBe('consensus');
    expect(decided?.payload.storyCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/debate.test.mts`
Expected: FAIL — `onEvent` is not on `DebateDeps`; no events captured.

- [ ] **Step 3: Add `onEvent` to `DebateDeps` and emit**

In `src/prd/debate.mts`, add `onEvent` to the `DebateDeps` interface:

```ts
export interface DebateDeps {
  proposeFn?: (task: Task) => Promise<string>;
  critiqueFn?: (persona: DebatePersona, task: Task, proposal: ProposedStory[], round: number) => Promise<string>;
  synthesizeFn?: (task: Task, proposal: ProposedStory[], stances: PersonaStance[]) => Promise<string>;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}
```

In `runDebate`, after the opening-proposal check (the `if (proposal.length === 0) { throw ... }` block), add:

```ts
  deps?.onEvent?.('debate_started', { taskId: task.id, taskName: task.name });
```

Inside the per-persona loop, emit right after each stance is pushed:

```ts
    for (const persona of DEBATE_PERSONAS) {
      const stance = parseStance(persona, await critique(persona, task, proposal, round));
      stances.push(stance);
      deps?.onEvent?.('persona_stance', {
        taskId: task.id,
        round,
        persona: stance.persona,
        verdict: stance.verdict,
        comments: stance.comments,
      });
    }
```

Before the final `return { ... }` (after the `logger.info(...)` line), add:

```ts
  deps?.onEvent?.('debate_decided', { taskId: task.id, decidedBy, storyCount: proposal.length });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/debate.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/prd/debate.mts tests/unit/prd/debate.test.mts
git commit -m "feat: runDebate emits debate_started/persona_stance/debate_decided"
```

---

## Task 3: `sizePlan` emits sizing events + forwards onEvent

**Files:**
- Modify: `src/prd/sizer.mts`
- Test: `tests/unit/prd/sizer.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/sizer.test.mts` (inside the existing `describe('sizePlan', ...)` block; it already has `makeTask` and `cannedSplit`):

```ts
  it('emits sizing_started and a task_sized per task', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await sizePlan([makeTask({ id: 'TASK-001' }), makeTask({ id: 'TASK-002' })], {
      sizeFn: async () => new Map([['TASK-001', 'M'], ['TASK-002', 'S']]),
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    expect(events[0]?.type).toBe('sizing_started');
    expect(events[0]?.payload.taskCount).toBe(2);
    const sized = events.filter((e) => e.type === 'task_sized').map((e) => e.payload.taskId);
    expect(sized).toContain('TASK-001');
    expect(sized).toContain('TASK-002');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: FAIL — `onEvent` is not on `SizePlanDeps`.

- [ ] **Step 3: Add `onEvent` and emit**

In `src/prd/sizer.mts`, extend `SizePlanDeps`:

```ts
export interface SizePlanDeps {
  readonly sizeFn?: (tasks: readonly Task[]) => Promise<Map<string, TaskSize>>;
  readonly debateFn?: (task: Task) => Promise<DebateSplitResult>;
  readonly onEvent?: (type: string, payload: Record<string, unknown>) => void;
}
```

In `sizePlan`, change the default `debate` to forward `onEvent`, add an `emit` alias, and emit the events. Replace the top of the function body (from `const sizeFn = ...` down through `let current = ...`) with:

```ts
  const sizeFn = deps?.sizeFn ?? ((t: readonly Task[]) => getModelSizes(t));
  const emit = deps?.onEvent;
  const debate = deps?.debateFn ?? ((t: Task) => debateSplit(t, { onEvent: deps?.onEvent }));

  emit?.('sizing_started', { taskCount: tasks.length });

  // Size freshly-split children: reuse an existing child size when present,
  // otherwise run the model + floor on the unsized ones.
  const sizeChildren = async (children: Task[]): Promise<Task[]> => {
    const unsized = children.filter((c) => !c.size);
    if (unsized.length === 0) return children;
    const childSizes = await sizeFn(unsized);
    return children.map((c) => (c.size ? c : sizeOne(c, childSizes)));
  };

  const modelSizes = await sizeFn(tasks);
  let current: Task[] = tasks.map((t) => sizeOne(t, modelSizes));
  for (const t of current) emit?.('task_sized', { taskId: t.id, size: t.size });
```

Then, inside the pass loop, emit `task_sized` for freshly-sized children. Change the split-application block:

```ts
    for (const parentTask of splittable) {
      const { children, recommendation } = await debate(parentTask);
      if (!recMap.has(parentTask.id)) recMap.set(parentTask.id, recommendation);
      if (children.length === 0) continue;
      const sizedChildren = await sizeChildren(children);
      for (const c of sizedChildren) emit?.('task_sized', { taskId: c.id, size: c.size });
      current = applySplit(current, parentTask.id, sizedChildren);
      splits.push({ parentId: parentTask.id, childIds: sizedChildren.map((c) => c.id) });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/prd/sizer.mts tests/unit/prd/sizer.test.mts
git commit -m "feat: sizePlan emits sizing_started/task_sized and forwards onEvent to the debate"
```

---

## Task 4: Wire `onEvent` in `sizePlanNode`

**Files:**
- Modify: `src/agent/graph.mts`

- [ ] **Step 1: Pass onEvent into sizePlan**

In `src/agent/graph.mts`, in `sizePlanNode`, change the `sizePlan` call to forward events to the UI:

```ts
    result = await sizePlan(state.tasks, {
      onEvent: (type, payload) => emitAgentEvent(type, payload),
    });
```

(Leave the surrounding `try/catch` and the rest of the node unchanged.)

- [ ] **Step 2: Verify**

Run: `bunx tsc --noEmit` — no new errors.
Run: `bun test tests/unit/agent/ tests/unit/prd/` — green.

- [ ] **Step 3: Commit**

```bash
git add src/agent/graph.mts
git commit -m "feat: forward sizing feedback events from sizePlanNode to the UI"
```

---

## Task 5: `formatFeedLine` pure formatter

**Files:**
- Create: `src/ui/lib/format-feed-line.mts`
- Test: `tests/unit/ui/format-feed-line.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ui/format-feed-line.test.mts`:

```ts
import { describe, expect, it } from 'bun:test';
import { formatFeedLine } from '../../../src/ui/lib/format-feed-line.mts';

describe('formatFeedLine', () => {
  it('formats sizing_started', () => {
    expect(formatFeedLine('sizing_started', { taskCount: 14 })).toContain('14');
  });

  it('formats task_sized', () => {
    expect(formatFeedLine('task_sized', { taskId: 'TASK-001', size: 'M' })).toBe('TASK-001 = M');
  });

  it('formats debate_started with the task name', () => {
    expect(formatFeedLine('debate_started', { taskId: 'TASK-005', taskName: 'photo upload' }))
      .toContain('TASK-005');
  });

  it('formats persona_stance with a display name and truncates long comments', () => {
    const line = formatFeedLine('persona_stance', {
      taskId: 'T', round: 1, persona: 'scrum_master', verdict: 'revise', comments: 'x'.repeat(200),
    });
    expect(line).toContain('Scrum Master');
    expect(line).toContain('revise');
    expect(line!.length).toBeLessThan(120); // truncated to ~80 + label
    expect(line).toContain('…');
  });

  it('formats debate_decided', () => {
    expect(formatFeedLine('debate_decided', { taskId: 'T', decidedBy: 'architect', storyCount: 3 }))
      .toContain('3 stories');
  });

  it('returns null for an unrecognized event', () => {
    expect(formatFeedLine('tool_called', { toolName: 'read_file' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/ui/format-feed-line.test.mts`
Expected: FAIL — cannot find module `format-feed-line.mts`.

- [ ] **Step 3: Implement**

Create `src/ui/lib/format-feed-line.mts`:

```ts
const PERSONA_LABELS: Record<string, string> = {
  scrum_master: 'Scrum Master',
  solution_architect: 'Solution Architect',
  sme: 'SME',
  developer: 'Developer',
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Turn a sizing/debate feedback event into a single display line, or null for
// events this feed does not render.
export function formatFeedLine(type: string, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'sizing_started':
      return `Sizing ${String(payload['taskCount'])} tasks…`;
    case 'task_sized':
      return `${String(payload['taskId'])} = ${String(payload['size'])}`;
    case 'debate_started':
      return `Debating ${String(payload['taskId'])} (${String(payload['taskName'])})…`;
    case 'persona_stance': {
      const label = PERSONA_LABELS[String(payload['persona'])] ?? String(payload['persona']);
      const comments = truncate(String(payload['comments'] ?? ''), 80);
      return `  ${label}: ${String(payload['verdict'])} — ${comments}`;
    }
    case 'debate_decided':
      return `${String(payload['taskId'])}: decided by ${String(payload['decidedBy'])} → ${String(payload['storyCount'])} stories`;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/ui/format-feed-line.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/lib/format-feed-line.mts tests/unit/ui/format-feed-line.test.mts
git commit -m "feat: formatFeedLine renders sizing/debate events as feed lines"
```

---

## Task 6: `ActivityFeed` panel + `App` wiring

**Files:**
- Create: `src/ui/components/ActivityFeed.tsx`
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Create the component**

Create `src/ui/components/ActivityFeed.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

interface ActivityFeedProps {
  readonly lines: readonly string[];
}

export function ActivityFeed({ lines }: ActivityFeedProps): React.ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="gray">Activity</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>{line}</Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Add feed state and handlers to `App.tsx`**

In `src/ui/App.tsx`:

Add the imports:

```tsx
import { ActivityFeed } from './components/ActivityFeed.tsx';
import { formatFeedLine } from './lib/format-feed-line.mts';
```

Add `feed` to `UIState` (after `error`):

```tsx
  error: string | null;
  feed: string[];
```

Add `feed: []` to `INITIAL_STATE`:

```tsx
  error: null,
  feed: [],
```

Inside the `useEffect`, add a handler and register it for the five events (place alongside the other handlers, before the `agentEvents.on(...)` block):

```tsx
    const handleFeedEvent = (event: unknown): void => {
      const e = event as { type: string; payload: Record<string, unknown> };
      const line = formatFeedLine(e.type, e.payload);
      if (line === null) return;
      setState((prev) => ({ ...prev, feed: [...prev.feed, line].slice(-8) }));
    };
```

Register (add to the `agentEvents.on(...)` group):

```tsx
    agentEvents.on('sizing_started', handleFeedEvent);
    agentEvents.on('task_sized', handleFeedEvent);
    agentEvents.on('debate_started', handleFeedEvent);
    agentEvents.on('persona_stance', handleFeedEvent);
    agentEvents.on('debate_decided', handleFeedEvent);
```

Unregister (add to the cleanup `return` block):

```tsx
      agentEvents.off('sizing_started', handleFeedEvent);
      agentEvents.off('task_sized', handleFeedEvent);
      agentEvents.off('debate_started', handleFeedEvent);
      agentEvents.off('persona_stance', handleFeedEvent);
      agentEvents.off('debate_decided', handleFeedEvent);
```

- [ ] **Step 3: Render the feed below the status bar**

In the main `return (...)` of `App.tsx`, add `<ActivityFeed>` after `<StatusBar ... />`:

```tsx
      <StatusBar
        phase={state.phase}
        model={state.currentModel || undefined}
        currentTool={state.currentTool || undefined}
        iteration={state.currentIteration}
      />
      <ActivityFeed lines={state.feed} />
```

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit` — no new errors.
Run: `bun test tests/unit` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/ActivityFeed.tsx src/ui/App.tsx
git commit -m "feat: ActivityFeed panel streams sizing/debate feedback in the TUI"
```

---

## Final Verification

- [ ] `bun test tests/unit` — all green.
- [ ] `bunx tsc --noEmit` — only the 16 pre-existing baseline errors.
- [ ] Manual: run a sizing-heavy plan and confirm the Activity panel shows `Sizing N tasks…`, per-task `TASK-xxx = M/S/L`, and for `L` tasks the `Debating…`, per-persona `Scrum Master: revise — …`, and `decided by …` lines updating live.
