import { ChatOllama } from '@langchain/ollama';
import { env } from '../env.mts';
import { logger } from '../logger.mts';

export function createChatModel(model: string): ChatOllama {
  return new ChatOllama({
    baseUrl: env.OLLAMA_BASE_URL,
    model,
    temperature: 0,
    numCtx: env.NUM_CTX,
    // Keep the HTTP connection alive to avoid socket-reset errors on long
    // generation runs. -1 means keep loaded indefinitely in Ollama.
    keepAlive: '-1m',
  });
}

const CODER_FALLBACKS = ['qwen3-coder:30b', 'devstral-small-2:24b', 'deepseek-r1:32b'] as const;

async function fetchAvailableModels(): Promise<Set<string>> {
  try {
    const response = await fetch(`${env.OLLAMA_BASE_URL}/api/tags`);
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
