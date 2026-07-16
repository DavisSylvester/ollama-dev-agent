# ODA vs. the Single-Shot Build Pipeline

> Grounding note: **ODA** is described from its source (explored directly) and real runs.
> The **single-shot pipeline** is described from its agent specifications; it has not been
> executed end-to-end here. Inferred-from-spec points are noted where relevant.

## 0. One-line framing

- **ODA** = one local/cloud process, one model family (Ollama), a 3-node state machine that
  role-switches Planner→Worker→Reviewer, self-healing via a per-task iteration ("Ralph") loop.
- **Single-shot pipeline** = many specialized Claude subagents under a governance layer,
  contract-first and wave-based, with an independent E2E + anti-cheat verification loop.

They occupy different points on the same axis: **ODA optimizes for cheap, private, one-command
autonomy; the pipeline optimizes for correctness, multi-domain integration, and trustworthy
verification.**

---

## 1. Architecture at a glance

| Dimension | ODA (Ollama Dev Agent) | Single-shot build pipeline |
|---|---|---|
| Execution unit | Single Node/Bun process, Ink TUI | Many Claude Code subagents orchestrated by the main session |
| Model substrate | Ollama — local **or** cloud (`glm-5.2:cloud`, etc.). Open-weight models | Claude (Anthropic) subagents; cloud-only |
| Roles | 3 prompted roles: Planner, Worker (ReAct), Reviewer | ~15 specialized agents (stack-architect, project-owner, story-sizer, planning-council, backend-{database,services,api}, ui-frontend, iac, e2e-tester, loop-controller, remediation, validation, ui-stylist) |
| Planning | 1 planner LLM → PRD with tasks (`src/prd/generator.mts`) | Multi-stage: STACK.md → domain-partitioned BACKLOG.md → S/M/L sizing → **ratified** by a debating quorum |
| Domain separation | **None** — generic worker builds everything | **Strict** — DB/Services/API/UI/IAC each own a layer |
| Cross-layer integration | Implicit, via task descriptions/deps | **Contract-first**: `packages/contracts` ports + `contracts/openapi.json`, ports/adapters, wave 1 interfaces before wave 2 impls |
| Parallelism | **Verified**: dependency-free tasks run concurrently (`graph.mts:99`, `Promise.allSettled`) | Wave-based parallel subagents |
| Quality gate | Reviewer LLM (SHIP/REVISE) + per-task lint + task `Test Command` | **Independent** validation agent + real Playwright E2E |
| Self-healing | Ralph loop (max-iter) + **auto-split on failure** (`splitter.mts`) | loop-controller → remediation → validation, with formal stop conditions + KB graduation |
| Anti-regression / anti-cheat | Per-task lint isolation only (`loop.mts:215`) | **Explicit**: validation refuses weakened tests (skips, deleted assertions, loosened matchers) + no-regression check |
| Human-in-loop | Optional PRD review gate (`--no-prd-review`) | More checkpoints; ui-stylist explicitly HITL |
| State/persistence | `.ai/activity/<slug>/<task>/`, `.oda.log`, resumable, KB | Per-agent docs: STACK.md, BACKLOG.md, REVIEW.md, error.md, KB JSONL |
| Invocation | **One command** (`oda ...`) | Orchestrated multi-step; not a single command |

Worker toolset (verified): `read_file`, `write_file`, `edit_file`, `delete_file`, `glob_search`,
`grep_search`, `list_directory`, `run_linter`, `shell_exec` — a genuine ReAct agent, not a single
completion.

---

## 2. Features

### ODA
- 3-node graph (`generate_prd` → `run_task` batches → `generate_results`).
- ReAct worker with real file/search/shell tools.
- Reviewer LLM issues SHIP/REVISE with feedback fed back to the worker.
- Dependency-topological **parallel** task execution.
- Auto-split of oversized failing tasks into sub-tasks.
- Cross-run knowledge base (lessons).
- Resumable interrupted runs.
- Per-role model selection (planner/coder/editor independently).
- Local **or** cloud Ollama; fully offline-capable.
- Single command, TUI progress.

### Single-shot pipeline
- Formal stack resolution (STACK.md) as single source of truth.
- Domain-partitioned backlog with acceptance criteria and contract-chain deps.
- Story sizing to guarantee "one builder, one pass, no context exhaustion."
- Adversarial planning ratification (planning-council quorum + decision log).
- Contract-first ports/adapters + OpenAPI, so layers integrate deterministically.
- Real E2E (Playwright) authored from acceptance criteria, run at integration.
- Independent validation gate with anti-test-weakening + no-regression enforcement.
- Formal remediation policy (stop conditions, hypothesis dedup, KB graduation).
- Post-build review (REVIEW.md) with remediation stories.
- Optional design restyle (ui-stylist) via Claude Design.

---

## 3. Pros

### ODA pros
1. **Cost & privacy**: run entirely local → near-zero marginal cost, no code leaves the machine.
2. **Simplicity/ergonomics**: one command, one process, one config file.
3. **Fast start**: give a prompt or a PRD, go.
4. **Model-agnostic & swappable**: any Ollama model; upgrade by changing a tag.
5. **Genuinely autonomous loop**: worker↔reviewer with auto-split is effective for well-scoped
   CRUD-shaped work.
6. **Parallel throughput** on independent tasks.
7. **Portable**: not tied to the Claude Code harness.

### Pipeline pros
1. **Correctness posture**: independent E2E + anti-cheat validation is far harder to fool than a
   single reviewer LLM.
2. **Integration integrity**: contract-first ports/OpenAPI prevent the cross-task drift that
   plagues generic agents.
