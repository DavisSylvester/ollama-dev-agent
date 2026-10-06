import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPlaybooks,
  loadPlaybooks,
  parsePlaybook,
  playbooksForDomain,
} from '../../src/playbooks/load-playbooks.mts';
import { buildReviewerPrompt, buildWorkerPrompt } from '../../src/prd/prompts.mts';
import type { Task } from '../../src/types/index.mts';

const playbook = (name: string, domain: string, body: string): string =>
  `---\nname: ${name}\ndomain: ${domain}\nkeywords: Angular, SCSS , signal\ndescription: d\n---\n${body}\n`;

describe('parsePlaybook', () => {
  it('reads the frontmatter and body', () => {
    const p = parsePlaybook(playbook('angular-ui', 'UI', '- Use signals.'), 'x.md');
    expect(p).toEqual({
      name: 'angular-ui', domain: 'ui', keywords: ['angular', 'scss', 'signal'],
      description: 'd', body: '- Use signals.', source: 'x.md',
    });
  });

  it('accepts Windows line endings', () => {
    expect(parsePlaybook(playbook('a', 'api', 'body').replace(/\n/g, '\r\n'), 'x')?.body).toBe('body');
  });

  it('rejects a file without frontmatter or without a domain', () => {
    expect(parsePlaybook('# just markdown', 'x')).toBeNull();
    expect(parsePlaybook('---\nname: a\n---\nbody', 'x')).toBeNull();
  });
});

describe('loadPlaybooks', () => {
  let shared: string;
  let project: string;

  beforeEach(() => {
    shared = mkdtempSync(join(tmpdir(), 'oda-pb-shared-'));
    project = mkdtempSync(join(tmpdir(), 'oda-pb-project-'));
    writeFileSync(join(shared, 'ui.md'), playbook('angular-ui', 'ui', 'shared ui rules'));
    writeFileSync(join(shared, 'api.md'), playbook('elysia-api', 'api', 'api rules'));
    writeFileSync(join(shared, 'notes.txt'), 'ignored');
    writeFileSync(join(shared, 'broken.md'), 'no frontmatter');
  });

  afterEach(() => {
    rmSync(shared, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('loads the shared folder and skips invalid files', async () => {
    const names = (await loadPlaybooks(project, shared)).map((p) => p.name).sort();
    expect(names).toEqual(['angular-ui', 'elysia-api']);
  });

  it("lets a project's playbook replace a shared one with the same name", async () => {
    mkdirSync(join(project, 'playbooks'));
    writeFileSync(join(project, 'playbooks', 'ui.md'), playbook('angular-ui', 'ui', 'project ui rules'));
    const ui = playbooksForDomain(await loadPlaybooks(project, shared), 'ui');
    expect(ui.map((p) => p.body)).toEqual(['project ui rules']);
  });

  it('returns nothing when the folders do not exist', async () => {
    expect(await loadPlaybooks(join(project, 'missing'), join(shared, 'missing'))).toEqual([]);
  });
});

describe('formatPlaybooks', () => {
  const p = parsePlaybook(playbook('angular-ui', 'ui', 'x'.repeat(500)), 'x')!;

  it('heads the section and clips it to the budget', () => {
    const out = formatPlaybooks([p], 100);
    expect(out).toStartWith('## Domain playbook');
    expect(out).toContain('(playbook truncated)');
    expect(out.length).toBeLessThan(200);
  });

  it('is empty with no playbooks or a zero budget', () => {
    expect(formatPlaybooks([], 6000)).toBe('');
    expect(formatPlaybooks([p], 0)).toBe('');
  });
});

describe('prompts carry the playbook', () => {
  const task: Task = {
    id: 'TASK-1', name: 'Board page', description: 'd', acceptanceCriteria: 'a', testCommand: 'bun test',
    dependsOn: [], domain: 'ui', status: 'pending', iterationCount: 0,
  };
  const section = '## Domain playbook — follow these rules for this task\n\n### angular-ui\n- Use signals.';

  it('puts it in the worker prompt, before the lessons', () => {
    const prompt = buildWorkerPrompt(task, 1, '', 'F', '/w', '', '', '', '## Lessons from prior runs', '', section);
    expect(prompt).toContain('- Use signals.');
    expect(prompt.indexOf('Domain playbook')).toBeLessThan(prompt.indexOf('Lessons from prior runs'));
  });

  it('puts it in the reviewer prompt', () => {
    expect(buildReviewerPrompt(task, 'report', 'F', [], '', section)).toContain('- Use signals.');
  });

  it('leaves the prompts unchanged without one', () => {
    expect(buildWorkerPrompt(task, 1, '', 'F', '/w')).not.toContain('Domain playbook');
  });
});
