// Live progress of one streamed Ollama /api/chat call, read straight off the
// HTTP response body. LangChain hides the thinking stream, so without this a
// model that is thinking hard looks exactly like a dead connection.

// Rough chars-per-token ratio, good enough for budgets and progress display.
const CHARS_PER_TOKEN = 4;

export interface CallProgress {
  startedAt: number;
  // When the last chunk arrived; undefined until the first one does.
  lastChunkAt: number | undefined;
  thinkingChars: number;
  contentChars: number;
  toolCalls: number;
  done: boolean;
}

export type StallReason = 'idle' | 'thinking_budget';

export interface StallLimits {
  readonly idleMs: number;
  readonly thinkingBudgetTokens: number;
}

export function newProgress(now: number): CallProgress {
  return { startedAt: now, lastChunkAt: undefined, thinkingChars: 0, contentChars: 0, toolCalls: 0, done: false };
}

export function thinkingTokens(progress: CallProgress): number {
  return Math.round(progress.thinkingChars / CHARS_PER_TOKEN);
}

export function outputTokens(progress: CallProgress): number {
  return Math.round(progress.contentChars / CHARS_PER_TOKEN);
}

/** True once the model has started answering (text or a tool call). */
export function hasActed(progress: CallProgress): boolean {
  return progress.contentChars > 0 || progress.toolCalls > 0;
}

interface ChatChunk {
  message?: { content?: string; thinking?: string; tool_calls?: unknown[] };
  done?: boolean;
}

/** Fold one NDJSON line of an /api/chat stream into the progress record. */
export function applyChunkLine(progress: CallProgress, line: string, now: number): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let chunk: ChatChunk;
  try {
    chunk = JSON.parse(trimmed) as ChatChunk;
  } catch {
    return;
  }
  progress.lastChunkAt = now;
  progress.thinkingChars += chunk.message?.thinking?.length ?? 0;
  progress.contentChars += chunk.message?.content?.length ?? 0;
  progress.toolCalls += chunk.message?.tool_calls?.length ?? 0;
  if (chunk.done) progress.done = true;
}

/**
 * Pass a response body through unchanged while updating `progress` from each
 * complete NDJSON line.
 */
export function monitorBody(
  body: ReadableStream<Uint8Array>,
  progress: CallProgress,
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) applyChunkLine(progress, line, now());
        controller.enqueue(chunk);
      },
      flush(): void {
        applyChunkLine(progress, pending + decoder.decode(), now());
      },
    }),
  );
}

/**
 * Why a call should be abandoned, or null while it is healthy:
 * - idle: no data for `idleMs` (counted from the start until the first chunk);
 * - thinking_budget: thought past the budget without starting an answer.
 */
export function checkProgress(progress: CallProgress, now: number, limits: StallLimits): StallReason | null {
  if (progress.done) return null;
  const lastActivity = progress.lastChunkAt ?? progress.startedAt;
  if (now - lastActivity > limits.idleMs) return 'idle';
  if (!hasActed(progress) && thinkingTokens(progress) > limits.thinkingBudgetTokens) return 'thinking_budget';
  return null;
}
