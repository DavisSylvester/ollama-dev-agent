import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';

// Load THIS package's .env regardless of the process cwd. Without this, the
// global `oda` command run from another directory falls back to schema defaults
// (local ollama + qwen3-coder/devstral), ignoring the configured cloud models.
// override:true so ODA's own config wins over a stray .env in the invocation dir.
// CLI flags still take precedence — they are applied after via applyEnvOverrides.
loadDotenv({ path: join(import.meta.dir, '..', '.env'), override: true });

const envSchema = z.object({
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  // Set when targeting Ollama Cloud (https://ollama.com). Sent as a Bearer token.
  OLLAMA_API_KEY: z.string().optional(),
  PLANNER_MODEL: z.string().default('qwen3.5:35b'),
  CODER_MODEL: z.string().default('qwen3-coder:30b'),
  EDITOR_MODEL: z.string().default('devstral-small-2'),
  MAX_ITERATIONS: z.coerce.number().int().min(1).max(50).default(30),
  MAX_REACT_STEPS: z.coerce.number().int().min(5).max(100).default(20),
  // Wall-clock cap per worker iteration (seconds). Independent of step count —
  // catches a single hung tool call that would otherwise consume the whole run.
  MAX_ITERATION_SECONDS: z.coerce.number().int().min(30).max(1800).default(420),
  REVIEWER_MAX_STEPS: z.coerce.number().int().min(3).max(20).default(8),
  PLANNER_MAX_STEPS: z.coerce.number().int().min(5).max(50).default(15),
  // Web-search-enabled planning. Disable for a fast single-shot PRD call.
  // Only the literal "false" / "0" turns it off (avoids the z.coerce.boolean truthiness trap).
  RESEARCH_PLANNING: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0'),
  // When a task fails (iteration cap), decompose it into sub-tasks and run those
  // instead of giving up. Self-correcting for oversized tasks.
  AUTO_SPLIT_ON_FAILURE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0'),
  NUM_CTX: z.coerce.number().int().min(2048).default(32768),
  BRAVE_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FILE: z.string().default('.oda.log'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.format();
    throw new Error(`Invalid environment configuration:\n${JSON.stringify(formatted, null, 2)}`);
  }
  return result.data;
}

export const env = loadEnv();

/**
 * Apply runtime overrides (e.g. from CLI flags) onto the loaded env singleton.
 * Only defined values are applied. Consumers read `env.*` at call-time, so
 * overriding here before the agent runs propagates everywhere.
 */
export function applyEnvOverrides(overrides: { [K in keyof Env]?: Env[K] | undefined }): void {
  const target = env as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}
