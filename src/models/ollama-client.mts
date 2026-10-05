import { ChatOllama } from '@langchain/ollama';
import { Ollama, type Fetch } from 'ollama';
import { env } from '../env.mts';
import { logger } from '../logger.mts';
import { emitAgentEvent } from '../agent/events.mts';
import {
  checkProgress,
  hasActed,
  monitorBody,
  newProgress,
  outputTokens,
  thinkingTokens,
  type CallProgress,
  type StallLimits,
} from './stream-monitor.mts';

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
 * Thrown when a streamed call sends no data for IDLE_TIMEOUT_SECONDS — the
 * connection has stalled, as opposed to a model that is still working.
 */
export class ModelStreamStalledError extends Error {

  public constructor(public readonly idleMs: number) {
    super(`Model stream stalled: no data for ${Math.round(idleMs / 1000)}s`);
    this.name = "ModelStreamStalledError";
  }
}

/**
 * Thrown when the model thinks past THINKING_BUDGET_TOKENS without starting an
 * answer. The retry tells the model to act instead of planning further.
 */
export class ThinkingBudgetExceededError extends Error {

  public constructor(public readonly thinkingTokens: number) {
    super(`Model thought for ~${Math.round(thinkingTokens / 1000)}k tokens without acting`);
    this.name = "ThinkingBudgetExceededError";
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
  if (
    err instanceof OllamaUnreachableError ||
    err instanceof ModelStreamStalledError ||
    err instanceof ThinkingBudgetExceededError
  ) {
    return true;
  }
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly label?: string;
  /** Hard per-attempt ceiling in ms. Defaults to CALL_TIMEOUT_SECONDS. */
  readonly callTimeoutMs?: number;
  /** Absolute epoch-ms deadline; no attempt or retry starts past it. */
  readonly deadlineMs?: number;
  /** Called when an attempt is abandoned, to cancel the in-flight request. */
  readonly onCallTimeout?: () => void;
  /**
   * Live progress of the current streamed request. When given, an attempt is
   * also abandoned when the stream goes idle or the model over-thinks.
   */
  readonly progress?: () => CallProgress | undefined;
  /** Overrides IDLE_TIMEOUT_SECONDS / THINKING_BUDGET_TOKENS (tests). */
  readonly limits?: StallLimits;
  /** How often the watchdog checks progress. */
  readonly pollMs?: number;
}

/** What the attempt function is told about the attempt it is making. */
export interface AttemptContext {
  readonly attempt: number;
  readonly lastError: unknown;
}

// Don't start a retry with less than this left before the deadline — it could
// not produce a useful answer and would only overrun the iteration.
const MIN_USEFUL_CALL_MS = 15_000;

// How often a running call reports its progress to the UI.
const PROGRESS_EVENT_MS = 3_000;

interface WatchOptions {
  readonly timeoutMs: number;
  readonly label: string;
  readonly attemptStartedAt: number;
  readonly onAbandon?: () => void;
  readonly progress?: () => CallProgress | undefined;
  readonly limits: StallLimits;
  readonly pollMs: number;
}

// The progress record for this attempt's request, ignoring a stale one left
// by an earlier call on the same model.
function currentProgress(opts: WatchOptions): CallProgress | undefined {
  const progress = opts.progress?.();
  return progress && progress.startedAt >= opts.attemptStartedAt ? progress : undefined;
}

/**
 * Race the attempt against a watchdog: the hard ceiling, plus — when progress
 * is available — an idle-stream check and the thinking budget.
 */
async function raceWatchdog<T>(work: Promise<T>, opts: WatchOptions): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastEventAt = opts.attemptStartedAt;
  const watchdog = new Promise<never>((_, reject) => {
    const abandon = (err: Error): void => {
      opts.onAbandon?.();
      reject(err);
    };
    timer = setInterval(() => {
      const now = Date.now();
      if (now - opts.attemptStartedAt >= opts.timeoutMs) {
        abandon(new ModelCallTimeoutError(opts.timeoutMs));
        return;
      }
      if (!opts.progress) return;
      // Before the request is sent there is no record yet; idle time counts
      // from the start of the attempt.
      const progress = currentProgress(opts) ?? newProgress(opts.attemptStartedAt);
      const stall = checkProgress(progress, now, opts.limits);
      if (stall === 'idle') {
        abandon(new ModelStreamStalledError(opts.limits.idleMs));
        return;
      }
      if (stall === 'thinking_budget') {
        abandon(new ThinkingBudgetExceededError(thinkingTokens(progress)));
        return;
      }
      if (now - lastEventAt >= PROGRESS_EVENT_MS) {
        lastEventAt = now;
        emitAgentEvent("model_progress", {
          label: opts.label,
          phase: hasActed(progress) ? "writing" : progress.thinkingChars > 0 ? "thinking" : "waiting",
          thinkingTokens: thinkingTokens(progress),
          outputTokens: outputTokens(progress),
          elapsedSeconds: Math.round((now - opts.attemptStartedAt) / 1000),
        });
      }
    }, opts.pollMs);
  });
  try {
    return await Promise.race([work, watchdog]);
  } finally {
    clearInterval(timer);
  }
}

