# Decision Log

Append-only record of design decisions. Newest first.

---

## 2026-07-16 — L-Task Debate Forum (replaces single-shot split recommendation)

**Context:** When the sizer marks a task **L**, the previous behavior (Task 13) was a single model call (`recommendSplitApproach`) producing advisory split text. We are replacing that with a multi-persona debate that argues the task's complexity and produces a concrete, executable breakdown. This is effectively a sizing-time `planning-council` and a precursor to SP1's council in the Ollama-single-shot overview.

### Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Debate output | **Drive the split** — the Solution Architect's final decision becomes the real child tasks that replace the L task in the plan (not advisory only). |
| 2 | Persona execution | **One model call per persona per round** (full independence). All four personas critique every round; no SA-led early exit within a round. |
| 3 | Relationship to Task 13 | **Replace it** — remove `recommendSplitApproach` / `buildSplitRecommendationPrompt` as the primary path. `explainOversize` (deterministic) is retained only as the failure fallback. |
| 4 | Persona models | **Per-persona, tiered defaults.** Overridable via env; defaults: SA + SME → `PLANNER_MODEL`; Scrum Master + Developer → `CODER_MODEL`. |
| 5 | Recursion (child still L) | **Re-size children; re-debate any child still L**, bounded by the existing `MAX_SPLIT_DEPTH`. Guarantees no L survives; `SizeGateError` still fires if an L persists at max depth with the gate enforced. |
| 6 | Fallback on model failure | **Retry debate once, then deterministic.** If the debate errors or Ollama is unreachable, retry once; on repeat failure fall back to `splitTask` + `explainOversize`. The run continues; SIZING.md notes the debate was skipped. |
| 7 | Transcript persistence | Full transcript kept in `DebateResult` (for logging); SIZING.md carries a **compact summary** (final persona verdicts + decision + `decidedBy`). |
| 8 | Max rounds | `DEBATE_MAX_ROUNDS`, default **4**, hard-capped at 4. A decision is made once all personas agree OR max rounds is hit. |

### Personas

| Persona | Lens | Default model | Override env |
|---------|------|---------------|--------------|
| Scrum Master | INVEST slicing, story independence, vertical slices | `CODER_MODEL` | `DEBATE_SCRUM_MODEL` |
| Solution Architect | technical decomposition; **holds the final decision** | `PLANNER_MODEL` | `DEBATE_ARCHITECT_MODEL` |
| SME | domain correctness (uses `task.domain`) | `PLANNER_MODEL` | `DEBATE_SME_MODEL` |
| Developer | implementation feasibility & effort | `CODER_MODEL` | `DEBATE_DEV_MODEL` |

### Debate loop (`src/prd/debate.mts`)

1. **Round 0** — Solution Architect proposes an initial breakdown (2–4 sub-stories).
2. **Each round (max `DEBATE_MAX_ROUNDS`, ≤ 4):**
   - All four personas critique the current proposal independently — one model call per persona per round. Each returns a structured stance: `{ verdict: 'agree' | 'revise', comments }`.
   - **Consensus check:** all four `agree` → debate ends, `decidedBy: 'consensus'`.
   - Otherwise the SA synthesizes the critiques into a revised proposal for the next round.
3. **Termination:** consensus, OR round 4 reached → SA's current proposal is the final decision (`decidedBy: 'architect'` when max rounds hit — SA decides unilaterally).

Approx. ≤ 20 model calls per L task (1 proposal + 4×4 critiques + 3 syntheses).

### Data shapes

- `ProposedStory { name; description; acceptanceCriteria }`
- `PersonaStance { persona; verdict: 'agree' | 'revise'; comments }`
- `DebateRound { round; proposal: ProposedStory[]; stances: PersonaStance[] }`
- `DebateResult { taskId; taskName; rounds: DebateRound[]; finalStories: ProposedStory[]; decidedBy: 'consensus' | 'architect'; transcript }`

### Split integration

- `finalStories` → child `Task[]` via a shared helper extracted into `splitter.mts` (`buildChildTasks(parent, stories)`): reuses existing re-ID (`<parent>-N`), foundation-first dependency wiring, `domain` inheritance, `splitDepth+1`. `splitTask` refactors onto the same helper (DRY).
- `sizePlan` replaces the per-L `recommend` + `split` calls with a debate that returns children and drives the split; `SizedPlanResult.recommendations` are sourced from the debate.

### Error handling & testing

- Tolerant JSON parsing of persona/SA output (strip code fences, locate JSON, garbled stance defaults to `revise`).
- Unit tests inject per-persona invoke fns (no live model): consensus-in-round-1 early stop; no-consensus → round 4 → architect decides; garbled stance → `revise`; `buildChildTasks` wiring; bounded re-debate on a still-L child; fallback-to-deterministic on debate error; env default resolution.
- Live smoke against real Ollama kept out of the unit suite; included as a final plan task.

### Env additions

`DEBATE_ARCHITECT_MODEL`, `DEBATE_SME_MODEL`, `DEBATE_SCRUM_MODEL`, `DEBATE_DEV_MODEL` (all optional; tiered defaults), `DEBATE_MAX_ROUNDS` (default 4, capped 4).
