import { assertOllamaReachable } from '../src/models/index.mts';
import { runDebate } from '../src/prd/debate.mts';
import type { Task } from '../src/types/index.mts';

const task: Task = {
  id: 'TASK-001',
  name: 'Build the full notes feature',
  description:
    'Implement a Mongo repository, an Elysia route handler, and an Angular standalone component for notes, wired end to end.',
  acceptanceCriteria:
    'notes persist to Mongo; the API exposes CRUD routes returning ApiResponse; the UI lists and creates notes; validation rejects empty bodies.',
  testCommand: 'bun test',
  dependsOn: [],
  domain: 'services',
  status: 'pending',
  iterationCount: 0,
};

async function main(): Promise<void> {
  await assertOllamaReachable();
  console.log('Running debate against live Ollama (this is slow)...');
  const result = await runDebate(task);
  console.log('Decided by:', result.decidedBy, 'in', result.rounds.length, 'round(s)');
  console.log('Final stories:');
  for (const s of result.finalStories) console.log(` - ${s.name}: ${s.description}`);
  console.log('\nTranscript:\n' + result.transcript);
  if (result.finalStories.length < 2) {
    throw new Error('Expected at least 2 stories from the debate');
  }
  console.log('\nSmoke OK');
}

main().catch((err) => {
  console.error('Smoke FAILED:', err);
  process.exit(1);
});
