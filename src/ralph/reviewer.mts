import type { Task, ReviewDecision, ChecklistItem } from '../types/index.mts';
import { createChatModel } from '../models/index.mts';
import { SystemMessage, HumanMessage, type AIMessage } from '@langchain/core/messages';
import { buildReviewerPrompt } from '../prd/index.mts';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { join } from 'node:path';

interface ReviewerParams {
  readonly task: Task;
  readonly featureName: string;
  readonly featureSlug: string;
  readonly workingDirectory: string;
  readonly workerOutput: string;
}

const MAX_REVIEWER_DECISION_RETRIES = 2;

function hasDecision(response: string): boolean {
  return /DECISION:\s*(SHIP|REVISE)/i.test(response);
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

  const firstMessage = (await model.invoke(baseMessages)) as AIMessage;
  let response = extractContent(firstMessage);

  for (let retry = 0; retry < MAX_REVIEWER_DECISION_RETRIES && !hasDecision(response); retry++) {
    logger.warn(
      { taskId, retry: retry + 1, responseLength: response.length },
      'reviewer.missing_decision_retry',
    );
    const retryMessage = (await model.invoke([
      ...baseMessages,
      firstMessage,
      new HumanMessage(
        'Your response is missing the required DECISION line. ' +
        'You MUST end your response with exactly one of:\n\n' +
        'DECISION: SHIP\n\nor\n\n' +
        'DECISION: REVISE\nISSUES:\n- <specific issue>\n\n' +
        'Provide your complete review and decision now.',
      ),
    ])) as AIMessage;
    response = extractContent(retryMessage);
  }

  return response;
}

export async function runReviewer(params: ReviewerParams): Promise<ReviewDecision> {
  const { task, featureName, workerOutput, workingDirectory } = params;

  // Pre-load the files the worker created so the reviewer doesn't need tools
  const fileContents = await loadMentionedFiles(workerOutput, workingDirectory);

  const systemPrompt = buildReviewerPrompt(task, workerOutput, featureName, fileContents);

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

async function loadMentionedFiles(
  workerOutput: string,
  workingDirectory: string,
): Promise<LoadedFile[]> {
  const paths = extractFilePaths(workerOutput);
  const MAX_FILES = 6;
  const MAX_FILE_BYTES = 8000;

  const results: LoadedFile[] = [];

  for (const relativePath of paths.slice(0, MAX_FILES)) {
    const absolutePath = join(workingDirectory, relativePath);
    try {
      const raw = await Bun.file(absolutePath).text();
      const content = raw.length > MAX_FILE_BYTES
        ? raw.slice(0, MAX_FILE_BYTES) + '\n... [truncated]'
        : raw;
      results.push({ path: relativePath, content });
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

  if (/DECISION:\s*SHIP/i.test(response)) {
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

  if (/DECISION:\s*REVISE/i.test(response)) {
    const issues = extractIssues(response);
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
