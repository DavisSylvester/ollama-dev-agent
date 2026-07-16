# L-Task Debate Forum — Design Spec

**Date:** 2026-07-16
**Status:** Approved
**Supersedes:** Task 13 (`recommendSplitApproach`) of the domain-partitioned T-shirt sizing feature.
**Decision log:** see `docs/DECISIONS.md` → "2026-07-16 — L-Task Debate Forum".

## 1. Problem

When the sizer marks a task **L** (too big for one focused pass), the current behavior is a single planner call (`recommendSplitApproach`) that emits advisory split text. Advisory text does not guarantee a good decomposition, and a single voice has no adversarial pressure. We want a deliberated, executable breakdown produced by multiple viewpoints, with a clear decision owner.

## 2. Goal

Replace the single-shot recommendation with a **four-persona debate** that argues an L task's complexity, converges on a concrete breakdown, and **drives the actual split** — the debate's outcome becomes the real child tasks that replace the L task in the plan.

## 3. Personas

| Persona | Lens | Default model | Override env |
|---------|------|---------------|--------------|
| Scrum Master | INVEST slicing, story independence, vertical slices | `CODER_MODEL` | `DEBATE_SCRUM_MODEL` |
| Solution Architect | technical decomposition; **holds the final decision** | `PLANNER_MODEL` | `DEBATE_ARCHITECT_MODEL` |
| SME | domain correctness (uses `task.domain`) | `PLANNER_MODEL` | `DEBATE_SME_MODEL` |
| Developer | implementation feasibility & effort | `CODER_MODEL` | `DEBATE_DEV_MODEL` |

## 4. The debate loop (`src/prd/debate.mts`)

1. **Round 0** — the Solution Architect proposes an initial breakdown of 2–4 sub-stories.
2. **Each round (max `DEBATE_MAX_ROUNDS`, hard-capped at 4):**
   - All four personas critique the current proposal **independently** — one model call per persona per round. Each returns a structured stance `{ verdict: 'agree' | 'revise', comments }`.
   - **Consensus check:** if all four `agree`, the debate ends with `decidedBy: 'consensus'`.
   - Otherwise the Solution Architect synthesizes the critiques into a **revised** proposal for the next round.
3. **Termination:** consensus, OR round 4 reached. On max rounds the SA's current proposal is the final decision with `decidedBy: 'architect'` (the SA decides unilaterally, as it holds the final decision).

Bounded cost: ≤ ~20 model calls per L task (1 proposal + 4×4 critiques + 3 syntheses).

### Data shapes

```ts
interface ProposedStory { name: string; description: string; acceptanceCriteria: string; }
interface PersonaStance { persona: DebatePersona; verdict: 'agree' | 'revise'; comments: string; }
interface DebateRound { round: number; proposal: ProposedStory[]; stances: PersonaStance[]; }
interface DebateResult {
  taskId: string;
  taskName: string;
  rounds: DebateRound[];
  finalStories: ProposedStory[];
  decidedBy: 'consensus' | 'architect';
  transcript: string;
}
```

`DebatePersona` is an `as const` union: `'scrum_master' | 'solution_architect' | 'sme' | 'developer'`.

## 5. Driving the split

- `finalStories` → child `Task[]` via a shared helper extracted into `splitter.mts`:
  `buildChildTasks(parent: Task, stories: ProposedStory[]): Task[]`.
  It reuses the existing child construction: re-ID `<parent>-N`, foundation-first dependency wiring (first child inherits the parent's external deps; the rest depend on the first), `domain` inheritance, `splitDepth + 1`, `status: 'pending'`, `iterationCount: 0`, `size` omitted (re-sized later).
- `splitTask` is refactored to build its children via the same helper (DRY).
- `sizePlan` replaces the per-L `recommend` + `split` pair with a `debateFn(task) => Promise<Task[]>` that runs the debate and returns children, driving `applySplit`.

## 6. The gate still holds

- Children produced by the debate are re-sized.
- Any child still **L** gets its own debate, bounded by `MAX_SPLIT_DEPTH` (`canSplitForSize`).
- If an L persists at max depth while `SIZE_ENFORCE_GATE` is true, `SizeGateError` fires — unchanged contract, including its `recommendations` payload.

## 7. Fallback

The debate depends on Ollama. If it errors or the model is unreachable:
1. **Retry the debate once.**
2. On repeat failure, fall back to the deterministic `splitTask` + `explainOversize` recommendation text. The run continues; SIZING.md notes the debate was skipped for that task.

## 8. Surfacing the outcome

- `SizedPlanResult.recommendations` are now sourced from the debate: `reasons` = why the task was L; `recommendation` = the SA's decision summary plus `decidedBy`.
- SIZING.md's "Recommendations for Oversized Tasks" section gains a **compact debate summary** (final persona verdicts + the decision + `decidedBy`). The full transcript is retained in `DebateResult` for logging, not written to SIZING.md.
- The `plan_sized` event carries the same recommendations.
- `recommendSplitApproach` and `buildSplitRecommendationPrompt` (and their tests) are removed.

## 9. Prompts (`src/prd/prompts.mts`)

- `buildDebateProposalPrompt(task)` — SA initial proposal; output a JSON array of `{name, description, acceptanceCriteria}`.
- `buildPersonaCritiquePrompt(persona, task, proposal, priorRounds)` — persona critique; output JSON `{verdict, comments}`.
- `buildDebateSynthesisPrompt(task, proposal, stances)` — SA revision; output a JSON array of stories.

All template-literal backticks escaped as `` \` `` per the project convention.

## 10. Error handling

Local models are unreliable at strict formats, so parsing degrades gracefully:
- Strip code fences, locate the first JSON value, parse.
- A garbled or unparseable stance defaults to `verdict: 'revise'` (keeps the debate honest — a broken voice cannot fake consensus).
- A proposal that parses to zero stories triggers the retry, then the deterministic fallback.

## 11. Testing

Unit tests inject per-persona invoke functions (no live model):
- Consensus in round 1 ends the debate early with `decidedBy: 'consensus'`.
- No consensus runs to round 4, then `decidedBy: 'architect'`.
- A garbled stance parses to `revise`.
- `buildChildTasks` produces correct IDs, dependency wiring, domain inheritance, and depth.
- A child that is still L triggers a bounded re-debate; an unsplittable L trips `SizeGateError`.
- Debate error falls back to the deterministic split + recommendation.
- Env defaults resolve to the tiered models when the `DEBATE_*_MODEL` vars are unset.

Live smoke against real Ollama is kept out of the unit suite (slow) and included as a final plan task.

## 12. Env additions (`src/env.mts`)

| Var | Default | Notes |
|-----|---------|-------|
| `DEBATE_ARCHITECT_MODEL` | `PLANNER_MODEL` | optional override |
| `DEBATE_SME_MODEL` | `PLANNER_MODEL` | optional override |
| `DEBATE_SCRUM_MODEL` | `CODER_MODEL` | optional override |
| `DEBATE_DEV_MODEL` | `CODER_MODEL` | optional override |
| `DEBATE_MAX_ROUNDS` | `4` | min 1, hard-capped at 4 |

Since the defaults reference other env values, they resolve at read time (a helper reads `env.DEBATE_ARCHITECT_MODEL ?? env.PLANNER_MODEL`), not as static Zod defaults.

## 13. Out of scope

- Persisting full transcripts to disk beyond in-memory logging.
- A runtime on/off toggle for the debate (it is the path; deterministic is only the failure fallback).
- Human-in-the-loop interaction during the debate.
