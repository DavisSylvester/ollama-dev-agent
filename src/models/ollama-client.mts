import { ChatOllama } from '@langchain/ollama';
import { Ollama, type Fetch } from 'ollama';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { emitAgentEvent } from '../agent/events.mts';

// Bearer auth header for Ollama Cloud. Returns undefined for local Ollama
// (no key set) so behavior is unchanged when running locally.
function authHeaders(): Headers | undefined {
  if (!env.OLLAMA_API_KEY) return undefined;
  return new Headers({ Authorization: `Bearer ${env.OLLAMA_API_KEY}` });
}

/**
 * Thrown when the configured Ollama endpoint cannot be reached. Carries the
 * base URL so callers can surface an actionable blocker message instead of a
 * generic fetch failure.
 */
export class OllamaUnreachableError extends Error {

  public constructor(
    public readonly baseUrl: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `Cannot reach Ollama at ${baseUrl}. Verify OLLAMA_BASE_URL is correct and ` +
        `the server is running, or pass --base-url / --cloud.`,
      options,
    );
    this.name = "OllamaUnreachableError";
  }
}

/**
 * Preflight connectivity check. Pings the Ollama `/api/tags` endpoint and
 * throws {@link OllamaUnreachableError} if it cannot connect. Run this once at
 * the start of a job so a dead endpoint aborts immediately with a clear blocker
 * rather than silently burning the entire iteration budget on failed calls.
 */
export async function assertOllamaReachable(): Promise<void> {
  const headers = authHeaders();
  let response: Response;
  try {
    response = await fetch(
      `${env.OLLAMA_BASE_URL}/api/tags`,
      headers ? { headers } : undefined,
    );
  } catch (err) {
    throw new OllamaUnreachableError(env.OLLAMA_BASE_URL, { cause: err });
  }
  if (!response.ok) {
    throw new OllamaUnreachableError(env.OLLAMA_BASE_URL, { cause: `HTTP ${response.status}` });
  }
}

// Substrings (lower-cased) that mark a transient/connectivity failure worth
// retrying. Crucially includes the exact phrases Ollama/Ollama Cloud emit on a
// dropped connection ("unable to connect", "typo in the url or port") — earlier
// detection missed these, so a cloud blip silently failed the whole task.
const TRANSIENT_ERROR_PATTERNS: readonly string[] = [
  "unable to connect",
  "typo in the url",
  "could not connect",
  "connection error",
  "connection refused",
  "connection reset",
  "fetch failed",
  "econnreset",
  "econnrefused",
  "enotfound",
  "etimedout",
  "socket hang up",
  "network",
  "timeout",
  "timed out",
  "service unavailable",
  "502",
  "503",
  "504",
];

// Substrings (lower-cased) that mark a usage-quota or rate-limit rejection.
// These are NOT transient: retrying within seconds cannot succeed, and treating
// them as task failures burns every remaining iteration in seconds. Callers
// must pause the run instead (see QuotaExceededError).
const QUOTA_ERROR_PATTERNS: readonly string[] = [
  "reached your",
  "usage limit",
  "hour limit",
  "weekly limit",
  "monthly limit",
  "quota",
  "rate limit",
  "rate-limit",
  "too many requests",
  "status code 429",
  "http 429",
];

/**
 * Thrown when the model provider rejects a call for quota or rate-limit
 * reasons. Never counted as a task failure — the run should save state and
 * pause until the quota resets.
 */
export class QuotaExceededError extends Error {

  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "QuotaExceededError";
  }
}

/**
 * Thrown when a single model call exceeds CALL_TIMEOUT_SECONDS. Its message
 * contains "timed out", so it is retried like any other transient error.
 */
export class ModelCallTimeoutError extends Error {

