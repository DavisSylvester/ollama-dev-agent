# Overview Design: Ollama Single-Shot Mirror + Best-of-Both Agent

**Date:** 2026-07-16
**Status:** Overview approved (shape) — spawns per-role-group specs
**Scope:** New capability inside `ollama-dev-agent` (this repo)

This is an **umbrella / overview** design. It defines the architecture, the role
map, the on-disk contracts, and the build sequence. It does **not** contain
task-level detail — each sub-project below gets its own `spec → plan →
implementation` cycle (via superpowers:brainstorming → writing-plans).

## Problem & goal

Reproduce the multi-agent orchestration of `C:\projects\davisSylvester\claude-single-shot-agent`
(a Claude Code plugin: 14 role-subagents, separation-of-powers planning,
contract-chain waves, a governed remediation loop) on a **local Ollama runtime**,
then produce a **best-of-both** agent that fuses that governance with ODA's
self-healing execution loop.

### The reframing (why a literal port is impossible)

`claude-single-shot-agent`'s 14 "subagents" are markdown role definitions executed
**by Claude Code's Agent tool**; the intelligence is Claude, orchestrated by a main
Claude session coordinating through files on disk. There is no model-swap knob. To
run those roles on Ollama we must **reimplement the orchestration on a real
runtime** — and ODA already is that runtime (LangGraph + Ollama client + tools +
react-agent + Worker/Reviewer loop + knowledge base). So the port lands as new
modules inside this repo.

## Decisions (from brainstorming, 2026-07-16)

| Decision | Choice |
|---|---|
| Deliverables | **Two separate artifacts**: (A) faithful Ollama mirror of all 14 roles, then (B) best-of-both. |
| Home | **Extend `ollama-dev-agent`** — reuse its LangGraph graph, Ollama client, tools, KB, worker/reviewer. |
| Fidelity | **Faithful — all 14 roles** and the separation-of-powers / wave structure. |
| Stack | **Keep the same fixed stack**: Angular · Elysia/Bun · MongoDB (native driver) · Terraform · Playwright · Azure. |
| Planning deliverable | **Decompose into sub-project specs**; this overview doc + per-group cycles. |
| Sizing feature | **Finish first** — `feature/domain-tshirt-sizing` (Tasks 6–12) is `story-sizer`; complete + merge before single-shot. |
| KB strategy | **Unify into one store** (category + failure-signature indexing) in the best-of-both. |

## Artifact A — "ollama-single-shot" (faithful mirror)

New tree `src/single-shot/`, separate from ODA's existing Ralph pipeline. Each of
the 14 roles becomes a **module with its own system prompt, an isolated context (a
fresh react-agent invocation), and an assigned model tier**, coordinating **only
through files on disk** — mirroring the original's "subagents cannot call each
other; they coordinate through artifacts" rule. A LangGraph orchestrator drives the
wave flow with **human-approval checkpoints** (reusing ODA's `emitAgentEvent` /
`waitForPRDApproval` mechanism).

### Role → Ollama realization

| Single-shot role | Ollama realization | Model tier |
|---|---|---|
| `stack-architect` | resolves `docs/STACK.md` | `PLANNER_MODEL` (strongest) |
| `project-owner` | drafts `docs/BACKLOG.md`; post-build review → `docs/REVIEW.md` | `PLANNER_MODEL` |
| `story-sizer` | **= the paused sizing feature**; sizes S/M/L + splits → `docs/SIZING.md` | `PLANNER_MODEL` |
| `planning-council` | debates + ratifies backlog → `docs/PLANNING-DECISIONS.md` | `PLANNER_MODEL` |
| `backend-database` | TypeBox schemas + repo ports (wave 1), Mongo adapters (wave 2) | `CODER_MODEL` |
| `backend-services` | service interfaces (wave 1), logic vs ports (wave 2) | `CODER_MODEL` |
| `backend-api` | Elysia transport + DI; `contracts/openapi.json` | `CODER_MODEL` |
| `ui-frontend` | Angular signals/standalone; typed client; default theme tokens | `CODER_MODEL` |
| `iac` | Terraform per STACK.md | `EDITOR_MODEL` |
| `e2e-tester` | Playwright specs (wave 2), runs (wave 4) | `CODER_MODEL` |
| `loop-controller` | remediation policy/state; stop conditions; emits directive | `PLANNER_MODEL` |
| `remediation` | one scoped fix per iteration, fresh context, hypothesis-first | `CODER_MODEL` |
| `validation` | independent 3-check gate + KB graduation guard | `PLANNER_MODEL` |
| `ui-stylist` | optional, outside single-shot; token-swap restyle | `CODER_MODEL` |

Governance/reasoning roles (opus in the original) map to the strongest available
Ollama model; builders (sonnet) to `CODER_MODEL`/`EDITOR_MODEL`. A future
`REVIEWER_MODEL`/tier split can refine this.

### On-disk contract artifacts (ported verbatim)

`docs/STACK.md` · `docs/BACKLOG.md` (draft→ratified) · `docs/SIZING.md` ·
`docs/PLANNING-DECISIONS.md` · `packages/contracts/{schemas,ports,services}` ·
`contracts/openapi.json` · `docs/REVIEW.md` · `error.md` (episodic, gitignored) ·
the signature-normalized remediation KB.

Guiding rule preserved: **depend on the shape, not the thing** — every cross-domain
edge points at a contract that lands in an early wave.

### Wave flow (orchestrator)

```
Planning:  stack-architect → project-owner → story-sizer → planning-council (ratify)   [human checkpoints]
Wave 1:    contracts — schemas + ports · service interfaces · openapi skeleton
Wave 2:    implement in parallel (mock upstream) · e2e-tester authors specs · iac parallel
Wave 3:    integrate — swap mocks for real, wire DI
Wave 4:    e2e run → project-owner review → remediation loop
Wave 5:    (optional, outside single-shot) ui-stylist restyle — only once green
```

