# ODA Reliability and Standards Plan

**Date:** 2026-10-05

## Status (2026-10-05, branch `feature/global-standards-and-ts-version`)

| Item | Status |
|---|---|
| 0.1 Rotate exposed key | **Open (Davis)** |
| 0.2 Commit WIP | Done (`ddfb651`) |
| 0.3 `tsc` errors | Done: 16 → 0. Tools moved from zod to TypeBox via `src/tools/define-tool.mts` (also 4.4 for tools; `env.mts` still uses zod) |
| 0.4 Lint script | Done (`eslint src`) |
| 1.1 Per-call timeout | Done: `CALL_TIMEOUT_SECONDS`, deadline-aware retry with jitter, real HTTP abort via a tracking `fetch` (ChatOllama ignores `signal` on a silent connection — verified) |
| 1.1b Runaway thinking | Done: the tracking `fetch` reads the stream; a call is abandoned on `IDLE_TIMEOUT_SECONDS` of silence or past `THINKING_BUDGET_TOKENS` without acting, and the retry nudges the model to act. `MAX_OUTPUT_TOKENS` caps a reply; knowledge-base lessons capped at `KB_PROMPT_MAX_CHARS`. LangChain upgraded to 1.x. Found on `D:\temp\4`: 4 of 6 replays of one worker call had not acted after 120 s; after the fix, 8 of 8 acted (2 via the nudge, at ~45 s) |
| 1.2 Quota pause | Done: `QuotaExceededError`; the loop rethrows it and the scheduler puts the task back to pending, saves state, and pauses (`QUOTA_PAUSE_MINUTES`, capped by `QUOTA_MAX_PAUSE_MINUTES`) |
| 1.3 Empty iterations | Done: worker or reviewer errors skip lint and review and keep the last real review; timeout and lint feedback carry the last review's issues forward |
| 1.6 (part) | `--max-iter` validated (1–50) |
| 2.1 Dependency preflight | Done: `src/deps/`, run before each batch, `--no-dep-upgrade`. Verified on a copy of `D:\temp\4`: Angular 20→22, mongodb, auth0 upgraded; typescript pinned 6.0.3 (7.0.2 breaks lint) |
| 2.3 Reviewer parsing | Done: last real `DECISION` line wins; issues read after it |
| 3.10 Crashing task | Done: stamped finished, `task_failed` emitted, logged |
| 3.4 (part) | State-save failures are now logged |
| 5.4 `edit_file` `$` | Done |
| Everything else | Not started |
**Evidence:** the 19-hour run log from `D:\temp\4\.oda.log` and two code reviews of this repo. The core claims were spot-checked against the source.

## Why

On a 50-subtask plan, ODA completed 11 subtasks in about 12.7 active hours, using 26 worker-hours. The log shows:

- **Wasted iterations.** 45% of worker iterations hit the 20-minute wall clock and were auto-REVISEd without review. 28% made no tool calls at all.
- **Model calls timing out.** 130 retries after Ollama timeouts.
- **Re-reading instead of working.** 106 tool-limit hits, 87 "thrash" warnings, and 162 context compactions.
- **Quota treated as failure.** One quota error ("Pro 5-hour limit") was handled as a task failure, which failed 3 tasks and blocked almost the whole graph.
- **A rule nobody executes.** The reviewer kept demanding `typescript ^7.0.2`, but no step ever performs the upgrade, so TASK-003-2 could never pass.

The root causes are in the harness, not the model.

---

## Phase 0: Hygiene (do first)

| # | Fix | Where |
|---|---|---|
| 0.1 | Rotate the exposed `ANTHROPIC_API_KEY_DAVACO_DEVS` and move secrets out of `.env` (Key Vault, or a user-level env var) | `.env` |
| 0.2 | Commit or shelve the uncommitted WIP: the new TypeScript-version rule, the standards sections, and the reviewer preloading `package.json` | `prompts.mts`, `reviewer.mts`, `worker.mts`, `prd/index.mts`, `typescript-version.mts` |
| 0.3 | Fix the 16 `tsc` errors (`src/tools/*`, `react-agent.test.mts`) so CI is green | — |
| 0.4 | Fix the `lint` script's single-quoted glob, which breaks on Windows | `package.json` |

---

## Phase 1: Stop the waste (highest impact)

### 1.1 Per-call timeout and deadline-aware retry
- **Problem:** `createChatModel` sets no per-call timeout, and `withOllamaRetry` makes 4 attempts while ignoring the iteration deadline. One hung call plus its retries can consume the whole 1200 s.
- **Fix:** pass an `AbortSignal.timeout(CALL_TIMEOUT_SECONDS)` (default 180) to every `invoke`, or stream the response. Skip a retry when the time left is less than one call's timeout. Add jitter to the backoff. Race tool executions against the same deadline.
- **Done when:** no iteration exceeds its deadline by more than one call timeout, and the log records the time spent per call.

