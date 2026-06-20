import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessage,
} from '@langchain/core/messages';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { DateTime } from 'luxon';

// ---------------------------------------------------------------------------
// LLM invoke retry — wraps the model call with exponential backoff so
// transient Ollama timeouts / connection drops don't fail the whole task.
// ---------------------------------------------------------------------------

const MAX_INVOKE_RETRIES = 2;
const INVOKE_RETRY_BASE_MS = 3000;

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  );
}

async function invokeWithRetry(
  model: BaseChatModel,
  messages: Parameters<BaseChatModel['invoke']>[0],
): Promise<AIMessage> {
  for (let attempt = 0; attempt <= MAX_INVOKE_RETRIES; attempt++) {
    try {
      return (await model.invoke(messages)) as AIMessage;
    } catch (err) {
      if (attempt === MAX_INVOKE_RETRIES || !isRetryableError(err)) throw err;
      const delayMs = INVOKE_RETRY_BASE_MS * (attempt + 1);
      logger.warn(
        { attempt: attempt + 1, maxRetries: MAX_INVOKE_RETRIES, delayMs, error: String(err) },
        'react_agent.invoke_retry',
      );
      await Bun.sleep(delayMs);
    }
  }
  throw new Error('invokeWithRetry: unreachable');
}

// Exported so loop.mts (and tests) can detect a timed-out worker without
// string-matching the full message.
export const REACT_TIMEOUT_SENTINEL = 'Reached maximum steps';

type ConvMessage = SystemMessage | HumanMessage | AIMessage | ToolMessage;

// Compact when estimated tokens exceed this fraction of the context window.
const CONTEXT_COMPACT_RATIO = 0.7;
// Most-recent messages always kept verbatim (never summarized).
const KEEP_RECENT_MESSAGES = 6;

// Hard per-run limits for exploration/verification tools.
// Once a tool exceeds its limit, every subsequent call returns an error message
// telling the model to act rather than explore.
const TOOL_CALL_LIMITS: Record<string, number> = {
  list_directory: 5,
  read_file: 10,
  run_linter: 5,
  run_tests: 5,
};

