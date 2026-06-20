#!/usr/bin/env bun
// Debug script - runs agent without Ink to surface raw errors
import { DevAgent } from './src/agent/index.mts';
import { agentEvents } from './src/agent/events.mts';
import { resolve } from 'node:path';

const workingDir = resolve('./test-run/kanban');
const prompt = 'Create a Kanban Board ensuring you can move cards between stages. No database persistence is required.';

console.log(`Working dir: ${workingDir}`);

// Subscribe to all events for debugging
agentEvents.on('phase_changed', (e: unknown) => {
  const ev = e as { payload: { phase: string } };
  console.log(`[PHASE] ${ev.payload.phase}`);
});

agentEvents.on('prd_generated', (e: unknown) => {
  const ev = e as { payload: { featureName: string; taskCount: number } };
  console.log(`[PRD] Generated: "${ev.payload.featureName}" (${ev.payload.taskCount} tasks)`);
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
  process.stdout.write(`  → ${ev.payload.toolName}\n`);
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
  console.log(`[✓] Task ${ev.payload.taskId} SHIPPED`);
});

agentEvents.on('task_failed', (e: unknown) => {
  const ev = e as { payload: { taskId: string; reason: string } };
  console.log(`[✗] Task ${ev.payload.taskId} FAILED: ${ev.payload.reason}`);
});

agentEvents.on('complete', (e: unknown) => {
  const ev = e as { payload: { featureName: string; completedCount: number; failedCount: number } };
  console.log(`\n[DONE] Feature "${ev.payload.featureName}" complete. ${ev.payload.completedCount} shipped, ${ev.payload.failedCount} failed.`);
});

agentEvents.on('error', (e: unknown) => {
  const ev = e as { payload: { message?: string } };
  console.error(`[ERROR] ${ev.payload.message ?? 'Unknown error'}`);
});

const agent = new DevAgent({ workingDirectory: workingDir, maxIterations: 3 });

try {
  await agent.run(prompt);
  console.log('\nAgent finished.');
} catch (err) {
  console.error('Agent threw:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
