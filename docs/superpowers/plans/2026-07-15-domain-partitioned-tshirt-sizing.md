# Domain-Partitioned, T-Shirt-Sized Planning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ODA's planner tag every task with one functional-area domain and a T-shirt size (S/M/L), and guarantee no task larger than Medium ever executes by proactively splitting any `L` before the run starts.

**Architecture:** The single `generate_prd` graph node becomes a planning sub-pipeline `draft_plan → size_plan → ratify_plan(stub) → awaiting_approval`. A new `src/prd/sizer.mts` sizes tasks by model judgment plus a deterministic floor, then splits every `L` into `S`/`M` children using the existing splitter. A proactive gate hard-stops the run if any `L` survives; the existing post-failure auto-split remains as a backstop.

**Tech Stack:** BunJS, TypeScript strict, LangGraph (`@langchain/langgraph`), LangChain messages, zod (env), luxon, `bun test`. All source `.mts`, kebab-case filenames, imports carry `.mts`.

**Reference:** Design spec at `docs/superpowers/specs/2026-07-15-domain-partitioned-tshirt-sizing-design.md`. Reference implementation of the pattern lives at `C:\projects\davisSylvester\claude-single-shot-agent` (`agents/story-sizer.md`, `agents/project-owner.md`).

**Note on conventions:** The global standard prefers TypeBox over zod, but `src/env.mts` already uses zod — follow the existing file. One type per file for the new `TaskSize`/`TaskDomain`.

---

## File Structure

**Create:**
- `src/types/task-size.mts` — `TaskSize` union.
- `src/types/task-domain.mts` — `TaskDomain` union + `TASK_DOMAINS` list + `DOMAIN_KEYWORDS` map.
- `src/prd/sizer.mts` — sizing signals, deterministic floor, model sizing pass, proactive split loop + gate.
- `src/prd/sizing-report.mts` — builds `SIZING.md` markdown.
- `tests/unit/prd/sizer.test.mts` — sizer unit tests.
- `tests/unit/prd/sizing-report.test.mts` — report builder tests.

**Modify:**
- `src/types/task.mts` — add `domain` + `size` to `Task`.
- `src/types/index.mts` — barrel the new types.
- `src/prd/parser.mts` — extract `**Domain**:`; default + warn when absent.
- `src/prd/prompts.mts` — drafter prompt requires domain-first partition + `**Domain**:` tag; add `buildSizingPrompt`.
- `src/prd/splitter.mts` — children inherit parent `domain`; add `canSplitForSize`.
- `src/env.mts` — add sizing-threshold env vars.
- `src/types/agent.mts` — add `sizing_plan` phase + `plan_sized` event.
- `src/agent/graph.mts` — split `generate_prd` into `draft_plan` + `size_plan` + `ratify_plan` stub; emit `plan_sized`; write `SIZING.md`; propagate `domain`/`size` on the reactive backstop split.
- `tests/unit/prd/parser.test.mts` (or nearest existing parser test) — assert domain parsing.

---

## Task 1: Add `TaskSize` and `TaskDomain` types

**Files:**
- Create: `src/types/task-size.mts`
- Create: `src/types/task-domain.mts`
- Modify: `src/types/task.mts`
- Modify: `src/types/index.mts`
- Test: `tests/unit/prd/sizer.test.mts` (created later; type-check is the gate here)

- [ ] **Step 1: Create the size type**

Create `src/types/task-size.mts`:

```ts
// A task's T-shirt size. `L` means "too big for one focused pass — must be
// split into S/M children before execution."
export type TaskSize = 'S' | 'M' | 'L';
```

- [ ] **Step 2: Create the domain type + keyword map**

Create `src/types/task-domain.mts`:

```ts
// The functional area a task belongs to. Exactly one per task.
export type TaskDomain =
  | 'ui'
  | 'api'
  | 'services'
  | 'database'
  | 'auth'
  | 'iac'
  | 'e2e'
  | 'ci';

// Canonical ordered list for validation and reporting.
export const TASK_DOMAINS: readonly TaskDomain[] = [
  'ui',
  'api',
  'services',
  'database',
  'auth',
  'iac',
  'e2e',
  'ci',
];

// Keywords that signal a domain in free-text description/acceptance. Used by the
// deterministic floor to detect a task that spans more than one domain.
export const DOMAIN_KEYWORDS: Record<TaskDomain, readonly string[]> = {
  ui: ['angular', 'component', 'frontend', 'front-end', 'css', 'scss', 'view', 'template'],
  api: ['elysia', 'endpoint', 'route', 'http server', 'controller', 'rest'],
  services: ['service', 'business logic', 'orchestration', 'use case', 'domain rule'],
  database: ['mongo', 'mongodb', 'repository', 'schema', 'collection', 'dal', 'persistence'],
  auth: ['auth', 'auth0', 'jwt', 'login', 'token', 'oauth', 'permission'],
  iac: ['terraform', 'infrastructure', 'provision', 'azure', 'container app'],
  e2e: ['playwright', 'e2e', 'end-to-end', 'browser test'],
  ci: ['github actions', 'workflow', 'ci', 'pipeline', 'deploy'],
};

export function isTaskDomain(value: string): value is TaskDomain {
  return (TASK_DOMAINS as readonly string[]).includes(value);
}
```

- [ ] **Step 3: Extend the `Task` interface**