export async function runReactAgent(
  model: BaseChatModel,
  tools: StructuredTool[],
  systemPrompt: string,
  userPrompt: string,
  maxSteps?: number,
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void,
): Promise<string> {
  const limit = maxSteps ?? env.MAX_REACT_STEPS;

  const toolMap = new Map<string, StructuredTool>(
    tools.map((t) => [t.name, t]),
  );

  if (!model.bindTools) {
    throw new Error('Model does not support tool binding. Ensure you are using ChatOllama.');
  }
  const modelWithTools = model.bindTools(tools);

  let messages: ConvMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

  // Summarizer for context compaction — uses the UNBOUND model (no tools) so it
  // can't try to call tools while summarizing.
  const summarize = async (text: string): Promise<string> => {
    const res = (await model.invoke([
      new SystemMessage(
        'Summarize this agent work-log concisely as terse bullet points. Capture: ' +
        'files created/modified, key decisions, test/lint results, and any unresolved ' +
        'errors. This replaces older context to save tokens — preserve facts, drop prose.',
      ),
      new HumanMessage(text.slice(0, 12000)),
    ])) as AIMessage;
    return extractContent(res);
  };

  // Per-run call count per tool name
  const toolCallCounts = new Map<string, number>();

  // Cache of read_file results keyed by path — prevents redundant re-reads
  const readFileCache = new Map<string, string>();

  // How many times we've retried after getting an empty final response
  let emptyRetries = 0;
  const MAX_EMPTY_RETRIES = 2;

  // Wall-clock budget — independent of step count. Catches a single hung tool
  // call (e.g. a server start) that would otherwise consume the whole run.
  const startMs = DateTime.utc().toMillis();
  const deadlineMs = startMs + env.MAX_ITERATION_SECONDS * 1000;

  for (let step = 0; step < limit; step++) {
    if (DateTime.utc().toMillis() >= deadlineMs) {
      const uniqueTools = [...new Set(toolCallCounts.keys())];
      logger.warn(
        { step, elapsedSeconds: Math.round((DateTime.utc().toMillis() - startMs) / 1000), maxSeconds: env.MAX_ITERATION_SECONDS },
        'react_agent.wall_clock_timeout',
      );
      return (
        `${REACT_TIMEOUT_SENTINEL} (wall-clock ${env.MAX_ITERATION_SECONDS}s exceeded) ` +
        `without a final answer. Tools attempted: ${uniqueTools.join(', ') || 'none'}.`
      );
    }
    // Context compaction — when the conversation approaches the context window,
    // summarize older turns (at a clean tool-call boundary) so a long iteration
    // doesn't overflow. Reduces size in place; safe to run every step.
    if (estimateTokens(messages) > env.NUM_CTX * CONTEXT_COMPACT_RATIO) {
      const before = messages.length;
      messages = await compactConversation(messages, summarize);
      logger.info(
        { step, messagesBefore: before, messagesAfter: messages.length, estTokens: estimateTokens(messages) },
        'react_agent.context_compacted',
      );
    }

    logger.debug({ step, totalSteps: limit }, 'react_agent.step');

    const aiMessage = await invokeWithRetry(modelWithTools as BaseChatModel, messages);
    messages.push(aiMessage);

    const toolCalls = aiMessage.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      const content = extractContent(aiMessage);

      if (content.trim().length === 0 && emptyRetries < MAX_EMPTY_RETRIES) {
        emptyRetries++;
        logger.debug({ step, emptyRetries }, 'react_agent.empty_response_retry');
        messages.push(
          new HumanMessage(
            'Your last response was empty. Please provide your final answer now. ' +
            'Do NOT call any more tools — just write your response as plain text.',
          ),
        );
        continue;
      }

      logger.debug({ step, contentLength: content.length }, 'react_agent.final_answer');
      return content;
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.name;
      const toolArgs = (toolCall.args ?? {}) as Record<string, unknown>;
      const toolCallId = toolCall.id ?? `tool-call-${step}`;

      onToolCall?.(toolName, toolArgs);

      // Increment per-run call count
      const callCount = (toolCallCounts.get(toolName) ?? 0) + 1;
      toolCallCounts.set(toolName, callCount);

      logger.debug(
        { step, toolName, callCount, argKeys: Object.keys(toolArgs) },
        'react_agent.tool_call',
      );

      // Check hard per-run limit
      const hardLimit = TOOL_CALL_LIMITS[toolName];
      if (hardLimit !== undefined && callCount > hardLimit) {
        logger.warn(
          { step, toolName, callCount, hardLimit },
          'react_agent.tool_limit_reached',
        );
        messages.push(
          new ToolMessage({
            tool_call_id: toolCallId,
            content:
              `[TOOL LIMIT REACHED] You have already called "${toolName}" ${callCount} times ` +
              `(limit: ${hardLimit}). This tool is now disabled for this task. ` +
              `Stop exploring — use write_file to implement your code, or provide your final answer now.`,
          }),
        );
        continue;
      }

      // Deduplicate read_file — return cached content instead of re-reading the same path
      if (toolName === 'read_file' && typeof toolArgs['path'] === 'string') {
        const cachedPath = toolArgs['path'] as string;
        if (readFileCache.has(cachedPath)) {
          logger.debug({ step, toolName, path: cachedPath }, 'react_agent.read_file_cache_hit');
          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              content:
                `[CACHED — already read earlier in this task. Use this content from memory.]\n` +
                readFileCache.get(cachedPath),
            }),
          );
          continue;
        }
      }

      const tool = toolMap.get(toolName);
      if (!tool) {
        logger.warn({ step, toolName }, 'react_agent.tool_not_found');
        messages.push(
          new ToolMessage({
            tool_call_id: toolCallId,
            content: `Error: tool "${toolName}" not found.`,
          }),
        );
        continue;
      }

      let toolResult: string;
      try {
        const rawResult = await tool.invoke(toolArgs);
        toolResult =
          typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        logger.debug(
          { step, toolName, resultLength: toolResult.length },
          'react_agent.tool_result',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolResult = `Error executing tool "${toolName}": ${message}`;
        logger.warn({ step, toolName, error: message }, 'react_agent.tool_error');
      }

      // Store read_file results in cache for deduplication on future calls
      if (toolName === 'read_file' && typeof toolArgs['path'] === 'string') {
        readFileCache.set(toolArgs['path'] as string, toolResult);
      }

      messages.push(
        new ToolMessage({
          tool_call_id: toolCallId,
          content: toolResult,
        }),
      );
    }

    // Inject budget warnings so the model can self-correct before exhausting steps
    const stepsUsed = step + 1;
    const stepsRemaining = limit - stepsUsed;
    if (stepsRemaining > 0) {
      if (stepsUsed === Math.floor(limit * 0.5)) {
        messages.push(
          new HumanMessage(
            `⚠ BUDGET WARNING: You have used ${stepsUsed} of ${limit} steps. ` +
            `${stepsRemaining} steps remain. Stop exploring — write your implementation files now.`,
          ),
        );
      } else if (stepsUsed === Math.floor(limit * 0.75)) {
        messages.push(
          new HumanMessage(
            `🚨 CRITICAL: Only ${stepsRemaining} steps remain. ` +
            `Write all remaining files immediately and provide your final answer.`,
          ),
        );
      }
    }
  }

  const uniqueTools = [...new Set(toolCallCounts.keys())];
  logger.warn(
    { limit, uniqueTools, toolCallCounts: Object.fromEntries(toolCallCounts) },
    'react_agent.timeout',
  );
  return (
    `${REACT_TIMEOUT_SENTINEL} (${limit}) without a final answer. ` +
    `Tools attempted: ${uniqueTools.join(', ') || 'none'}.`
  );
}

