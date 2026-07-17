import { describe, expect, it, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDocFiles } from '../../../src/prd/doc-ingest.mts';

const ROOT = join('tests', '.tmp-docs');

afterEach(async () => { await rm(ROOT, { recursive: true, force: true }); });

async function seed(): Promise<void> {
  await mkdir(join(ROOT, 'memory'), { recursive: true });
  await mkdir(join(ROOT, 'node_modules'), { recursive: true });
  await writeFile(join(ROOT, 'a.md'), '# A', 'utf-8');
  await writeFile(join(ROOT, 'memory', 'b.txt'), 'B', 'utf-8');
  await writeFile(join(ROOT, 'c.png'), 'binary', 'utf-8');       // wrong ext
  await writeFile(join(ROOT, 'node_modules', 'd.md'), 'skip', 'utf-8'); // ignored dir
}

describe('collectDocFiles', () => {
  it('recursively collects text docs, skipping ignored dirs and non-doc extensions', async () => {
    await seed();
    const files = await collectDocFiles(ROOT);
    const rel = files.map((f) => f.replace(/\\/g, '/'));
    expect(rel.some((f) => f.endsWith('a.md'))).toBe(true);
    expect(rel.some((f) => f.endsWith('memory/b.txt'))).toBe(true);
    expect(rel.some((f) => f.endsWith('c.png'))).toBe(false);
    expect(rel.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('returns [] for a missing directory', async () => {
    expect(await collectDocFiles(join(ROOT, 'nope'))).toEqual([]);
  });
});