### 1.2 Detect quota errors, pause, and resume
- **Problem:** "Pro 5-hour limit" matches none of the patterns in `TRANSIENT_ERROR_PATTERNS`. The loop then lints and reviews a run in which nothing happened, spends every iteration in seconds, fails the task and its dependents, and writes the quota message into the knowledge base as a lesson.
- **Fix:**
  - Add a typed `QuotaExceededError`, matched on HTTP 429, "limit", "quota" or "rate".
  - Throw it out of `RalphLoop` without counting an iteration.
  - In `graph.mts`, save the run state, pause, probe with backoff until the quota resets (or exit with a resume hint), then continue.
  - Never fail a task or write to the knowledge base because of a quota error.
- **Done when:** a simulated 429 pauses the run without changing any task's status.

### 1.3 Don't review an empty iteration
- **Fix:** on `worker_error`, or when nothing changed, skip lint and the reviewer, carry the previous review's ISSUES forward, and record the reason.
- **Fix:** keep feedback across timeout and lint iterations: append to it instead of overwriting `reviewer-N.md`. `loadLastReviewerFeedback` must return the latest *real* review.

### 1.4 Context budget
- **Problem:** compaction triggers at 0.7 × 32,768 tokens. The fixed part of the context alone (about 300 lines of rules, up to 78 knowledge-base entries, an activity log that keeps growing, and the full reviewer reply) is already over that, so compaction runs on every step. `estimateTokens` also ignores `tool_calls` arguments.
- **Fix:**
  - Measure and cap the fixed prompt: at most 10 knowledge-base entries, the last 2 activity-log entries, and only the reviewer's ISSUES block.
  - Count tool-call arguments in the token estimate.
  - Compact only when compacting actually shrinks the context, and never on two consecutive steps.
  - Raise `NUM_CTX` where the model allows it.

### 1.5 Read cache and tool limits
- **Fix:**
  - Clear the `readFileCache` entry on `write_file` or `edit_file` (and key it by path plus mtime).
  - Stop counting cache hits toward tool limits and thrash detection.
  - Apply limits per path, not per tool.
  - Remove the prompt's "~3 exploration reads / one read per file" rule.
  - Have the harness put the current contents of changed files back into the context after a write, so the model doesn't need to re-read them.

### 1.6 Stall detection replaces large `--max-iter`
- **Fix:** end a task early after N iterations (default 3) that end with the same failing test signature, or with no diff. Then either split the task or escalate it (see 3.2). Validate `--max-iter` (NaN or values over 50 are rejected) through the env schema.

---

## Phase 2: Deterministic checks instead of LLM opinion

### 2.1 Dependency version policy (the "force the upgrade" fix)
An LLM reviewer can't reliably compare semver, can't run `bun add`, and can't judge a toolchain waiver. **Move version enforcement out of the prompts and into a harness preflight step that runs once per run, before any task, serially:**

