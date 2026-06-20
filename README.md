# ODA — Ollama Dev Agent

An autonomous, self-healing code generation agent that runs entirely locally using [Ollama](https://ollama.com). Give it a feature prompt, approve the generated plan, and it implements, tests, and reviews the code iteratively until everything passes.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture Overview](#architecture-overview)
- [The 3-Node State Machine](#the-3-node-state-machine)
- [The Ralph Loop](#the-ralph-loop)
- [The ReAct Agent Loop](#the-react-agent-loop)
- [Tools](#tools)
- [PRD System](#prd-system)
- [Persistence & State](#persistence--state)
- [Model Configuration](#model-configuration)
- [UI](#ui)
- [Environment Variables](#environment-variables)
- [CLI Usage](#cli-usage)
- [Key Files](#key-files)

---

## How It Works

```
You: "Build a kanban board API"
 ↓
Planner LLM generates a PRD with N tasks
 ↓
You approve (or reject) the plan
 ↓
For each task:
  Worker LLM implements it using tools
  Reviewer LLM evaluates the result
  → SHIP: move to next task
  → REVISE: pass feedback back to Worker, retry
 ↓
Results summary written, agent exits
```

The key design principle: the **Planner thinks big** (whole feature), the **Worker executes small** (one task), the **Reviewer enforces quality** (reject until criteria met).

---

## Architecture Overview

Built with:

- **Bun** — runtime and package manager
- **LangChain** — LLM integration and tool abstractions
- **LangGraph** — state machine orchestration
- **Ink** — React-based terminal UI
- **Commander** — CLI argument parsing
- **Ollama** — local LLM inference (no API keys required)

---

## The 3-Node State Machine

`src/agent/graph.mts`

```
START → generate_prd → run_task ↔ generate_results → END
                          ↑              ↓
                          └──────────────┘
                          (loops until all tasks done)
```

### Node 1 — `generate_prd`

- Sends your prompt to the **Planner model**
- LLM returns a structured markdown PRD with tasks (`TASK-001`, `TASK-002`, …)
- Each task includes: name, description, acceptance criteria, and a test command
- PRD is saved to `.ai/planning/<feature-slug>/prd.md`
- Phase shifts to `awaiting_approval` — UI shows the PRD and waits for your input

### Node 2 — `run_task`

- Iterates over each `Task` in order
- For each task, instantiates and runs the **Ralph Loop**
- On completion, marks the task done and advances to the next
- Loops back to itself until all tasks are complete, then transitions to results

### Node 3 — `generate_results`

- Tallies completed vs failed tasks
- Writes a markdown summary to `.ai/feature-results/<slug>/RESULTS.md`
- Emits `complete` and exits

### Agent State

```typescript
{
  userPrompt: string           // Original user request
  workingDirectory: string     // Target repo path
  prd: PRD | null              // Generated product requirements
  featureName: string          // Human-readable feature name
  featureSlug: string          // kebab-case slug
  tasks: Task[]                // Ordered task list
  currentTaskIndex: number     // Which task is running
  currentIteration: number     // Iteration count for current task
  maxIterations: number        // Cap on Ralph iterations (default: 5)
  workerOutput: string         // Last worker output
  reviewerFeedback: string     // Last reviewer decision
  lastDecision: ReviewDecision // SHIP | REVISE
  phase: AgentPhase            // Current workflow phase
  error: string | null         // Any error message
  completedTaskIds: string[]   // Accumulating list of complete task IDs
}
```

---

## The Ralph Loop

`src/ralph/loop.mts`

The core self-healing execution engine. For each task it runs up to `MAX_ITERATIONS` times:

```
Iteration N:
  ┌─ Worker  ──────────────────────────────────────┐
  │  Receives: task + acceptance criteria           │
  │            + reviewer feedback (if N > 1)       │
  │  Uses: full tool set                            │
  │  Produces: implementation                       │
  └─────────────────────────────────────────────────┘
                        ↓
  ┌─ Reviewer ─────────────────────────────────────┐
  │  Receives: task + worker output                 │
  │  Uses: read-only tools                          │
  │  Produces: SHIP or REVISE + issues list         │
  └─────────────────────────────────────────────────┘
                        ↓
              SHIP → task complete ✓
              REVISE → iteration N+1
```

**Callbacks emitted per iteration:**
- `onIterationStart(taskId, n)` — iteration begins
- `onWorkerComplete(taskId, output)` — worker finished
- `onReviewerComplete(taskId, decision)` — reviewer decision received
- `onToolCall(toolName, args)` — tool invoked by the model

**Persistence:**
Each iteration's output is saved to disk so runs can be resumed:
- `worker-N.md` — worker output from iteration N
- `reviewer-N.md` — reviewer feedback from iteration N
- `.complete` — marker file written on SHIP; presence skips the task on restart

---

## The ReAct Agent Loop

`src/models/react-agent.mts`

Both Worker and Reviewer use the **ReAct (Reason + Act)** pattern:

```
1. Call LLM with system prompt + conversation + tools
2. LLM returns:
   a) tool_calls → invoke each tool, append result to conversation
   b) final text → return (done)
3. Repeat until final answer or max steps reached
```

**Hard per-task tool call limits** prevent the model from exploring indefinitely:

| Tool | Max calls |
|---|---|
| `read_file` | 10 |
| `list_directory` | 10 |
| `run_linter` | 10 |
| `run_tests` | 10 |

Once a limit is hit, the tool returns an error message forcing the model to commit to an output rather than keep exploring.

---

## Tools

`src/tools/`

13 tools available, split between Worker (read + write) and Reviewer (read-only):

| Tool | Worker | Reviewer | Description |
|---|---|---|---|
| `file_read` | ✓ | ✓ | Read file contents |
| `file_write` | ✓ | ✗ | Write file (creates parent dirs) |
| `file_edit` | ✓ | ✗ | Replace text in file |
| `file_delete` | ✓ | ✗ | Delete a file |
| `list_directory` | ✓ | ✓ | List directory contents |
| `glob_search` | ✓ | ✓ | Find files by glob pattern (max 200) |
| `grep_search` | ✓ | ✓ | Search file contents by regex (max 100) |
| `shell_exec` | ✓ | ✓ | Run arbitrary shell command |
| `run_tests` | ✓ | ✓ | Run `bun test` (optionally a specific file) |
| `run_linter` | ✓ | ✓ | Run ESLint (with optional `--fix`) |
| `install_package` | ✓ | ✗ | Run `bun add` |
| `web_search_ddg` | ✓ | ✓ | DuckDuckGo search (no API key) |
| `web_search_brave` | ✓ | ✓ | Brave Search API (requires `BRAVE_API_KEY`) |

All tools validate paths to stay within `workingDirectory` — no filesystem escape is possible.

---

## PRD System

`src/prd/`

### Generation

```
User prompt
    ↓
Planner LLM
    ↓
Markdown PRD
    ↓
Parser (regex extraction)
    ↓
Task[] array
    ↓
Saved to .ai/planning/<slug>/prd.md
```

### PRD Format

```markdown
# PRD: Feature Name
**Feature Slug**: kebab-case-slug

## Overview
...

## Goals
- goal 1

## Technical Approach
...

## Tasks
- [ ] **TASK-001**: Task name
  - **Description**: what to implement
  - **Acceptance**: measurable criteria
  - **Test Command**: `bun test src/feature.test.mts`

## Acceptance Criteria
- criterion 1

## Out of Scope
- excluded item
```

### Task Interface

```typescript
interface Task {
  id: string               // e.g. "TASK-001"
  name: string             // Short task name
  description: string      // What to implement
  acceptanceCriteria: string
  testCommand: string      // Command used to verify (e.g. "bun test ...")
  status: 'pending' | 'in_progress' | 'complete' | 'failed'
  iterationCount: number   // How many Ralph iterations it took
}
```

---

## Persistence & State

`src/ralph/context-manager.mts`

Everything is saved to disk under `.ai/` in the working directory:

```
.ai/
  planning/<slug>/
    prd.md                          ← generated PRD
    tasks.md                        ← extracted task list
  activity/<slug>/<taskId>/
    worker-1.md                     ← worker output, iteration 1
    reviewer-1.md                   ← reviewer feedback, iteration 1
    worker-2.md                     ← worker output, iteration 2 (if REVISE)
    reviewer-2.md                   ← ...
    .complete                       ← marker: task done, skip on restart
  feature-results/<slug>/
    RESULTS.md                      ← final summary
```

On restart, any task with a `.complete` marker is skipped automatically. The agent resumes from the first incomplete task.

---

## Model Configuration

Three separate models handle three different roles:

| Role | Default Model | Responsibility |
|---|---|---|
| Planner | `qwen3.5:35b` | Generates the PRD and task breakdown |
| Worker (Coder) | `qwen3-coder:30b` | Implements each task using tools |
| Reviewer (Editor) | `devstral-small-2` | Evaluates implementation quality |

All models run locally via **Ollama** at `http://localhost:11434` with `temperature: 0` for deterministic output.

---

## UI

`src/ui/`

Built with **Ink** (React for the terminal). Displays:

1. **Header** — feature name and agent version
2. **PRD Preview** — rendered plan awaiting your approval (`Enter` to approve, `Esc` to reject)
3. **Task List** — each task with status icon and iteration count
4. **Status Bar** — current phase, active model, tool being called
5. **Spinner** — visual feedback during LLM calls

Communication between agent and UI is event-driven via `EventEmitter`:

```
Agent emits 'prd_generated'
    ↓
UI displays PRD
    ↓
User presses Enter
    ↓
UI emits 'prd_approved'
    ↓
Agent continues to run_task
```

---

## Environment Variables

All validated at startup with Zod via `src/env.mts`. Never access `Bun.env` directly in application code.

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `PLANNER_MODEL` | `qwen3.5:35b` | Model for PRD generation |
| `CODER_MODEL` | `qwen3-coder:30b` | Worker model |
| `EDITOR_MODEL` | `devstral-small-2` | Reviewer model |
| `MAX_ITERATIONS` | `5` | Max Ralph iterations per task |
| `MAX_REACT_STEPS` | `30` | Max ReAct steps per LLM call |
| `NUM_CTX` | `32768` | LLM context window size |
| `BRAVE_API_KEY` | — | Optional, for Brave Search |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `LOG_FILE` | `.oda.log` | Log output file |

---

## CLI Usage

```bash
oda <prompt> [options]

Options:
  -d, --cwd <directory>     Working directory for the agent (default: cwd)
  -i, --max-iter <number>   Max Ralph iterations per task (default: 5)
  --no-prd-review           Skip PRD approval and auto-execute
```

**Examples:**

```bash
# Generate and implement a feature interactively
oda "Add JWT authentication to the API"

# Point at a specific project
oda "Add pagination to the users endpoint" --cwd ../my-api

# Run fully automated (no approval prompt)
oda "Fix the failing tests" --no-prd-review

# Limit iterations per task
oda "Refactor the store module" --max-iter 3
```

### Running from source

If you haven't installed the `oda` binary, run directly with Bun from the project root:

```bash
# Basic usage
bun src/index.mts "your feature prompt here"

# Point at a target project directory
bun src/index.mts "build a REST API for todos" -d /path/to/target/project

# Skip PRD review (auto-approve)
bun src/index.mts "your prompt" --no-prd-review

# Custom max iterations
bun src/index.mts "your prompt" -i 5

# Watch mode (auto-restart on source changes)
bun run dev "your prompt"
```

> The `-d` flag is important — it sets the directory where code is generated. Without it, the agent defaults to the current working directory.

---

## Sample Run

### 1. Generate a PRD and implement a feature

```bash
# From source (no install required)
bun src/index.mts "Add pagination to the users endpoint" --cwd ../my-api

# Or if installed as a binary
oda "Add pagination to the users endpoint" --cwd ../my-api
```

```
$ bun src/index.mts "Add pagination to the users endpoint" --cwd ../my-api

  ODA — Ollama Dev Agent  v0.1.0

  ◆ Generating PRD...  [planner · qwen3.5:35b]

  ╔══════════════════════════════════════════════════════════════╗
  ║  PRD: Users Endpoint Pagination                              ║
  ║  Slug: users-endpoint-pagination                             ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  TASK-001  Add page/limit query params to GET /users         ║
  ║  TASK-002  Implement pagination logic in UserService         ║
  ║  TASK-003  Return pageInfo in API response shape             ║
  ║  TASK-004  Write integration tests for pagination            ║
  ╚══════════════════════════════════════════════════════════════╝

  Press Enter to approve · Esc to reject
```

### 2. Task execution — SHIP on first attempt

```
  ✓ PRD approved — starting execution

  ○ TASK-001  Add page/limit query params to GET /users
  ⠸ TASK-002  Implement pagination logic in UserService    [iter 1 · coder · qwen3-coder:30b]
  ○ TASK-003  Return pageInfo in API response shape
  ○ TASK-004  Write integration tests for pagination

  Worker › read_file(src/services/user.service.ts)
  Worker › edit_file(src/services/user.service.ts)
  Worker › run_tests(src/services/user.service.test.ts)
  Worker › run_linter()
  Reviewer › SHIP ✓
```

### 3. Task execution — REVISE then SHIP

```
  ✓ TASK-001  Add page/limit query params to GET /users     [1 iter]
  ⠸ TASK-003  Return pageInfo in API response shape         [iter 2 · coder · qwen3-coder:30b]
  ○ TASK-004  Write integration tests for pagination

  Worker › read_file(src/types/api-response.ts)
  Worker › edit_file(src/routes/users.router.ts)
  Worker › run_tests(src/routes/users.test.ts)
  Reviewer › REVISE — missing 'hasNextPage' field in pageInfo
  Worker › edit_file(src/routes/users.router.ts)
  Worker › run_tests(src/routes/users.test.ts)
  Reviewer › SHIP ✓
```

### 4. Final results

```
  ✓ TASK-001  Add page/limit query params to GET /users     [1 iter]
  ✓ TASK-002  Implement pagination logic in UserService     [1 iter]
  ✓ TASK-003  Return pageInfo in API response shape         [2 iter]
  ✓ TASK-004  Write integration tests for pagination        [1 iter]

  ════════════════════════════════════════════
  Completed  4 / 4 tasks
  Results    .ai/feature-results/users-endpoint-pagination/RESULTS.md
  ════════════════════════════════════════════
```

### 5. Debug: test PRD generation only

```bash
# Run PRD generation without the full agent UI (useful for testing your prompt)
bun debug-prd.mts
```

```
Testing PRD generation...

Prompt: Create a Kanban Board ensuring you can move cards between stages. No database persistence is required.
Working dir: ./test-run/kanban

=== PRD Generated ===
Feature: Kanban Board with Card Movement
Slug: kanban-board-card-movement
Tasks: 12

Task list:
  TASK-001: Setup Project Types & Configuration
  TASK-002: Initialize In-Memory State Store
  TASK-003: Implement Card Creation Logic
  ...
```

### 6. Resume an interrupted run

If a run is interrupted mid-task, re-run the same command. Tasks with a `.complete` marker are skipped automatically:

```
$ oda "Add pagination to the users endpoint" --cwd ../my-api

  ✓ TASK-001  (skipped — already complete)
  ✓ TASK-002  (skipped — already complete)
  ⠸ TASK-003  Resuming from last incomplete task...
```

---

## Key Files

| File | Role |
|---|---|
| `src/index.mts` | CLI entry point, UI bootstrap |
| `src/agent/graph.mts` | LangGraph 3-node state machine |
| `src/agent/state.mts` | State annotation schema |
| `src/agent/events.mts` | Agent ↔ UI EventEmitter |
| `src/ralph/loop.mts` | Ralph iteration engine |
| `src/ralph/worker.mts` | Worker LLM invocation |
| `src/ralph/reviewer.mts` | Reviewer LLM invocation |
| `src/ralph/context-manager.mts` | Disk persistence layer |
| `src/models/react-agent.mts` | ReAct loop implementation |
| `src/models/ollama-client.mts` | ChatOllama model factory |
| `src/prd/generator.mts` | PRD generation from prompt |
| `src/prd/parser.mts` | Markdown → `Task[]` extraction |
| `src/prd/prompts.mts` | System/user prompt templates |
| `src/tools/index.mts` | Tool factory (worker + reviewer sets) |
| `src/tools/*.mts` | Individual tool implementations |
| `src/env.mts` | Environment config (Zod validated) |
| `src/ui/App.tsx` | Ink terminal UI root |
| `src/types/*.mts` | Type definitions (barrel exported) |