In `src/types/task.mts`, add the import and two fields. Replace the current interface top:

```ts
import type { TaskSize } from './task-size.mts';
import type { TaskDomain } from './task-domain.mts';

export interface Task {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly testCommand: string;
  readonly dependsOn: readonly string[];
  // Functional area. Defaults to 'services' with a warning if the drafter omits it.
  readonly domain: TaskDomain;
  // T-shirt size assigned by the sizer. Absent until size_plan runs.
  size?: TaskSize;
  status: TaskStatus;
  iterationCount: number;
  splitDepth?: number;
}
```

- [ ] **Step 4: Barrel the new types**

In `src/types/index.mts`, add after the existing `./task.mts` re-export line:

```ts
export type { TaskSize } from './task-size.mts';
export type { TaskDomain } from './task-domain.mts';
export { TASK_DOMAINS, DOMAIN_KEYWORDS, isTaskDomain } from './task-domain.mts';
```

- [ ] **Step 5: Type-check (expected to fail where `Task` is constructed without `domain`)**

Run: `bunx tsc --noEmit`
Expected: NEW errors only in files that build a `Task` literal without `domain` — `src/prd/parser.mts` and `src/prd/splitter.mts`. (Pre-existing unrelated errors may remain; note the count.) Tasks 2 and 8 fix these.

- [ ] **Step 6: Commit**

```bash
git add src/types/task-size.mts src/types/task-domain.mts src/types/task.mts src/types/index.mts
git commit -m "feat: add TaskSize and TaskDomain types to Task"
```

---

## Task 2: Parse `**Domain**:` in the PRD parser

**Files:**
- Modify: `src/prd/parser.mts`
- Test: `tests/unit/prd/parser.test.mts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/prd/parser.test.mts` (create the file if it does not exist, importing from `../../../src/prd/parser.mts`):

```ts
import { describe, expect, it } from 'bun:test';
import { parseTasks } from '../../../src/prd/parser.mts';

describe('parseTasks — domain', () => {
  it('parses an explicit **Domain** tag', () => {
    const prd = [
      '## Tasks',
      '- [ ] **TASK-001**: Build login form',
      '  - **Domain**: ui',
      '  - **Description**: Angular login component',
      '  - **Acceptance**: renders and submits',
      '  - **Test Command**: `bun test`',
    ].join('\n');

    const [task] = parseTasks(prd);
    expect(task?.domain).toBe('ui');
  });

  it('defaults domain to services when the tag is missing', () => {
    const prd = [
      '- [ ] **TASK-001**: Something',
      '  - **Description**: no domain here',
      '  - **Acceptance**: works',
      '  - **Test Command**: `bun test`',
    ].join('\n');

    const [task] = parseTasks(prd);
    expect(task?.domain).toBe('services');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/parser.test.mts`
Expected: FAIL — `task.domain` is `undefined` (parser does not set it yet).

- [ ] **Step 3: Implement domain extraction**

In `src/prd/parser.mts`, add the import at the top:

```ts
import { isTaskDomain, type TaskDomain } from '../types/index.mts';
import { logger } from '../logger.mts';
```

Add this helper next to the other `extract*` helpers:

```ts
function extractDomain(block: string, taskId: string): TaskDomain {
  const raw = extractSubBullet(block, 'Domain').toLowerCase().trim();
  if (isTaskDomain(raw)) {
    return raw;
  }
  logger.warn({ taskId, raw }, 'parser.domain_missing_defaulted');
  return 'services';
}
```

Then in the `parseTasks` loop, compute it and add to the pushed object. Replace the `const dependsOn = extractDependsOn(block);` line's vicinity so the push includes `domain`:

```ts
    const dependsOn = extractDependsOn(block);
    const domain = extractDomain(block, current.id);

    tasks.push({
      id: current.id,
      name: current.name,
      description,
      acceptanceCriteria,
      testCommand,
      dependsOn,
      domain,
      status: current.checked ? 'complete' : 'pending',
      iterationCount: 0,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/prd/parser.test.mts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/prd/parser.mts tests/unit/prd/parser.test.mts
git commit -m "feat: parse Domain tag on PRD tasks"
```

---

## Task 3: Require domain-first partitioning in the drafter prompt

**Files:**
- Modify: `src/prd/prompts.mts`
- Test: manual (prompt text) — asserted via a string test below

- [ ] **Step 1: Write the failing test**

Add `tests/unit/prd/prompts.test.mts`:

```ts
import { describe, expect, it } from 'bun:test';
import { buildPRDGenerationPrompt } from '../../../src/prd/prompts.mts';

describe('buildPRDGenerationPrompt — domain partitioning', () => {
  it('instructs the drafter to tag every task with a Domain', () => {
    const prompt = buildPRDGenerationPrompt('build a notes app', false);
    expect(prompt).toContain('**Domain**');
    expect(prompt).toContain('ui, api, services, database, auth, iac, e2e, ci');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: FAIL — the prompt does not yet mention `**Domain**` or the domain list.

- [ ] **Step 3: Update the drafter prompt**

In `src/prd/prompts.mts`, inside `buildPRDGenerationPrompt`, update the task template block to include a `**Domain**` line. Change the `## Tasks` example so TASK-001 shows the domain line:

```
## Tasks
- [ ] **TASK-001**: <task name>
  - **Domain**: <one of: ui | api | services | database | auth | iac | e2e | ci>
  - **Description**: <what needs to be implemented>
  - **Acceptance**: <specific, measurable acceptance criteria>
  - **Test Command**: \`<bun test command or shell command to verify>\`
```

