import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  countPatchFiles,
  createTaskWorkspace,
  findNodeModules,
  mergeTaskWorkspace,
  prepareIsolation,
  removeTaskWorkspace,
} from '../../src/agent/task-isolation.mts';

// Real git, real worktrees, in a throwaway repo under the OS temp dir.

let repo: string;

async function git(...args: string[]): Promise<string> {
  return (await execa('git', args, { cwd: repo })).stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'oda-isolation-'));
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'oda test');
  await writeFile(join(repo, '.gitignore'), 'node_modules\n.ai/\n');
  await writeFile(join(repo, 'shared.mts'), 'export const a: number = 1;\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');

  // State an earlier oda task left behind: uncommitted edit + untracked file.
  await writeFile(join(repo, 'shared.mts'), 'export const a: number = 2;\n');
  await writeFile(join(repo, 'earlier-task.mts'), 'export const earlier: boolean = true;\n');
  await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
});

afterEach(async () => {
  await execa('git', ['worktree', 'prune'], { cwd: repo, reject: false });
  await rm(repo, { recursive: true, force: true });
});

describe('task isolation', () => {
  it('returns null outside a git repo', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'oda-plain-'));
    try {
      expect(await prepareIsolation(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('snapshots uncommitted and untracked work without touching the user index', async () => {
    const statusBefore = await git('status', '--porcelain');
    const base = await prepareIsolation(repo);
    expect(base).not.toBeNull();
    expect(await git('status', '--porcelain')).toBe(statusBefore);

    const ws = await createTaskWorkspace(base!, 'TASK-001');
    try {
      expect(await readFile(join(ws.dir, 'shared.mts'), 'utf-8')).toContain('= 2');
      expect(await exists(join(ws.dir, 'earlier-task.mts'))).toBe(true);
      // Dependencies are linked in, not copied.
      expect(await exists(join(ws.dir, 'node_modules', 'dep', 'index.js'))).toBe(true);
    } finally {
      await removeTaskWorkspace(ws);
    }
  });

  it('merges a completed task back and leaves the real node_modules intact on cleanup', async () => {
    const base = (await prepareIsolation(repo))!;
    const ws = await createTaskWorkspace(base, 'TASK-002');
    await writeFile(join(ws.dir, 'new-file.mts'), 'export const n: number = 3;\n');

    const merged = await mergeTaskWorkspace(ws);
    await removeTaskWorkspace(ws);

    expect(merged).toEqual({ ok: true, filesChanged: 1 });
    expect(await readFile(join(repo, 'new-file.mts'), 'utf-8')).toContain('n: number = 3');
    expect(await exists(ws.root)).toBe(false);
    expect(await exists(join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });

  it('reports a conflict, without changing the real tree, when two tasks edit the same line', async () => {
    const base = (await prepareIsolation(repo))!;
    const first = await createTaskWorkspace(base, 'TASK-A');
    const second = await createTaskWorkspace(base, 'TASK-B');
    try {
      await writeFile(join(first.dir, 'shared.mts'), 'export const a: number = 10;\n');
      await writeFile(join(second.dir, 'shared.mts'), 'export const a: number = 20;\n');

      expect((await mergeTaskWorkspace(first)).ok).toBe(true);
      const conflict = await mergeTaskWorkspace(second);

      expect(conflict.ok).toBe(false);
      expect(await readFile(join(repo, 'shared.mts'), 'utf-8')).toContain('= 10');
    } finally {
      await removeTaskWorkspace(first);
      await removeTaskWorkspace(second);
    }
  });

  it('merges two tasks that touch different files', async () => {
    const base = (await prepareIsolation(repo))!;
    const first = await createTaskWorkspace(base, 'TASK-C');
    const second = await createTaskWorkspace(base, 'TASK-D');
    try {
      await writeFile(join(first.dir, 'c.mts'), 'export const c: number = 1;\n');
      await writeFile(join(second.dir, 'd.mts'), 'export const d: number = 1;\n');
      expect((await mergeTaskWorkspace(first)).ok).toBe(true);
      expect((await mergeTaskWorkspace(second)).ok).toBe(true);
      expect(await exists(join(repo, 'c.mts'))).toBe(true);
      expect(await exists(join(repo, 'd.mts'))).toBe(true);
    } finally {
      await removeTaskWorkspace(first);
      await removeTaskWorkspace(second);
    }
  });
});

describe('findNodeModules', () => {
  it('finds node_modules folders without descending into them', async () => {
    await mkdir(join(repo, 'apps', 'api', 'node_modules', 'x', 'node_modules'), { recursive: true });
    const found = (await findNodeModules(repo, 4)).map((p) => p.replace(/\\/g, '/')).sort();
    expect(found).toEqual(['apps/api/node_modules', 'node_modules']);
  });
});

describe('countPatchFiles', () => {
  it('counts the files in a git patch', () => {
    expect(countPatchFiles('')).toBe(0);
    expect(countPatchFiles('diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n')).toBe(2);
  });
});
