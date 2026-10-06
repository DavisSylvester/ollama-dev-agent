import type { Task, ReviewDecision, ChecklistItem } from '../types/index.mts';
import { createChatModel, ThinkingBudgetExceededError, watchModel, withOllamaRetry } from '../models/index.mts';
import { SystemMessage, HumanMessage, type AIMessage } from '@langchain/core/messages';
import { buildReviewerPrompt } from '../prd/index.mts';
import { getDependencyReport, summarizeForPrompt } from '../deps/dependency-preflight.mts';
import { playbookSectionFor } from '../playbooks/load-playbooks.mts';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { isAbsolute, relative, resolve } from 'node:path';

interface ReviewerParams {
  readonly task: Task;
  readonly featureName: string;
  readonly featureSlug: string;
  readonly workingDirectory: string;
  readonly workerOutput: string;
  // Files the worker wrote or edited this iteration (from its tool calls).
  // Loaded first: they are exactly what changed, unlike paths guessed from
  // the worker's prose summary.
  readonly changedFiles?: readonly string[];
}

const MAX_REVIEWER_DECISION_RETRIES = 2;

// A real decision line: "DECISION: SHIP" or "DECISION: REVISE", but not the
// prompt template being echoed back ("DECISION: SHIP | REVISE", "SHIP or REVISE").
const DECISION_LINE = /DECISION:\s*\**\s*(SHIP|REVISE)\b(?!\s*(?:\||\/|or\b))/gi;

/**
 * The reviewer's final decision: the LAST real DECISION line in the reply.
 * Earlier matches may be quoted instructions or a changed mind; matching the
 * first SHIP anywhere let an echoed template ship unreviewed work.
 */
export function finalDecision(response: string): { decision: 'ship' | 'revise'; index: number } | null {
  let last: { decision: 'ship' | 'revise'; index: number } | null = null;
  for (const match of response.matchAll(DECISION_LINE)) {
    const word = match[1]?.toLowerCase();
    if (word === 'ship' || word === 'revise') last = { decision: word, index: match.index };
  }
  return last;
}

function hasDecision(response: string): boolean {
  return finalDecision(response) !== null;
}

// After a review the model spent thinking without writing anything, ask for
// the verdict directly instead of repeating the same request.
export function withReviewNudge(
  messages: readonly (SystemMessage | HumanMessage)[],
  lastError: unknown,
): (SystemMessage | HumanMessage)[] {
  if (!(lastError instanceof ThinkingBudgetExceededError)) return [...messages];
  return [
    ...messages,
    new HumanMessage(
      'You spent too long deliberating. Check the acceptance criteria against the work ' +
      'as it stands and write your review and DECISION line now.',
    ),
  ];
}

async function invokeReviewerWithRetry(
  model: ReturnType<typeof createChatModel>,
  systemPrompt: string,
  userPrompt: string,
  taskId: string,
): Promise<string> {
  const baseMessages: [SystemMessage, HumanMessage] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

  const firstMessage = (await withOllamaRetry(
    ({ lastError }) => model.invoke(withReviewNudge(baseMessages, lastError)),
    { label: 'reviewer.invoke', ...watchModel(model) },
  )) as AIMessage;
  let response = extractContent(firstMessage);

  for (let retry = 0; retry < MAX_REVIEWER_DECISION_RETRIES && !hasDecision(response); retry++) {
    logger.warn(
      { taskId, retry: retry + 1, responseLength: response.length },
      'reviewer.missing_decision_retry',
    );
    const retryMessage = (await withOllamaRetry(
      () =>
        model.invoke([
          ...baseMessages,
          firstMessage,
          new HumanMessage(
            'Your response is missing the required DECISION line. ' +
            'You MUST end your response with exactly one of:\n\n' +
            'DECISION: SHIP\n\nor\n\n' +
            'DECISION: REVISE\nISSUES:\n- <specific issue>\n\n' +
            'Provide your complete review and decision now.',
          ),
        ]),
      { label: 'reviewer.invoke', ...watchModel(model) },
    )) as AIMessage;
    response = extractContent(retryMessage);
  }

  return response;
}

export async function runReviewer(params: ReviewerParams): Promise<ReviewDecision> {
  const { task, featureName, workerOutput, workingDirectory, changedFiles = [] } = params;

  // Pre-load the files the worker created so the reviewer doesn't need tools
  const fileContents = await loadReviewFiles(changedFiles, workerOutput, workingDirectory);
  const dependencySummary = summarizeForPrompt(getDependencyReport(workingDirectory));
  const playbooks = await playbookSectionFor(workingDirectory, task.domain);

  const systemPrompt = buildReviewerPrompt(
    task,
    workerOutput,
    featureName,
    fileContents,
    dependencySummary,
    playbooks,
  );

  const userPrompt =
    `Review the implementation of ${task.id}: ${task.name}\n\n` +
    `Working directory: ${workingDirectory}\n` +
    `The implementation files are embedded above. Provide your DECISION now.`;

  const model = createChatModel(env.EDITOR_MODEL);

  logger.debug({ taskId: task.id, model: env.EDITOR_MODEL, filesLoaded: fileContents.length }, 'reviewer.start');

  const response = await invokeReviewerWithRetry(model, systemPrompt, userPrompt, task.id);

  const decision = parseReviewDecision(response);

  logger.info(
    { taskId: task.id, decision: decision.decision, issueCount: decision.issues.length },
    'reviewer.decision',
  );

  return decision;
}

