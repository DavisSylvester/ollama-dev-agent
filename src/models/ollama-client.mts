import { ChatOllama } from '@langchain/ollama';
import { env } from '../env.mts';
import { logger } from '../logger.mts';

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

/**
 * True when an error looks transient (connectivity/timeout) and is therefore
 * worth retrying. {@link OllamaUnreachableError} always qualifies.
 */
export function isTransientOllamaError(err: unknown): boolean {
  if (err instanceof OllamaUnreachableError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly label?: string;
}

/**
 * Run an Ollama call with exponential-backoff retry on transient errors. A
 * non-transient error (e.g. a bad request or a model error) is rethrown
 * immediately. Use this to wrap every worker/reviewer model invocation so a
 * brief cloud drop is retried transparently instead of burning an iteration.
 */
export async function withOllamaRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 2000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isTransientOllamaError(err)) throw err;
      const delayMs = baseDelayMs * 2 ** attempt;
      logger.warn(
        { attempt: attempt + 1, maxRetries, delayMs, label: options?.label ?? "ollama", error: String(err) },
        "ollama.transient_retry",
      );
      await Bun.sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error("withOllamaRetry: exhausted retries without returning");
}

export function createChatModel(model: string): ChatOllama {
  const headers = authHeaders();
  return new ChatOllama({
    baseUrl: env.OLLAMA_BASE_URL,
    model,
    temperature: 0,
    numCtx: env.NUM_CTX,
    // Keep the HTTP connection alive to avoid socket-reset errors on long
    // generation runs. -1 means keep loaded indefinitely in Ollama.
    keepAlive: '-1m',
    ...(headers ? { headers } : {}),
  });
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
