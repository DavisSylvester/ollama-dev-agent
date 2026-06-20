import type { StructuredTool } from '@langchain/core/tools'; // worker tools only
import type { Task, ReviewDecision } from '../types/index.mts';
import { ContextManager } from './context-manager.mts';
import { runWorker } from './worker.mts';
import { runReviewer } from './reviewer.mts';
import { runLint, type LintResult } from '../tools/run-linter.mts';
import { REACT_TIMEOUT_SENTINEL } from '../models/react-agent.mts';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { DateTime } from 'luxon';

interface RalphLoopEvents {
  onIterationStart?: (taskId: string, iteration: number) => void;
  onWorkerStart?: (taskId: string) => void;
  onWorkerComplete?: (taskId: string, output: string) => void;
  onLintComplete?: (taskId: string, clean: boolean, output: string) => void;
  onReviewerStart?: (taskId: string) => void;
  onReviewerComplete?: (taskId: string, decision: ReviewDecision) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
}

// Injected runner functions — used by tests to avoid real LLM/lint calls.
export interface RalphRunnerDeps {
  readonly workerFn?: typeof runWorker;
  readonly reviewerFn?: typeof runReviewer;
  readonly lintFn?: typeof runLint;
}

export class RalphLoop {

  private readonly contextManager: ContextManager;

  constructor(
    private readonly workingDirectory: string,
    private readonly featureSlug: string,
    private readonly featureName: string,
    private readonly maxIterations: number,
  ) {
    this.contextManager = new ContextManager(workingDirectory, featureSlug);
  }

