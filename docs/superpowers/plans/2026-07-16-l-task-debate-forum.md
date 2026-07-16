# L-Task Debate Forum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-shot L-task split recommendation with a four-persona debate (Scrum Master, Solution Architect, SME, Developer) that deliberates the task's complexity and produces the real child tasks that replace it.

**Architecture:** A pure debate engine (`src/prd/debate.mts`) runs up to 4 rounds — the Solution Architect proposes a breakdown, all four personas critique it independently (one model call each per round), and the debate ends on consensus or at round 4 (Architect decides). The orchestration that turns the debate's decision into sized children, with retry + deterministic fallback, lives in `src/prd/sizer.mts` (`debateSplit`), keeping the module graph acyclic. `sizePlan`'s public result shape is unchanged, so the LangGraph node needs no edits.

**Tech Stack:** BunJS, TypeScript strict, `@langchain/ollama` via `createChatModel`, `@langchain/core` messages, Zod env, Luxon, `bun test`.

**Reference:** design spec `docs/superpowers/specs/2026-07-16-l-task-debate-forum-design.md`; decisions `docs/DECISIONS.md`.

---

## Conventions (read once)

- All source files use `.mts`; imports include the `.mts` extension; filenames are kebab-case.
- Never use `any`; explicit return types on all exported functions.
- Escape backticks inside `prompts.mts` template literals as `` \` ``.
- Interfaces are **co-located** in their module (matching the existing `sizer.mts`, which groups `SizingSignals`, `SizeRecommendation`, etc.) — do NOT create one-file-per-interface here; follow the established repo pattern.
- Full-suite check: `bun test`. Type check: `bunx tsc --noEmit` (baseline is 16 pre-existing unrelated errors in `src/tools/*.mts` and `tests/unit/models/react-agent.test.mts` — introduce no new ones).

---

## File Structure

- **Create** `src/prd/debate.mts` — persona enum, debate data types, model resolver, tolerant JSON parsers, `runDebate`, `DebateError`. Pure: depends only on prompts/models/env/types.
- **Create** `tests/unit/prd/debate.test.mts` — unit tests for the debate engine.
- **Modify** `src/env.mts` — add `DEBATE_*_MODEL` vars + `DEBATE_MAX_ROUNDS`.
- **Modify** `src/prd/prompts.mts` — add `buildDebateProposalPrompt`, `buildPersonaCritiquePrompt`, `buildDebateSynthesisPrompt`, `PERSONA_BRIEF`; remove `buildSplitRecommendationPrompt`.
- **Modify** `src/prd/splitter.mts` — extract `buildChildTasks`; refactor `splitTask` onto it.
- **Modify** `src/prd/sizer.mts` — add `debateSplit` (orchestration + fallback); rewire `sizePlan` to `debateFn`; remove `recommendSplitApproach`.
- **Modify** `src/prd/sizing-report.mts` — add the compact debate summary line to the recommendations section.
- **Modify** tests: `tests/unit/prd/sizer.test.mts`, `tests/unit/prd/prompts.test.mts`, `tests/unit/prd/splitter.test.mts`, `tests/unit/prd/sizing-report.test.mts`.
- **Create** `scripts/debate-smoke.mts` — live Ollama smoke.

---

## Task 1: Env vars for persona models and round cap

**Files:**
- Modify: `src/env.mts:42-47`
- Test: `tests/unit/env.test.mts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `tests/unit/env.test.mts`:

```ts
import { describe, expect, it } from 'bun:test';
import { env } from '../../src/env.mts';

describe('debate env', () => {
  it('caps DEBATE_MAX_ROUNDS at 4 by default', () => {
    expect(env.DEBATE_MAX_ROUNDS).toBeLessThanOrEqual(4);
    expect(env.DEBATE_MAX_ROUNDS).toBeGreaterThanOrEqual(1);
  });

  it('leaves persona model overrides undefined unless set', () => {
    // Unset by default so the resolver falls back to PLANNER/CODER models.
    expect(env.DEBATE_ARCHITECT_MODEL === undefined || typeof env.DEBATE_ARCHITECT_MODEL === 'string').toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx tsc --noEmit`
Expected: FAIL — `Property 'DEBATE_MAX_ROUNDS' does not exist on type 'Env'`.

- [ ] **Step 3: Add the env fields**

In `src/env.mts`, inside the `z.object({ ... })` after the `SIZE_ENFORCE_GATE` block (around line 47), add:

```ts
  // Per-persona model overrides for the L-task debate forum. Unset => the
  // resolver falls back to the tiered defaults (SA/SME => PLANNER, Scrum/Dev
  // => CODER). Kept optional so zero config is required.
  DEBATE_ARCHITECT_MODEL: z.string().optional(),
  DEBATE_SME_MODEL: z.string().optional(),
  DEBATE_SCRUM_MODEL: z.string().optional(),
  DEBATE_DEV_MODEL: z.string().optional(),
  // Max debate rounds before the Solution Architect decides unilaterally.
  // Hard-capped at 4 by product decision.
  DEBATE_MAX_ROUNDS: z.coerce.number().int().min(1).max(4).default(4),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/env.test.mts`
Expected: PASS. Also run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/env.mts tests/unit/env.test.mts
git commit -m "feat: add debate persona-model and max-round env vars"
```

---

## Task 2: `buildChildTasks` helper in the splitter

Extracts the child-construction logic (re-ID, foundation-first deps, domain inheritance, depth) so both `splitTask` and the debate can produce children identically.

**Files:**
- Modify: `src/prd/splitter.mts:81-126`
- Test: `tests/unit/prd/splitter.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/splitter.test.mts`:

```ts
import { buildChildTasks } from '../../../src/prd/splitter.mts';

describe('buildChildTasks', () => {
  const parent = {
    id: 'TASK-007', name: 'big', description: 'd', acceptanceCriteria: 'a',
    testCommand: 'bun test', dependsOn: ['TASK-001'], domain: 'database' as const,
    status: 'pending' as const, iterationCount: 0,
  };

  it('re-IDs children, inherits domain, and wires foundation-first deps', () => {
    const children = buildChildTasks(parent, [
      { name: 'schema', description: 'ds', acceptanceCriteria: 'as' },
      { name: 'repo', description: 'dr', acceptanceCriteria: 'ar' },
    ]);
    expect(children.map((c) => c.id)).toEqual(['TASK-007-1', 'TASK-007-2']);
    expect(children.every((c) => c.domain === 'database')).toBe(true);
    expect(children[0]!.dependsOn).toEqual(['TASK-001']); // inherits parent's external deps
    expect(children[1]!.dependsOn).toEqual(['TASK-007-1']); // followers depend on the first
    expect(children.every((c) => c.splitDepth === 1)).toBe(true);
    expect(children.every((c) => c.size === undefined)).toBe(true); // re-sized later
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/splitter.test.mts`
Expected: FAIL — `buildChildTasks` is not exported.

- [ ] **Step 3: Extract the helper and refactor `splitTask`**

In `src/prd/splitter.mts`, add this exported function (place it above `splitTask`):

```ts
export interface ChildStory {
  name: string;
  description: string;
  acceptanceCriteria: string;
  testCommand?: string;
}

/**
 * Build re-IDed child tasks from a parent and a list of proposed stories.
 * The first child inherits the parent's external dependencies; the rest depend
 * on the first (foundation first, followers parallelize). Children stay in the
 * parent's domain and carry the incremented split depth; `size` is left absent
 * so the sizer re-sizes them.
 */
