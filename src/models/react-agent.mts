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

  const messages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

  // Per-run call count per tool name
  const toolCallCounts = new Map<string, number>();

  // Cache of read_file results keyed by path — prevents redundant re-reads
  const readFileCache = new Map<string, string>();

  // How many times we've retried after getting an empty final response
  let emptyRetries = 0;
  const MAX_EMPTY_RETRIES = 2;

  for (let step = 0; step < limit; step++) {
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
