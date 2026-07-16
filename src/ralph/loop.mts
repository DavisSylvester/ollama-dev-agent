import type { StructuredTool } from '@langchain/core/tools'; // worker tools only
import type { Task, ReviewDecision } from '../types/index.mts';
import { ContextManager } from './context-manager.mts';
import { runWorker } from './worker.mts';
import { runReviewer } from './reviewer.mts';
import { runLint, type LintResult } from '../tools/run-linter.mts';
import { REACT_TIMEOUT_SENTINEL } from '../models/react-agent.mts';
import { appendEntry, categorizeTask, generalizePrompt, generalizeText } from '../knowledge-base/index.mts';
import { isTransientOllamaError } from '../models/index.mts';
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

    // Always record the task's goal so the activity folder is self-explanatory.
    try {
      await this.contextManager.saveTaskGoal(task);
    } catch {
      // Non-fatal
    }

    // Count of issues logged across iterations so we can record a final
    // "resolved" marker on SHIP only when the task actually struggled.
    let issuesLogged = 0;

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

      // --- Anti-pattern detection ---
      // Catch inefficient tool loops within a single iteration (e.g. re-running
      // run_tests repeatedly without converging) and log them to the KB so the
      // worker learns to break the loop next time.
      for (const thrash of detectToolThrash(toolCallLog)) {
        logger.warn({ taskId: task.id, iteration, thrash }, 'ralph.tool_thrash');
        await this.logIssue(task, thrash.issue, thrash.resolution, iteration, 'anti-pattern');
        issuesLogged++;
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

        await this.logIssue(
          task,
          `Worker timed out on iteration ${iteration} (exhausted ${env.MAX_REACT_STEPS}-step budget)`,
          'Break the work into fewer, larger writes. Write all files immediately after a minimal survey, then run the test command once. Do not re-explore or re-read files.',
          iteration,
          'timeout',
        );
        issuesLogged++;
        task.iterationCount = iteration;
        // Loop to next iteration — reviewer is skipped entirely.
        continue;
      }

      // --- Mandatory lint gate ---
      // This runs unconditionally after every Worker iteration.
      // The Reviewer is NEVER called if lint has unfixable errors.
      // Scope the lint to the files THIS worker wrote/edited this iteration, so
      // parallel tasks aren't held responsible for each other's lint state.
      const changedFiles = extractChangedFiles(toolCallLog);
      let lintResult: LintResult;
      try {
        await lint(this.workingDirectory, true, changedFiles);               // auto-fix in-place
        lintResult = await lint(this.workingDirectory, false, changedFiles); // detect remaining errors
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

        await this.logIssue(
          task,
          `Lint failed on iteration ${iteration} — ${firstLine(lintResult.output)}`,
          `Fix the ESLint violations:\n${lintResult.output.slice(0, 600)}`,
          iteration,
          'lint',
          // Generalized lesson: the recurring ESLint rule classes, not the specific files.
          `Run ESLint and fix all violations before finishing. Common classes: remove unused imports/vars, use \`import type\` for type-only imports, add explicit return types, and use the project's required file extension on imports.`,
        );
        issuesLogged++;
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

      // Persist the pre-completion checklist (per-acceptance-criterion verdicts).
      if (decision.checklist && decision.checklist.length > 0) {
        try {
          await this.contextManager.saveChecklist(task.id, iteration, decision.checklist);
        } catch {
          // Non-fatal
        }
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
        await this.logIssue(
          task,
          `Reviewer requested changes on iteration ${iteration}`,
          decision.issues.length > 0 ? decision.issues.join('\n') : decision.feedback,
          iteration,
          'revise',
        );
        issuesLogged++;
      }

      task.iterationCount = iteration;

      if (decision.decision === 'ship') {
        try {
          await this.contextManager.markTaskComplete(task.id);
        } catch {
          // Non-fatal
        }
        logger.info({ taskId: task.id, iteration }, 'ralph.task_complete');
        // Record the EXACT fix that resolved the task: the files changed in the
        // shipping iteration plus the worker's own summary of what it did.
        if (issuesLogged > 0) {
          const changed = extractChangedFiles(toolCallLog);
          const filesLine = changed.length > 0 ? `Files changed: ${changed.join(', ')}\n\n` : '';
          const exactFix = `${filesLine}${workerOutput.trim()}`.slice(0, 2000);
          await this.logIssue(
            task,
            `Resolved after ${issuesLogged} issue(s) over ${iteration} iteration(s)`,
            exactFix,
            iteration,
            'resolved',
          );
        }
        task.status = 'complete';
        return 'complete';
      }

      // decision === 'revise' — loop to next iteration
    }

    logger.warn(
      { taskId: task.id, maxIterations: this.maxIterations },
      'ralph.task_failed: max iterations exhausted',
    );
    // Record the unresolved failure so future runs know this is a hard problem.
    await this.logIssue(
      task,
      `Task failed: hit the ${this.maxIterations}-iteration cap without shipping`,
      'UNRESOLVED — exceeded max iterations. Consider a larger ReAct step budget (--max-react-steps) or splitting the task.',
      this.maxIterations,
      'failed',
    );
    task.status = 'failed';
    return 'failed';
  }

  // Append ONE issue → resolution record to the global knowledge base, flushed
  // immediately so nothing is lost on long or interrupted runs.
  // All path-like strings are relativized — the KB NEVER stores absolute paths.
  // Records both the actual (run-specific) and generalized (reusable) text.
  // `generalizedResolution` defaults to a stripped-down version of the actual.
  private async logIssue(
    task: Task,
    issue: string,
    actualResolution: string,
    iteration: number,
    status: string,
    generalizedResolution?: string,
  ): Promise<void> {
    // A transient connectivity/infra failure (a dropped Ollama call, lint
    // tooling crashing) is noise, not a reusable lesson — recording it pollutes
    // the KB the worker reads. With 3.6's retry, these rarely reach here anyway.
    if (isTransientOllamaError(new Error(`${issue}\n${actualResolution}`))) {
      logger.debug({ taskId: task.id, status }, 'kb.skip_transient_issue');
      return;
    }

    const wd = this.workingDirectory;
    const relResolution = toRelativePaths(actualResolution, wd);
    const generalized = generalizedResolution
      ? toRelativePaths(generalizedResolution, wd)
      : generalizeText(relResolution);
    const category = categorizeTask(task);

    await appendEntry(category, {
      issue: toRelativePaths(issue, wd),
      actual_prompt: toRelativePaths(`${task.name}: ${task.description}`, wd),
      actual_resolution: relResolution,
      generalized_prompt: generalizePrompt(category),
      generalized_resolution: generalized,
      model: env.CODER_MODEL,
      metadata: {
        taskId: task.id,
        iterations: iteration,
        status,
        timestamp: DateTime.utc().toISO() ?? '',
        featureSlug: this.featureSlug,
      },
    });
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

// Collect the distinct file paths the worker wrote or edited this iteration,
// so the lint gate can be scoped to exactly those files.
function extractChangedFiles(log: ToolCallEntry[]): string[] {
  const files = new Set<string>();
  for (const entry of log) {
    if (entry.toolName === 'write_file' || entry.toolName === 'edit_file') {
      const path = entry.args['path'];
      if (typeof path === 'string' && path.length > 0) {
        files.add(path);
      }
    }
  }
  return [...files];
}

// Strip the absolute working-directory prefix from any path in `text`, leaving
// project-relative paths. Handles both / and \ separators (Windows tooling like
// ESLint emits backslash absolute paths). The knowledge base must NEVER store
// absolute paths, so every KB write passes through this.
export function toRelativePaths(text: string, workingDirectory: string): string {
  if (!text || !workingDirectory) return text;
  // Try both separator normalizations of the working dir.
  const variants = new Set<string>([
    workingDirectory,
    workingDirectory.replace(/\\/g, '/'),
    workingDirectory.replace(/\//g, '\\'),
  ]);
  let out = text;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Remove the prefix plus any leading separator so "<wd>/apps/x" → "apps/x".
    out = out.replace(new RegExp(`${escaped}[\\\\/]?`, 'g'), '');
  }
  return out;
}

// First non-empty line of multi-line tool output, trimmed for KB summaries.
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? text).slice(0, 200);
}