export function buildChildTasks(parent: Task, stories: readonly ChildStory[]): Task[] {
  const depth = (parent.splitDepth ?? 0) + 1;
  const firstId = `${parent.id}-1`;
  return stories.map((s, i) => ({
    id: `${parent.id}-${i + 1}`,
    name: s.name,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    testCommand: s.testCommand ?? parent.testCommand,
    domain: parent.domain,
    dependsOn: i === 0 ? [...parent.dependsOn] : [firstId],
    status: 'pending' as const,
    iterationCount: 0,
    splitDepth: depth,
  }));
}
```

Then refactor `splitTask`'s tail (the `const depth = ...` through the `return subTasks;` block, lines ~107-125) to reuse it:

```ts
  const subTasks = buildChildTasks(
    task,
    parsed.map((sub) => ({
      name: sub.name,
      description: sub.description,
      acceptanceCriteria: sub.acceptanceCriteria,
      testCommand: sub.testCommand,
    })),
  );

  logger.info({ taskId: task.id, subTasks: subTasks.map((s) => s.id) }, 'splitter.split');
  return subTasks;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/splitter.test.mts`
Expected: PASS (new test + all existing splitter tests still green).
Run: `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/prd/splitter.mts tests/unit/prd/splitter.test.mts
git commit -m "refactor: extract buildChildTasks from splitTask"
```

---

## Task 3: Debate types, persona model resolver, and tolerant parsers

**Files:**
- Create: `src/prd/debate.mts`
- Test: `tests/unit/prd/debate.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prd/debate.test.mts`:

```ts
import { describe, expect, it } from 'bun:test';
import { DEBATE_PERSONAS, personaModel, parseStories, parseStance } from '../../../src/prd/debate.mts';

describe('personaModel', () => {
  it('maps SA and SME to the planner model, Scrum and Dev to the coder model (defaults)', () => {
    expect(personaModel('solution_architect')).toBe(personaModel('sme'));
    expect(personaModel('scrum_master')).toBe(personaModel('developer'));
    expect(personaModel('solution_architect')).not.toBe(personaModel('developer'));
  });
  it('exposes the four personas', () => {
    expect([...DEBATE_PERSONAS]).toEqual(['scrum_master', 'solution_architect', 'sme', 'developer']);
  });
});

describe('parseStories', () => {
  it('parses a fenced JSON array of stories', () => {
    const raw = '```json\n[{"name":"schema","description":"d","acceptanceCriteria":"a"}]\n```';
    const stories = parseStories(raw);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.name).toBe('schema');
  });
  it('returns [] for unparseable output', () => {
    expect(parseStories('no json here')).toEqual([]);
  });
});

