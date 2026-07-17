import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertOllamaReachable } from '../src/models/index.mts';
import { generatePRDFromDocs } from '../src/prd/index.mts';

async function main(): Promise<void> {
  await assertOllamaReachable();

  const docsDir = join('.tmp-docs-smoke', 'docs');
  const wd = join('.tmp-docs-smoke', 'wd');
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    join(docsDir, 'overview.md'),
    '# Notes API\nA service to create, list, and delete notes. Each note has a title and body. Expose REST endpoints returning an ApiResponse envelope.',
    'utf-8',
  );

  console.log('Generating PRD from docs against live Ollama (slow)...');
  const prd = await generatePRDFromDocs(docsDir, 'Build only the API', wd, (type, payload) =>
    console.log(`event: ${type}`, payload),
  );

  console.log('Feature:', prd.featureName);
  console.log('Tasks:', prd.tasks.length);
  for (const t of prd.tasks) console.log(` - ${t.id} [${t.domain}] ${t.name}`);

  await rm('.tmp-docs-smoke', { recursive: true, force: true });
  if (prd.tasks.length === 0) throw new Error('Expected at least one task');
  console.log('\nDocs-PRD smoke OK');
}

main().catch((err) => {
  console.error('Docs-PRD smoke FAILED:', err);
  process.exit(1);
});
