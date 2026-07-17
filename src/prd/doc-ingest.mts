import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

export const DOC_EXTENSIONS = ['.md', '.mdx', '.txt', '.rst'] as const;
export const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', '.ai', 'coverage', 'out'] as const;

const ignored: readonly string[] = IGNORED_DIRS;
const allowed: readonly string[] = DOC_EXTENSIONS;

// Recursively collect text-doc files under docsDir, skipping ignored directory
// names and non-doc extensions. Deterministic (sorted). Missing dir => [].
export async function collectDocFiles(docsDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignored.includes(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && allowed.includes(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }

  await walk(docsDir);
  return out.sort();
}