describe('parseStance', () => {
  it('parses a verdict and comments', () => {
    const s = parseStance('developer', '{"verdict":"agree","comments":"looks fine"}');
    expect(s.persona).toBe('developer');
    expect(s.verdict).toBe('agree');
  });
  it('defaults a garbled stance to revise', () => {
    expect(parseStance('sme', 'garbage').verdict).toBe('revise');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/debate.test.mts`
Expected: FAIL — cannot find module `debate.mts`.

- [ ] **Step 3: Create the module skeleton (types + resolver + parsers)**

Create `src/prd/debate.mts`:

```ts
import type { Task } from '../types/index.mts';
import { env } from '../env.mts';

export const DEBATE_PERSONAS = ['scrum_master', 'solution_architect', 'sme', 'developer'] as const;
export type DebatePersona = (typeof DEBATE_PERSONAS)[number];

export interface ProposedStory {
  name: string;
  description: string;
  acceptanceCriteria: string;
}

export interface PersonaStance {
  persona: DebatePersona;
  verdict: 'agree' | 'revise';
  comments: string;
}

export interface DebateRound {
  round: number;
  proposal: ProposedStory[];
  stances: PersonaStance[];
}

export interface DebateResult {
  taskId: string;
  taskName: string;
  rounds: DebateRound[];
  finalStories: ProposedStory[];
  decidedBy: 'consensus' | 'architect';
  transcript: string;
}

export class DebateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DebateError';
  }
}

// Tiered defaults: SA + SME reason on the planner model; Scrum + Dev on the
// cheaper coder model. Any DEBATE_*_MODEL override wins.
export function personaModel(persona: DebatePersona): string {
  switch (persona) {
    case 'solution_architect':
      return env.DEBATE_ARCHITECT_MODEL ?? env.PLANNER_MODEL;
    case 'sme':
      return env.DEBATE_SME_MODEL ?? env.PLANNER_MODEL;
    case 'scrum_master':
      return env.DEBATE_SCRUM_MODEL ?? env.CODER_MODEL;
    case 'developer':
      return env.DEBATE_DEV_MODEL ?? env.CODER_MODEL;
  }
}

// Pull the first JSON value out of a model reply that may be fenced or padded
// with prose. Returns null if nothing parses.
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const open = body[start]!;
  const close = open === '[' ? ']' : '}';
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function parseStories(raw: string): ProposedStory[] {
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return {
        name: asString(o.name).trim(),
        description: asString(o.description).trim(),
        acceptanceCriteria: asString(o.acceptanceCriteria).trim(),
      };
    })
    .filter((s) => s.name.length > 0);
}

