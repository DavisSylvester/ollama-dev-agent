import { z } from 'zod';

const envSchema = z.object({
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  // Set when targeting Ollama Cloud (https://ollama.com). Sent as a Bearer token.
  OLLAMA_API_KEY: z.string().optional(),
  PLANNER_MODEL: z.string().default('qwen3.5:35b'),
  CODER_MODEL: z.string().default('qwen3-coder:30b'),
  EDITOR_MODEL: z.string().default('devstral-small-2'),
  MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(5),
  MAX_REACT_STEPS: z.coerce.number().int().min(5).max(100).default(20),
  REVIEWER_MAX_STEPS: z.coerce.number().int().min(3).max(20).default(8),
  PLANNER_MAX_STEPS: z.coerce.number().int().min(5).max(50).default(15),
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