interface ThrashIssue {
  readonly issue: string;
  readonly resolution: string;
}

// Per-tool thresholds above which repeated calls in ONE iteration signal the
// worker is looping (re-running/re-reading) rather than converging. write_file
// and edit_file are excluded — writing many files in one pass is legitimate.
const THRASH_THRESHOLDS: Record<string, number> = {
  run_tests: 4,
  run_linter: 4,
  read_file: 8,
  list_directory: 4,
  glob_search: 5,
  grep_search: 5,
  shell_exec: 6,
};

const THRASH_GUIDANCE: Record<string, string> = {
  run_tests: 'Make one targeted fix based on the failure, then run the test command once. Do not re-run tests to re-read the same failure.',
  run_linter: 'Fix all reported violations in one pass, then run the linter once to confirm.',
  read_file: 'You already have these files in context — use them from memory instead of re-reading.',
  list_directory: 'The directory structure is already known — stop listing and start writing.',
};

// A single file rewritten this many times in one iteration signals a doom loop.
const FILE_EDIT_THRESHOLD = 4;

// Detect tool-call loops within a single iteration's tool log: both per-tool
// (re-running/re-reading) and per-file (rewriting the same file repeatedly).
function detectToolThrash(log: ToolCallEntry[]): ThrashIssue[] {
  const counts = new Map<string, number>();
  const fileEdits = new Map<string, number>();
  for (const entry of log) {
    counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
    if (entry.toolName === 'write_file' || entry.toolName === 'edit_file') {
      const path = entry.args['path'];
      if (typeof path === 'string' && path.length > 0) {
        fileEdits.set(path, (fileEdits.get(path) ?? 0) + 1);
      }
    }
  }

  const issues: ThrashIssue[] = [];

  // Per-tool thrash (verification/exploration loops).
  for (const [tool, count] of counts) {
    const threshold = THRASH_THRESHOLDS[tool];
    if (threshold !== undefined && count >= threshold) {
      issues.push({
        issue: `Worker called ${tool} ${count} times in a single iteration without converging`,
        resolution:
          THRASH_GUIDANCE[tool] ??
          `Avoid calling ${tool} repeatedly in one iteration — make a decision and move on.`,
      });
    }
  }

  // Per-file edit loop (rewriting the same file over and over).
  for (const [path, count] of fileEdits) {
    if (count >= FILE_EDIT_THRESHOLD) {
      issues.push({
        issue: `Worker edited the same file (${path}) ${count} times in a single iteration`,
        resolution:
          `Stop rewriting ${path}. Re-read the failing test/error, decide the correct final content, ` +
          `and write it once. Repeated edits to one file mean the approach needs rethinking, not another tweak.`,
      });
    }
  }

  return issues;
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
