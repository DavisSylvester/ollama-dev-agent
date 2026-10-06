import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { env } from '../env.mts';
import { logger } from '../logger.mts';

// Domain playbooks: plain Markdown instructions for one kind of task (Angular
// UI, Elysia API, MongoDB repository …), added to the worker and reviewer
// prompts only for tasks in that domain. They are ordinary files shared with
// silo, never tied to any one model provider:
//
//   ---
//   name: angular-ui
//   domain: ui
//   keywords: angular, standalone component, scss
//   description: Angular frontends with signals and SCSS
//   ---
//   <instructions>
//
// Shared playbooks live in ~/.ollama-agents/playbooks (PLAYBOOKS_DIR); a
// project's own playbooks/ folder overrides one with the same name.

const FrontmatterSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  domain: Type.String({ minLength: 1 }),
  keywords: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

type Frontmatter = Static<typeof FrontmatterSchema>;

export interface Playbook {
  name: string;
  domain: string;
  keywords: string[];
  description: string;
  body: string;
  source: string;
}

export const DEFAULT_PLAYBOOKS_DIR = join(homedir(), '.ollama-agents', 'playbooks');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse one playbook file, or null when its frontmatter is missing or invalid. */
export function parsePlaybook(text: string, source: string): Playbook | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (!Value.Check(FrontmatterSchema, fields)) return null;
  const meta: Frontmatter = Value.Parse(FrontmatterSchema, fields);
  return {
    name: meta.name,
    domain: meta.domain.toLowerCase(),
    keywords: (meta.keywords ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
    description: meta.description ?? '',
    body: (match[2] ?? '').trim(),
    source,
  };
}

async function readDir(dir: string): Promise<Playbook[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const playbooks: Playbook[] = [];
  for (const name of names.sort()) {
    const source = join(dir, name);
    try {
      const playbook = parsePlaybook(await readFile(source, 'utf-8'), source);
      if (playbook) playbooks.push(playbook);
      else logger.warn({ source }, 'playbooks.invalid_frontmatter');
    } catch (err) {
      logger.warn({ source, error: String(err) }, 'playbooks.read_failed');
    }
  }
  return playbooks;
}

/**
 * Load the shared playbooks, then the project's own; a project playbook
 * replaces a shared one with the same name.
 */
export async function loadPlaybooks(workingDirectory: string, sharedDir: string = DEFAULT_PLAYBOOKS_DIR): Promise<Playbook[]> {
  const byName = new Map<string, Playbook>();
  for (const dir of [resolve(sharedDir), resolve(workingDirectory, 'playbooks')]) {
    for (const playbook of await readDir(dir)) byName.set(playbook.name, playbook);
  }
  return [...byName.values()];
}

/** The playbooks written for this task domain. */
export function playbooksForDomain(playbooks: readonly Playbook[], domain: string): Playbook[] {
  return playbooks.filter((p) => p.domain === domain.toLowerCase());
}

/**
 * The prompt section for the chosen playbooks, at most `maxChars` long so a
 * large playbook cannot crowd out the task itself.
 */
export function formatPlaybooks(playbooks: readonly Playbook[], maxChars: number = 6000): string {
  if (playbooks.length === 0 || maxChars <= 0) return '';
  const body = playbooks.map((p) => `### ${p.name}\n${p.body}`).join('\n\n');
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars).trimEnd()}\n…(playbook truncated)` : body;
  return `## Domain playbook — follow these rules for this task\n\n${clipped}`;
}

/** The playbook section for a task in this domain, using the configured folder and budget. */
export async function playbookSectionFor(workingDirectory: string, domain: string): Promise<string> {
  if (env.PLAYBOOK_MAX_CHARS <= 0) return '';
  const playbooks = await loadPlaybooks(workingDirectory, env.PLAYBOOKS_DIR ?? DEFAULT_PLAYBOOKS_DIR);
  return formatPlaybooks(playbooksForDomain(playbooks, domain), env.PLAYBOOK_MAX_CHARS);
}