ODA's graph already runs ready tasks in parallel (`findReadyTasks`); wave semantics
extend that with contract-gated batches.

### Remediation loop (faithful)

Three roles with separation of powers, coordinating through `error.md` + KB:
- **loop-controller** — persistent policy/state; computes the **normalized failure
  signature** (`layer : normalized-message : failing-assertion`, stack-stripped);
  enforces stop conditions (max-attempts=5, no-novel-hypothesis, regression halt);
  emits one `SPAWN`/`HALT` directive per iteration; never edits code.
- **remediation** — fresh context each iteration; reads `error.md` + KB; writes the
  hypothesis **before** acting; smallest fix inside a scoped slice; never weakens a test.
- **validation** — adversarial 3-check gate (real fix · no regression · not a
  weakened test); the only writer to the KB; graduates only generalized lessons.

Realized on Ollama: the "main session dispatches" role becomes the LangGraph
orchestrator dispatching role-modules; each is a fresh react-agent invocation. The
KB CLI (`bun scripts/kb.mjs` in the original) is ported as an ODA module/CLI.

## Artifact B — "best of both"

**Thesis:** single-shot decides *who does what and guards quality*; ODA *grinds each
task to green*. Keep single-shot's governance (separation-of-powers planning,
contract-chain waves, remediation loop) as the macro-orchestration, but replace each
builder role's **single-pass** execution with **ODA's self-healing Ralph loop**
(worker → mandatory lint gate → reviewer → per-iteration KB → iteration budget →
proactive T-shirt sizing + auto-split + anti-thrash detection + transient-retry).

### Best parts of each (research synthesis)

- **From single-shot:** role separation of powers; domain partitioning; contract-chain
  waves ("depend on the shape"); normalized-signature remediation with mandatory stop
  conditions + independent validation gate + KB-graduation guard; functional-first UI
  theming; on-disk coordination.
- **From ODA:** Ralph worker/reviewer/lint loop; react-agent step budgets +
  anti-thrash; reachability + transient-retry guards; context compaction; category
  few-shot KB; single-process Ollama runtime; proactive sizing gate (this feature).

### Unified knowledge base (decision: one store)

The two projects ship **complementary** KBs — ODA's *category-based few-shot* (feeds
worker/planner prompts) and single-shot's *signature-normalized failure lessons*
(JSONL by hash, validation-gated graduation). Artifact B unifies them into **one
store with dual indexing**: a category index for prompt-time few-shot injection and a
failure-signature index for the remediation loop, sharing storage, dedup, and a
single access CLI. Detailed schema is its own sub-project spec.

## Sub-project decomposition (each = its own spec → plan)

- **SP0 — Finish story-sizer.** Complete `feature/domain-tshirt-sizing` Tasks 6–12,
  merge to main. Prerequisite; already planned.
- **SP1 — Planning quartet + orchestrator skeleton.** `stack-architect`,
  `project-owner`, `planning-council`, the wave orchestrator, human checkpoints, and
  the `STACK.md`/`BACKLOG.md`/`PLANNING-DECISIONS.md` artifacts. (`story-sizer` slots
  in from SP0.)
- **SP2 — Contract/build roles + waves.** `backend-database`, `backend-services`,
  `backend-api`, `ui-frontend`, `iac`, `e2e-tester`; contract artifacts
  (`packages/contracts/*`, `contracts/openapi.json`); wave 1–4 execution.
- **SP3 — Remediation trio + signature KB.** `loop-controller`, `remediation`,
  `validation`, `error.md`, the signature-normalized KB + its access CLI.
- **SP4 — UI theming + ui-stylist.** Default liquid-glass token theme +
  functional-first token purity; optional `ui-stylist` restyle pass.
- **SP5 — Best-of-both synthesis.** Swap builder single-pass for the Ralph loop;
  unify the KBs; reconcile ODA's existing pipeline with the single-shot orchestrator.

### Build order

`SP0 → SP1 → SP2 → SP3 → (SP4) → SP5`. SP4 is optional/parallel. Each sub-project
produces a working, testable increment.

## Fixed stack (unchanged from single-shot)

Angular (signals, standalone, injectable-service state) · Elysia on Bun with DI
(transport only) · MongoDB native driver (no ODM) · Terraform · Playwright · Azure
(Container Apps / Static Web Apps). `docs/STACK.md` remains the per-run source of
truth; `@davissylvester` package scope; ODA's existing worker/reviewer hard rules
apply.

## Risks & open questions (resolve within sub-project specs)

- **Ollama reasoning ceiling.** `planning-council` debate and `validation`
  adversarial review assume Claude-level reasoning. On local models these may
  underperform; SP1/SP3 must define fallback/tuning (stronger model tier, tighter
  prompts, or reduced ceremony) while staying faithful in structure.
- **Model tiering.** Whether to add a dedicated `REVIEWER_MODEL`/governance tier
  beyond PLANNER/CODER/EDITOR — decide in SP1.
- **Wave parallelism vs. context.** Running many builder react-agents in parallel
  multiplies Ollama load; SP2 defines concurrency limits.
- **KB path.** The original uses `~/.vault/knowledge-base`; ODA uses
  `.ai/knowledge-base/`. SP3/SP5 pick the unified location + graceful-absence
  behavior.

## Out of scope (this overview)

- Task-level implementation detail (lives in each sub-project spec/plan).
- Changing ODA's existing Ralph pipeline before SP5.
- Non-fixed stacks / stack-agnostic core (explicitly rejected).
