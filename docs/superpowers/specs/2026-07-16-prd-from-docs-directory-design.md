# PRD from a Docs Directory — Design Spec

**Date:** 2026-07-16
**Status:** Approved

## 1. Problem

Today the planner generates a PRD from a single prompt string. In research mode it *may* read a few project files, but it does so opportunistically within a step budget — it never exhaustively ingests a body of documentation. When the source of truth is a folder of design docs (e.g. `C:\projects\sylvesterllc\photo-hosting\docs`), the operator has to hand-summarize or paste, and the model only sees whatever it happened to open.

## 2. Goal

Add a one-command flow: point ODA at a directory of docs, ingest all of them, ground a generated PRD in their full content, and continue straight into the build.

`oda --docs-dir <path> [directive-prompt] --cwd <target>`

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Invocation | `--docs-dir <path>` flag; single run generates the PRD then continues into the build. Normal PRD-review gate applies unless `--no-prd-review`. |
| 2 | File selection | Recursive text docs (`.md`, `.mdx`, `.txt`, `.rst`), skipping an ignore list (`node_modules`, `.git`, `dist`, `build`, `.ai`, `coverage`, `out`). |
| 3 | Large-corpus strategy | **Always summarize per file** (map), then synthesize the PRD from the summaries (reduce). A single oversized file is chunked and its chunk-summaries combined. |
| 4 | Directive | The docs are grounding; an optional prompt argument scopes/directs the PRD. Falls back to a default directive when omitted. |

## 4. Pipeline

1. **Collect** — `collectDocFiles(docsDir)` recursively walks the directory, keeps files whose extension is in the allow-list, skips ignored directory names, and returns absolute paths (sorted for determinism).
2. **Summarize (map)** — `summarizeDocs(files, deps)` produces one `DocSummary` per file via a model call. Summaries are cached to `.ai/planning/doc-summaries/<sha256(path+content)>.md`; a cache hit skips the model call. A file whose content exceeds the context budget is split into chunks, each summarized, and the chunk-summaries concatenated into the file's summary.
3. **Synthesize (reduce)** — `generatePRDFromDocs` builds a synthesis prompt = the existing drafter prompt + the directive + all summaries injected as grounding, and runs the planner to emit a PRD in the standard `# PRD:` / `- [ ] **TASK-NNN**` format. If the combined summaries exceed the context budget, a fold pass groups and re-summarizes them (hierarchical reduce) before synthesis.
4. **Parse & persist** — reuse the existing `extractFeatureName`/`extractFeatureSlug`/`parseTasks` and `.ai/planning/<slug>/prd.md` persistence from `generatePRD`.
5. **Build** — the returned `PRD` flows into the normal graph (`size_plan → run_task`).

## 5. Components

- **`src/prd/doc-ingest.mts`**
  `export const DOC_EXTENSIONS = ['.md', '.mdx', '.txt', '.rst'] as const;`
  `export const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', '.ai', 'coverage', 'out'] as const;`
  `export function collectDocFiles(docsDir: string): Promise<string[]>` — recursive, filtered, sorted.

- **`src/prd/doc-summarizer.mts`**
  ```ts
  export interface DocSummary { relPath: string; summary: string; }
  export interface SummarizeDeps {
    invokeFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
    onProgress?: (done: number, total: number, relPath: string) => void;
  }
  export function summarizeDocs(docsDir: string, files: readonly string[], deps?: SummarizeDeps): Promise<DocSummary[]>;
  ```
  Handles per-file caching and chunking.

- **`src/prd/generator.mts`** — new export
  ```ts
  export function generatePRDFromDocs(
    docsDir: string,
    directive: string,
    workingDirectory: string,
    onEvent?: (type: string, payload: Record<string, unknown>) => void,
    deps?: PRDFromDocsDeps,
  ): Promise<PRD>;
  ```
  Orchestrates collect → summarize → synthesize → parse → persist. Reuses `generatePRD`'s parse/persist helpers (extract the shared parse/persist into a private `buildPRDFromMarkdown(rawMarkdown, workingDirectory)` used by both).

- **`src/prd/prompts.mts`**
  `export function buildDocSummaryPrompt(relPath: string, content: string): string;`
  `export function buildDocsPRDSynthesisPrompt(directive: string, summaries: readonly DocSummary[], research: boolean): string;`
  The synthesis prompt reuses the drafter's format/rules (domain tags, sizing, tech constraints) and injects a "## Source Documentation (summaries)" section.

- **Wiring**
  - `AgentConfig` gains `docsDir?: string`.
  - Graph state gains `docsDir: string | null`.
  - `draftPlanNode` branches: `state.docsDir` set → `generatePRDFromDocs(state.docsDir, state.userPrompt, ...)`; else current behavior.
  - CLI: `--docs-dir <path>` option, threaded into `AgentConfig`.

## 6. Prompts

- **Summary prompt** — instructs the model to extract, concisely: purpose, features/capabilities, entities/data models, API surface, constraints, and explicit tech decisions from the one document; output plain prose/bullets, no PRD formatting. Keeps each summary compact.
- **Synthesis prompt** — the existing `buildPRDGenerationPrompt` body (format + rules + domain partitioning + sizing + tech constraints) with the directive as the user goal and the summaries injected as grounding, with an instruction to ground every task in the documentation and not invent scope beyond it.

Backticks inside template literals are escaped as `` \` `` per the repo convention.

## 7. Events & UX

Under the existing `generating_prd` phase, emit:
- `docs_collected` — `{ count }`
- `doc_summarized` — `{ relPath, done, total }`

so the TUI shows live "summarizing 7/23" progress. The final PRD emits the existing `prd_generated` event.

## 8. Error handling

- Nonexistent directory or zero matching files → throw a clear error before any model call.
- A file that fails to read/summarize → log a warning and skip it (partial corpus beats aborting).
- Synthesis that exhausts the planner step budget → the existing `REACT_TIMEOUT_SENTINEL` guard in `generatePRD` applies.
- Resume: the generated PRD is persisted to `state.json`, so a re-run resumes the build rather than re-summarizing.

## 9. Testing

Unit tests inject the model fn (no live model):
- `collectDocFiles`: includes allow-listed extensions, excludes others, skips ignored dirs, recurses, deterministic order.
- `summarizeDocs`: one model call per file; second pass hits the cache (0 calls); chunking triggers for an oversized file; `onProgress` fires per file.
- `generatePRDFromDocs`: produces a parseable `PRD`; the directive appears in the synthesis input; empty-dir throws.
- Synthesis grounding: summaries are present in the synthesis prompt.

A live smoke script (`scripts/docs-prd-smoke.mts`) summarizes a tiny fixture directory end-to-end against real Ollama and prints the generated PRD.

## 10. Out of scope

- Splitting a whole-app docs folder into per-component PRDs automatically (the directive prompt is the scoping mechanism; a whole-app run still yields one 5–15-task PRD).
- Non-text docs (PDF, images, `.docx`) — text formats only for now.
- Watching the docs directory for changes / incremental regeneration beyond the content-hash cache.
