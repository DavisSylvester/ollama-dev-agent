import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from '../logger.mts';
import type { Task, KBCategory, KBEntry, KnowledgeBase } from '../types/index.mts';

// Global knowledge base lives at the ODA repo root (resolved from this module,
// NOT the target working directory) so learnings persist across every project
// and survive the working dir being wiped between runs. Override with the
// ODA_KB_DIR env var (used by tests to avoid polluting the real KB).
const DEFAULT_KB_DIR = resolve(import.meta.dir, '../../.ai/knowledge-base');

function kbDir(): string {
  return process.env['ODA_KB_DIR'] ?? DEFAULT_KB_DIR;
}

const CATEGORIES: readonly KBCategory[] = ['ui', 'api', 'database', 'auth'];

function categoryFile(category: KBCategory): string {
  return resolve(kbDir(), `${category}.json`);
}

function emptyKnowledgeBase(): KnowledgeBase {
  return { ui: [], api: [], database: [], auth: [] };
}

async function readCategory(category: KBCategory): Promise<KBEntry[]> {
  try {
    const raw = await readFile(categoryFile(category), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as KBEntry[]) : [];
  } catch {
    // Missing or unreadable file → no entries yet for this category.
    return [];
  }
}

export async function loadKnowledgeBase(): Promise<KnowledgeBase> {
  const kb = emptyKnowledgeBase();
  for (const category of CATEGORIES) {
    kb[category] = await readCategory(category);
  }
  return kb;
}

export async function appendEntry(category: KBCategory, entry: KBEntry): Promise<void> {
  try {
    await mkdir(kbDir(), { recursive: true });
    const existing = await readCategory(category);
    existing.push(entry);
    await writeFile(categoryFile(category), JSON.stringify(existing, null, 2), 'utf-8');
    logger.info({ category, issue: entry.issue.slice(0, 80) }, 'kb.entry_logged');
  } catch (err) {
    // Knowledge base is best-effort — never let it break a run.
    logger.warn({ category, error: String(err) }, 'kb.append_failed');
  }
}

// Heuristic mapping of a task to a knowledge-base category, based on its name
// and description. Order matters: auth is checked last so generic terms don't
// shadow database/api/ui signals.
export function categorizeTask(task: Task): KBCategory {
  const text = `${task.name} ${task.description}`.toLowerCase();
  if (/\b(angular|component|\bui\b|frontend|scss|template|form|page|signal)\b/.test(text)) {
    return 'ui';
  }
  if (/\b(database|sql|mongo|postgres|repository|persistence|schema|migration|orm)\b/.test(text)) {
    return 'database';
  }
  // Server-specific terms only — NOT the bare word "api", which appears in
  // phrases like "auth0 management api" that are really auth concerns.
  if (/\b(elysia|endpoint|route|server|controller|onerror|fastify|express|rest)\b/.test(text)) {
    return 'api';
  }
  if (/\b(auth0|auth|login|token|password|user|organization|connection|m2m|oauth|jwt)\b/.test(text)) {
    return 'auth';
  }
  return 'api';
}

// Build the prompt section fed to the worker each iteration. Includes the task's
// own category first (most relevant), then any other categories with entries.
export function formatForPrompt(kb: KnowledgeBase, primary: KBCategory): string {
  const ordered: KBCategory[] = [primary, ...CATEGORIES.filter((c) => c !== primary)];
  const sections: string[] = [];

  for (const category of ordered) {
    const entries = kb[category];
    if (!entries || entries.length === 0) continue;
    const lines = entries
      .slice(-10) // most recent 10 per category keeps the prompt bounded
      .map((e) => {
        const model = e.model ? ` _(model: ${e.model})_` : '';
        return `- **Issue**: ${e.issue}\n  **Resolution**: ${e.resolution || 'unresolved'}${model}`;
      });
    sections.push(`### ${category.toUpperCase()}\n${lines.join('\n')}`);
  }

  if (sections.length === 0) return '';

  return [
    `## Known Issues & Resolutions (from prior runs)`,
    ``,
    `These problems were hit in past runs. Apply the resolutions proactively to avoid repeating them:`,
    ``,
    sections.join('\n\n'),
  ].join('\n');
}
