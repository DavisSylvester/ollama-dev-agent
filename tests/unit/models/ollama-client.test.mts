import { describe, it, expect, afterEach } from 'bun:test';
import {
  assertOllamaReachable,
  OllamaUnreachableError,
  isTransientOllamaError,
  withOllamaRetry,
} from '../../../src/models/ollama-client.mts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('assertOllamaReachable', () => {

  it('resolves when /api/tags returns ok', async () => {
    globalThis.fetch = (async () =>
      new Response('{"models":[]}', { status: 200 })) as unknown as typeof fetch;

    await expect(assertOllamaReachable()).resolves.toBeUndefined();
  });

  it('throws OllamaUnreachableError when the connection fails', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Unable to connect. Is the computer able to access the url?');
    }) as unknown as typeof fetch;

    await expect(assertOllamaReachable()).rejects.toBeInstanceOf(OllamaUnreachableError);
  });

  it('throws OllamaUnreachableError on a non-ok HTTP status', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;

    await expect(assertOllamaReachable()).rejects.toBeInstanceOf(OllamaUnreachableError);
  });

  it('surfaces the base URL in the error message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    try {
      await assertOllamaReachable();
      throw new Error('expected assertOllamaReachable to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaUnreachableError);
      expect((err as OllamaUnreachableError).message).toContain('Cannot reach Ollama at');
      expect((err as OllamaUnreachableError).baseUrl).toBeTruthy();
    }
  });
});

describe('isTransientOllamaError', () => {

  // The exact strings Ollama / Ollama Cloud emit on a dropped connection — these
  // are the ones earlier detection missed, which let a cloud blip fail a task.
  it.each([
    'Unable to connect. Is the computer able to access the url?',
    'Was there a typo in the url or port?',
    'fetch failed',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:11434',
    'request timed out',
    'socket hang up',
    'Service Unavailable (503)',
  ])('treats %p as transient', (message) => {
    expect(isTransientOllamaError(new Error(message))).toBe(true);
  });

  it('treats OllamaUnreachableError as transient', () => {
    expect(isTransientOllamaError(new OllamaUnreachableError('http://x'))).toBe(true);
  });

  it('does NOT treat a genuine model error as transient', () => {
    expect(isTransientOllamaError(new Error('model "foo" not found'))).toBe(false);
    expect(isTransientOllamaError(new Error('invalid tool arguments'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientOllamaError('nope')).toBe(false);
    expect(isTransientOllamaError(undefined)).toBe(false);
  });
});

describe('withOllamaRetry', () => {

  it('returns the result without retrying on success', async () => {
    let calls = 0;
    const result = await withOllamaRetry(async () => {
      calls++;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient error then succeeds', async () => {
    let calls = 0;
    const result = await withOllamaRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('Unable to connect. Is the computer able to access the url?');
        return 'recovered';
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('rethrows a non-transient error immediately without retrying', async () => {
    let calls = 0;
    await expect(
      withOllamaRetry(async () => {
        calls++;
        throw new Error('model "foo" not found');
      }, { baseDelayMs: 1 }),
    ).rejects.toThrow('not found');
    expect(calls).toBe(1);
  });

  it('gives up after maxRetries and rethrows the transient error', async () => {
    let calls = 0;
    await expect(
      withOllamaRetry(async () => {
        calls++;
        throw new Error('fetch failed');
      }, { maxRetries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3); // initial + 2 retries
  });
});
