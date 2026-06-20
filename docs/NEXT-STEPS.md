# ODA — Next Steps / Remaining Work

Roadmap of harness improvements still to do, from the gap analysis
(see `harness-gap-analysis.html`). Phases 0–2 are complete; what remains is
listed below. Effort: S (≤½ day), M (1–2 days), L (multi-day).

## Done (for reference)

| Item | Commit |
|------|--------|
| 0.1 Planner task-sizing rules | f6b1bea |
| 0.2 dependsOn ordering | f6b1bea |
| 0.3 Auto-split on repeated failure | b31cec2 |
| 1.1 Wall-clock time budget | 7c05164 |
| 1.2 Process hygiene / server-start guard | 7c05164 |
| 1.3 Per-file edit-loop detection | 7c05164 |
| 1.4 Pre-completion checklist | 4000e84 |
| 2.1 Context compaction (ReAct loop) | fe38bf6 |
| 2.2 In-task todo list | 6519410 |

---

## Remaining

### Deferred — 2.2 Sub-agents — L
- **What:** Let a worker spawn nested ReAct loops with clean context for sub-steps.
- **Why deferred:** Task-level decomposition is already handled by auto-split-on-failure (0.3). Nested spawning adds recursion/cost/isolation risk for marginal gain.
- **Revisit if:** single tasks still need internal isolation that the todo list + auto-split don't provide.

### 3.1 Reasoning-budget allocation ("reasoning sandwich") — M
- **What:** Allocate more model reasoning to planning & verification, less to mechanical implementation.
- **Where:** model invocation params per phase — `src/models/react-agent.mts`, `src/ralph/reviewer.mts`.
- **Note:** depends on the model exposing a reasoning/thinking budget control.

### 3.2 Trace-analysis-driven self-improvement — L
- **What:** Periodically analyze run traces (worker/reviewer/activity logs + KB) with a dedicated agent to find failure modes and propose harness/prompt changes.
- **Where:** new `src/analysis/` + a CLI subcommand (e.g. `oda analyze`).
- **Note:** today the KB is populated reactively during runs; this makes improvement systematic and offline.

### 3.3 Annotation / backflow cycle (human) — M
- **What:** Let a human annotate the PRD inline and iterate; allow mid-implementation discovery to push a task back to re-planning.
- **Where:** `src/agent/graph.mts` + `src/ui/`.
- **Note:** the *automated* backflow is covered by 0.3; this is the human-in-the-loop version (currently only PRD approve/reject exists).

### 3.4 Skills architecture (namespaces) — L
- **What:** Executable skills (`spec:` / `oracle:` / `code:`) that behave differently (workflow vs advisory vs utility), context-loaded.
- **Where:** new `src/skills/`.
- **Note:** the knowledge base is *knowledge*; this adds executable *behaviors*.

### 3.5 Delta tracking (brownfield) — M
- **What:** Mark `ADDED` / `MODIFIED` / `REMOVED` so the agent reasons about existing code and evolving specs.
- **Where:** `src/prd/` + worker prompt.

### 3.6 Retry/fallback completeness — S
- **What:** Per-tool retry (not just model retry); model fallback for planner & reviewer (coder already has it).
- **Where:** `src/models/react-agent.mts`, `src/models/ollama-client.mts`.

---

## Known pre-existing tech debt (not gaps, but worth a pass)

- **LangChain `tool()` overload type errors** — all `src/tools/*.mts` files trip a
  `RunnableFunc` overload mismatch under `tsc` (~14 errors). Runtime-fine; the CI
  typecheck step is non-blocking because of these. Worth resolving by typing the
  tool input schemas so `tsc` passes cleanly and the step can become blocking.
- **`exactOptionalPropertyTypes`** edge in `src/index.mts`.

## Recommended next action

Run a **fresh full end-to-end build** to validate the shipped Phases 0–2 working
together (auto-split + compaction + guards + checklist), then let the observed
behavior prioritize which Phase 3 items to pick up.
