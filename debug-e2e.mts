#!/usr/bin/env bun
// Phase 0-2 end-to-end validation harness (non-interactive, no Ink).
// Uses the known-good Kanban PRD so this exercises the BUILD loop
// (auto-split + compaction + guards + checklist), not PRD generation.
import { applyEnvOverrides } from './src/env.mts';
import { DevAgent } from './src/agent/index.mts';
import { agentEvents } from './src/agent/events.mts';
import { resolve } from 'node:path';

// Target Ollama Cloud. The local model tags don't all exist on cloud, so map
// each role to its nearest cloud equivalent. OLLAMA_API_KEY comes from .env.
applyEnvOverrides({
  OLLAMA_BASE_URL: 'https://ollama.com',
  PLANNER_MODEL: 'qwen3.5:397b',
  CODER_MODEL: 'qwen3-coder-next',
  EDITOR_MODEL: 'devstral-small-2:24b',
});

const workingDir = resolve('./test-run/e2e-phase012');
const prdFile = resolve('./prd-samples/original/prd.md');

console.log(`Working dir: ${workingDir}`);
console.log(`PRD file:    ${prdFile}`);
console.log(`Started:     ${new Date().toISOString()}\n`);

agentEvents.on('phase_changed', (e: unknown) => {
  const ev = e as { payload: { phase: string } };
  console.log(`[PHASE] ${ev.payload.phase}`);
});

agentEvents.on('prd_generated', (e: unknown) => {
  const ev = e as { payload: { featureName: string; taskCount: number } };
  console.log(`[PRD] Loaded: "${ev.payload.featureName}" (${ev.payload.taskCount} tasks)`);
});

agentEvents.on('task_started', (e: unknown) => {
  const ev = e as { payload: { taskId: string; taskName: string } };
  console.log(`\n[TASK] Starting: ${ev.payload.taskId} - ${ev.payload.taskName}`);
});

agentEvents.on('iteration_started', (e: unknown) => {
  const ev = e as { payload: { taskId: string; iteration: number } };
  console.log(`[ITER] Task ${ev.payload.taskId} iteration ${ev.payload.iteration}`);
});

agentEvents.on('tool_called', (e: unknown) => {
  const ev = e as { payload: { toolName: string } };
  process.stdout.write(`  -> ${ev.payload.toolName}\n`);
});

agentEvents.on('worker_output', (e: unknown) => {
  const ev = e as { payload: { taskId: string; iteration: number } };
  console.log(`[WORKER] Task ${ev.payload.taskId} iteration ${ev.payload.iteration} complete`);
});

agentEvents.on('reviewer_decision', (e: unknown) => {
  const ev = e as { payload: { taskId: string; decision: { decision: string } } };
  console.log(`[REVIEW] Task ${ev.payload.taskId}: ${ev.payload.decision.decision.toUpperCase()}`);
});

agentEvents.on('task_complete', (e: unknown) => {
  const ev = e as { payload: { taskId: string } };
  console.log(`[OK] Task ${ev.payload.taskId} SHIPPED`);
});

agentEvents.on('task_failed', (e: unknown) => {
  const ev = e as { payload: { taskId: string; reason: string } };
  console.log(`[X] Task ${ev.payload.taskId} FAILED: ${ev.payload.reason}`);
});

agentEvents.on('complete', (e: unknown) => {
  const ev = e as { payload: { featureName: string; completedCount: number; failedCount: number } };
  console.log(`\n[DONE] Feature "${ev.payload.featureName}" complete. ${ev.payload.completedCount} shipped, ${ev.payload.failedCount} failed.`);
});

agentEvents.on('error', (e: unknown) => {
  const ev = e as { payload: { message?: string } };
  console.error(`[ERROR] ${ev.payload.message ?? 'Unknown error'}`);
});

// maxIterations omitted -> DevAgent falls back to env.MAX_ITERATIONS (real budget).
const agent = new DevAgent({ workingDirectory: workingDir, prdFile });

try {
  await agent.run('Build the Kanban Board Core Logic & API per the provided PRD.');
  console.log(`\nAgent finished: ${new Date().toISOString()}`);
} catch (err) {
  console.error('Agent threw:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
