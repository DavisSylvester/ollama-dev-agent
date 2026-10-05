# Agent ↔ Orchestrator Sequence

How the LangGraph orchestrator (`src/agent/graph.mts`) drives the per-task
Ralph loop (`src/ralph/loop.mts`), which in turn runs the Worker (ReAct agent,
`CODER_MODEL`) and the Reviewer (`EDITOR_MODEL`) against Ollama. Every step
reports to the Ink TUI through the `agentEvents` bus (`src/agent/events.mts`).

## Participants

| Participant  | Source                              | Role |
|--------------|-------------------------------------|------|
| TUI          | `src/index.mts`, `src/ui/`          | Starts the run, renders `agentEvents` (feed, progress board) |
| Orchestrator | `src/agent/graph.mts`               | LangGraph: `draft_plan → size_plan → ratify_plan → run_task ⟲ → generate_results` |
| PRD / Sizer  | `src/prd/`                          | PRD generation, task sizing + debate, auto-split on failure |
| RalphLoop    | `src/ralph/loop.mts`                | Worker → lint gate → Reviewer loop, up to `maxIterations` per task |
| Context      | `src/ralph/context-manager.mts`     | On-disk activity log, reviewer feedback, checklists, completion markers |
| Worker       | `src/ralph/worker.mts`              | ReAct agent with file/shell/test/lint tools + knowledge base |
| Lint         | `src/tools/run-linter.mts`          | ESLint fix + check, scoped to files this iteration changed |
| Reviewer     | `src/ralph/reviewer.mts`            | Returns `ship` / `revise` with issues and AC checklist |
| KB           | `src/knowledge-base/`               | Global issue → resolution records read by the Worker |

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant TUI as TUI (Ink)
    participant Orch as Orchestrator<br/>(LangGraph)
    participant PRD as PRD / Sizer
    participant Ralph as RalphLoop
    participant Ctx as ContextManager
    participant Worker as Worker<br/>(ReAct, CODER_MODEL)
    participant Lint as Lint gate
    participant Rev as Reviewer<br/>(EDITOR_MODEL)
    participant KB as Knowledge Base

    User->>TUI: prompt (+ --prd-file / --docs-dir)
    TUI->>Orch: agent.run(prompt)

    %% ---------- planning ----------
    rect rgba(120,120,200,0.12)
    Note over Orch,PRD: draft_plan (skipped on resume or pre-loaded PRD)
    Orch-->>TUI: phase_changed: generating_prd
    Orch->>PRD: generatePRD / generatePRDFromDocs
    PRD-->>Orch: PRD + ordered tasks
    Orch-->>TUI: prd_generated
    opt --prd-review
        TUI-->>User: show PRD
        User->>TUI: approve / reject
        TUI->>Orch: uiEvents: prd_approved / prd_rejected
    end

    Note over Orch,PRD: size_plan
    Orch->>PRD: sizePlan(tasks, onEvent)
    PRD-->>TUI: sizing_started / task_sized / debate events
    alt oversized task can't be split
        PRD-->>Orch: SizeGateError
        Orch-->>TUI: error (run aborts)
    else plan fits
        PRD-->>Orch: sized + split tasks
        Orch->>Orch: write SIZING.md, saveRunState
        Orch-->>TUI: plan_sized
    end

    Note over Orch: ratify_plan (Phase A pass-through)
    end

    %% ---------- execution ----------
    loop run_task: while any task is pending or in_progress
        Orch->>Orch: findReadyTasks (pending, all dependsOn complete)
        alt nothing ready but tasks still pending
            Orch-->>TUI: task_failed ("Blocked by a failed dependency")
        else ready batch
            Orch-->>TUI: task_started (one per task)
            par each ready task runs in parallel
                Orch->>Ralph: new RalphLoop(...).runTask(task, workerTools, events)
                Ralph->>Ctx: isTaskComplete? / saveTaskGoal
                loop iteration = 1..maxIterations
                    Ralph-->>TUI: iteration_started
                    Ralph->>Ctx: loadLastReviewerFeedback + loadActivityLog
                    Ralph->>Worker: runWorker(task, feedback, activityLog, tools)
                    Worker->>KB: loadKnowledgeBase (filtered by task category)
                    Worker->>Worker: ReAct steps (read/write/edit files, shell, tests)
                    Worker-->>TUI: tool_called (per tool call)
                    Worker-->>Ralph: output (or step-budget timeout sentinel)
                    Ralph-->>TUI: worker_output

                    alt worker timed out
                        Ralph->>Ctx: save timeout feedback + TIMED_OUT activity
                        Ralph->>KB: log issue
                        Note right of Ralph: skip Reviewer, force REVISE
                    else worker finished
                        Ralph->>Lint: lint(fix) then lint(check) on changed files
                        Lint-->>Ralph: clean / errors
                        Ralph-->>TUI: lint_complete
                        alt lint errors remain
                            Ralph->>Ctx: save lint feedback + LINT_FAILED activity
                            Ralph->>KB: log issue
                            Note right of Ralph: skip Reviewer, force REVISE
                        else lint clean
                            Ralph->>Rev: runReviewer(task, workerOutput, files)
                            Rev-->>Ralph: decision (ship / revise, issues, checklist)
                            Ralph-->>TUI: reviewer_decision
                            Ralph->>Ctx: saveReviewerFeedback + saveChecklist
                            alt revise
                                Ralph->>Ctx: REVISE activity entry
                                Ralph->>KB: log issue
                            else ship
                                Ralph->>Ctx: markTaskComplete
                                opt task had logged issues
                                    Ralph->>KB: log "resolved" with the exact fix
                                end
                                Ralph-->>Orch: 'complete'
                            end
                        end
                    end
                end
                opt max iterations hit without ship
                    Ralph->>KB: log "failed" (unresolved)
                    Ralph-->>Orch: 'failed'
                end
            end
            Orch-->>TUI: task_complete / task_failed

            opt a task failed and can be split
                Orch->>PRD: splitTask(failed, failureContext) → sizePlan(subTasks)
                PRD-->>Orch: subtasks (replace failed task as pending)
                Orch-->>TUI: task_split
            end
            Orch->>Orch: saveRunState (state.json)
        end
        Orch->>Orch: routeAfterTask → run_task or generate_results
    end

    %% ---------- results ----------
    Note over Orch: generate_results
    Orch-->>TUI: phase_changed: generating_results
    Orch->>Orch: write results summary under feature-results/{featureSlug}/
    Orch-->>TUI: results_generated, complete
    TUI-->>User: final summary
```

## Notes

- **Two event buses.** `agentEvents` carries Agent → UI traffic (dashed arrows
  to the TUI above). `uiEvents` carries UI → Agent input, today only PRD
  approval.
- **The Reviewer only sees code that compiled through the lint gate and came
  from a Worker that finished within its step budget.** A timeout or unfixable
  lint error forces another iteration with targeted feedback instead.
- **State lives on disk.** Each iteration re-reads the last reviewer feedback
  and the activity log through `ContextManager`, so a new Worker starts with
  the history of prior attempts. `saveRunState` after sizing and after every
  batch makes the run resumable.
- **Parallelism is per batch.** All ready tasks in a batch run concurrently;
  the next batch starts only after the whole batch settles.