1. For each package covered by the policy (see open question Q1), read the declared range from every `package.json`. Look up the newest version with `npm view <pkg> version`. Compare with the `semver` package.
2. If the declared version is older, run `bun add [-d] <pkg>@<latest>` in the workspace that declares it.
3. Run the gate: `bun install`, then `tsc --noEmit`, `eslint`, and `bun test`.
4. **If the gate passes,** keep the upgrade and commit it as `chore(deps): bump <pkg> to <v>`.
5. **If it fails,** roll back. Then try the newest version allowed by the peer-dependency ranges of the toolchain packages (e.g. typescript-eslint's `peerDependencies.typescript`). Re-run the gate. Record "pinned X because Y" in the run state and in `docs/DEPENDENCIES.md`, which the compatibility-fallback rule requires.
6. Give the reviewer the **result as a fact** (e.g. "typescript pinned 6.0.3; 7.0.2 breaks typescript-eslint 9.x"). Remove the "REVISE if typescript below X" gate from the reviewer prompt.
7. Remove the worker prompt's "Available Packages: do NOT run `bun add`" contradiction for packages covered by the policy. The worker never upgrades these packages; the harness does.

Result: an upgrade happens once, gets tested, and is recorded, and no task can get stuck on a version rule again.

### 2.2 Objective gate before the LLM reviewer
The harness runs these and feeds the results to the reviewer:
- `tsc --noEmit`
- `eslint`
- the task's test command
- a grep check for banned patterns: `from 'zod'`, `enum `, `export default`, `/healthz`, backend `console.`, `mongodb@<7`

The LLM reviewer then judges only the acceptance criteria and design.

### 2.3 Reviewer correctness
- `parseReviewDecision` checks for SHIP anywhere in the reply first, so an echoed template can SHIP. Parse the **last** `DECISION:` line instead.
- Give the reviewer `extractChangedFiles(toolCallLog)`, not just the paths mentioned in the worker's text. Raise the 6-file / 8 KB cap, or send diffs instead of whole files.
- Remove the duplicated steps 1 and 2 in the reviewer prompt.

---

## Phase 3: Orchestration

| # | Fix | Detail |
|---|---|---|
| 3.1 | **Continuous worker pool** | Replace the `Promise.allSettled` batch barrier in `runTaskNode` with a pool capped at `--parallel N`. A ready task starts as soon as any slot frees up. |
| 3.2 | **Handle failed dependencies** | Add a `blocked` status with `blockedBy`. When a task fails, stop scheduling its subtree and keep running unrelated tasks. Write `NEEDS_ATTENTION.md`. On resume, `failed` stays failed unless you pass `--retry <id>` or `--retry-failed`. Only `blocked` and `in_progress` tasks go back to pending. |
| 3.3 | **Git worktree per task** | Run each task on its own branch and worktree, then merge serially with the test gate (as silo `--orchestrate` does). In the meantime, run siblings in the same domain one after another. |
| 3.4 | **Atomic, frequent state saves** | Write to a temp file, rename it over the real one, and keep a `.bak`. Save on every task transition and iteration through one async queue. Log save errors instead of swallowing them with `.catch(() => {})`. |
| 3.5 | **Run ids** | Store state under `<workingDirectory>/.ai/runs/<runId>/`, not relative to the process's cwd. Add `oda runs` and `oda resume <runId>`. Normalise path case on Windows. Add a lock file to stop two processes running at once. |
| 3.6 | **Split early** | Split on a stall signal (1.6), not after the iteration cap. |
| 3.7 | **Calibrate sizing** | Count bullet points as acceptance criteria, not sentences. Raise `SIZE_MAX_CRITERIA`. Cap the debate at 2 rounds and run task debates in parallel. Today a 15-task plan inflates to 50 subtasks. |
| 3.8 | **Validate the graph** | Reject unknown, duplicate or cyclic dependencies. Fix the parser's ID regex to accept `TASK-003-1` and `TASK-00Xa`. Compute the recursion limit after splitting. |
| 3.9 | **Make PRD approval real** | `waitForPRDApproval` is never awaited and `ratifyPlanNode` is a stub. Block the graph on approval or rejection. |
| 3.10 | **Handle a crashing task** | When `runSingleTask` throws: stamp it finished, emit `task_failed`, and log it. Today `PROGRESS.md` shows it as `in_progress` forever. |

---

## Phase 4: Standards and model handling

### 4.1 Load project standards
Load `CLAUDE.md`, `AGENTS.md` and `.claude/CLAUDE.md`, from the working directory up to the git root, into the planner, debate, splitter, worker and reviewer prompts. Label them "project conventions override the defaults below". Silo already does this in `system-prompt.mts`.

### 4.2 Make the built-in rules overridable defaults
Move the hard-coded rules into `defaults/standards.md`. Remove or make conditional the rules that conflict:

| Rule | Change |
|---|---|
| `.mts` import specifiers | Change to `.mjs` |
| Mandatory `@davissylvester` scope | Make configurable; default to the scope already used in the project |
| Mandatory `@davissylvester/api-common` | Require only if it's in `package.json` |
| Mandatory luxon, plus the false claim that it's "already installed" | Require only if it's in `package.json` |
| Hard-coded "Windows cmd.exe" | Detect the shell |
| "Zod/TypeBox" | TypeBox only |

### 4.3 Model resolution and fallback
- Resolve the coder model **once per process**, not on every iteration.
- Make it Cloud-aware (`:cloud` suffix, skip `/api/tags` on Cloud), and log the model actually used.
- Use a real fallback chain, triggered after N consecutive timeouts or a quota error. Example: `glm-5.3:cloud` → LAN Ollama `qwen3-coder:30b` → (optional) Claude via `--llm`.

### 4.4 Port ODA's own code to the house rules
Switch `env.mts` and the tool schemas from zod to TypeBox.

---

## Phase 5: Safety and tools

| # | Fix |
|---|---|
| 5.1 | `shell_exec`: pass a cleaned environment (no `*_API_KEY`), cap `timeout_ms` (for example 10 minutes), and add an optional allowlist. Don't echo command output into the global knowledge base. |
| 5.2 | Add timeouts to `run_tests`, `install_package` and `runLint`. |
| 5.3 | `glob_search` and `grep_search`: reject paths that escape the working directory, skip `node_modules`, and protect against runaway regexes (ReDoS) with a timeout and length cap. |
| 5.4 | `edit_file`: pass a function as the replacer, so `$&` and `$1` in the new text aren't expanded. |
| 5.5 | `read_file`: add a size cap, with paging for large files. |
| 5.6 | Knowledge base: put a lock or append-only writes around `appendEntry`, de-duplicate lessons, exclude infrastructure noise (quota and timeouts), and cap its size. |
| 5.7 | Logs: never log env values, and redact anything matching `sk-`, `key=` or `token`. |

---

## Phase 6: Observability and tests
- Write `metrics.json` per run: time per call and per iteration, SHIP rate, tokens, timeouts, quota pauses, and tool calls per iteration.
- Add a per-task wall-clock budget and a per-run token budget.
- Tests:
  - `runTaskNode` pool scheduling
  - blocked cascade and split-on-stall
  - quota pause
  - resume selection, including Windows path case and a corrupt `state.json`
  - `parseReviewDecision` (template echo, multiple `DECISION:` lines)
  - `edit_file` with `$` patterns
  - the dependency preflight, using a fake registry

---

## Suggested order and size

| Order | Item | Size |
|---|---|---|
| 1 | Phase 0 | S |
| 2 | 1.1, 1.2, 1.3 (timeouts, quota pause, empty iterations) | M. Fixes most of the wasted time. |
| 3 | 2.1 (dependency preflight) and 2.3 (reviewer parsing) | M. Unblocks TASK-003-2. |
| 4 | 1.4 to 1.6 (context, cache, stall detection) | M |
| 5 | 4.1 and 4.2 (project standards) | S |
| 6 | 3.1, 3.2, 3.4, 3.5 (pool, blocked handling, atomic state, run ids) | L |
| 7 | 2.2, 3.3, 3.6 to 3.10, Phase 5, Phase 6 | L |

After step 3, re-run `D:\temp\4` from its saved state and compare with this log's baseline: 45% wall-clock timeouts, 28% iterations with zero tool calls, and 0.9 tasks completed per hour.

## Decisions (confirmed by Davis, 2026-10-05)
1. **Upgrade scope: all direct dependencies.** See the 2.1 addendum below.
2. **WIP:** commit the uncommitted work first, on a feature branch, then build on it.
3. **Direction:** fix ODA's own executor. ODA stays a standalone tool and does not hand execution to silo.
4. **Fallback chain:** `glm-5.3:cloud`, then LAN Ollama (`192.168.128.230`, e.g. `qwen3-coder:30b`), then Claude.

### 2.1 addendum: upgrading all direct dependencies
Bumping every dependency at once makes failures hard to attribute, so the preflight upgrades in stages:

1. List the outdated direct dependencies (`bun outdated`, or `npm view` for each package). Group them so that coupled packages move together: `@angular/*`; `typescript` with `typescript-eslint`; `eslint` with `@eslint/*`; `mongodb` with `mongodb-memory-server`.
2. **Optimistic pass:** upgrade everything to its latest version and run the gate (`bun install`, then `tsc`, `eslint`, `bun test`). If the gate passes, commit once and stop.
3. **If it fails, isolate the cause:** go back to the starting state. Upgrade one group at a time and run the gate after each. Keep each group that passes. For a group that fails, try the newest version its peers allow. If that fails too, pin the group at its current version.
4. **Major versions:** allowed (latest means latest), but each one gets its own commit (`chore(deps): bump X 5→6`), so it can be reverted on its own.
5. Write `docs/DEPENDENCIES.md` with each package's version, its latest version, and the reason it's pinned. Give the reviewer this table as a fact.
6. **Cost control:** run the preflight once per run, cache the registry lookups for 24 hours, and add `--no-dep-upgrade` to skip it.

### 4.3 addendum: fallback chain
- **Triggers:** 2 consecutive call timeouts, a `QuotaExceededError`, or the model being unreachable. Any of these moves to the next model for the rest of the iteration. Probe the primary model again at the start of the next task.
- **Claude:** use the latest model ID, and read the key from a user-level env var or Key Vault, never from ODA's `.env`. Add a per-run spend cap (`--claude-budget`). Record each switch in `metrics.json`.
- **Prerequisite:** rotate the exposed key (0.1) before Claude fallback is enabled.