  async runTask(
    task: Task,
    workerTools: StructuredTool[],
    events?: RalphLoopEvents,
    deps?: RalphRunnerDeps,
  ): Promise<'complete' | 'failed'> {
    const worker = deps?.workerFn ?? runWorker;
    const reviewer = deps?.reviewerFn ?? runReviewer;
    const lint = deps?.lintFn ?? runLint;

    // Short-circuit if already complete
    const alreadyComplete = await this.contextManager.isTaskComplete(task.id).catch(() => false);
    if (alreadyComplete) {
      logger.info({ taskId: task.id }, 'ralph.task_already_complete');
      task.status = 'complete';
      return 'complete';
    }

    task.status = 'in_progress';

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      logger.info(
        { taskId: task.id, iteration, maxIterations: this.maxIterations },
        'ralph.iteration_start',
      );
      events?.onIterationStart?.(task.id, iteration);

      // Load reviewer feedback and activity log from previous iterations
      let reviewerFeedback = '';
      try {
        reviewerFeedback = await this.contextManager.loadLastReviewerFeedback(task.id);
      } catch {
        reviewerFeedback = '';
      }

      let activityLog = '';
      try {
        activityLog = await this.contextManager.loadActivityLog(task.id);
      } catch {
        activityLog = '';
      }

      // --- Worker ---
      events?.onWorkerStart?.(task.id);

      const toolCallLog: Array<{ step: number; toolName: string; args: Record<string, unknown> }> = [];

      const workerStartTime = DateTime.utc().toMillis();
      let workerOutput = '';
      try {
        workerOutput = await worker({
          task,
          featureName: this.featureName,
          featureSlug: this.featureSlug,
          workingDirectory: this.workingDirectory,
          iteration,
          reviewerFeedback,
          activityLog,
          tools: workerTools,
          onToolCall: (toolName, args) => {
            toolCallLog.push({ step: toolCallLog.length + 1, toolName, args });
            events?.onToolCall?.(toolName, args);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        workerOutput = `Worker encountered an unexpected error: ${message}`;
        logger.error({ taskId: task.id, iteration, error: message }, 'ralph.worker_error');
      }
      const workerDurationMs = DateTime.utc().toMillis() - workerStartTime;

      logger.info(
        {
          taskId: task.id,
          iteration,
          durationMs: workerDurationMs,
          toolCallCount: toolCallLog.length,
          outputLength: workerOutput.length,
          timedOut: workerOutput.startsWith(REACT_TIMEOUT_SENTINEL),
        },
        'ralph.worker_complete',
      );

      events?.onWorkerComplete?.(task.id, workerOutput);

      try {
        await this.contextManager.saveWorkerOutput(
          task.id,
          iteration,
          buildWorkerDoc(task, iteration, toolCallLog, workerDurationMs, env.CODER_MODEL, workerOutput),
        );
      } catch {
        // Non-fatal: continue even if we can't persist
      }

      // --- Sentinel detection ---
      // If the worker exhausted its step budget, skip the reviewer and force
      // another iteration with targeted feedback. The worker may have left files
      // in a partial state, so it is unsafe to let the reviewer SHIP from here.
      if (workerOutput.startsWith(REACT_TIMEOUT_SENTINEL)) {
        logger.warn(
          { taskId: task.id, iteration, durationMs: workerDurationMs, toolCallCount: toolCallLog.length },
          'ralph.worker_timeout: step budget exhausted; skipping reviewer, forcing REVISE',
        );

        const timeoutFeedback = buildTimeoutFeedback(workerDurationMs, toolCallLog.length);
        const noDataReason =
          `The worker exhausted its step budget after ${formatDuration(workerDurationMs)} ` +
          `and ${toolCallLog.length} tool call(s). ` +
          `The reviewer was skipped to prevent shipping incomplete or broken code. ` +
          `See \`reviewer-${iteration}.md\` for the feedback passed to the next worker iteration.`;

        try {
          await this.contextManager.saveReviewerFeedback(task.id, iteration, timeoutFeedback);
        } catch {
          // Non-fatal
        }

        try {
          await this.contextManager.saveReviewerNoData(task.id, iteration, noDataReason);
        } catch {
          // Non-fatal
        }

        try {
          await this.contextManager.saveActivityEntry(
            task.id,
            buildActivityEntry(iteration, 'TIMED_OUT', toolCallLog, workerDurationMs, []),
          );
        } catch {
          // Non-fatal
        }

        task.iterationCount = iteration;
        // Loop to next iteration — reviewer is skipped entirely.
        continue;
      }

      // --- Mandatory lint gate ---
      // This runs unconditionally after every Worker iteration.
      // The Reviewer is NEVER called if lint has unfixable errors.
      let lintResult: LintResult;
      try {
        await lint(this.workingDirectory, true);               // auto-fix in-place
        lintResult = await lint(this.workingDirectory, false); // detect remaining errors
      } catch (err) {
        lintResult = { clean: false, output: String(err) };    // execution failure = lint failure
      }

      logger.info(
        { taskId: task.id, iteration, lintClean: lintResult.clean },
        'ralph.lint_complete',
      );

      events?.onLintComplete?.(task.id, lintResult.clean, lintResult.output);

      if (!lintResult.clean) {
        logger.warn(
          { taskId: task.id, iteration, lintErrorCount: lintResult.output.split('\n').length },
          'ralph.lint_failed: unfixable errors remain; skipping reviewer, forcing REVISE',
        );

        const lintFeedback = buildLintFeedback(lintResult.output);

        try {
          await this.contextManager.saveReviewerFeedback(task.id, iteration, lintFeedback);
        } catch {
          // Non-fatal
        }

        try {
          await this.contextManager.saveActivityEntry(
            task.id,
            buildActivityEntry(iteration, 'LINT_FAILED', toolCallLog, workerDurationMs, [lintResult.output]),
          );
        } catch {
          // Non-fatal
        }

        task.iterationCount = iteration;
        // Loop to next iteration — reviewer is skipped entirely.
        continue;
      }

      // --- Reviewer ---
      events?.onReviewerStart?.(task.id);

      let decision: ReviewDecision;
      try {
        decision = await reviewer({
          task,
          featureName: this.featureName,
          featureSlug: this.featureSlug,
          workingDirectory: this.workingDirectory,
          workerOutput,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        decision = {
          decision: 'revise',
          feedback: `Reviewer encountered an unexpected error: ${message}`,
          issues: [`Internal reviewer error: ${message}`],
        };
        logger.error({ taskId: task.id, iteration, error: message }, 'ralph.reviewer_error');
      }

      logger.info(
        { taskId: task.id, iteration, decision: decision.decision, issueCount: decision.issues.length },
        'ralph.reviewer_complete',
      );

      events?.onReviewerComplete?.(task.id, decision);

      try {
        await this.contextManager.saveReviewerFeedback(
          task.id,
          iteration,
          decision.feedback,
        );
      } catch {
        // Non-fatal: continue even if we can't persist
      }

      if (decision.decision === 'revise') {
        try {
          await this.contextManager.saveActivityEntry(
            task.id,
            buildActivityEntry(iteration, 'REVISE', toolCallLog, workerDurationMs, decision.issues),
          );
        } catch {
          // Non-fatal
        }
      }

      task.iterationCount = iteration;

      if (decision.decision === 'ship') {
        try {
          await this.contextManager.markTaskComplete(task.id);
        } catch {
          // Non-fatal
        }
        logger.info({ taskId: task.id, iteration }, 'ralph.task_complete');
        task.status = 'complete';
        return 'complete';
      }

      // decision === 'revise' — loop to next iteration
    }

    logger.warn(
      { taskId: task.id, maxIterations: this.maxIterations },
      'ralph.task_failed: max iterations exhausted',
    );
    task.status = 'failed';
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ToolCallEntry {
  readonly step: number;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function buildWorkerDoc(
  task: Task,
  iteration: number,
  toolCallLog: ToolCallEntry[],
  durationMs: number,
  model: string,
  finalOutput: string,
): string {
  const timestamp = DateTime.utc().toISO() ?? '';
  const timedOut = finalOutput.startsWith(REACT_TIMEOUT_SENTINEL);

  const header = [
    `# Worker Report — ${task.id}: ${task.name}`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Task ID | \`${task.id}\` |`,
    `| Iteration | ${iteration} |`,
    `| Timestamp | ${timestamp} |`,
    `| Duration | ${formatDuration(durationMs)} |`,
    `| Model | \`${model}\` |`,
    `| Tool calls | ${toolCallLog.length} |`,
    `| Status | ${timedOut ? '⚠ TIMED OUT (step budget exhausted)' : '✓ Completed'} |`,
    ``,
    `## Task Details`,
    ``,
    `**Description:** ${task.description}`,
    ``,
    `**Acceptance Criteria:** ${task.acceptanceCriteria}`,
    ``,
    `**Test Command:** \`${task.testCommand}\``,
  ].join('\n');

  const toolSection =
    toolCallLog.length === 0
      ? `## Tool Calls\n\n_No tools called._`
      : [
          `## Tool Calls`,
          ``,
          ...toolCallLog.map((entry) => {
            const argsText =
              Object.keys(entry.args).length === 0
                ? '_no args_'
                : '```json\n' + JSON.stringify(entry.args, null, 2) + '\n```';
            return [
              `### Step ${entry.step} — \`${entry.toolName}\``,
              ``,
              argsText,
            ].join('\n');
          }),
        ].join('\n\n');

  const outputSection = [
    `## Final Output`,
    ``,
    finalOutput.trim() || '_No output produced._',
  ].join('\n');

  return [header, toolSection, outputSection].join('\n\n---\n\n');
}

function summarizeToolCalls(log: ToolCallEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of log) {
    counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => `${name} (${count}x)`).join(', ');
}

function buildActivityEntry(
  iteration: number,
  status: 'TIMED_OUT' | 'REVISE' | 'LINT_FAILED',
  toolCallLog: ToolCallEntry[],
  durationMs: number,
  issues: readonly string[],
): string {
  const timestamp = DateTime.utc().toISO() ?? '';
  const toolSummary = summarizeToolCalls(toolCallLog);

  const statusLabel = status === 'TIMED_OUT' ? 'TIMED OUT' : status === 'LINT_FAILED' ? 'LINT FAILED' : 'REVISE';

  const lines: string[] = [
    `## Iteration ${iteration} — ${statusLabel}`,
    ``,
    `- **Timestamp**: ${timestamp}`,
    `- **Duration**: ${formatDuration(durationMs)}`,
    `- **Tool calls**: ${toolCallLog.length} total${toolSummary ? ` (${toolSummary})` : ''}`,
  ];

  if (status === 'TIMED_OUT') {
    lines.push(`- **Outcome**: Step budget exhausted — implementation was incomplete`);
    lines.push(`- **Action required**: Skip all exploration already done; write files immediately`);
  }

  if (status === 'LINT_FAILED') {
    lines.push(`- **Outcome**: ESLint found unfixable errors after auto-fix`);
    lines.push(`- **Action required**: Review lint errors and fix violations`);
  }

  if (issues.length > 0) {
    const sectionLabel = status === 'LINT_FAILED' ? 'Lint errors' : 'Reviewer issues';
    lines.push(`- **${sectionLabel}**:`);
    for (const issue of issues) {
      lines.push(`  - ${issue}`);
    }
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

function buildTimeoutFeedback(durationMs: number, toolCallCount: number): string {
  return [
    `## ⚠ Worker Timed Out`,
    ``,
    `The previous attempt exhausted its step budget after ${formatDuration(durationMs)} and ${toolCallCount} tool calls.`,
    `The reviewer was **skipped** — the implementation may be incomplete or broken.`,
    ``,
    `## Instructions for Next Attempt`,
    ``,
    `- Call \`list_directory\` **at most once** at the very start`,
    `- Do NOT re-read files you have already seen this iteration`,
    `- Begin writing implementation files **immediately** after your initial survey`,
    `- Run the test command **only after** all files are written`,
    `- Do not call the same tool more than 2–3 times total`,
    `- If the directory is already populated from a previous attempt, skip exploration entirely and go straight to verification`,
  ].join('\n');
}

function buildLintFeedback(lintOutput: string): string {
  return [
    `## 🔴 ESLint Validation Failed`,
    ``,
    `The previous implementation has unfixable ESLint errors. Auto-fix was attempted but some violations remain.`,
    `You **must** fix all of the errors listed below before the task can be approved.`,
    ``,
    `## ESLint Output`,
    ``,
    `\`\`\``,
    lintOutput.trim(),
    `\`\`\``,
    ``,
    `## Instructions for Next Attempt`,
    ``,
    `- Read the error messages above carefully`,
    `- Fix each violation in the source files`,
    `- Run the test command to verify your changes do not break functionality`,
    `- Do not re-read files unnecessarily — use your context from this iteration`,
  ].join('\n');
}
