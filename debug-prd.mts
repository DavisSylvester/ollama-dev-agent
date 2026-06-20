#!/usr/bin/env bun
// Debug script - tests PRD generation without Ink UI
import { generatePRD } from './src/prd/index.mts';

const workingDir = './test-run/kanban';
const prompt = 'Create a Kanban Board ensuring you can move cards between stages. No database persistence is required.';

console.log('Testing PRD generation...\n');
console.log(`Prompt: ${prompt}`);
console.log(`Working dir: ${workingDir}\n`);

try {
  const prd = await generatePRD(prompt, workingDir);
  console.log('=== PRD Generated ===');
  console.log(`Feature: ${prd.featureName}`);
  console.log(`Slug: ${prd.featureSlug}`);
  console.log(`Tasks: ${prd.tasks.length}`);
  console.log('\nTask list:');
  for (const task of prd.tasks) {
    console.log(`  ${task.id}: ${task.name}`);
  }
  console.log('\n=== Full PRD ===');
  console.log(prd.rawMarkdown);
} catch (err) {
  console.error('FAILED:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