export function parseStance(persona: DebatePersona, raw: string): PersonaStance {
  const parsed = extractJson(raw) as Record<string, unknown> | null;
  const verdict = asString(parsed?.verdict).trim().toLowerCase() === 'agree' ? 'agree' : 'revise';
  return { persona, verdict, comments: asString(parsed?.comments).trim() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/debate.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/prd/debate.mts tests/unit/prd/debate.test.mts
git commit -m "feat: debate types, persona model resolver, tolerant parsers"
```

---

## Task 4: Debate prompts

**Files:**
- Modify: `src/prd/prompts.mts` (add three builders + `PERSONA_BRIEF`)
- Test: `tests/unit/prd/prompts.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/prompts.test.mts`:

```ts
import {
  buildDebateProposalPrompt,
  buildPersonaCritiquePrompt,
  buildDebateSynthesisPrompt,
} from '../../../src/prd/prompts.mts';

const task = {
  id: 'TASK-001', name: 'big', description: 'build the whole thing',
  acceptanceCriteria: 'a; b; c', testCommand: 'bun test', dependsOn: [],
  domain: 'database' as const, status: 'pending' as const, iterationCount: 0,
};

describe('debate prompts', () => {
  it('proposal prompt asks the architect for a JSON array of stories', () => {
    const p = buildDebateProposalPrompt(task);
    expect(p).toContain('Solution Architect');
    expect(p).toContain('acceptanceCriteria');
    expect(p).toContain(task.id);
  });

  it('critique prompt frames the persona and asks for a verdict', () => {
    const p = buildPersonaCritiquePrompt('scrum_master', task, [
      { name: 's', description: 'd', acceptanceCriteria: 'a' },
    ], 1);
    expect(p).toContain('Scrum Master');
    expect(p).toContain('verdict');
    expect(p.toLowerCase()).toContain('agree');
  });

  it('synthesis prompt includes the personas\' comments', () => {
    const p = buildDebateSynthesisPrompt(task, [
      { name: 's', description: 'd', acceptanceCriteria: 'a' },
    ], [{ persona: 'developer', verdict: 'revise', comments: 'too big still' }]);
    expect(p).toContain('too big still');
    expect(p).toContain('acceptanceCriteria');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: FAIL — the three builders are not exported.

- [ ] **Step 3: Add the builders**

In `src/prd/prompts.mts`, add near the other builders. Import the persona type at the top:

```ts
import type { DebatePersona, ProposedStory, PersonaStance } from './debate.mts';
```

Then:

```ts
export const PERSONA_BRIEF: Record<DebatePersona, string> = {
  scrum_master:
    'the Scrum Master. You judge stories by INVEST — independent, negotiable, valuable, estimable, small, testable. You push for thin vertical slices.',
  solution_architect:
    'the Solution Architect. You judge technical decomposition and clean module boundaries. You hold the final decision.',
  sme:
    'the Subject Matter Expert. You judge domain correctness and whether the split fully covers the original acceptance criteria.',
  developer:
    'the Developer. You judge implementation feasibility — whether each story fits a single focused pass without exhausting context.',
};

function storiesBlock(stories: readonly ProposedStory[]): string {
  return stories
    .map(
      (s, i) =>
        `${i + 1}. ${s.name}\n   Description: ${s.description}\n   Acceptance: ${s.acceptanceCriteria}`,
    )
    .join('\n');
}

export function buildDebateProposalPrompt(task: Task): string {
  return `You are the Solution Architect opening a design debate about an oversized (size L) task.

## The oversized task
${task.id} [${task.domain}]: ${task.name}
Description: ${task.description}
Acceptance: ${task.acceptanceCriteria}

## Your job
Propose an initial breakdown into 2 to 4 smaller stories, each completable in one focused pass (roughly one module plus its test). Together they MUST fully cover the original acceptance criteria, and every story stays within the "${task.domain}" domain.

Output ONLY a JSON array, nothing else:

[
  { "name": "<short story name>", "description": "<one focused concern>", "acceptanceCriteria": "<specific, verifiable criteria>" }
]`;
}

export function buildPersonaCritiquePrompt(
  persona: DebatePersona,
  task: Task,
  proposal: readonly ProposedStory[],
  round: number,
): string {
  return `You are ${PERSONA_BRIEF[persona]}

This is round ${round} of a debate about how to break down an oversized task.

## Original task
${task.id} [${task.domain}]: ${task.name}
Acceptance: ${task.acceptanceCriteria}

## Current proposed breakdown
${storiesBlock(proposal)}

## Your job
Critique THIS breakdown strictly from your perspective. Decide whether it is good enough to build ("agree") or still needs revision ("revise").

Output ONLY a JSON object, nothing else:

{ "verdict": "agree" | "revise", "comments": "<one or two sentences of specific critique>" }`;
}

export function buildDebateSynthesisPrompt(
  task: Task,
  proposal: readonly ProposedStory[],
  stances: readonly PersonaStance[],
): string {
  const feedback = stances
    .map((s) => `- ${s.persona} (${s.verdict}): ${s.comments}`)
    .join('\n');

  return `You are the Solution Architect. Revise the proposed breakdown using the panel's feedback.

## Original task
${task.id} [${task.domain}]: ${task.name}
Acceptance: ${task.acceptanceCriteria}

## Current proposed breakdown
${storiesBlock(proposal)}

## Panel feedback
${feedback}

## Your job
Produce a revised breakdown of 2 to 4 stories that addresses the feedback, still fully covers the original acceptance criteria, and keeps every story single-pass and within the "${task.domain}" domain.

Output ONLY a JSON array, nothing else:

[
  { "name": "<short story name>", "description": "<one focused concern>", "acceptanceCriteria": "<specific, verifiable criteria>" }
]`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors (the `debate.mts` types imported here already exist from Task 3).

- [ ] **Step 5: Commit**

```bash
git add src/prd/prompts.mts tests/unit/prd/prompts.test.mts
git commit -m "feat: debate proposal, critique, and synthesis prompts"
```

---

## Task 5: The debate loop (`runDebate`)

**Files:**
- Modify: `src/prd/debate.mts` (add `DebateDeps`, `runDebate`)
- Test: `tests/unit/prd/debate.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/debate.test.mts`:

```ts
import { runDebate, DebateError, type DebateDeps } from '../../../src/prd/debate.mts';
import type { Task } from '../../../src/types/index.mts';

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'TASK-001', name: 'big', description: 'd', acceptanceCriteria: 'a; b; c',
    testCommand: 'bun test', dependsOn: [], domain: 'database', status: 'pending',
    iterationCount: 0, ...over,
  };
}

const twoStories = '[{"name":"schema","description":"d","acceptanceCriteria":"a"},{"name":"repo","description":"d","acceptanceCriteria":"b"}]';

describe('runDebate', () => {
  it('ends in round 1 by consensus when all personas agree', async () => {
    const deps: DebateDeps = {
      proposeFn: async () => twoStories,
      critiqueFn: async () => '{"verdict":"agree","comments":"ok"}',
      synthesizeFn: async () => { throw new Error('should not synthesize on consensus'); },
    };
    const result = await runDebate(makeTask(), deps);
    expect(result.decidedBy).toBe('consensus');
    expect(result.rounds).toHaveLength(1);
    expect(result.finalStories).toHaveLength(2);
  });

  it('runs to the round cap then the architect decides', async () => {
    const deps: DebateDeps = {
      proposeFn: async () => twoStories,
      critiqueFn: async () => '{"verdict":"revise","comments":"nope"}',
      synthesizeFn: async () => twoStories,
    };
    const result = await runDebate(makeTask(), deps);
    expect(result.decidedBy).toBe('architect');
    expect(result.rounds).toHaveLength(4); // DEBATE_MAX_ROUNDS
  });

  it('throws DebateError when the opening proposal has no stories', async () => {
    const deps: DebateDeps = {
      proposeFn: async () => 'not json',
      critiqueFn: async () => '{"verdict":"agree","comments":"ok"}',
    };
    await expect(runDebate(makeTask(), deps)).rejects.toBeInstanceOf(DebateError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/debate.test.mts`
Expected: FAIL — `runDebate` is not exported.

- [ ] **Step 3: Implement `runDebate`**

In `src/prd/debate.mts`, add these imports at the top:

```ts
import { createChatModel } from '../models/index.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { logger } from '../logger.mts';
import {
  buildDebateProposalPrompt,
  buildPersonaCritiquePrompt,
  buildDebateSynthesisPrompt,
} from './prompts.mts';
```

Then add at the bottom of the file:

```ts
export interface DebateDeps {
  proposeFn?: (task: Task) => Promise<string>;
  critiqueFn?: (persona: DebatePersona, task: Task, proposal: ProposedStory[], round: number) => Promise<string>;
  synthesizeFn?: (task: Task, proposal: ProposedStory[], stances: PersonaStance[]) => Promise<string>;
}

function extractContent(aiMessage: AIMessage): string {
  const content = aiMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : typeof b === 'object' && b !== null && 'text' in b && typeof (b as { text: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
      )
      .join('');
  }
  return String(content);
}

async function invoke(modelName: string, systemPrompt: string): Promise<string> {
  const model = createChatModel(modelName);
  const res = (await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage('Respond now with only the requested JSON.'),
  ])) as AIMessage;
  return extractContent(res);
}

function renderTranscript(rounds: DebateRound[], decidedBy: DebateResult['decidedBy']): string {
  const body = rounds
    .map((r) => {
      const votes = r.stances.map((s) => `  ${s.persona}: ${s.verdict} — ${s.comments}`).join('\n');
      return `Round ${r.round} (${r.proposal.length} stories)\n${votes}`;
    })
    .join('\n\n');
  return `${body}\n\nDecided by: ${decidedBy}`;
}

export async function runDebate(task: Task, deps?: DebateDeps): Promise<DebateResult> {
  const propose = deps?.proposeFn ?? ((t: Task) => invoke(personaModel('solution_architect'), buildDebateProposalPrompt(t)));
  const critique =
    deps?.critiqueFn ??
    ((p: DebatePersona, t: Task, prop: ProposedStory[], round: number) =>
      invoke(personaModel(p), buildPersonaCritiquePrompt(p, t, prop, round)));
  const synthesize =
    deps?.synthesizeFn ??
    ((t: Task, prop: ProposedStory[], stances: PersonaStance[]) =>
      invoke(personaModel('solution_architect'), buildDebateSynthesisPrompt(t, prop, stances)));

  let proposal = parseStories(await propose(task));
  if (proposal.length === 0) {
    throw new DebateError(`Debate for ${task.id} produced no opening proposal`);
  }

  const rounds: DebateRound[] = [];
  let decidedBy: DebateResult['decidedBy'] = 'architect';
  const maxRounds = env.DEBATE_MAX_ROUNDS;

  for (let round = 1; round <= maxRounds; round++) {
    const stances: PersonaStance[] = [];
    for (const persona of DEBATE_PERSONAS) {
      stances.push(parseStance(persona, await critique(persona, task, proposal, round)));
    }
    rounds.push({ round, proposal, stances });

    if (stances.every((s) => s.verdict === 'agree')) {
      decidedBy = 'consensus';
      break;
    }
    if (round === maxRounds) {
      decidedBy = 'architect';
      break;
    }

    const revised = parseStories(await synthesize(task, proposal, stances));
    if (revised.length > 0) proposal = revised; // keep prior proposal if synthesis garbles
  }

  logger.info({ taskId: task.id, decidedBy, rounds: rounds.length }, 'debate.decided');
  return {
    taskId: task.id,
    taskName: task.name,
    rounds,
    finalStories: proposal,
    decidedBy,
    transcript: renderTranscript(rounds, decidedBy),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/debate.test.mts`
Expected: PASS (all debate tests). Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/prd/debate.mts tests/unit/prd/debate.test.mts
git commit -m "feat: runDebate persona loop with consensus and architect decision"
```

---

## Task 6: `debateSplit` orchestration in the sizer (retry + fallback + children + recommendation)

**Files:**
- Modify: `src/prd/sizer.mts` (add `debateSplit`; import `runDebate`, `buildChildTasks`)
- Test: `tests/unit/prd/sizer.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/sizer.test.mts`:

```ts
import { debateSplit } from '../../../src/prd/sizer.mts';

describe('debateSplit', () => {
  it('builds sized-ready children and a recommendation from a successful debate', async () => {
    const parent = makeTask({ id: 'TASK-050', domain: 'database' });
    const out = await debateSplit(parent, {
      debateFn: async () => ({
        taskId: parent.id, taskName: parent.name, rounds: [], decidedBy: 'consensus' as const,
        transcript: 't',
        finalStories: [
          { name: 'schema', description: 'd', acceptanceCriteria: 'a' },
          { name: 'repo', description: 'd', acceptanceCriteria: 'b' },
        ],
      }),
    });
    expect(out.children.map((c) => c.id)).toEqual(['TASK-050-1', 'TASK-050-2']);
    expect(out.children.every((c) => c.domain === 'database')).toBe(true);
    expect(out.recommendation.taskId).toBe('TASK-050');
    expect(out.recommendation.recommendation.toLowerCase()).toContain('consensus');
  });

  it('retries once then falls back to the deterministic split on repeated debate failure', async () => {
    const parent = makeTask({ id: 'TASK-051', acceptanceCriteria: 'a\nb\nc\nd\ne\nf' });
    let calls = 0;
    const out = await debateSplit(parent, {
      debateFn: async () => { calls++; throw new Error('ollama down'); },
      splitFn: async () => [
        { ...makeTask({ id: 'TASK-051-1', splitDepth: 1 }), size: 'M' as const },
      ],
    });
    expect(calls).toBe(2); // initial + one retry
    expect(out.children.map((c) => c.id)).toEqual(['TASK-051-1']);
    expect(out.recommendation.recommendation.toLowerCase()).toContain('acceptance-criteria'); // deterministic text
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: FAIL — `debateSplit` is not exported.

- [ ] **Step 3: Implement `debateSplit`**

In `src/prd/sizer.mts`, add imports at the top:

```ts
import { runDebate, type DebateResult, type DebateDeps } from './debate.mts';
import { buildChildTasks } from './splitter.mts';
```

(`splitTask`, `applySplit`, `canSplitForSize` are already imported on line 8.)

Add these exports (place above `sizePlan`):

```ts
export interface DebateSplitDeps extends DebateDeps {
  // Override the whole debate (unit tests inject a canned DebateResult).
  debateFn?: (task: Task) => Promise<DebateResult>;
  // Deterministic fallback splitter (defaults to splitTask).
  splitFn?: typeof splitTask;
}

export interface DebateSplitResult {
  children: Task[];
  recommendation: SizeRecommendation;
}

function summarizeDebate(task: Task, result: DebateResult): SizeRecommendation {
  const { reasons } = explainOversize(task);
  const stories = result.finalStories.map((s, i) => `${i + 1}. ${s.name} — ${s.description}`).join('\n');
  const recommendation =
    `Decided by ${result.decidedBy} after ${result.rounds.length} round(s). Split into:\n${stories}`;
  return { taskId: task.id, taskName: task.name, reasons, recommendation };
}

function deterministicRecommendation(task: Task): SizeRecommendation {
  const { reasons, recommendation } = explainOversize(task);
  return { taskId: task.id, taskName: task.name, reasons, recommendation };
}

// Run the debate to drive the split. Retries the debate once, then falls back
// to the deterministic splitter + recommendation so the run never stalls on a
// flaky model.
export async function debateSplit(task: Task, deps?: DebateSplitDeps): Promise<DebateSplitResult> {
  const debate = deps?.debateFn ?? ((t: Task) => runDebate(t, deps));
  const split = deps?.splitFn ?? splitTask;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await debate(task);
      const children = buildChildTasks(task, result.finalStories);
      if (children.length === 0) throw new Error('debate produced no stories');
      return { children, recommendation: summarizeDebate(task, result) };
    } catch (err) {
      logger.warn(
        { taskId: task.id, attempt, err: err instanceof Error ? err.message : String(err) },
        'sizer.debate_failed',
      );
    }
  }

  const children = await split(task, '');
  return { children, recommendation: deterministicRecommendation(task) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: PASS (new `debateSplit` tests; existing tests may fail to compile if they still reference removed symbols — that is fixed in Task 7). Run `bunx tsc --noEmit`.

> Note: `recommendSplitApproach` is still present at this point; it is removed in Task 8. If the existing `sizePlan` tests reference `recommendFn`/`splitFn`, they are rewired in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/prd/sizer.mts tests/unit/prd/sizer.test.mts
git commit -m "feat: debateSplit orchestration with retry and deterministic fallback"
```

---

## Task 7: Rewire `sizePlan` onto the debate

**Files:**
- Modify: `src/prd/sizer.mts:230-307`
- Test: `tests/unit/prd/sizer.test.mts` (update the existing `sizePlan` describe block)

- [ ] **Step 1: Update the failing tests**

In `tests/unit/prd/sizer.test.mts`, replace the entire `describe('sizePlan', ...)` block with:

```ts
describe('sizePlan', () => {
  const canned = (parentId: string) => ({
    debateFn: async () => ({
      taskId: parentId, taskName: 'x', rounds: [], decidedBy: 'consensus' as const, transcript: 't',
      finalStories: [
        { name: 'a', description: 'd', acceptanceCriteria: 'a' },
        { name: 'b', description: 'd', acceptanceCriteria: 'b' },
      ],
    }),
  });

  it('splits an L task into sized children and leaves no L', async () => {
    const tasks = [makeTask({ id: 'TASK-001', domain: 'database' })];
    const result = await sizePlan(tasks, {
      sizeFn: async () => new Map([['TASK-001', 'L']]),
      debateFn: async () => (await debateSplit(makeTask({ id: 'TASK-001', domain: 'database' }), canned('TASK-001'))),
    });
    expect(result.tasks.some((t) => t.size === 'L')).toBe(false);
    expect(result.tasks.map((t) => t.id)).toEqual(['TASK-001-1', 'TASK-001-2']);
    expect(result.recommendations).toHaveLength(1);
  });

  it('hard-stops when an L cannot be split further', async () => {
    const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })]; // already at max depth
    await expect(
      sizePlan(tasks, { sizeFn: async () => new Map([['TASK-001', 'L']]) }),
    ).rejects.toBeInstanceOf(SizeGateError);
  });

  it('includes recommendations in the gate error for unsplittable L tasks', async () => {
    const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })];
    try {
      await sizePlan(tasks, { sizeFn: async () => new Map([['TASK-001', 'L']]) });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SizeGateError);
      expect((err as SizeGateError).recommendations).toHaveLength(1);
    }
  });
});
```

Ensure the import line at the top of the file includes `debateSplit` (added in Task 6) and no longer imports `recommendSplitApproach` (removed in Task 8 — leave it importable for now if the file still compiles; the `recommendSplitApproach` describe block is removed in Task 8).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: FAIL — `SizePlanDeps` has no `debateFn`.

- [ ] **Step 3: Rewire `SizePlanDeps` and the `sizePlan` loop**

In `src/prd/sizer.mts`, replace `SizePlanDeps` (lines ~230-234) with:

```ts
export interface SizePlanDeps {
  sizeFn?: (tasks: readonly Task[]) => Promise<Map<string, TaskSize>>;
  debateFn?: (task: Task) => Promise<DebateSplitResult>;
}
```

Then replace the body of `sizePlan` (lines ~253-307) with:

```ts
export async function sizePlan(
  tasks: Task[],
  deps?: SizePlanDeps,
): Promise<SizedPlanResult> {
  const sizeFn = deps?.sizeFn ?? ((t: readonly Task[]) => getModelSizes(t));
  const debate = deps?.debateFn ?? ((t: Task) => debateSplit(t));

  const sizeChildren = async (children: Task[]): Promise<Task[]> => {
    const unsized = children.filter((c) => !c.size);
    if (unsized.length === 0) return children;
    const childSizes = await sizeFn(unsized);
    return children.map((c) => (c.size ? c : sizeOne(c, childSizes)));
  };

  const modelSizes = await sizeFn(tasks);
  let current: Task[] = tasks.map((t) => sizeOne(t, modelSizes));
  const splits: Array<{ parentId: string; childIds: string[] }> = [];
  const recMap = new Map<string, SizeRecommendation>();

  for (let pass = 0; pass < MAX_SIZE_PASSES; pass++) {
    const oversized = current.filter((t) => t.size === 'L');
    if (oversized.length === 0) break;

    // Unsplittable L tasks still need a recommendation for the gate error.
    for (const t of oversized) {
      if (!canSplitForSize(t) && !recMap.has(t.id)) {
        recMap.set(t.id, deterministicRecommendation(t));
      }
    }

    const splittable = oversized.filter((t) => canSplitForSize(t));
    if (splittable.length === 0) break; // nothing more we can do — gate decides

    for (const parentTask of splittable) {
      const { children, recommendation } = await debate(parentTask);
      if (!recMap.has(parentTask.id)) recMap.set(parentTask.id, recommendation);
      if (children.length === 0) continue;
      const sizedChildren = await sizeChildren(children);
      current = applySplit(current, parentTask.id, sizedChildren);
      splits.push({ parentId: parentTask.id, childIds: sizedChildren.map((c) => c.id) });
    }
  }

  const recommendations = [...recMap.values()];
  const stillLarge = current.filter((t) => t.size === 'L').map((t) => t.id);
  if (stillLarge.length > 0 && env.SIZE_ENFORCE_GATE) {
    throw new SizeGateError(
      stillLarge,
      recommendations.filter((r) => stillLarge.includes(r.taskId)),
    );
  }

  return { tasks: current, distribution: countSizes(current), splits, recommendations };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/prd/sizer.mts tests/unit/prd/sizer.test.mts
git commit -m "feat: drive L-task splits through the debate in sizePlan"
```

---

## Task 8: Remove the superseded single-shot recommendation

**Files:**
- Modify: `src/prd/sizer.mts` (remove `recommendSplitApproach`, `RecommendDeps`)
- Modify: `src/prd/prompts.mts` (remove `buildSplitRecommendationPrompt`)
- Modify: `tests/unit/prd/sizer.test.mts`, `tests/unit/prd/prompts.test.mts`

- [ ] **Step 1: Remove the tests first**

In `tests/unit/prd/sizer.test.mts`, delete the entire `describe('recommendSplitApproach', ...)` block and remove `recommendSplitApproach` from the top-level import.

In `tests/unit/prd/prompts.test.mts`, delete any test referencing `buildSplitRecommendationPrompt` and remove it from the import.

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `bunx tsc --noEmit`
Expected: FAIL — the removed test symbols are gone but the source still exports them (unused) — this compiles, so instead verify by grep that no test references remain: `grep -rn "recommendSplitApproach\|buildSplitRecommendationPrompt" tests/` returns nothing.

- [ ] **Step 3: Remove the source symbols**

In `src/prd/sizer.mts`:
- Delete the `RecommendDeps` interface (lines ~88-90).
- Delete the entire `recommendSplitApproach` function (lines ~92-127).
- Remove `buildSplitRecommendationPrompt` from the `./prompts.mts` import on line 5 (keep `buildSizingPrompt`).

In `src/prd/prompts.mts`:
- Delete the entire `buildSplitRecommendationPrompt` function (lines ~164-180).

`explainOversize` stays — it is used by `deterministicRecommendation`.

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS (all suites). Run `bunx tsc --noEmit` — only the 16 pre-existing baseline errors.
Run: `grep -rn "recommendSplitApproach\|buildSplitRecommendationPrompt" src/ tests/`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add src/prd/sizer.mts src/prd/prompts.mts tests/unit/prd/sizer.test.mts tests/unit/prd/prompts.test.mts
git commit -m "refactor: remove superseded recommendSplitApproach path"
```

---

## Task 9: Compact debate summary in SIZING.md

The recommendation text produced by `summarizeDebate` already carries "Decided by <consensus|architect> …". This task confirms the report renders it and adds a header note.

**Files:**
- Modify: `src/prd/sizing-report.mts:20-30`
- Test: `tests/unit/prd/sizing-report.test.mts`

- [ ] **Step 1: Write the failing test**

Replace the second test in `tests/unit/prd/sizing-report.test.mts` (`renders a recommendations section...`) with:

```ts
  it('renders a debate-sourced recommendation with the decision maker', () => {
    const result: SizedPlanResult = {
      tasks: [task('TASK-001', 'database', 'L')],
      distribution: { S: 0, M: 0, L: 1 },
      splits: [],
      recommendations: [
        {
          taskId: 'TASK-001',
          taskName: 'big task',
          reasons: ['Spans 3 distinct domains.'],
          recommendation: 'Decided by consensus after 2 round(s). Split into:\n1. schema — d\n2. repo — d',
        },
      ],
    };
    const md = buildSizingReport('Notes App', 'notes-app', result);
    expect(md).toContain('## Recommendations for Oversized Tasks');
    expect(md).toContain('Decided by consensus');
    expect(md).toContain('Debate outcome'); // new label
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/sizing-report.test.mts`
Expected: FAIL — output does not contain "Debate outcome".

- [ ] **Step 3: Update the recommendation renderer**

In `src/prd/sizing-report.mts`, change the `recRows` mapping (lines ~23-28) to label the debate outcome:

```ts
      ? result.recommendations
          .map(
            (r) =>
              `### ${r.taskId} — ${r.taskName}\n\n` +
              `**Why:** ${r.reasons.join(' ')}\n\n` +
              `**Debate outcome:**\n\n${r.recommendation}`,
          )
          .join('\n\n')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/sizing-report.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/sizing-report.mts tests/unit/prd/sizing-report.test.mts
git commit -m "feat: label debate outcome in the sizing report"
```

---

## Task 10: Live Ollama smoke

Proves the debate actually runs end-to-end against real models — unit tests inject deps and never exercise the model or JSON round-trip.

**Files:**
- Create: `scripts/debate-smoke.mts`

- [ ] **Step 1: Write the smoke script**

Create `scripts/debate-smoke.mts`:

```ts
import { assertOllamaReachable } from '../src/models/index.mts';
import { runDebate } from '../src/prd/debate.mts';
import type { Task } from '../src/types/index.mts';

const task: Task = {
  id: 'TASK-001',
  name: 'Build the full notes feature',
  description:
    'Implement a Mongo repository, an Elysia route handler, and an Angular standalone component for notes, wired end to end.',
  acceptanceCriteria:
    'notes persist to Mongo; the API exposes CRUD routes returning ApiResponse; the UI lists and creates notes; validation rejects empty bodies.',
  testCommand: 'bun test',
  dependsOn: [],
  domain: 'services',
  status: 'pending',
  iterationCount: 0,
};

async function main(): Promise<void> {
  await assertOllamaReachable();
  console.log('Running debate against live Ollama (this is slow)...');
  const result = await runDebate(task);
  console.log('Decided by:', result.decidedBy, 'in', result.rounds.length, 'round(s)');
  console.log('Final stories:');
  for (const s of result.finalStories) console.log(` - ${s.name}: ${s.description}`);
  console.log('\nTranscript:\n' + result.transcript);
  if (result.finalStories.length < 2) {
    throw new Error('Expected at least 2 stories from the debate');
  }
  console.log('\nSmoke OK');
}

main().catch((err) => {
  console.error('Smoke FAILED:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke (requires Ollama running)**

Run: `bun run scripts/debate-smoke.mts`
Expected: prints a decision (`consensus` or `architect`), ≥ 2 stories, and `Smoke OK`. May take a few minutes on local models.

> If Ollama is unreachable in the execution environment, note it and skip — do not fail the task. The unit suite is the gate; this script is operator-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/debate-smoke.mts
git commit -m "test: live Ollama smoke for the debate forum"
```

---

## Final Verification

- [ ] Run the whole suite: `bun test` — all green.
- [ ] Type check: `bunx tsc --noEmit` — only the 16 pre-existing baseline errors.
- [ ] `grep -rn "recommendSplitApproach\|buildSplitRecommendationPrompt" src/ tests/` — no matches.
- [ ] Confirm `sizePlan` still returns the same `SizedPlanResult` shape (no `graph.mts` change needed).
