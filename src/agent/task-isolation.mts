import { execa } from 'execa';
import { mkdir, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DateTime } from 'luxon';
import { logger } from '../logger.mts';

// Tasks in one batch run at the same time. Sharing one working tree let a task's
// test command fail on a sibling's half-written files. Each task in a parallel
// batch instead works in its own git worktree, checked out from a snapshot of
// the current tree (uncommitted and untracked files included). When the batch
// settles, each completed task's changes are applied back to the real tree.

// Never copied into a snapshot or carried back in a patch: dependencies are
// linked in instead, and oda's own run records stay in the real tree.
const EXCLUDES: readonly string[] = [
  ':(exclude,glob)**/node_modules',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/.ai/**',
  ':(exclude,glob)**/feature-results/**',
];

// How deep to look for node_modules folders to link (root, apps/x, libs/x/y).
const NODE_MODULES_SEARCH_DEPTH = 4;

export interface IsolationBase {
  // The git top-level of the working directory.
  readonly repoRoot: string;
  // The working directory relative to repoRoot ('' when they are the same).
  readonly subPath: string;
  // Commit holding the tree as it was when the batch started.
  readonly snapshot: string;
}

export interface TaskWorkspace {
  readonly taskId: string;
  // The worktree's root folder.
  readonly root: string;
  // Where the task works: the worktree's copy of the working directory.
  readonly dir: string;
  readonly base: IsolationBase;
  // node_modules links created in the worktree (removed before the worktree).
  readonly links: string[];
}

export type MergeResult = { ok: true; filesChanged: number } | { ok: false; error: string };

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const proc = await execa('git', args, {
    cwd,
    reject: false,
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed: ${(proc.stderr || proc.stdout).trim()}`);
  }
  return proc.stdout.trim();
}

/**
 * Snapshot the working directory's repo for a parallel batch, or null when
 * isolation isn't possible (not a git repo, or no commit to build on yet).
 */
export async function prepareIsolation(workingDirectory: string): Promise<IsolationBase | null> {
  let repoRoot: string;
  try {
    repoRoot = await git(workingDirectory, ['rev-parse', '--show-toplevel']);
    await git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return null;
  }

  // Build the snapshot in a throwaway index so the user's index is untouched.
  const indexFile = join(tmpdir(), `oda-index-${DateTime.utc().toMillis()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(repoRoot, ['read-tree', 'HEAD'], env);
    await git(repoRoot, ['add', '-A', '--', '.', ...EXCLUDES], env);
    const tree = await git(repoRoot, ['write-tree'], env);
    const snapshot = await git(repoRoot, ['commit-tree', tree, '-p', 'HEAD', '-m', 'oda: parallel batch snapshot']);
    await git(repoRoot, ['worktree', 'prune']).catch(() => '');
    const subPath = relative(repoRoot, workingDirectory).replace(/\\/g, '/');
    return { repoRoot, subPath, snapshot };
  } catch (err) {
    logger.warn({ error: String(err) }, 'isolation.snapshot_failed: tasks run in the shared tree');
    return null;
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/** Create a worktree for one task, with the real tree's node_modules linked in. */
export async function createTaskWorkspace(base: IsolationBase, taskId: string): Promise<TaskWorkspace> {
  const root = join(
    tmpdir(),
    'oda-worktrees',
    `${taskId.replace(/[^A-Za-z0-9_-]/g, '_')}-${DateTime.utc().toMillis()}`,
  );
  await mkdir(dirname(root), { recursive: true });
  await git(base.repoRoot, ['worktree', 'add', '--detach', root, base.snapshot]);

  const links: string[] = [];
  for (const rel of await findNodeModules(base.repoRoot, NODE_MODULES_SEARCH_DEPTH)) {
    const link = join(root, rel);
    try {
      await mkdir(dirname(link), { recursive: true });
      // A junction needs no admin rights on Windows; elsewhere it is a symlink.
      await symlink(join(base.repoRoot, rel), link, 'junction');
      links.push(link);
    } catch (err) {
      logger.warn({ taskId, path: rel, error: String(err) }, 'isolation.link_failed');
    }
  }

  return { taskId, root, dir: base.subPath ? join(root, base.subPath) : root, base, links };
}

/** Repo-relative paths of node_modules folders (not descending into them). */
export async function findNodeModules(repoRoot: string, depth: number, rel: string = ''): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(join(repoRoot, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = rel ? join(rel, entry.name) : entry.name;
    if (entry.name === 'node_modules') {
      found.push(child);
    } else if (!entry.name.startsWith('.') && depth > 0) {
      found.push(...(await findNodeModules(repoRoot, depth - 1, child)));
    }
  }
  return found;
}

/** The task's changes against the batch snapshot, as a binary git patch. */
export async function collectPatch(workspace: TaskWorkspace): Promise<string> {
  await git(workspace.root, ['add', '-A', '--', '.', ...EXCLUDES]);
  return execa('git', ['diff', '--cached', '--binary', workspace.base.snapshot, '--', '.', ...EXCLUDES], {
    cwd: workspace.root,
    windowsHide: true,
    stripFinalNewline: false,
  }).then((p) => p.stdout);
}

/** Count the files a patch touches. */
export function countPatchFiles(patch: string): number {
  return (patch.match(/^diff --git /gm) ?? []).length;
}

/**
 * Apply a completed task's changes to the real tree. Fails without changing
 * anything when the patch no longer applies (a sibling changed the same lines).
 */
export async function mergeTaskWorkspace(workspace: TaskWorkspace): Promise<MergeResult> {
  let patch: string;
  try {
    patch = await collectPatch(workspace);
  } catch (err) {
    return { ok: false, error: `could not read the task's changes: ${String(err)}` };
  }
  const filesChanged = countPatchFiles(patch);
  if (filesChanged === 0) return { ok: true, filesChanged: 0 };

  const patchFile = join(tmpdir(), `oda-${workspace.taskId}-${DateTime.utc().toMillis()}.patch`);
  try {
    await writeFile(patchFile, patch, 'utf-8');
    const check = await execa('git', ['apply', '--check', '--binary', '--whitespace=nowarn', patchFile], {
      cwd: workspace.base.repoRoot,
      reject: false,
      windowsHide: true,
    });
    if (check.exitCode !== 0) {
      return { ok: false, error: (check.stderr || check.stdout).trim().split('\n').slice(0, 5).join(' | ') };
    }
    await git(workspace.base.repoRoot, ['apply', '--binary', '--whitespace=nowarn', patchFile]);
    return { ok: true, filesChanged };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await rm(patchFile, { force: true }).catch(() => undefined);
  }
}

/** Remove a task's worktree. Links are removed first so nothing is deleted through them. */
export async function removeTaskWorkspace(workspace: TaskWorkspace): Promise<void> {
  let allUnlinked = true;
  for (const link of workspace.links) {
    try {
      await unlink(link).catch(() => rmdir(link));
    } catch (err) {
      allUnlinked = false;
      logger.warn({ link, error: String(err) }, 'isolation.unlink_failed');
    }
  }
  if (!allUnlinked) {
    // A recursive delete could follow a surviving link into the real
    // node_modules. Leave the folder (it is under the OS temp dir) instead.
    logger.warn({ root: workspace.root }, 'isolation.worktree_left_in_place: a dependency link could not be removed');
    await git(workspace.base.repoRoot, ['worktree', 'prune']).catch(() => '');
    return;
  }
  await git(workspace.base.repoRoot, ['worktree', 'remove', '--force', workspace.root]).catch(() => '');
  await rm(workspace.root, { recursive: true, force: true }).catch(() => undefined);
  await git(workspace.base.repoRoot, ['worktree', 'prune']).catch(() => '');
}