Then add a new rules section immediately before `## Task Sizing — CRITICAL`:

```
## Functional Areas (Domains) — REQUIRED

Partition the work **by functional area first**, then decompose each area into tasks. Every task MUST carry exactly ONE \`**Domain**\` tag from this closed set:

- \`ui\` — Angular components, views, styling
- \`api\` — Elysia routes/controllers (transport only)
- \`services\` — business logic / orchestration (storage-agnostic)
- \`database\` — Mongo schemas, repositories, data access
- \`auth\` — authentication / authorization
- \`iac\` — Terraform / infrastructure
- \`e2e\` — Playwright end-to-end tests
- \`ci\` — GitHub Actions / pipelines

Rules:
- A task that would span **more than one** domain is too big — split it so each child is single-domain.
- Do NOT invent domains outside this set.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prd/prompts.mts tests/unit/prd/prompts.test.mts
git commit -m "feat: require domain-first partitioning in drafter prompt"
```

---

## Task 4: Add sizing-threshold env vars

**Files:**
- Modify: `src/env.mts`
- Test: `tests/unit/prd/sizer.test.mts` reads these; type-check gate here

- [ ] **Step 1: Add the env fields**

In `src/env.mts`, add inside `envSchema` (after `AUTO_SPLIT_ON_FAILURE`):

```ts
  // Deterministic sizing floor: a task is force-promoted to `L` (must split)
  // when any of these signals is exceeded, regardless of the model's own guess.
  SIZE_MAX_CRITERIA: z.coerce.number().int().min(1).max(20).default(4),
  SIZE_MAX_CONCERNS: z.coerce.number().int().min(1).max(20).default(3),
  // When false, an unsplittable `L` warns instead of hard-stopping the run.
  SIZE_ENFORCE_GATE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0'),
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no NEW errors from `src/env.mts`.

- [ ] **Step 3: Commit**

```bash
git add src/env.mts
git commit -m "feat: add sizing-threshold env vars"
```

---

## Task 5: Sizer signals + deterministic floor (pure functions)

**Files:**
- Create: `src/prd/sizer.mts`
- Test: `tests/unit/prd/sizer.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prd/sizer.test.mts`:

```ts
import { describe, expect, it } from 'bun:test';
import { computeSignals, applyDeterministicFloor } from '../../../src/prd/sizer.mts';
import type { Task } from '../../../src/types/index.mts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-001',
    name: 'sample',
    description: 'do a thing',
    acceptanceCriteria: 'it works',
    testCommand: 'bun test',
    dependsOn: [],
    domain: 'services',
    status: 'pending',
    iterationCount: 0,
    ...overrides,
  };
}

describe('computeSignals', () => {
  it('counts acceptance-criteria clauses split on newline and semicolon', () => {
    const task = makeTask({ acceptanceCriteria: 'a; b\nc; d; e' });
    expect(computeSignals(task).criteriaCount).toBe(5);
  });

  it('detects more than one domain mentioned in the text', () => {
    const task = makeTask({
      description: 'add an Elysia endpoint and an Angular component',
    });
    expect(computeSignals(task).domainMentions).toBeGreaterThan(1);
  });

  it('counts concerns via "and" / commas in the description', () => {
    const task = makeTask({ description: 'scaffold, wire, validate and test' });
    expect(computeSignals(task).concernCount).toBeGreaterThanOrEqual(3);
  });
});