3. **Higher model ceiling**: Claude agents reason better on ambiguous/complex specs.
4. **Governance**: adversarial planning + sizing catches bad scope *before* code is written.
5. **Multi-domain**: natively produces API + UI + IAC + tests as a coherent system.
6. **Auditability**: STACK/BACKLOG/REVIEW/decision-log artifacts.

---

## 4. Cons

### ODA cons
1. **Verification is weak/soft**: the "gate" is a reviewer LLM + a task-supplied `Test Command`.
   An LLM reviewer can rubber-stamp or false-REVISE. No independent E2E.
2. **No anti-cheat**: nothing stops the worker from weakening/removing tests to make a task "pass."
3. **No contract enforcement**: many independent tasks can each be locally valid yet fail to
   integrate (mismatched DTOs, route shapes).
4. **Capability ceiling**: open models are weaker at large, interdependent designs; quality
   degrades on hard tasks.
5. **No domain specialization**: one generic prompt does DB, services, transport, tests.
6. **Config foot-guns**: silent fallback to wrong models when its `.env` isn't loaded (a real
   bug hit and fixed during setup — see `src/env.mts`).
7. **No global regression gate** across parallel tasks (lint is isolated per task by design).

### Pipeline cons
1. **Cost**: Claude tokens across many agents and waves.
2. **Cloud-only**: no offline/private mode; code and specs go to the provider.
3. **Operational weight**: many agents, artifacts, waves — more to understand, set up, babysit.
4. **Not one command**: requires orchestration and the Claude Code harness/agent-team installed.
5. **Slower cold start**: planning quorum + sizing before any code.
6. **Overkill for small tasks**: the ceremony dwarfs a single-endpoint change.

---

## 5. Gaps (what each is missing that the other has)

**ODA is missing (that the pipeline has):**
- An **independent** verifier separate from the generator.
- **Real E2E** (Playwright) beyond per-task shell test commands.
- **Anti-test-weakening / no-regression** enforcement.
- **Contract/interface enforcement** between layers.
- **Pre-code plan ratification** and story-sizing discipline.
- **Domain-specialized** reasoning.

**Pipeline is missing (that ODA has):**
- **Local/offline/private** execution and a **local-cost** option.
- **One-command** turnkey autonomy.
- **Model portability** off Anthropic.
- A **single self-contained process** (no harness dependency).
- Lightweight footprint for **small/medium** jobs.

---

## 6. Recommendations — when to use which

**Reach for ODA when:**
- Privacy/air-gap or cost sensitivity dominates.
- The work is a **greenfield, CRUD-shaped backend** with a good task breakdown.
- You want a **single command** and can tolerate softer verification (you review output yourself).
- You're iterating quickly / prototyping.

**Reach for the single-shot pipeline when:**
- It's a **production system** with real quality bars.
- You need **multi-domain** output (API + Angular UI + Terraform) that must integrate.
- You need **trustworthy verification** (E2E + anti-cheat) you won't hand-audit.
- Budget for Claude + orchestration is acceptable and the code can go to the cloud.

**Concrete call for the Aperive build:** it is a multi-domain, auth-heavy, contract-sensitive API
(Auth0 orgs, Stripe/WHCC webhooks, S3, per-grant permissions). That is squarely the pipeline's
sweet spot and squarely ODA's weak spot (contract drift + soft verification across ~31
interdependent tasks). ODA can plausibly get the **infra + simple CRUD entities** done cheaply; the
**auth/webhook/permission** tasks are where an LLM-only reviewer is most likely to wave through
subtly-broken code.

---

## 7. Suggestions

### A. Hybrid (best of both) — recommended
1. Use the **pipeline's planning** (project-owner → story-sizer → planning-council) to produce a
   rigorously sized, contract-annotated backlog.
2. Convert that backlog to ODA's PRD format and let **ODA workers execute cheaply/locally** the
   mechanical tasks (infra, CRUD entities).
3. Gate ODA's output with the pipeline's **e2e-tester + validation** agents — ODA writes, Claude
   *verifies*. This directly patches ODA's biggest weakness while keeping most execution cheap.
4. Route the **hard tasks** (auth, webhooks, permissions) to Claude domain agents; route the easy
   ones to ODA.

### B. Harden ODA to close its gaps (if you want it standalone)
- Add an **independent validation step** (separate model/prompt) that (a) runs the real test suite,
  (b) diffs tests to detect skips/deleted assertions/loosened matchers, (c) fails the task on
  regression — mirror the pipeline's `validation` agent.
- Add a **Playwright E2E** stage from acceptance criteria, not just per-task `Test Command`.
- **Emit and consume contracts**: have the worker write/read an OpenAPI + shared interface package
  so later tasks bind to earlier ones deterministically.
- **Reviewer robustness**: enforce a strict JSON schema on SHIP/REVISE, retry on parse failure, and
  use the **strongest** cloud model for the reviewer role (it's the quality bottleneck).
- **Global regression gate** across parallel tasks before final results.
- Make config **loud, not silent**: fail fast if models aren't reachable/available instead of
  falling back to defaults.

### C. Operational
- Keep the env fix and add a `.env.example` documenting the cloud tags so runs are reproducible.
- For any real ODA run, **commit the target repo first** so you can diff/rollback — ODA's soft
  verification means you must be the final gate.

---

## Bottom line

The pipeline is a **higher-assurance, higher-cost, multi-domain system builder**; ODA is a
**cheaper, private, one-command feature builder with softer guarantees**. For Aperive specifically,
use the pipeline (or the hybrid) for the auth/payments/permissions core and let ODA carry the
mechanical CRUD — and in all cases, don't trust ODA's LLM reviewer as your only gate.
