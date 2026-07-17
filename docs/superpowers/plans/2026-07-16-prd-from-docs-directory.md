# PRD from a Docs Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `oda --docs-dir <path> [directive]` that recursively ingests a directory of docs, summarizes each file, synthesizes a standard PRD grounded in the summaries plus an optional directive, and continues into the normal build.

**Architecture:** A collect → summarize (map, per-file, cached, chunked) → synthesize (reduce) pipeline. New pure-ish modules `doc-ingest.mts` (file discovery) and `doc-summarizer.mts` (summaries + cache + chunk + fold). `generator.mts` gains `generatePRDFromDocs`, reusing a extracted `buildPRDFromMarkdown` parse/persist helper. `draftPlanNode` branches on a new `docsDir` state field; a `--docs-dir` CLI flag threads it through `AgentConfig`.

**Tech Stack:** BunJS, TypeScript strict, `@langchain/ollama` via `createChatModel`, `@langchain/core` messages, `node:crypto`, `bun test`.

**Reference:** spec `docs/superpowers/specs/2026-07-16-prd-from-docs-directory-design.md`.

---

## Conventions (read once)

- `.mts` everywhere; imports include `.mts`; kebab-case filenames; no `any`; explicit return types on exports.
- Escape backticks inside `prompts.mts` template literals as `` \` ``.
- Type check: `bunx tsc --noEmit` (baseline is 16 pre-existing unrelated errors in `src/tools/*.mts` and `tests/unit/models/react-agent.test.mts` — add no new ones).

---

## File Structure

- **Create** `src/prd/doc-ingest.mts` — `collectDocFiles`, `DOC_EXTENSIONS`, `IGNORED_DIRS`.
- **Create** `src/prd/doc-summarizer.mts` — `DocSummary`, `SummarizeDeps`, `summarizeDocs`, `reduceSummaries`.
- **Modify** `src/prd/prompts.mts` — `buildDocSummaryPrompt`, `buildDocsPRDSynthesisPrompt`.
- **Modify** `src/prd/generator.mts` — extract `buildPRDFromMarkdown`; add `generatePRDFromDocs`.
- **Modify** `src/prd/index.mts` — barrel `generatePRDFromDocs`.
- **Modify** `src/types/agent.mts` — `AgentConfig.docsDir`; add `docs_collected`/`doc_summarized` event types.
- **Modify** `src/agent/state.mts` — `docsDir` annotation.
- **Modify** `src/agent/graph.mts` — `draftPlanNode` branch.
- **Modify** `src/agent/index.mts` — seed `docsDir` into state.
- **Modify** `src/index.mts` — `--docs-dir` flag.
- **Create** `tests/unit/prd/doc-ingest.test.mts`, `tests/unit/prd/doc-summarizer.test.mts`, `tests/unit/prd/generator-docs.test.mts`; extend `tests/unit/prd/prompts.test.mts`.
- **Create** `scripts/docs-prd-smoke.mts`.

---

## Task 1: `collectDocFiles`

**Files:**
- Create: `src/prd/doc-ingest.mts`
- Test: `tests/unit/prd/doc-ingest.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prd/doc-ingest.test.mts`:

```ts
import { describe, expect, it, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDocFiles } from '../../../src/prd/doc-ingest.mts';

const ROOT = join('tests', '.tmp-docs');

afterEach(async () => { await rm(ROOT, { recursive: true, force: true }); });

async function seed(): Promise<void> {
  await mkdir(join(ROOT, 'memory'), { recursive: true });
  await mkdir(join(ROOT, 'node_modules'), { recursive: true });
  await writeFile(join(ROOT, 'a.md'), '# A', 'utf-8');
  await writeFile(join(ROOT, 'memory', 'b.txt'), 'B', 'utf-8');
  await writeFile(join(ROOT, 'c.png'), 'binary', 'utf-8');       // wrong ext
  await writeFile(join(ROOT, 'node_modules', 'd.md'), 'skip', 'utf-8'); // ignored dir
}

describe('collectDocFiles', () => {
  it('recursively collects text docs, skipping ignored dirs and non-doc extensions', async () => {
    await seed();
    const files = await collectDocFiles(ROOT);
    const rel = files.map((f) => f.replace(/\\/g, '/'));
    expect(rel.some((f) => f.endsWith('a.md'))).toBe(true);
    expect(rel.some((f) => f.endsWith('memory/b.txt'))).toBe(true);
    expect(rel.some((f) => f.endsWith('c.png'))).toBe(false);
    expect(rel.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('returns [] for a missing directory', async () => {
    expect(await collectDocFiles(join(ROOT, 'nope'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/doc-ingest.test.mts`
Expected: FAIL — cannot find module `doc-ingest.mts`.

- [ ] **Step 3: Implement**

Create `src/prd/doc-ingest.mts`:

```ts
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

export const DOC_EXTENSIONS = ['.md', '.mdx', '.txt', '.rst'] as const;
export const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', '.ai', 'coverage', 'out'] as const;

const ignored: readonly string[] = IGNORED_DIRS;
const allowed: readonly string[] = DOC_EXTENSIONS;

// Recursively collect text-doc files under docsDir, skipping ignored directory
// names and non-doc extensions. Deterministic (sorted). Missing dir => [].
export async function collectDocFiles(docsDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignored.includes(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && allowed.includes(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }

  await walk(docsDir);
  return out.sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/doc-ingest.test.mts`
Expected: PASS. Run `bunx tsc --noEmit` — no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/prd/doc-ingest.mts tests/unit/prd/doc-ingest.test.mts
git commit -m "feat: collectDocFiles recursive doc discovery"
```

---

## Task 2: `buildDocSummaryPrompt`

**Files:**
- Modify: `src/prd/prompts.mts`
- Test: `tests/unit/prd/prompts.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/prompts.test.mts` (add `buildDocSummaryPrompt` to the import from `prompts.mts`):

```ts
describe('buildDocSummaryPrompt', () => {
  it('embeds the file path and content and asks for a concise extraction', () => {
    const p = buildDocSummaryPrompt('memory/05-data-models.md', 'User has id and email.');
    expect(p).toContain('memory/05-data-models.md');
    expect(p).toContain('User has id and email.');
    expect(p.toLowerCase()).toContain('summar');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: FAIL — `buildDocSummaryPrompt` is not exported.

- [ ] **Step 3: Implement**

In `src/prd/prompts.mts`, add:

```ts
export function buildDocSummaryPrompt(relPath: string, content: string): string {
  return `You are condensing one project document so a planner can generate a PRD from many documents without exceeding its context.

## Document: ${relPath}

${content}

## Your job
Summarize THIS document concisely but completely for PRD generation. Capture, as compact bullets or prose:
- purpose / what this document is about
- concrete features and capabilities
- entities / data models and key fields
- API surface (endpoints, operations) if any
- constraints, rules, and explicit technical decisions

Do NOT use PRD or task formatting. Do NOT invent details not present in the document. Output only the summary.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/prompts.mts tests/unit/prd/prompts.test.mts
git commit -m "feat: buildDocSummaryPrompt for per-file doc summaries"
```

---

## Task 3: `summarizeDocs` (map)

**Files:**
- Create: `src/prd/doc-summarizer.mts`
- Test: `tests/unit/prd/doc-summarizer.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prd/doc-summarizer.test.mts`:

```ts
import { describe, expect, it, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeDocs } from '../../../src/prd/doc-summarizer.mts';

const ROOT = join('tests', '.tmp-sum');

afterEach(async () => { await rm(ROOT, { recursive: true, force: true }); });

async function file(name: string, body: string): Promise<string> {
  const full = join(ROOT, name);
  await mkdir(ROOT, { recursive: true });
  await writeFile(full, body, 'utf-8');
  return full;
}

describe('summarizeDocs', () => {
  it('summarizes one file per invoke call and reports progress', async () => {
    const f1 = await file('a.md', 'alpha');
    const f2 = await file('b.md', 'beta');
    let calls = 0;
    const progress: number[] = [];
    const out = await summarizeDocs(ROOT, [f1, f2], {
      invokeFn: async () => { calls++; return `summary ${calls}`; },
      onProgress: (done) => progress.push(done),
    });
    expect(calls).toBe(2);
    expect(out.map((s) => s.relPath).sort()).toEqual(['a.md', 'b.md']);
    expect(progress).toEqual([1, 2]);
  });

  it('skips a file whose summary comes back empty', async () => {
    const f1 = await file('a.md', 'alpha');
    const out = await summarizeDocs(ROOT, [f1], { invokeFn: async () => '   ' });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/doc-summarizer.test.mts`
Expected: FAIL — cannot find module `doc-summarizer.mts`.

- [ ] **Step 3: Implement**

Create `src/prd/doc-summarizer.mts`:

```ts
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { createChatModel } from '../models/index.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { buildDocSummaryPrompt } from './prompts.mts';

export interface DocSummary {
  relPath: string;
  summary: string;
}

export interface SummarizeDeps {
  invokeFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  onProgress?: (done: number, total: number, relPath: string) => void;
  cacheDir?: string;
  maxContentChars?: number;
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

async function defaultInvoke(systemPrompt: string, userPrompt: string): Promise<string> {
  const model = createChatModel(env.PLANNER_MODEL);
  const res = (await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ])) as AIMessage;
  return extractContent(res);
}

const SUMMARY_USER_PROMPT = 'Summarize the document above.';

// Map: one summary per file. Reads content, invokes the model, collects
// non-empty summaries. Read/summarize failures are logged and skipped.
export async function summarizeDocs(
  docsDir: string,
  files: readonly string[],
  deps?: SummarizeDeps,
): Promise<DocSummary[]> {
  const invoke = deps?.invokeFn ?? defaultInvoke;
  const summaries: DocSummary[] = [];
  let done = 0;

  for (const file of files) {
    const relPath = relative(docsDir, file).replace(/\\/g, '/');
    let content = '';
    try {
      content = await readFile(file, 'utf-8');
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'docs.read_failed');
      done++;
      deps?.onProgress?.(done, files.length, relPath);
      continue;
    }

    let summary = '';
    try {
      summary = (await invoke(buildDocSummaryPrompt(relPath, content), SUMMARY_USER_PROMPT)).trim();
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'docs.summarize_failed');
    }

    if (summary.length > 0) summaries.push({ relPath, summary });
    done++;
    deps?.onProgress?.(done, files.length, relPath);
  }

  return summaries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/doc-summarizer.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/doc-summarizer.mts tests/unit/prd/doc-summarizer.test.mts
git commit -m "feat: summarizeDocs per-file map with progress"
```

---

## Task 4: Summary caching

**Files:**
- Modify: `src/prd/doc-summarizer.mts`
- Test: `tests/unit/prd/doc-summarizer.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/doc-summarizer.test.mts`:

```ts
describe('summarizeDocs caching', () => {
  it('writes to the cache and skips the invoke on the second pass', async () => {
    const f1 = await file('a.md', 'alpha');
    const cacheDir = join(ROOT, '.cache');
    let calls = 0;
    const inv = async (): Promise<string> => { calls++; return 'cached summary'; };

    const first = await summarizeDocs(ROOT, [f1], { invokeFn: inv, cacheDir });
    const second = await summarizeDocs(ROOT, [f1], { invokeFn: inv, cacheDir });

    expect(calls).toBe(1); // second pass hit the cache
    expect(first[0]!.summary).toBe('cached summary');
    expect(second[0]!.summary).toBe('cached summary');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/doc-summarizer.test.mts`
Expected: FAIL — the second pass still invokes (calls === 2).

- [ ] **Step 3: Implement caching**

In `src/prd/doc-summarizer.mts`, add imports:

```ts
import { mkdir, readFile as fsReadFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
```

(Keep the existing `import { readFile } from 'node:fs/promises';` — or merge into the line above and use `fsReadFile` throughout; simplest is to add `mkdir, writeFile` and `readFile as fsReadFile` and use `readFile` for docs, `fsReadFile` for cache. To avoid confusion, replace the top import with: `import { readFile, mkdir, writeFile } from 'node:fs/promises';`.)

Add cache helpers and wire them into the loop. Replace the summarize section of the loop:

```ts
    const key = createHash('sha256').update(`${relPath} ${content}`).digest('hex');
    let summary = deps?.cacheDir ? await readCache(deps.cacheDir, key) : '';

    if (summary.length === 0) {
      try {
        summary = (await invoke(buildDocSummaryPrompt(relPath, content), SUMMARY_USER_PROMPT)).trim();
      } catch (err) {
        logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'docs.summarize_failed');
      }
      if (summary.length > 0 && deps?.cacheDir) await writeCache(deps.cacheDir, key, summary);
    }
```

And add these helpers at module scope:

```ts
async function readCache(cacheDir: string, key: string): Promise<string> {
  try {
    return (await readFile(join(cacheDir, `${key}.md`), 'utf-8')).trim();
  } catch {
    return '';
  }
}

async function writeCache(cacheDir: string, key: string, summary: string): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${key}.md`), summary, 'utf-8');
  } catch (err) {
    logger.warn({ cacheDir, err: err instanceof Error ? err.message : String(err) }, 'docs.cache_write_failed');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/doc-summarizer.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/doc-summarizer.mts tests/unit/prd/doc-summarizer.test.mts
git commit -m "feat: content-hash caching for doc summaries"
```

---

## Task 5: Chunking + `reduceSummaries`

**Files:**
- Modify: `src/prd/doc-summarizer.mts`
- Test: `tests/unit/prd/doc-summarizer.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/doc-summarizer.test.mts`:

```ts
import { reduceSummaries } from '../../../src/prd/doc-summarizer.mts';

describe('chunking + reduceSummaries', () => {
  it('chunks a file larger than maxContentChars into multiple invoke calls', async () => {
    const big = await file('big.md', 'x'.repeat(50));
    let calls = 0;
    const out = await summarizeDocs(ROOT, [big], {
      invokeFn: async () => { calls++; return `part ${calls}`; },
      maxContentChars: 20, // 50 chars => 3 chunks
    });
    expect(calls).toBe(3);
    expect(out[0]!.summary).toContain('part 1');
    expect(out[0]!.summary).toContain('part 3');
  });

  it('reduceSummaries folds when combined length exceeds the budget', async () => {
    const summaries = [
      { relPath: 'a', summary: 'aaaa' },
      { relPath: 'b', summary: 'bbbb' },
      { relPath: 'c', summary: 'cccc' },
    ];
    let calls = 0;
    const out = await reduceSummaries(summaries, {
      invokeFn: async () => { calls++; return `merged ${calls}`; },
      maxContentChars: 6, // forces folding
    });
    expect(calls).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(summaries.length);
  });

  it('reduceSummaries returns input unchanged when under budget', async () => {
    const summaries = [{ relPath: 'a', summary: 'aa' }];
    const out = await reduceSummaries(summaries, { invokeFn: async () => 'unused', maxContentChars: 1000 });
    expect(out).toEqual(summaries);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/doc-summarizer.test.mts`
Expected: FAIL — chunking not implemented; `reduceSummaries` not exported.

- [ ] **Step 3: Implement**

In `src/prd/doc-summarizer.mts`, add a default budget and chunking. Add near the top:

```ts
// ~4 chars/token; halve NUM_CTX to leave room for the summary prompt itself.
function defaultMaxContentChars(): number {
  return Math.floor(env.NUM_CTX * 4 * 0.5);
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
```

Replace the single-invoke summarize step (the `if (summary.length === 0) { ... }` block) so it chunks oversized content:

```ts
    const maxChars = deps?.maxContentChars ?? defaultMaxContentChars();
    const key = createHash('sha256').update(`${relPath} ${content}`).digest('hex');
    let summary = deps?.cacheDir ? await readCache(deps.cacheDir, key) : '';

    if (summary.length === 0) {
      try {
        if (content.length <= maxChars) {
          summary = (await invoke(buildDocSummaryPrompt(relPath, content), SUMMARY_USER_PROMPT)).trim();
        } else {
          const parts = chunk(content, maxChars);
          const partSummaries: string[] = [];
          for (let i = 0; i < parts.length; i++) {
            const label = `${relPath} (part ${i + 1}/${parts.length})`;
            partSummaries.push((await invoke(buildDocSummaryPrompt(label, parts[i]!), SUMMARY_USER_PROMPT)).trim());
          }
          summary = partSummaries.filter((s) => s.length > 0).join('\n\n');
        }
      } catch (err) {
        logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'docs.summarize_failed');
      }
      if (summary.length > 0 && deps?.cacheDir) await writeCache(deps.cacheDir, key, summary);
    }
```

Add `reduceSummaries` at module scope:

```ts
function totalChars(summaries: readonly DocSummary[]): number {
  return summaries.reduce((n, s) => n + s.summary.length, 0);
}

// Fold: if the combined summaries exceed the budget, group them into batches
// under the budget and summarize each batch into one merged DocSummary.
export async function reduceSummaries(
  summaries: DocSummary[],
  deps?: SummarizeDeps,
): Promise<DocSummary[]> {
  const maxChars = deps?.maxContentChars ?? defaultMaxContentChars();
  if (totalChars(summaries) <= maxChars) return summaries;

  const invoke = deps?.invokeFn ?? defaultInvoke;
  const batches: DocSummary[][] = [];
  let current: DocSummary[] = [];
  let size = 0;
  for (const s of summaries) {
    if (size + s.summary.length > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += s.summary.length;
  }
  if (current.length > 0) batches.push(current);

  const merged: DocSummary[] = [];
  for (let i = 0; i < batches.length; i++) {
    const joined = batches[i]!.map((s) => `### ${s.relPath}\n${s.summary}`).join('\n\n');
    const summary = (await invoke(buildDocSummaryPrompt(`merged-group-${i + 1}`, joined), SUMMARY_USER_PROMPT)).trim();
    merged.push({ relPath: `merged-group-${i + 1}`, summary: summary.length > 0 ? summary : joined });
  }
  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/doc-summarizer.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/doc-summarizer.mts tests/unit/prd/doc-summarizer.test.mts
git commit -m "feat: chunk oversized docs and fold summaries to fit context"
```

---

## Task 6: `buildDocsPRDSynthesisPrompt`

**Files:**
- Modify: `src/prd/prompts.mts`
- Test: `tests/unit/prd/prompts.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/prompts.test.mts` (add `buildDocsPRDSynthesisPrompt` to the import):

```ts
describe('buildDocsPRDSynthesisPrompt', () => {
  it('includes the directive, the PRD format rules, and the doc summaries', () => {
    const p = buildDocsPRDSynthesisPrompt(
      'build only the API',
      [{ relPath: 'memory/06-api.md', summary: 'CRUD for photos' }],
      false,
    );
    expect(p).toContain('build only the API');       // directive
    expect(p).toContain('TASK-001');                  // reuses PRD format rules
    expect(p).toContain('Source Documentation');      // grounding section
    expect(p).toContain('memory/06-api.md');
    expect(p).toContain('CRUD for photos');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: FAIL — `buildDocsPRDSynthesisPrompt` is not exported.

- [ ] **Step 3: Implement**

In `src/prd/prompts.mts`, add the import type and the builder. At the top:

```ts
import type { DocSummary } from './doc-summarizer.mts';
```

Then:

```ts
export const DEFAULT_DOCS_DIRECTIVE =
  'Generate a PRD that builds the system described in the documentation below.';

export function buildDocsPRDSynthesisPrompt(
  directive: string,
  summaries: readonly DocSummary[],
  research: boolean,
): string {
  const base = buildPRDGenerationPrompt(directive.trim().length > 0 ? directive : DEFAULT_DOCS_DIRECTIVE, research);
  const docsBlock = summaries.map((s) => `### ${s.relPath}\n${s.summary}`).join('\n\n');

  return `${base}

## Source Documentation (summaries)

Ground every task in the documentation summarized below. Do NOT invent scope beyond what these documents describe; where the directive narrows scope, follow the directive.

${docsBlock}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/prompts.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/prompts.mts tests/unit/prd/prompts.test.mts
git commit -m "feat: buildDocsPRDSynthesisPrompt grounds the drafter in doc summaries"
```

---

## Task 7: Extract `buildPRDFromMarkdown`

Refactor the parse/persist tail of `generatePRD` into a shared helper so `generatePRDFromDocs` can reuse it. No behavior change.

**Files:**
- Modify: `src/prd/generator.mts:54-95`
- Test: `tests/unit/prd/generator-docs.test.mts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prd/generator-docs.test.mts`:

```ts
import { describe, expect, it, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPRDFromMarkdown } from '../../../src/prd/generator.mts';

const WD = join('tests', '.tmp-wd');

afterEach(async () => { await rm(join(WD, '.ai'), { recursive: true, force: true }); });

const SAMPLE = `# PRD: Notes App
**Feature Slug**: notes-app

## Overview
A notes app.

## Tasks
- [ ] **TASK-001**: Create note
  - **Domain**: api
  - **Description**: add a note
  - **Acceptance**: returns 201
  - **Test Command**: \`bun test\`
`;

describe('buildPRDFromMarkdown', () => {
  it('parses feature name, slug, and tasks from PRD markdown', async () => {
    const prd = await buildPRDFromMarkdown(SAMPLE, WD);
    expect(prd.featureName).toBe('Notes App');
    expect(prd.featureSlug).toBe('notes-app');
    expect(prd.tasks).toHaveLength(1);
    expect(prd.tasks[0]!.domain).toBe('api');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/generator-docs.test.mts`
Expected: FAIL — `buildPRDFromMarkdown` is not exported.

- [ ] **Step 3: Refactor**

In `src/prd/generator.mts`, extract the tail of `generatePRD` (lines ~54-94, from `const featureName = ...` through the `return { ... }`) into a new exported function, and call it from `generatePRD`:

```ts
export async function buildPRDFromMarkdown(rawMarkdown: string, workingDirectory: string): Promise<PRD> {
  const featureName = extractFeatureName(rawMarkdown);
  const featureSlug = extractFeatureSlug(rawMarkdown);
  const tasks = parseTasks(rawMarkdown);

  const overview = extractSection(rawMarkdown, 'Overview');
  const technicalApproach = extractSection(rawMarkdown, 'Technical Approach');
  const goals = extractBulletList(rawMarkdown, 'Goals');
  const acceptanceCriteria = extractBulletList(rawMarkdown, 'Acceptance Criteria');
  const outOfScope = extractBulletList(rawMarkdown, 'Out of Scope');

  const planningDir = join(workingDirectory, '.ai', 'planning', featureSlug);
  await mkdir(planningDir, { recursive: true });
  await writeFile(join(planningDir, 'prd.md'), rawMarkdown, 'utf-8');

  const taskMarkdown = tasks
    .map(
      (t) =>
        `## ${t.id}: ${t.name}\n\n` +
        `**Status**: ${t.status}\n` +
        `**Description**: ${t.description}\n` +
        `**Acceptance**: ${t.acceptanceCriteria}\n` +
        `**Test Command**: \`${t.testCommand}\`\n`,
    )
    .join('\n---\n\n');
  await writeFile(join(planningDir, 'tasks.md'), taskMarkdown, 'utf-8');

  return { featureName, featureSlug, overview, goals, technicalApproach, tasks, acceptanceCriteria, outOfScope, rawMarkdown };
}
```

Then in `generatePRD`, replace everything from `const featureName = ...` to the final `return { ... };` with:

```ts
  return buildPRDFromMarkdown(rawMarkdown, workingDirectory);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/generator-docs.test.mts`
Expected: PASS. Run the wider PRD suite to confirm no regression: `bun test tests/unit/prd/`. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/generator.mts tests/unit/prd/generator-docs.test.mts
git commit -m "refactor: extract buildPRDFromMarkdown from generatePRD"
```

---

## Task 8: `generatePRDFromDocs`

**Files:**
- Modify: `src/prd/generator.mts`, `src/prd/index.mts`
- Test: `tests/unit/prd/generator-docs.test.mts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/prd/generator-docs.test.mts`:

```ts
import { generatePRDFromDocs } from '../../../src/prd/generator.mts';

describe('generatePRDFromDocs', () => {
  it('collects, summarizes, synthesizes, and parses a PRD grounded in the docs + directive', async () => {
    let synthSystemPrompt = '';
    const prd = await generatePRDFromDocs('docs-dir', 'build only the API', WD, undefined, {
      collectFn: async () => ['docs-dir/a.md'],
      summarizeFn: async () => [{ relPath: 'a.md', summary: 'CRUD photos' }],
      reduceFn: async (s) => s,
      runAgentFn: async (_model, _tools, systemPrompt) => {
        synthSystemPrompt = systemPrompt;
        return SAMPLE;
      },
    });
    expect(prd.featureName).toBe('Notes App');
    expect(synthSystemPrompt).toContain('build only the API');
    expect(synthSystemPrompt).toContain('CRUD photos');
  });

  it('throws when the directory has no docs', async () => {
    await expect(
      generatePRDFromDocs('empty', '', WD, undefined, { collectFn: async () => [] }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/prd/generator-docs.test.mts`
Expected: FAIL — `generatePRDFromDocs` is not exported.

- [ ] **Step 3: Implement**

In `src/prd/generator.mts`, add imports:

```ts
import { createPlannerTools } from '../tools/index.mts';
import { collectDocFiles } from './doc-ingest.mts';
import { summarizeDocs, reduceSummaries, type DocSummary, type SummarizeDeps } from './doc-summarizer.mts';
import { buildDocsPRDSynthesisPrompt } from './prompts.mts';
```

(`createChatModel`, `runReactAgent`, `REACT_TIMEOUT_SENTINEL`, `env`, `logger`, `join` are already imported.)

Add:

```ts
export interface PRDFromDocsDeps {
  collectFn?: (docsDir: string) => Promise<string[]>;
  summarizeFn?: (docsDir: string, files: readonly string[], deps?: SummarizeDeps) => Promise<DocSummary[]>;
  reduceFn?: (summaries: DocSummary[], deps?: SummarizeDeps) => Promise<DocSummary[]>;
  runAgentFn?: typeof runReactAgent;
}

// Ingest a docs directory -> per-file summaries -> a PRD grounded in them plus
// an optional directive. onEvent surfaces progress (docs_collected/doc_summarized).
export async function generatePRDFromDocs(
  docsDir: string,
  directive: string,
  workingDirectory: string,
  onEvent?: (type: string, payload: Record<string, unknown>) => void,
  deps?: PRDFromDocsDeps,
): Promise<PRD> {
  const collect = deps?.collectFn ?? collectDocFiles;
  const summarize = deps?.summarizeFn ?? summarizeDocs;
  const reduce = deps?.reduceFn ?? reduceSummaries;
  const runAgent = deps?.runAgentFn ?? runReactAgent;

  const files = await collect(docsDir);
  if (files.length === 0) {
    throw new Error(`No documentation files found under ${docsDir}`);
  }
  onEvent?.('docs_collected', { count: files.length });

  const cacheDir = join(workingDirectory, '.ai', 'planning', 'doc-summaries');
  const summaries = await summarize(docsDir, files, {
    cacheDir,
    onProgress: (done, total, relPath) => onEvent?.('doc_summarized', { relPath, done, total }),
  });
  const grounded = await reduce(summaries, {});

  const research = env.RESEARCH_PLANNING;
  const model = createChatModel(env.PLANNER_MODEL);
  const tools = research ? createPlannerTools(workingDirectory, env.BRAVE_API_KEY) : [];
  const systemPrompt = buildDocsPRDSynthesisPrompt(directive, grounded, research);
  const userPrompt =
    directive.trim().length > 0 ? directive : 'Generate the PRD grounded in the documentation summaries above.';

  const rawMarkdown = await runAgent(
    model,
    tools,
    systemPrompt,
    userPrompt,
    env.PLANNER_MAX_STEPS,
    (toolName, args) => onEvent?.('tool_called', { toolName, args, phase: 'generating_prd' }),
  );

  if (rawMarkdown.startsWith(REACT_TIMEOUT_SENTINEL)) {
    logger.error({ plannerMaxSteps: env.PLANNER_MAX_STEPS }, 'prd.docs_generation_timeout');
    throw new Error(
      `PRD generation from docs failed: the planner used all ${env.PLANNER_MAX_STEPS} steps without producing a PRD.`,
    );
  }

  return buildPRDFromMarkdown(rawMarkdown, workingDirectory);
}
```

In `src/prd/index.mts`, add `generatePRDFromDocs` to the `generator.mts` export:

```ts
export { generatePRD, generatePRDFromDocs, loadPRDFromFile } from './generator.mts';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/prd/generator-docs.test.mts`
Expected: PASS. Run `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/prd/generator.mts src/prd/index.mts tests/unit/prd/generator-docs.test.mts
git commit -m "feat: generatePRDFromDocs orchestration"
```

---

## Task 9: Config, state, and events

**Files:**
- Modify: `src/types/agent.mts`, `src/agent/state.mts`

- [ ] **Step 1: Add the config field and event types**

In `src/types/agent.mts`, add to `AgentConfig`:

```ts
  readonly docsDir?: string;
```

And add two members to `AgentEventType`:

```ts
  | 'docs_collected'
  | 'doc_summarized'
```

- [ ] **Step 2: Add the state annotation**

In `src/agent/state.mts`, inside `AgentStateAnnotation`, after the `prdFile` line, add:

```ts
  docsDir: Annotation<string | null>({ default: () => null, reducer: (_, b) => b }),
```

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/agent.mts src/agent/state.mts
git commit -m "feat: docsDir config/state and docs progress event types"
```

---

## Task 10: Wire into the graph and CLI

**Files:**
- Modify: `src/agent/graph.mts` (`draftPlanNode`), `src/agent/index.mts`, `src/index.mts`

- [ ] **Step 1: Branch `draftPlanNode` on `docsDir`**

In `src/agent/graph.mts`, add the import:

```ts
import { generatePRD } from '../prd/index.mts';
import { generatePRDFromDocs } from '../prd/index.mts';
```

(Or merge: `import { generatePRD, generatePRDFromDocs } from '../prd/index.mts';` — replace the existing `generatePRD` import line.)

Replace the PRD-generation call in `draftPlanNode` (the `const prd = await generatePRD(...)` block) with a branch:

```ts
  emitAgentEvent('phase_changed', { phase: 'generating_prd' });

  const prd = state.docsDir
    ? await generatePRDFromDocs(
        state.docsDir,
        state.userPrompt,
        state.workingDirectory,
        (type, payload) => emitAgentEvent(type, payload),
      )
    : await generatePRD(
        state.userPrompt,
        state.workingDirectory,
        (toolName, args) => {
          emitAgentEvent('tool_called', { toolName, args, phase: 'generating_prd' });
        },
      );
```

(Leave the subsequent `emitAgentEvent('prd_generated', ...)` and the `return { prd, ... }` unchanged.)

- [ ] **Step 2: Seed `docsDir` in `DevAgent.run`**

In `src/agent/index.mts`, add `docsDir` to `initialState` where `prdFile` is set:

```ts
    const docsDir = this.config.docsDir ?? null;
```

and include it in the `initialState` object literal:

```ts
      prdFile,
      docsDir,
```

- [ ] **Step 3: Add the CLI flag**

In `src/index.mts`, add the option (near `--prd-file`):

```ts
  .option('--docs-dir <path>', 'Generate the PRD from a directory of docs (ingest + summarize)')
```

Add `docsDir?: string;` to the `opts` generic type, and thread it into `config`:

```ts
  ...(opts.docsDir ? { docsDir: opts.docsDir } : {}),
```

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit` — no new errors.
Run: `bun run src/index.mts --help 2>&1 | grep -i docs-dir` — the flag appears.
Run: `bun test tests/unit/agent/ tests/unit/prd/` — green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/graph.mts src/agent/index.mts src/index.mts
git commit -m "feat: --docs-dir flag wired through draftPlanNode"
```

---

## Task 11: Live docs→PRD smoke

**Files:**
- Create: `scripts/docs-prd-smoke.mts`

- [ ] **Step 1: Write the script**

Create `scripts/docs-prd-smoke.mts`:

```ts
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertOllamaReachable } from '../src/models/index.mts';
import { generatePRDFromDocs } from '../src/prd/index.mts';

async function main(): Promise<void> {
  await assertOllamaReachable();

  const docsDir = join('.tmp-docs-smoke', 'docs');
  const wd = join('.tmp-docs-smoke', 'wd');
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    join(docsDir, 'overview.md'),
    '# Notes API\nA service to create, list, and delete notes. Each note has a title and body. Expose REST endpoints returning an ApiResponse envelope.',
    'utf-8',
  );

  console.log('Generating PRD from docs against live Ollama (slow)...');
  const prd = await generatePRDFromDocs(docsDir, 'Build only the API', wd, (type, payload) =>
    console.log(`event: ${type}`, payload),
  );

  console.log('Feature:', prd.featureName);
  console.log('Tasks:', prd.tasks.length);
  for (const t of prd.tasks) console.log(` - ${t.id} [${t.domain}] ${t.name}`);

  await rm('.tmp-docs-smoke', { recursive: true, force: true });
  if (prd.tasks.length === 0) throw new Error('Expected at least one task');
  console.log('\nDocs-PRD smoke OK');
}

main().catch((err) => {
  console.error('Docs-PRD smoke FAILED:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it (requires Ollama)**

Run: `bun run scripts/docs-prd-smoke.mts`
Expected: prints `docs_collected`/`doc_summarized` events, a feature name, ≥1 task, and `Docs-PRD smoke OK`. If Ollama is unreachable, note it and skip — do not fail the task.

- [ ] **Step 3: Commit**

```bash
git add scripts/docs-prd-smoke.mts
git commit -m "test: live docs->PRD smoke script"
```

---

## Final Verification

- [ ] `bun test tests/unit/prd/` — all green.
- [ ] `bunx tsc --noEmit` — only the 16 pre-existing baseline errors.
- [ ] `bun run src/index.mts --help | grep docs-dir` — flag present.
- [ ] Manual: `bun start --docs-dir C:/projects/sylvesterllc/photo-hosting/docs "build only the API, extend don't rebuild" --cwd C:/projects/sylvesterllc/photo-hosting/packages/api --fresh` — watch `docs_collected`/`doc_summarized` progress, then a generated PRD grounded in the docs proceeds to sizing.