// ---------------------------------------------------------------------------
// File pre-loading
// ---------------------------------------------------------------------------

interface LoadedFile {
  readonly path: string;
  readonly content: string;
}

const MAX_REVIEW_FILES = 10;
const MAX_REVIEW_FILE_CHARS = 16_000;
// Total cap across all files so the reviewer prompt fits the context window.
const MAX_REVIEW_TOTAL_CHARS = 80_000;

// Marker the reviewer prompt explains: a cut-off file is not a code defect.
export const REVIEW_TRUNCATION_MARKER = '... [truncated by oda for length — not a defect in the file]';

/**
 * The files to embed in the review: the worker's changed files first (exact),
 * then paths mentioned in its summary. Paths may be relative or absolute;
 * anything outside the working directory or missing is skipped.
 */
export async function loadReviewFiles(
  changedFiles: readonly string[],
  workerOutput: string,
  workingDirectory: string,
): Promise<LoadedFile[]> {
  const candidates = [...changedFiles, ...extractFilePaths(workerOutput)];
  const seen = new Set<string>();
  const results: LoadedFile[] = [];
  let total = 0;

  for (const candidate of candidates) {
    if (results.length >= MAX_REVIEW_FILES || total >= MAX_REVIEW_TOTAL_CHARS) break;
    const absolutePath = resolve(workingDirectory, candidate);
    const rel = relative(workingDirectory, absolutePath);
    if (rel.startsWith('..') || isAbsolute(rel) || seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    try {
      const raw = await Bun.file(absolutePath).text();
      const budget = Math.min(MAX_REVIEW_FILE_CHARS, MAX_REVIEW_TOTAL_CHARS - total);
      const content = raw.length > budget ? `${raw.slice(0, budget)}\n${REVIEW_TRUNCATION_MARKER}` : raw;
      total += content.length;
      results.push({ path: rel.replace(/\\/g, '/'), content });
    } catch {
      // File may not exist or path extraction was wrong — skip silently
    }
  }

  return results;
}

function extractFilePaths(workerOutput: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  function add(p: string): void {
    const trimmed = p.trim().replace(/^['"]|['"]$/g, '');
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      paths.push(trimmed);
    }
  }

  // write_file / read_file tool call args: "path": "src/foo.mts"
  const jsonPathPattern = /"path":\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = jsonPathPattern.exec(workerOutput)) !== null) {
    if (m[1]) add(m[1]);
  }

  // Backtick-quoted paths: `src/foo.mts`
  const backtickPattern = /`([^`\s]+\.(?:mts|ts|json|css|scss|html|md))`/g;
  while ((m = backtickPattern.exec(workerOutput)) !== null) {
    if (m[1]) add(m[1]);
  }

  // Bold paths: **src/foo.mts**
  const boldPattern = /\*\*([^*\s]+\.(?:mts|ts|json|css|scss|html))\*\*/g;
  while ((m = boldPattern.exec(workerOutput)) !== null) {
    if (m[1]) add(m[1]);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractContent(aiMessage: AIMessage): string {
  const content = aiMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (
          typeof block === 'object' &&
          block !== null &&
          'text' in block &&
          typeof (block as { text: unknown }).text === 'string'
        ) {
          return (block as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return String(content);
}

// Exported for unit testing
export function parseReviewDecision(response: string): ReviewDecision {
  const checklist = parseChecklist(response);
  const unmet = checklist.filter((c) => !c.met);
  const final = finalDecision(response);

  if (final?.decision === 'ship') {
    // Pre-completion gate: a SHIP is only valid if every acceptance criterion
    // in the checklist is met. If the reviewer marked SHIP but left criteria
    // unchecked, override to REVISE with the unmet criteria as issues.
    if (unmet.length > 0) {
      return {
        decision: 'revise',
        feedback: response,
        issues: unmet.map((c) => `Acceptance criterion not met: ${c.criterion}`),
        checklist,
      };
    }
    return { decision: 'ship', feedback: response, issues: [], checklist };
  }

  if (final?.decision === 'revise') {
    // Issues belong to the final decision, so read the ISSUES block after it.
    const issues = extractIssues(response.slice(final.index));
    return { decision: 'revise', feedback: response, issues, checklist };
  }

  // Fallback: no explicit decision found
  return {
    decision: 'revise',
    feedback: response,
    issues: ['Reviewer did not provide an explicit DECISION. Full response attached as feedback.'],
    checklist,
  };
}

// Parse the reviewer's CHECKLIST section: lines like "- [x] criterion" (met) or
// "- [ ] criterion" (not met). Returns [] when no checklist is present.
function parseChecklist(response: string): ChecklistItem[] {
  const section = response.match(/CHECKLIST:\s*\n([\s\S]*?)(?:\n\s*DECISION:|$)/i);
  const block = section?.[1] ?? '';
  const items: ChecklistItem[] = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/);
    if (m?.[1] && m[2]) {
      items.push({ criterion: m[2].trim(), met: m[1].toLowerCase() === 'x' });
    }
  }
  return items;
}

function extractIssues(response: string): readonly string[] {
  const issuesMatch = response.match(/ISSUES:\s*\n([\s\S]*?)(?:\n\n|$)/i);
  if (!issuesMatch?.[1]) return [];

  return issuesMatch[1]
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line.length > 0);
}