/**
 * Run an Ollama call with exponential-backoff retry on transient errors.
 *
 * - Each attempt is capped at `callTimeoutMs` (default CALL_TIMEOUT_SECONDS).
 *   With `progress`, it is also abandoned when the stream sends nothing for
 *   IDLE_TIMEOUT_SECONDS or the model thinks past THINKING_BUDGET_TOKENS
 *   without acting. `onCallTimeout` cancels the request; the attempt is then
 *   retried, and `fn` is told why the previous attempt failed.
 * - With a `deadlineMs`, no attempt starts (and no retry is scheduled) once
 *   the remaining time is too short to be useful — a DeadlineExceededError is
 *   thrown instead, so retries can never overrun the iteration.
 * - A quota/rate-limit rejection is rethrown at once as QuotaExceededError.
 * - Any other non-transient error is rethrown immediately.
 */
export async function withOllamaRetry<T>(
  fn: (context: AttemptContext) => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  const label = options?.label ?? "ollama";
  const callTimeoutMs = options?.callTimeoutMs ?? env.CALL_TIMEOUT_SECONDS * 1000;
  const deadlineMs = options?.deadlineMs;
  const limits: StallLimits = options?.limits ?? {
    idleMs: env.IDLE_TIMEOUT_SECONDS * 1000,
    thinkingBudgetTokens: env.THINKING_BUDGET_TOKENS,
  };
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remainingMs = deadlineMs === undefined ? Infinity : deadlineMs - Date.now();
    if (remainingMs <= 0) throw new DeadlineExceededError(label);
    const attemptTimeoutMs = Math.min(callTimeoutMs, remainingMs);

    try {
      return await raceWatchdog(fn({ attempt, lastError }), {
        timeoutMs: attemptTimeoutMs,
        label,
        attemptStartedAt: Date.now(),
        ...(options?.onCallTimeout ? { onAbandon: options.onCallTimeout } : {}),
        ...(options?.progress ? { progress: options.progress } : {}),
        limits,
        pollMs: options?.pollMs ?? 1000,
      });
    } catch (err) {
      lastError = err;
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

// Per chat model: its in-flight HTTP requests, so an abandoned call can be
// cancelled at the socket, and the live progress of its latest chat request.
// ChatOllama only checks an AbortSignal between streamed chunks, so a request
// that never sends a byte would otherwise stay open server-side (still
// generating, still counting against quota) after we give up on it.
interface ModelRequests {
  readonly controllers: Set<AbortController>;
  progress: CallProgress | undefined;
}

const modelRequests = new WeakMap<ChatOllama, ModelRequests>();

function isChatRequest(input: Parameters<Fetch>[0]): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.endsWith("/api/chat");
}

function trackingFetch(state: ModelRequests): Fetch {
  const tracked = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
    const controller = new AbortController();
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    state.controllers.add(controller);
    const progress = isChatRequest(input) ? newProgress(Date.now()) : undefined;
    if (progress) state.progress = progress;
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (!progress || !response.body) return response;
      return new Response(monitorBody(response.body, progress), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      state.controllers.delete(controller);
      throw err;
    }
  };
  // Bun's fetch type also carries preconnect(); keep the wrapper a full fetch.
  return Object.assign(tracked, { preconnect: fetch.preconnect });
}

/** Abort every in-flight HTTP request made by this model. */
export function abortModelRequests(model: ChatOllama): void {
  const state = modelRequests.get(model);
  if (!state) return;
  for (const controller of state.controllers) controller.abort(new ModelCallTimeoutError(0));
  state.controllers.clear();
}

/** Live progress of this model's latest chat request, if any. */
export function modelProgress(model: ChatOllama): CallProgress | undefined {
  return modelRequests.get(model)?.progress;
}

/** The retry options that let withOllamaRetry watch and cancel this model's calls. */
export function watchModel(model: ChatOllama): Pick<RetryOptions, "onCallTimeout" | "progress"> {
  return {
    onCallTimeout: () => abortModelRequests(model),
    progress: () => modelProgress(model),
  };
}

export function createChatModel(model: string): ChatOllama {
  const headers = authHeaders();
  const chat = new ChatOllama({
    baseUrl: env.OLLAMA_BASE_URL,
    model,
    temperature: 0,
    numCtx: env.NUM_CTX,
    // Caps one reply, thinking included, so no call can generate without end.
    numPredict: env.MAX_OUTPUT_TOKENS,
    // Keep the HTTP connection alive to avoid socket-reset errors on long
    // generation runs. -1 means keep loaded indefinitely in Ollama.
    keepAlive: '-1m',
    ...(headers ? { headers } : {}),
  });

  // Swap in a client whose requests we can abort and watch (see modelRequests).
  const state: ModelRequests = { controllers: new Set<AbortController>(), progress: undefined };
  chat.client = new Ollama({
    host: env.OLLAMA_BASE_URL,
    ...(headers ? { headers } : {}),
    fetch: trackingFetch(state),
  });
  modelRequests.set(chat, state);
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
