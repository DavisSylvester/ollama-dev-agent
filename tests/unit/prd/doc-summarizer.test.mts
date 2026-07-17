import { describe, expect, it, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeDocs, reduceSummaries } from '../../../src/prd/doc-summarizer.mts';

const ROOT = join('tests', '.tmp-sum');

afterEach(async () => { await rm(ROOT, { recursive: true, force: true }); });

async function file(name: string, body: string): Promise<string> {
  const full = join(ROOT, name);
  await mkdir(ROOT, { recursive: true });
  await writeFile(full, body, 'utf-8');
  return full;
}

describe('summarizeDocs', () => {
  it('summarizes one file per invoke call and reports progress', async () => {
    const f1 = await file('a.md', 'alpha');
    const f2 = await file('b.md', 'beta');
    let calls = 0;
    const progress: number[] = [];
    const out = await summarizeDocs(ROOT, [f1, f2], {
      invokeFn: async () => { calls++; return `summary ${calls}`; },
      onProgress: (done) => progress.push(done),
    });
    expect(calls).toBe(2);
    expect(out.map((s) => s.relPath).sort()).toEqual(['a.md', 'b.md']);
    expect(progress).toEqual([1, 2]);
  });

  it('skips a file whose summary comes back empty', async () => {
    const f1 = await file('a.md', 'alpha');
    const out = await summarizeDocs(ROOT, [f1], { invokeFn: async () => '   ' });
    expect(out).toEqual([]);
  });
});

describe('summarizeDocs caching', () => {
  it('writes to the cache and skips the invoke on the second pass', async () => {
    const f1 = await file('a.md', 'alpha');
    const cacheDir = join(ROOT, '.cache');
    let calls = 0;
    const inv = async (): Promise<string> => { calls++; return 'cached summary'; };

    const first = await summarizeDocs(ROOT, [f1], { invokeFn: inv, cacheDir });
    const second = await summarizeDocs(ROOT, [f1], { invokeFn: inv, cacheDir });

    expect(calls).toBe(1); // second pass hit the cache
    expect(first[0]!.summary).toBe('cached summary');
    expect(second[0]!.summary).toBe('cached summary');
  });
});

describe('chunking + reduceSummaries', () => {
  it('chunks a file larger than maxContentChars into multiple invoke calls', async () => {
    const big = await file('big.md', 'x'.repeat(50));
    let calls = 0;
    const out = await summarizeDocs(ROOT, [big], {
      invokeFn: async () => { calls++; return `part ${calls}`; },
      maxContentChars: 20, // 50 chars => 3 chunks
    });
    expect(calls).toBe(3);
    expect(out[0]!.summary).toContain('part 1');
    expect(out[0]!.summary).toContain('part 3');
  });

  it('reduceSummaries folds when combined length exceeds the budget', async () => {
    const summaries = [
      { relPath: 'a', summary: 'aaaa' },
      { relPath: 'b', summary: 'bbbb' },
      { relPath: 'c', summary: 'cccc' },
    ];
    let calls = 0;
    const out = await reduceSummaries(summaries, {
      invokeFn: async () => { calls++; return `merged ${calls}`; },
      maxContentChars: 6, // forces folding
    });
    expect(calls).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(summaries.length);
  });

  it('reduceSummaries returns input unchanged when under budget', async () => {
    const summaries = [{ relPath: 'a', summary: 'aa' }];
    const out = await reduceSummaries(summaries, { invokeFn: async () => 'unused', maxContentChars: 1000 });
    expect(out).toEqual(summaries);
  });
});
