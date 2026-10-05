import { describe, it, expect } from 'bun:test';
import {
  ModelCallTimeoutError,
  ModelStreamStalledError,
  ThinkingBudgetExceededError,
  isTransientOllamaError,
  withOllamaRetry,
  type AttemptContext,
} from '../../../src/models/ollama-client.mts';
import {
  applyChunkLine,
  checkProgress,
  monitorBody,
  newProgress,
  thinkingTokens,
  type CallProgress,
} from '../../../src/models/stream-monitor.mts';
import { agentEvents } from '../../../src/agent/events.mts';

const line = (message: Record<string, unknown>, done = false): string => `${JSON.stringify({ message, done })}\n`;

describe('stream monitor', () => {
  it('counts thinking, content and tool calls from NDJSON lines', () => {
    const p = newProgress(0);
    applyChunkLine(p, line({ thinking: 'abcd'.repeat(10) }), 5);
    applyChunkLine(p, line({ content: 'hi', tool_calls: [{}, {}] }, true), 9);
    expect(p).toMatchObject({ thinkingChars: 40, contentChars: 2, toolCalls: 2, done: true, lastChunkAt: 9 });
    expect(thinkingTokens(p)).toBe(10);
  });

  it('ignores blank and malformed lines', () => {
    const p = newProgress(0);
    applyChunkLine(p, '   ', 1);
    applyChunkLine(p, '{not json', 2);
    expect(p.lastChunkAt).toBeUndefined();
  });

  it('passes the body through unchanged, even with lines split across chunks', async () => {
    const text = line({ thinking: 'think' }) + line({ content: 'answer' }, true);
    const bytes = new TextEncoder().encode(text);
    const source = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7, 30));
        controller.enqueue(bytes.slice(30));
        controller.close();
      },
    });
    const p = newProgress(0);
    const out = await new Response(monitorBody(source, p, () => 1)).text();
    expect(out).toBe(text);
    expect(p).toMatchObject({ thinkingChars: 5, contentChars: 6, done: true });
  });

  it('flags an idle stream and a runaway thinker, but not a model that acts', () => {
    const limits = { idleMs: 1000, thinkingBudgetTokens: 100 };
    expect(checkProgress(newProgress(0), 1500, limits)).toBe('idle');

    const thinker = { ...newProgress(0), lastChunkAt: 1400, thinkingChars: 800 } satisfies CallProgress;
    expect(checkProgress(thinker, 1500, limits)).toBe('thinking_budget');

    const actor = { ...thinker, toolCalls: 1 };
    expect(checkProgress(actor, 1500, limits)).toBeNull();
    expect(checkProgress({ ...newProgress(0), done: true }, 99_999, limits)).toBeNull();
  });
});

describe('withOllamaRetry watchdog', () => {
  const fast = { baseDelayMs: 1, pollMs: 5 } as const;

  it('abandons a silent stream and cancels the request', async () => {
    let aborted = 0;
    const progress = newProgress(Date.now() + 1);
    await expect(
      withOllamaRetry(() => new Promise<never>(() => {}), {
        ...fast,
        maxRetries: 0,
        progress: () => progress,
        onCallTimeout: () => { aborted++; },
        limits: { idleMs: 30, thinkingBudgetTokens: 1000 },
      }),
    ).rejects.toBeInstanceOf(ModelStreamStalledError);
    expect(aborted).toBe(1);
  });

  it('keeps waiting while the stream is active, up to the hard ceiling', async () => {
    const progress = newProgress(Date.now() + 1);
    const feeder = setInterval(() => applyChunkLine(progress, line({ content: 'x' }), Date.now()), 5);
    const started = Date.now();
    try {
      await expect(
        withOllamaRetry(() => new Promise<never>(() => {}), {
          ...fast,
          maxRetries: 0,
          callTimeoutMs: 150,
          progress: () => progress,
          limits: { idleMs: 40, thinkingBudgetTokens: 1000 },
        }),
      ).rejects.toBeInstanceOf(ModelCallTimeoutError);
    } finally {
      clearInterval(feeder);
    }
    // Survived several idle windows because data kept arriving.
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('stops a runaway thinker and tells the retry why', async () => {
    const contexts: AttemptContext[] = [];
    let progress = newProgress(0);
    const result = await withOllamaRetry(
      async (context) => {
        contexts.push(context);
        progress = newProgress(Date.now());
        if (context.attempt === 0) {
          applyChunkLine(progress, line({ thinking: 'x'.repeat(4000) }), Date.now());
          return new Promise<string>(() => {});
        }
        return 'acted';
      },
      { ...fast, progress: () => progress, limits: { idleMs: 5000, thinkingBudgetTokens: 500 } },
    );
    expect(result).toBe('acted');
    expect(contexts[0]?.lastError).toBeUndefined();
    expect(contexts[1]?.lastError).toBeInstanceOf(ThinkingBudgetExceededError);
  });

  it('ignores progress left over from an earlier call', async () => {
    // A finished record from before this attempt must not count as idle time.
    const stale = { ...newProgress(Date.now() - 10_000), lastChunkAt: Date.now() - 10_000 };
    const value = await withOllamaRetry(async () => {
      await Bun.sleep(30);
      return 'ok';
    }, { ...fast, maxRetries: 0, progress: () => stale, limits: { idleMs: 1000, thinkingBudgetTokens: 10 } });
    expect(value).toBe('ok');
  });

  it('reports progress for the UI while a call runs', async () => {
    const seen: Record<string, unknown>[] = [];
    const listener = (e: { payload: Record<string, unknown> }): void => { seen.push(e.payload); };
    agentEvents.on('model_progress', listener);
    const progress = newProgress(Date.now() + 1);
    try {
      await withOllamaRetry(async () => {
        applyChunkLine(progress, line({ thinking: 'y'.repeat(400) }), Date.now());
        await Bun.sleep(3_200);
        return 'done';
      }, { ...fast, maxRetries: 0, label: 'worker.invoke', progress: () => progress, pollMs: 100, limits: { idleMs: 10_000, thinkingBudgetTokens: 10_000 } });
    } finally {
      agentEvents.off('model_progress', listener);
    }
    expect(seen[0]).toMatchObject({ label: 'worker.invoke', phase: 'thinking', thinkingTokens: 100 });
  });

  it('treats stalls and runaway thinking as retryable', () => {
    expect(isTransientOllamaError(new ModelStreamStalledError(60_000))).toBe(true);
    expect(isTransientOllamaError(new ThinkingBudgetExceededError(9000))).toBe(true);
  });
});