function extractContent(aiMessage: AIMessage): string {
  const content = aiMessage.content;
  if (typeof content === 'string') {
    return content;
  }
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

// ---------------------------------------------------------------------------
// Context compaction
// ---------------------------------------------------------------------------

function messageContentText(m: ConvMessage): string {
  const content = (m as { content: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : typeof b === 'object' && b !== null && 'text' in b && typeof (b as { text: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
      )
      .join('');
  }
  return content == null ? '' : String(content);
}

// Rough token estimate (~4 chars/token) over all message content.
export function estimateTokens(messages: ConvMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += messageContentText(m).length;
  return Math.ceil(chars / 4);
}

function roleOf(m: ConvMessage): string {
  if (m instanceof ToolMessage) return 'tool';
  if (m instanceof HumanMessage) return 'user';
  if (m instanceof SystemMessage) return 'system';
  return 'assistant';
}

function renderForSummary(messages: ConvMessage[]): string {
  const MAX_PER = 1500;
  return messages
    .map((m) => {
      const t = messageContentText(m);
      const body = t.length > MAX_PER ? `${t.slice(0, MAX_PER)} …[truncated]` : t;
      return `[${roleOf(m)}] ${body}`;
    })
    .join('\n\n')
    .slice(0, 12000);
}

// Deterministic fallback if the summarizer call fails — never overflow.
function crudeSummary(messages: ConvMessage[]): string {
  const lines = messages.map((m) => {
    const t = messageContentText(m).replace(/\s+/g, ' ').trim();
    return `- [${roleOf(m)}] ${t.slice(0, 200)}`;
  });
  return `(${messages.length} older steps; semantic summary unavailable)\n${lines.join('\n')}`;
}

/**
 * Replace older turns with a single summary message to keep the conversation
 * under the context window. Preserves the system + original user prompt and the
 * most recent turns verbatim. Critically, the kept tail starts at a turn
 * boundary (never an orphaned ToolMessage), so tool-call/result pairing stays
 * valid for the model API.
 */
export async function compactConversation(
  messages: ConvMessage[],
  summarize: (text: string) => Promise<string>,
  keepRecent: number = KEEP_RECENT_MESSAGES,
): Promise<ConvMessage[]> {
  if (messages.length <= 2 + keepRecent) return messages;

  // Advance the tail start past any ToolMessages so the tail begins cleanly.
  let split = Math.max(2, messages.length - keepRecent);
  while (split < messages.length && messages[split] instanceof ToolMessage) split++;

  const oldPart = messages.slice(2, split);
  if (oldPart.length === 0) return messages;
  const tail = messages.slice(split);

  let summaryText: string;
  try {
    summaryText = await summarize(renderForSummary(oldPart));
  } catch {
    summaryText = crudeSummary(oldPart);
  }

  return [
    messages[0]!,
    messages[1]!,
    new HumanMessage(`## Progress so far (older steps compacted to save context)\n\n${summaryText}`),
    ...tail,
  ];
}