  public constructor(public readonly timeoutMs: number) {
    super(`Model call timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "ModelCallTimeoutError";
  }
}

/**
 * Thrown when there is not enough time left before the caller's deadline to
 * make (or retry) a model call. Callers treat it as a wall-clock timeout.
 */
export class DeadlineExceededError extends Error {

  public constructor(public readonly label: string) {
    super(`${label}: no time left before the iteration deadline`);
    this.name = "DeadlineExceededError";
  }
}

export function isQuotaError(err: unknown): boolean {
  if (err instanceof QuotaExceededError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * True when an error looks transient (connectivity/timeout) and is therefore
 * worth retrying. {@link OllamaUnreachableError} always qualifies; a quota
 * error never does.
 */
export function isTransientOllamaError(err: unknown): boolean {
  if (isQuotaError(err)) return false;
  if (err instanceof OllamaUnreachableError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly label?: string;
  /** Per-attempt cap in ms. Defaults to CALL_TIMEOUT_SECONDS. */
  readonly callTimeoutMs?: number;
  /** Absolute epoch-ms deadline; no attempt or retry starts past it. */
  readonly deadlineMs?: number;
  /** Called when an attempt times out, to cancel the in-flight request. */
  readonly onCallTimeout?: () => void;
}

// Don't start a retry with less than this left before the deadline — it could
// not produce a useful answer and would only overrun the iteration.
const MIN_USEFUL_CALL_MS = 15_000;

async function raceTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ModelCallTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run an Ollama call with exponential-backoff retry on transient errors.
 *
 * - Each attempt is capped at `callTimeoutMs` (default CALL_TIMEOUT_SECONDS);
 *   on expiry `onCallTimeout` cancels the request and the attempt is retried.
 * - With a `deadlineMs`, no attempt starts (and no retry is scheduled) once
 *   the remaining time is too short to be useful — a DeadlineExceededError is
 *   thrown instead, so retries can never overrun the iteration.
 * - A quota/rate-limit rejection is rethrown at once as QuotaExceededError.
 * - Any other non-transient error is rethrown immediately.
 */
export async function withOllamaRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  const label = options?.label ?? "ollama";
  const callTimeoutMs = options?.callTimeoutMs ?? env.CALL_TIMEOUT_SECONDS * 1000;
  const deadlineMs = options?.deadlineMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remainingMs = deadlineMs === undefined ? Infinity : deadlineMs - Date.now();
    if (remainingMs <= 0) throw new DeadlineExceededError(label);
    const attemptTimeoutMs = Math.min(callTimeoutMs, remainingMs);

    try {
      return await raceTimeout(fn(), attemptTimeoutMs, options?.onCallTimeout);
    } catch (err) {
      if (isQuotaError(err)) {
        throw err instanceof QuotaExceededError
          ? err
          : new QuotaExceededError(err instanceof Error ? err.message : String(err), { cause: err });
      }
      if (attempt === maxRetries || !isTransientOllamaError(err)) throw err;

      // Full jitter around the exponential step so parallel workers that
      // failed together don't retry in lockstep.
      const delayMs = Math.round(baseDelayMs * 2 ** attempt * (0.5 + Math.random()));
      if (deadlineMs !== undefined && Date.now() + delayMs + MIN_USEFUL_CALL_MS > deadlineMs) {
        logger.warn({ attempt: attempt + 1, label, error: String(err) }, "ollama.retry_skipped_deadline");
        throw new DeadlineExceededError(label);
      }
      logger.warn(
        { attempt: attempt + 1, maxRetries, delayMs, label, error: String(err) },
        "ollama.transient_retry",
      );
      // Surface the retry in the UI — otherwise a slow provider looks like a hang.
      emitAgentEvent("model_retry", {
        label,
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await Bun.sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error("withOllamaRetry: exhausted retries without returning");
}

// In-flight HTTP requests per chat model, so a timed-out call can be cancelled
// at the socket. ChatOllama only checks an AbortSignal between streamed chunks,
// so a request that never sends a byte would otherwise stay open server-side
// (still generating, still counting against quota) after we give up on it.
const inFlightRequests = new WeakMap<ChatOllama, Set<AbortController>>();

function trackingFetch(controllers: Set<AbortController>): Fetch {
  const tracked = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
    const controller = new AbortController();
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    controllers.add(controller);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      controllers.delete(controller);
      throw err;
    }
  };
  // Bun's fetch type also carries preconnect(); keep the wrapper a full fetch.
  return Object.assign(tracked, { preconnect: fetch.preconnect });
}

/** Abort every in-flight HTTP request made by this model. */
export function abortModelRequests(model: ChatOllama): void {
  const controllers = inFlightRequests.get(model);
  if (!controllers) return;
  for (const controller of controllers) controller.abort(new ModelCallTimeoutError(0));
  controllers.clear();
}

export function createChatModel(model: string): ChatOllama {
  const headers = authHeaders();
  const chat = new ChatOllama({
    baseUrl: env.OLLAMA_BASE_URL,
    model,
    temperature: 0,
    numCtx: env.NUM_CTX,
    // Keep the HTTP connection alive to avoid socket-reset errors on long
    // generation runs. -1 means keep loaded indefinitely in Ollama.
    keepAlive: '-1m',
    ...(headers ? { headers } : {}),
  });

  // Swap in a client whose requests we can abort (see inFlightRequests).
  const controllers = new Set<AbortController>();
  chat.client = new Ollama({
    host: env.OLLAMA_BASE_URL,
    ...(headers ? { headers } : {}),
    fetch: trackingFetch(controllers),
  });
  inFlightRequests.set(chat, controllers);
  return chat;
}

const CODER_FALLBACKS = ['qwen3-coder:30b', 'devstral-small-2:24b', 'deepseek-r1:32b'] as const;

async function fetchAvailableModels(): Promise<Set<string>> {
  try {
    const headers = authHeaders();
    const response = await fetch(
      `${env.OLLAMA_BASE_URL}/api/tags`,
      headers ? { headers } : undefined,
    );
    if (!response.ok) return new Set();
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const names = new Set<string>();
    for (const m of data.models ?? []) {
      names.add(m.name);
      // Also index by base name without tag so "qwen3-coder:30b" matches "qwen3-coder:30b"
      // and "qwen3-coder" matches any variant
      const base = m.name.split(':')[0];
      if (base) names.add(base);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Resolves which coder model to use. Tries the configured model first,
 * then falls back through the priority list:
 *   qwen3-coder:30b → devstral-small-2:24b → deepseek-r1:32b
 *
 * If no model from the list is available, returns the configured model
 * and lets the downstream call fail with a useful error.
 */
export async function resolveCoderModel(): Promise<string> {
  const configured = env.CODER_MODEL;
  const available = await fetchAvailableModels();

  if (available.size === 0) {
    // Could not reach Ollama — return configured and let the call surface the error
    logger.warn({ model: configured }, 'ollama.unreachable — using configured coder model');
    return configured;
  }

  const candidates = [configured, ...CODER_FALLBACKS];
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const ordered = candidates.filter((m) => {
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });

  for (const candidate of ordered) {
    if (available.has(candidate)) {
      if (candidate !== configured) {
        logger.warn(
          { configured, resolved: candidate },
          'ollama.coder-model-fallback — configured model not available',
        );
      }
      return candidate;
    }
  }

  // None of the candidates are available; fall back to configured and let it fail visibly
  logger.warn(
    { configured, fallbacks: CODER_FALLBACKS },
    'ollama.no-coder-model-available — none of the candidates found; using configured',
  );
  return configured;
}
