import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { logger } from '../logger.mts';
import type { PRD, Task } from '../types/index.mts';

export const RUN_STATE_VERSION = 1;

export interface RunState {
  version: number;
  featureSlug: string;
  featureName: string;
  userPrompt: string;
  prdFile: string | null;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
  prd: PRD | null;
  tasks: Task[];
}

function stateDir(featureSlug: string): string {
  return join('feature-results', featureSlug);
}

function statePath(featureSlug: string): string {
  return join(stateDir(featureSlug), 'state.json');
}

// Write state.json. Preserves the createdAt of any existing file so the first
// write's timestamp survives later batch updates; always refreshes updatedAt.
export async function saveRunState(state: RunState): Promise<void> {
  const dir = stateDir(state.featureSlug);
  await mkdir(dir, { recursive: true });

  let createdAt = state.createdAt;
  const existing = await loadRunState(state.featureSlug);
  if (existing) createdAt = existing.createdAt;

  const toWrite: RunState = {
    ...state,
    version: RUN_STATE_VERSION,
    createdAt,
    updatedAt: DateTime.utc().toISO() ?? state.updatedAt,
  };
  await writeFile(statePath(state.featureSlug), JSON.stringify(toWrite, null, 2), 'utf-8');
}

// Read + parse one state file. Returns null on missing/unreadable/malformed or
// version-mismatched content — never throws.
export async function loadRunState(featureSlug: string): Promise<RunState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(featureSlug), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RunState;
    if (parsed.version !== RUN_STATE_VERSION) {
      logger.warn({ featureSlug, version: parsed.version }, 'run_state.version_mismatch');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn({ featureSlug, err: err instanceof Error ? err.message : String(err) }, 'run_state.parse_failed');
    return null;
  }
}

// Scan feature-results/*/state.json for a resumable match: same working dir,
// same identity (prdFile path when given, else userPrompt), and at least one
// task not yet complete. Returns the newest match by updatedAt, or null.
export async function findResumableRun(
  workingDirectory: string,
  userPrompt: string,
  prdFile: string | null,
): Promise<RunState | null> {
  let slugs: string[];
  try {
    slugs = await readdir('feature-results');
  } catch {
    return null;
  }

  const candidates: RunState[] = [];
  for (const slug of slugs) {
    const state = await loadRunState(slug);
    if (!state) continue;

    const sameDir = state.workingDirectory === workingDirectory;
    const idMatch = prdFile != null ? state.prdFile === prdFile : state.userPrompt === userPrompt;
    const hasWork = state.tasks.some((t) => t.status !== 'complete');
    if (sameDir && idMatch && hasWork) candidates.push(state);
  }

  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0] ?? null;
}