describe('applyDeterministicFloor', () => {
  it('keeps the model size when no signal is exceeded', () => {
    expect(applyDeterministicFloor(makeTask(), 'S')).toBe('S');
  });

  it('force-promotes to L when criteria count exceeds the threshold', () => {
    const task = makeTask({ acceptanceCriteria: 'a\nb\nc\nd\ne' });
    expect(applyDeterministicFloor(task, 'S')).toBe('L');
  });

  it('force-promotes to L when more than one domain is present', () => {
    const task = makeTask({
      description: 'build an Angular component and a Mongo repository',
    });
    expect(applyDeterministicFloor(task, 'M')).toBe('L');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: FAIL — `src/prd/sizer.mts` does not exist / exports undefined.

- [ ] **Step 3: Implement signals + floor**

Create `src/prd/sizer.mts` with the pure pieces (model + split pieces come in Tasks 6–7):

```ts
import type { Task, TaskSize } from '../types/index.mts';
import { TASK_DOMAINS, DOMAIN_KEYWORDS } from '../types/index.mts';
import { env } from '../env.mts';

export interface SizingSignals {
  readonly criteriaCount: number;
  readonly domainMentions: number;
  readonly concernCount: number;
}

// Derive countable signals from a task's free-text fields.
export function computeSignals(task: Task): SizingSignals {
  const criteriaCount = task.acceptanceCriteria
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  const haystack = `${task.description} ${task.acceptanceCriteria}`.toLowerCase();
  const domainMentions = TASK_DOMAINS.filter((domain) =>
    DOMAIN_KEYWORDS[domain].some((kw) => haystack.includes(kw)),
  ).length;

  const andCount = (task.description.toLowerCase().match(/\band\b/g) ?? []).length;
  const commaCount = (task.description.match(/,/g) ?? []).length;
  const concernCount = andCount + commaCount;

  return { criteriaCount, domainMentions, concernCount };
}

// Force-promote to `L` when any hard signal is exceeded; otherwise keep the
// model's size. The floor only ever raises size, never lowers it.
export function applyDeterministicFloor(task: Task, modelSize: TaskSize): TaskSize {
  const { criteriaCount, domainMentions, concernCount } = computeSignals(task);
  const overCriteria = criteriaCount > env.SIZE_MAX_CRITERIA;
  const multiDomain = domainMentions > 1;
  const overConcerns = concernCount > env.SIZE_MAX_CONCERNS;

  if (overCriteria || multiDomain || overConcerns) {
    return 'L';
  }
  return modelSize;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prd/sizer.mts tests/unit/prd/sizer.test.mts
git commit -m "feat: sizer signals and deterministic floor"
```

---

## Task 6: Model sizing pass

**Files:**
- Modify: `src/prd/prompts.mts` (add `buildSizingPrompt`)
- Modify: `src/prd/sizer.mts` (add `getModelSizes`)
- Test: `tests/unit/prd/sizer.test.mts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/prd/sizer.test.mts`:

```ts
import { getModelSizes } from '../../../src/prd/sizer.mts';

describe('getModelSizes', () => {
  it('parses TASK-ID: SIZE lines from the model output', async () => {
    const tasks = [
      makeTask({ id: 'TASK-001' }),
      makeTask({ id: 'TASK-002' }),
    ];
    const sizes = await getModelSizes(tasks, {
      invokeFn: async () => 'TASK-001: S\nTASK-002: M',
    });
    expect(sizes.get('TASK-001')).toBe('S');
    expect(sizes.get('TASK-002')).toBe('M');
  });

  it('defaults an unparseable/absent task to M', async () => {
    const tasks = [makeTask({ id: 'TASK-001' })];
    const sizes = await getModelSizes(tasks, { invokeFn: async () => 'garbage' });
    expect(sizes.get('TASK-001')).toBe('M');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: FAIL — `getModelSizes` is not exported.

- [ ] **Step 3: Add the sizing prompt**

In `src/prd/prompts.mts`, add a new exported function (place after `buildPRDGenerationPrompt`):

```ts
export function buildSizingPrompt(tasks: readonly Task[]): string {
  const rows = tasks
    .map(
      (t) =>
        `- ${t.id} [${t.domain}]: ${t.name}\n  Description: ${t.description}\n  Acceptance: ${t.acceptanceCriteria}`,
    )
    .join('\n');

  return `You are the Story Sizer. You own exactly one question: does each task fit in a single builder agent's focused pass without exhausting its context?

Assign each task a T-shirt size:
- **S** — trivially one pass.
- **M** — one pass, meaningful but bounded.
- **L** — will NOT fit one pass; must be split.

Judge by concrete signals: files/modules touched; count of schemas / ports / services / routes / components; whether it spans more than one concern or domain; unknowns. A task spanning many endpoints, many collections, or a whole feature's UI is almost always L.

## Tasks to size
${rows}

## Output format — STRICT
Output ONLY one line per task, nothing else:

TASK-001: S
TASK-002: M
TASK-003: L

Use the exact task ids above. Do not add commentary.`;
}
```

- [ ] **Step 4: Implement `getModelSizes`**

In `src/prd/sizer.mts`, add imports and the function:

```ts
import { createChatModel } from '../models/index.mts';
import { buildSizingPrompt } from './prompts.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { logger } from '../logger.mts';

export interface SizerDeps {
  readonly invokeFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
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

function parseSize(raw: string): TaskSize | null {
  const v = raw.trim().toUpperCase();
  return v === 'S' || v === 'M' || v === 'L' ? v : null;
}

// Ask the planner to size each task. Returns id -> TaskSize; any task the model
// omits or garbles defaults to 'M' (the deterministic floor still applies later).
export async function getModelSizes(
  tasks: readonly Task[],
  deps?: SizerDeps,
): Promise<Map<string, TaskSize>> {
  const systemPrompt = buildSizingPrompt(tasks);
  const userPrompt = 'Size every task now.';

  let raw: string;
  if (deps?.invokeFn) {
    raw = await deps.invokeFn(systemPrompt, userPrompt);
  } else {
    const model = createChatModel(env.PLANNER_MODEL);
    const res = (await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ])) as AIMessage;
    raw = extractContent(res);
  }

  const sizes = new Map<string, TaskSize>();
  const linePattern = /(TASK-[\w-]+)\s*:\s*([SML])/gi;
  let m: RegExpExecArray | null;
  while ((m = linePattern.exec(raw)) !== null) {
    const size = parseSize(m[2]!);
    if (size) sizes.set(m[1]!, size);
  }

  for (const task of tasks) {
    if (!sizes.has(task.id)) {
      logger.warn({ taskId: task.id }, 'sizer.model_size_missing_defaulted');
      sizes.set(task.id, 'M');
    }
  }

  return sizes;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: PASS (all sizer tests).

- [ ] **Step 6: Commit**

```bash
git add src/prd/sizer.mts src/prd/prompts.mts tests/unit/prd/sizer.test.mts
git commit -m "feat: model sizing pass for tasks"
```

---

## Task 7: Splitter — children inherit domain; add `canSplitForSize`

**Files:**
- Modify: `src/prd/splitter.mts`
- Test: `tests/unit/prd/splitter.test.mts` (extend existing, or create)

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/prd/splitter.test.mts` (import from `../../../src/prd/splitter.mts`):

```ts
import { describe, expect, it } from 'bun:test';
import { splitTask, canSplitForSize } from '../../../src/prd/splitter.mts';
import type { Task } from '../../../src/types/index.mts';

function parent(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-003',
    name: 'big task',
    description: 'lots of work',
    acceptanceCriteria: 'many things',
    testCommand: 'bun test',
    dependsOn: [],
    domain: 'database',
    status: 'pending',
    iterationCount: 0,
    ...overrides,
  };
}

describe('splitTask — domain inheritance', () => {
  it('gives every child the parent domain', async () => {
    const children = await splitTask(parent(), '', {
      invokeFn: async () =>
        [
          '- [ ] **TASK-1**: schema',
          '  - **Description**: define schema',
          '  - **Acceptance**: schema exists',
          '  - **Test Command**: `bun test`',
          '- [ ] **TASK-2**: repo',
          '  - **Description**: build repo',
          '  - **Acceptance**: repo works',
          '  - **Test Command**: `bun test`',
        ].join('\n'),
    });
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.domain === 'database')).toBe(true);
  });
});

describe('canSplitForSize', () => {
  it('allows splitting an original task', () => {
    expect(canSplitForSize(parent())).toBe(true);
  });
  it('refuses once split depth is reached', () => {
    expect(canSplitForSize(parent({ splitDepth: 1 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/splitter.test.mts`
Expected: FAIL — children lack `domain` (parser now sets it, but the split sub-tasks come from `parseTasks` on the sub-task markdown which defaults to `services`, not `database`); and `canSplitForSize` is not exported.

- [ ] **Step 3: Implement domain inheritance + `canSplitForSize`**

In `src/prd/splitter.mts`, inside `splitTask`, update the `subTasks` mapping to force the parent domain and clear any size:

```ts
  const depth = (task.splitDepth ?? 0) + 1;
  const firstId = `${task.id}-1`;
  const subTasks: Task[] = parsed.map((sub, i) => ({
    ...sub,
    id: `${task.id}-${i + 1}`,
    domain: task.domain, // children stay in the parent's functional area
    size: undefined,      // re-sized by the sizer after the split
    dependsOn: i === 0 ? [...task.dependsOn] : [firstId],
    status: 'pending' as const,
    iterationCount: 0,
    splitDepth: depth,
  }));
```

Add the exported helper near `canSplit`:

```ts
// Proactive (plan-time) split gate. Unlike canSplit it is NOT tied to the
// AUTO_SPLIT_ON_FAILURE runtime flag — proactive sizing always splits an `L`.
export function canSplitForSize(task: Task): boolean {
  return (task.splitDepth ?? 0) < MAX_SPLIT_DEPTH;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/prd/splitter.test.mts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prd/splitter.mts tests/unit/prd/splitter.test.mts
git commit -m "feat: split children inherit parent domain; add canSplitForSize"
```

---

## Task 8: Sizer orchestration + proactive gate (`sizePlan`)

**Files:**
- Modify: `src/prd/sizer.mts`
- Test: `tests/unit/prd/sizer.test.mts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/prd/sizer.test.mts`:

```ts
import { sizePlan, SizeGateError } from '../../../src/prd/sizer.mts';

describe('sizePlan', () => {
  it('splits an L task into sized children and leaves no L', async () => {
    const tasks = [makeTask({ id: 'TASK-001', domain: 'database' })];
    const result = await sizePlan(tasks, {
      // model calls the L, split returns two small children
      sizeFn: async () => new Map([['TASK-001', 'L']]),
      splitFn: async () => [
        makeTask({ id: 'TASK-001-1', domain: 'database', splitDepth: 1 }),
        makeTask({ id: 'TASK-001-2', domain: 'database', splitDepth: 1, dependsOn: ['TASK-001-1'] }),
      ],
    });
    expect(result.tasks.some((t) => t.size === 'L')).toBe(false);
    expect(result.tasks.map((t) => t.id)).toEqual(['TASK-001-1', 'TASK-001-2']);
    expect(result.tasks.every((t) => t.size === 'S' || t.size === 'M')).toBe(true);
  });

  it('hard-stops when an L cannot be split further', async () => {
    const tasks = [makeTask({ id: 'TASK-001', splitDepth: 1 })]; // already at max depth
    await expect(
      sizePlan(tasks, { sizeFn: async () => new Map([['TASK-001', 'L']]) }),
    ).rejects.toBeInstanceOf(SizeGateError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: FAIL — `sizePlan` / `SizeGateError` not exported.

- [ ] **Step 3: Implement `sizePlan` + gate**

In `src/prd/sizer.mts`, add imports and the orchestrator:

```ts
import { splitTask, applySplit, canSplitForSize } from './splitter.mts';

export interface SizedPlanResult {
  readonly tasks: Task[];
  readonly distribution: Record<TaskSize, number>;
  readonly splits: Array<{ parentId: string; childIds: string[] }>;
}

// Thrown when a task remains `L` and cannot be split further while the gate is
// enforced. Aborts the run rather than executing an oversized task.
export class SizeGateError extends Error {
  constructor(public readonly unsplittableIds: string[]) {
    super(
      `Sizing gate failed: ${unsplittableIds.length} task(s) remain size L and ` +
        `cannot be split further: ${unsplittableIds.join(', ')}`,
    );
    this.name = 'SizeGateError';
  }
}

export interface SizePlanDeps {
  readonly sizeFn?: (tasks: readonly Task[]) => Promise<Map<string, TaskSize>>;
  readonly splitFn?: typeof splitTask;
}

// Cap on how many split passes we run so a pathological model can't loop forever.
const MAX_SIZE_PASSES = 5;

// Assign a size to one task: model size raised by the deterministic floor.
function sizeOne(task: Task, modelSizes: Map<string, TaskSize>): Task {
  const modelSize = modelSizes.get(task.id) ?? 'M';
  return { ...task, size: applyDeterministicFloor(task, modelSize) };
}

export async function sizePlan(
  tasks: Task[],
  deps?: SizePlanDeps,
): Promise<SizedPlanResult> {
  const sizeFn = deps?.sizeFn ?? ((t) => getModelSizes(t));
  const split = deps?.splitFn ?? splitTask;

  const modelSizes = await sizeFn(tasks);
  let current: Task[] = tasks.map((t) => sizeOne(t, modelSizes));
  const splits: Array<{ parentId: string; childIds: string[] }> = [];

  for (let pass = 0; pass < MAX_SIZE_PASSES; pass++) {
    const oversized = current.filter((t) => t.size === 'L');
    if (oversized.length === 0) break;

    const splittable = oversized.filter((t) => canSplitForSize(t));
    if (splittable.length === 0) break; // nothing more we can do — gate decides

    for (const parent of splittable) {
      const children = await split(parent, '');
      if (children.length === 0) continue;
      const sizedChildren = await sizeChildren(children);
      current = applySplit(current, parent.id, sizedChildren);
      splits.push({ parentId: parent.id, childIds: sizedChildren.map((c) => c.id) });
    }
  }

  const stillLarge = current.filter((t) => t.size === 'L').map((t) => t.id);
  if (stillLarge.length > 0 && env.SIZE_ENFORCE_GATE) {
    throw new SizeGateError(stillLarge);
  }

  return { tasks: current, distribution: countSizes(current), splits };
}

// Size freshly-split children (their own model pass + floor).
async function sizeChildren(children: Task[]): Promise<Task[]> {
  const childSizes = await getModelSizes(children);
  return children.map((c) => sizeOne(c, childSizes));
}

function countSizes(tasks: readonly Task[]): Record<TaskSize, number> {
  const dist: Record<TaskSize, number> = { S: 0, M: 0, L: 0 };
  for (const t of tasks) {
    if (t.size) dist[t.size]++;
  }
  return dist;
}
```

Note: the two `sizeChildren`/`getModelSizes` calls run against the real planner in production. Tests inject `sizeFn`/`splitFn` and construct children already carrying `size`, so `sizeChildren`'s internal `getModelSizes` still runs — to keep the unit test hermetic, the `splitFn` children in the test are pre-sized `M` via `makeTask`; adjust `sizeChildren` to preserve an existing child size when present:

```ts
async function sizeChildren(children: Task[]): Promise<Task[]> {
  const unsized = children.filter((c) => !c.size);
  if (unsized.length === 0) return children;
  const childSizes = await getModelSizes(unsized);
  return children.map((c) => (c.size ? c : sizeOne(c, childSizes)));
}
```

(`makeTask` in the test has no `size`; add `size: 'M'` to the child factories in the Step 1 test so `sizeChildren` short-circuits and no live model is hit.)

- [ ] **Step 4: Update the Step 1 test children to be pre-sized**

In the `sizePlan` test's `splitFn`, add `size: 'M'` to each returned child so `sizeChildren` skips the model:

```ts
      splitFn: async () => [
        { ...makeTask({ id: 'TASK-001-1', domain: 'database', splitDepth: 1 }), size: 'M' as const },
        { ...makeTask({ id: 'TASK-001-2', domain: 'database', splitDepth: 1, dependsOn: ['TASK-001-1'] }), size: 'M' as const },
      ],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/prd/sizer.test.mts`
Expected: PASS (split-and-size case leaves no `L`; hard-stop case throws `SizeGateError`).

- [ ] **Step 6: Commit**

```bash
git add src/prd/sizer.mts tests/unit/prd/sizer.test.mts
git commit -m "feat: sizePlan orchestration with proactive size gate"
```

---

## Task 9: `SIZING.md` report builder

**Files:**
- Create: `src/prd/sizing-report.mts`
- Test: `tests/unit/prd/sizing-report.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prd/sizing-report.test.mts`:

```ts
import { describe, expect, it } from 'bun:test';
import { buildSizingReport } from '../../../src/prd/sizing-report.mts';
import type { SizedPlanResult } from '../../../src/prd/sizer.mts';
import type { Task } from '../../../src/types/index.mts';

function task(id: string, domain: Task['domain'], size: Task['size']): Task {
  return {
    id, name: `name ${id}`, description: '', acceptanceCriteria: '',
    testCommand: 'bun test', dependsOn: [], domain, size,
    status: 'pending', iterationCount: 0,
  };
}

describe('buildSizingReport', () => {
  it('renders the distribution, a per-task table, and the split tree', () => {
    const result: SizedPlanResult = {
      tasks: [task('TASK-001-1', 'database', 'M'), task('TASK-002', 'ui', 'S')],
      distribution: { S: 1, M: 1, L: 0 },
      splits: [{ parentId: 'TASK-001', childIds: ['TASK-001-1', 'TASK-001-2'] }],
    };
    const md = buildSizingReport('Notes App', 'notes-app', result);
    expect(md).toContain('# Sizing: Notes App');
    expect(md).toContain('| S | 1 |');
    expect(md).toContain('TASK-001-1');
    expect(md).toContain('TASK-001 → TASK-001-1, TASK-001-2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/sizing-report.test.mts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the report builder**

Create `src/prd/sizing-report.mts`:

```ts
import { DateTime } from 'luxon';
import type { SizedPlanResult } from './sizer.mts';

export function buildSizingReport(
  featureName: string,
  featureSlug: string,
  result: SizedPlanResult,
): string {
  const { distribution, tasks, splits } = result;

  const taskRows = tasks
    .map((t) => `| ${t.id} | ${t.domain} | ${t.size ?? '?'} | ${t.name} |`)
    .join('\n');

  const splitRows =
    splits.length > 0
      ? splits.map((s) => `- ${s.parentId} → ${s.childIds.join(', ')}`).join('\n')
      : '_No proactive splits were required._';

  return `# Sizing: ${featureName}

**Feature Slug**: ${featureSlug}
**Generated**: ${DateTime.utc().toISO()}

## Size Distribution

| Size | Count |
|------|-------|
| S | ${distribution.S} |
| M | ${distribution.M} |
| L | ${distribution.L} |

## Tasks

| ID | Domain | Size | Name |
|----|--------|------|------|
${taskRows}

## Proactive Splits

${splitRows}
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/prd/sizing-report.test.mts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prd/sizing-report.mts tests/unit/prd/sizing-report.test.mts
git commit -m "feat: SIZING.md report builder"
```

---

## Task 10: Add `sizing_plan` phase + `plan_sized` event

**Files:**
- Modify: `src/types/agent.mts`
- Test: `tests/unit/prd/sizer.test.mts` type-check gate

- [ ] **Step 1: Extend the phase union**

In `src/types/agent.mts`, add `'sizing_plan'` to `AgentPhase` after `'generating_prd'`:

```ts
export type AgentPhase =
  | 'initializing'
  | 'generating_prd'
  | 'sizing_plan'
  | 'awaiting_approval'
  | 'executing_tasks'
  | 'worker_running'
  | 'lint_running'
  | 'reviewer_running'
  | 'generating_results'
  | 'complete'
  | 'failed';
```

- [ ] **Step 2: Extend the event union**

Add `'plan_sized'` to `AgentEventType` after `'prd_generated'`:

```ts
export type AgentEventType =
  | 'phase_changed'
  | 'prd_generated'
  | 'plan_sized'
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

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: no NEW errors from `src/types/agent.mts`.

- [ ] **Step 4: Commit**

```bash
git add src/types/agent.mts
git commit -m "feat: add sizing_plan phase and plan_sized event"
```

---

## Task 11: Wire the planning sub-pipeline into the graph

**Files:**
- Modify: `src/agent/graph.mts`
- Test: `tests/unit/agent/graph.test.mts` (extend existing if present; otherwise the integration is exercised by `debug-e2e.mts`)

- [ ] **Step 1: Rename the draft node and add the size node**

In `src/agent/graph.mts`, rename `generatePRDNode` to `draftPlanNode` (keep its body, but change the emitted phase event value from `'generating_prd'` to keep as-is — it stays `generating_prd`). Then add a new node after it. Add imports at the top:

```ts
import { sizePlan, SizeGateError } from '../prd/sizer.mts';
import { buildSizingReport } from '../prd/sizing-report.mts';
```

Add the new node function (place after `draftPlanNode`):

```ts
// --- Node: size_plan ---
//
// Assigns a T-shirt size to every task (model judgment + deterministic floor),
// proactively splits any `L` into S/M children, and refuses to proceed if an
// oversized task survives. Writes SIZING.md alongside the other planning docs.

async function sizePlanNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  emitAgentEvent('phase_changed', { phase: 'sizing_plan' });

  let result;
  try {
    result = await sizePlan(state.tasks);
  } catch (err) {
    if (err instanceof SizeGateError) {
      emitAgentEvent('error', {
        phase: 'sizing_plan',
        message: err.message,
        unsplittableIds: err.unsplittableIds,
      });
    }
    throw err; // abort the run — an oversized task must not execute
  }

  emitAgentEvent('plan_sized', {
    distribution: result.distribution,
    splits: result.splits,
    taskCount: result.tasks.length,
  });

  const sizingMarkdown = buildSizingReport(
    state.featureName,
    state.featureSlug,
    result,
  );
  const resultsDir = join('feature-results', state.featureSlug);
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, 'SIZING.md'), sizingMarkdown, 'utf-8');

  return { tasks: result.tasks, phase: 'awaiting_approval' };
}
```

- [ ] **Step 2: Add the ratify stub node (Phase B placeholder)**

Add after `sizePlanNode`:

```ts
// --- Node: ratify_plan (Phase B stub) ---
//
// Placeholder for the ratifying council. In Phase A it passes the sized plan
// through unchanged. Phase B replaces this with a debate-and-ratify pass.

async function ratifyPlanNode(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  return { phase: 'awaiting_approval' };
}
```

- [ ] **Step 3: Rewire the graph edges**

In `buildAgentGraph`, replace the node/edge registration for `generate_prd` so the pipeline is `draft_plan → size_plan → ratify_plan → run_task`:

```ts
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('draft_plan', draftPlanNode)
    .addNode('size_plan', sizePlanNode)
    .addNode('ratify_plan', ratifyPlanNode)
    .addNode('run_task', runTaskNode)
    .addNode('generate_results', generateResultsNode)
    .addEdge(START, 'draft_plan')
    .addEdge('draft_plan', 'size_plan')
    .addEdge('size_plan', 'ratify_plan')
    .addEdge('ratify_plan', 'run_task')
    .addConditionalEdges('run_task', routeAfterTask, {
      run_task: 'run_task',
      generate_results: 'generate_results',
    })
    .addEdge('generate_results', END);

  return graph.compile();
```

- [ ] **Step 4: Keep the pre-loaded PRD path working**

`draftPlanNode` currently returns `{ phase: 'awaiting_approval' }` when `state.prd !== null` (pre-loaded via `--prd-file`). Change that early return to route into sizing instead:

```ts
  if (state.prd !== null) {
    return { phase: 'sizing_plan' };
  }
```

(The graph edge from `draft_plan → size_plan` runs regardless of phase value, so the pre-loaded tasks still get sized. The phase value is cosmetic here.)

- [ ] **Step 5: Propagate domain/size on the reactive backstop split**

In `runTaskNode`, the auto-split path calls `splitTask` then `applySplit`. `splitTask` (Task 7) now sets `domain` on children and clears `size`. Add a re-size of those children so they are not left size-undefined. After the `applySplit` call inside the auto-split loop, replace:

```ts
        mergedTasks = applySplit(mergedTasks, failed.id, subTasks);
```

with:

```ts
        const sized = await sizePlan(subTasks).catch(() => ({ tasks: subTasks, distribution: { S: 0, M: 0, L: 0 }, splits: [] }));
        mergedTasks = applySplit(mergedTasks, failed.id, sized.tasks);
```

Add the `sizePlan` import (already added in Step 1). The `.catch` keeps the backstop best-effort — a sizing failure here must not crash an already-degraded run.

- [ ] **Step 6: Type-check and run the full unit suite**

Run: `bunx tsc --noEmit`
Expected: no NEW errors (pre-existing count unchanged).

Run: `bun test`
Expected: PASS — all existing tests plus the new sizer/parser/prompt/report tests. Note the total count.

- [ ] **Step 7: Commit**

```bash
git add src/agent/graph.mts
git commit -m "feat: wire draft->size->ratify planning sub-pipeline"
```

---

## Task 12: End-to-end smoke of the planning path

**Files:**
- Modify: `debug-e2e.mts` (only if needed to observe SIZING.md); otherwise no code change
- Test: manual run

- [ ] **Step 1: Confirm Ollama reachable**

Run: `bun run src/index.mts --help` (or the project's normal entry) and confirm the configured endpoint responds. If unreachable, stop — sizing needs the planner model. (See memory: `assertOllamaReachable` aborts fast.)

- [ ] **Step 2: Run the existing debug harness**

Run: `bun run debug-e2e.mts`
Expected: after PRD generation the log shows a `phase_changed → sizing_plan` then `plan_sized` event, and `feature-results/<slug>/SIZING.md` exists with a size distribution and (if any) split rows. No task in the RESULTS table should have originated from an `L` that ran un-split.

- [ ] **Step 3: Inspect the artifact**

Run: `cat feature-results/*/SIZING.md`
Expected: a distribution table with `L: 0` in the final plan and every task tagged S or M with a domain.

- [ ] **Step 4: Commit any harness tweaks (only if changed)**

```bash
git add debug-e2e.mts
git commit -m "chore: observe SIZING.md in debug e2e harness"
```

---

## Self-Review

**Spec coverage:**
- Data model (`domain`, `size`, S/M/L, hybrid domains) → Task 1. ✓
- Domain-first drafting → Task 3. ✓
- Model judgment + deterministic floor → Tasks 5–6. ✓
- Proactive split + hard-stop gate → Task 8. ✓
- Reactive backstop propagates domain/size → Task 11 Step 5. ✓
- `SIZING.md` in `feature-results/<slug>/` → Task 9 + Task 11 Step 1. ✓
- `plan_sized` event + `sizing_plan` phase → Task 10. ✓
- draft → size → ratify(stub) pipeline → Task 11. ✓
- Phase B (council) explicitly deferred → out of scope; `ratifyPlanNode` stub present. ✓
- Single-domain-per-task enforcement → deterministic floor `domainMentions > 1 ⇒ L` (Task 5). ✓
- Parser round-trip for `**Domain**` → Task 2. ✓
- Threshold env vars → Task 4. ✓

**Type consistency:** `TaskSize`/`TaskDomain` used identically across parser, sizer, splitter, report; `SizedPlanResult` shape (`tasks`/`distribution`/`splits`) consistent between Task 8 (producer) and Tasks 9 & 11 (consumers); `sizePlan` signature `(tasks, deps?)` used the same in sizer tests and graph. `getModelSizes(tasks, deps?)` consistent. `canSplitForSize` defined Task 7, used Task 8.

**Placeholder scan:** No TBD/TODO; every code step shows full code. `ratifyPlanNode` is an intentional, fully-specified stub (documented as Phase B), not a placeholder.
