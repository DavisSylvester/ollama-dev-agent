# PRD: ODA — Ollama Dev Agent

**Version**: 0.1.0
**Status**: Active
**Owner**: Davis Sylvester
**Date**: 2026-03-20

---

## Overview

ODA is a local, autonomous software engineering CLI agent powered by [Ollama](https://ollama.ai). It operates like Claude Code but runs entirely on local hardware using open-source models. Given a natural-language prompt, ODA generates a PRD, breaks it into tasks, and executes those tasks in a self-healing Ralph loop until the feature is complete.

---

## Goals

- Provide a one-shot CLI agent that accepts a prompt and autonomously produces working code
- Use a sequential model pipeline: Planner (qwen3.5:35b) → Coder (qwen3-coder:30b) → Reviewer (devstral-small-2)
- Implement the Ralph loop pattern: Worker implements → Reviewer evaluates → SHIP or REVISE → repeat
- Document all planning, decisions, and activity in `.ai/` subfolders
- Store feature output artifacts in `feature-results/<feature-name>/`
- Provide a rich Ink-based terminal UI
- Be self-healing: automatically detect and fix errors (lint, tests, type errors) within the Worker loop

---

## User Persona

**Solo Developer / Power User** who wants to automate complex feature development without relying on cloud AI services. They have an Ollama instance running (local or network), a working directory for a project, and they want to run one command and come back to working code.

---

## Technical Approach

### Models

| Role | Model | Purpose |
|------|-------|---------|
| Planner | `qwen3.5:35b` | Generates PRD, extracts tasks, reasons about architecture |
| Coder (Worker) | `qwen3-coder:30b` | Implements code, uses tools, runs tests, self-heals |
| Editor (Reviewer) | `devstral-small-2` | Reviews completed work, decides SHIP or REVISE |

Models are called **sequentially**: Planner first, then Worker/Reviewer in the Ralph loop.

### Ralph Loop Pattern

```
User Prompt
  └─> Planner: Generate PRD
  └─> User Reviews & Approves PRD
  └─> For Each Task:
        └─> Worker (Coder): Implement task with tools
              └─> run_tests, run_lint (self-heal inline)
        └─> Reviewer (Editor): Evaluate implementation
              └─> Decision: SHIP or REVISE
              └─> REVISE: save feedback → fresh context → Worker again (max 5)
              └─> SHIP: save results → next task
  └─> Generate feature-results/<feature>/
```

### LangGraph Graph

```
START → planner_node → [human approval] → task_loop_node → results_node → END

task_loop_node (conditional):
  - run_worker → run_reviewer → decide
  - ship   → advance_task → (more tasks? task_loop_node : results_node)
  - revise → increment_iteration → (< max_iter? run_worker : advance_task)
```

### Tool Set

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write/create a file |
| `edit_file` | Replace text in an existing file |
| `delete_file` | Delete a file |
| `list_directory` | List directory contents |
| `glob_search` | Find files by glob pattern |
| `grep_search` | Search file content by regex |
| `shell_exec` | Run arbitrary shell commands (scoped to working dir) |
| `run_tests` | Execute `bun test` and return results |
| `run_linter` | Execute ESLint and return results |
| `install_package` | Run `bun add <packages>` |
| `web_search_ddg` | DuckDuckGo web search |
| `web_search_brave` | Brave Search API |

All file and shell tools are **scoped to the working directory**. Paths escaping the working directory are rejected.

### CLI

```bash
# One-shot usage
oda "Generate me a wrapper library in BunJS that wraps all functions of Auth0 SDK"

# With working directory
oda --cwd /path/to/project "Add authentication to this Express app"

# With max iterations override
oda --max-iter 3 "Create unit tests for the users module"
```

### UI (Ink)

A rich terminal UI shows:
- Current phase (Generating PRD / Executing Tasks / Complete)
- Task list with status indicators (pending ○ / in-progress ⠸ / complete ✓ / failed ✗)
- Current iteration and model in use
- Live streamed worker/reviewer output
- Final summary with artifact paths

---

## Folder Structure

```
<working-directory>/
├── .ai/
│   ├── planning/<feature-name>/
│   │   ├── prd.md
│   │   └── tasks.md
│   ├── decisions/<feature-name>/
│   │   └── decisions.md
│   └── activity/<feature-name>/
│       └── <task-id>/
│           ├── worker-1.md
│           ├── reviewer-1.md
│           ├── worker-2.md          (if revised)
│           ├── reviewer-2.md
│           └── .complete            (marker file)
└── feature-results/
    └── <feature-name>/
        └── (generated code / artifacts)
```

---

## Tasks

### Phase 1: Foundation

- [ ] **TASK-001**: Project setup and infrastructure
  - **Description**: Configure package.json, tsconfig.json, ESLint. Create all directory scaffolding.
  - **Acceptance**: `bun install` succeeds; TypeScript compiles with no errors; `bun test` runs
  - **Test Command**: `bun run tsc --noEmit && bun test`

- [ ] **TASK-002**: Environment and logging
  - **Description**: Create typed `env.mts` (Zod-validated), structured logger with pino
  - **Acceptance**: All env vars typed; logger writes structured JSON
  - **Test Command**: `bun test tests/unit/env.test.mts`

- [ ] **TASK-003**: Type definitions
  - **Description**: Define all TypeScript interfaces: `AgentState`, `Task`, `PRD`, `ToolResult`, `RalphIteration`, `ReviewDecision`
  - **Acceptance**: Types exported from barrel, no `any` usage
  - **Test Command**: `bun run tsc --noEmit`

### Phase 2: Tools

- [ ] **TASK-004**: File system tools
  - **Description**: Implement `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`. All scoped to working directory via path validation.
  - **Acceptance**: All tools reject paths outside working dir; file operations work
  - **Test Command**: `bun test tests/unit/tools.test.mts`

- [ ] **TASK-005**: Search tools
  - **Description**: Implement `glob_search`, `grep_search`
  - **Acceptance**: Glob patterns work; grep returns matching lines with line numbers
  - **Test Command**: `bun test tests/unit/tools.test.mts`

- [ ] **TASK-006**: Execution tools
  - **Description**: Implement `shell_exec`, `run_tests`, `run_linter`, `install_package`
  - **Acceptance**: Commands run in working directory; output captured; errors returned as tool result (not thrown)
  - **Test Command**: `bun test tests/unit/tools.test.mts`

- [ ] **TASK-007**: Web search tools
  - **Description**: Implement `web_search_ddg` (DuckDuckGo HTML scrape) and `web_search_brave` (Brave Search API)
  - **Acceptance**: DDG works without API key; Brave works with `BRAVE_API_KEY`; both return structured results
  - **Test Command**: `bun test tests/unit/tools.test.mts`

### Phase 3: Models

- [ ] **TASK-008**: Ollama model wrappers
  - **Description**: Create `planner-model.mts`, `coder-model.mts`, `editor-model.mts` wrapping `ChatOllama`. Implement `runReactAgent` helper.
  - **Acceptance**: Models connect to configured Ollama URL; tool calling works
  - **Test Command**: `bun test tests/unit/models.test.mts`

### Phase 4: PRD System

- [ ] **TASK-009**: PRD generator
  - **Description**: Use Planner model to generate a structured PRD from a user prompt. Save to `.ai/planning/<feature>/prd.md`.
  - **Acceptance**: Generated PRD contains Overview, Goals, Tasks with checkboxes, Acceptance Criteria
  - **Test Command**: `bun test tests/unit/prd-parser.test.mts`

- [ ] **TASK-010**: PRD parser and task extractor
  - **Description**: Parse PRD markdown to extract `Task[]` with IDs, names, descriptions, acceptance criteria, and test commands
  - **Acceptance**: All checkbox tasks extracted; task IDs normalized; checkboxes updated to `[x]` on completion
  - **Test Command**: `bun test tests/unit/prd-parser.test.mts`

### Phase 5: Ralph Loop

- [ ] **TASK-011**: Context manager
  - **Description**: Manage `.ai/activity/<feature>/<task>/` files. Save/load worker prompts, reviewer feedback, iteration markers.
  - **Acceptance**: Files saved with correct naming; `.complete` marker detected; history readable
  - **Test Command**: `bun test tests/unit/context-manager.test.mts`

- [ ] **TASK-012**: Worker agent
  - **Description**: Implement Worker using Coder model + all tools. Worker builds task context from PRD, previous feedback, iteration number. Runs until tests pass.
  - **Acceptance**: Worker runs ReAct loop; uses tools; self-heals on test failure; saves output to context manager
  - **Test Command**: `bun test tests/integration/ralph-loop.test.mts`

- [ ] **TASK-013**: Reviewer agent
  - **Description**: Implement Reviewer using Editor model + read-only tools. Evaluates Worker output against task acceptance criteria. Returns structured `ReviewDecision`.
  - **Acceptance**: Reviewer outputs `{ decision: 'ship' | 'revise', feedback: string, issues: string[] }`
  - **Test Command**: `bun test tests/integration/ralph-loop.test.mts`

- [ ] **TASK-014**: Ralph loop orchestrator
  - **Description**: Coordinate Worker/Reviewer cycle per task. Track iterations, enforce max limit, save history.
  - **Acceptance**: Loop runs up to `MAX_ITERATIONS` (default 5); SHIP advances task; REVISE restarts worker with fresh context
  - **Test Command**: `bun test tests/integration/ralph-loop.test.mts`

### Phase 6: LangGraph Agent

- [ ] **TASK-015**: Agent state and graph
  - **Description**: Define `AgentState` with LangGraph `Annotation.Root`. Build `StateGraph` with nodes: `planner`, `task_runner`, `reviewer`, `results`. Wire edges and conditional routing.
  - **Acceptance**: Graph compiles; nodes transition correctly; state persisted between nodes
  - **Test Command**: `bun test tests/integration/agent.test.mts`

### Phase 7: UI

- [ ] **TASK-016**: Ink UI components
  - **Description**: Build `Header`, `TaskList`, `IterationStatus`, `StatusBar` Ink components. Implement event bus to receive agent updates.
  - **Acceptance**: UI renders without errors; updates reactively as events fire; PRD preview renders correctly
  - **Test Command**: Visual inspection

### Phase 8: CLI Entry

- [ ] **TASK-017**: CLI entry point
  - **Description**: `src/index.mts` with `commander` for arg parsing. Start Ink app. Wire agent to UI events. Handle PRD approval flow.
  - **Acceptance**: `bun src/index.mts "prompt"` runs end-to-end; PRD shown before execution; results saved on completion
  - **Test Command**: `bun src/index.mts "Create a hello world function"`

---

## Acceptance Criteria

- [ ] `bun src/index.mts "Generate me a wrapper library in BunJS that wraps all functions of Auth0 SDK for users, organizations, and B2C and M2M"` produces a working library in `feature-results/auth0-wrapper-library/`
- [ ] PRD is displayed and requires user approval before execution begins
- [ ] Each task runs the Ralph loop (Worker → Reviewer → SHIP/REVISE)
- [ ] All tools are scoped to the working directory
- [ ] `.ai/activity/` contains iteration history for every task
- [ ] `bun test` passes all unit and integration tests
- [ ] No `any` types in codebase
- [ ] ESLint passes with zero errors

---

## Out of Scope (v0.1)

- Multi-project/concurrent agent runs
- Web browser automation
- Git operations (commit, branch, PR)
- Cloud model providers
- Resume interrupted runs (checkpoint/recovery)
- Interactive PRD editing (edit → re-generate)
- Plugin system for custom tools
