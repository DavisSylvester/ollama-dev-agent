import { describe, expect, it, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPRDFromMarkdown } from '../../../src/prd/generator.mts';

const WD = join('tests', '.tmp-wd');

afterEach(async () => { await rm(join(WD, '.ai'), { recursive: true, force: true }); });

const SAMPLE = `# PRD: Notes App
**Feature Slug**: notes-app

## Overview
A notes app.

## Tasks
- [ ] **TASK-001**: Create note
  - **Domain**: api
  - **Description**: add a note
  - **Acceptance**: returns 201
  - **Test Command**: \`bun test\`
`;

describe('buildPRDFromMarkdown', () => {
  it('parses feature name, slug, and tasks from PRD markdown', async () => {
    const prd = await buildPRDFromMarkdown(SAMPLE, WD);
    expect(prd.featureName).toBe('Notes App');
    expect(prd.featureSlug).toBe('notes-app');
    expect(prd.tasks).toHaveLength(1);
    expect(prd.tasks[0]!.domain).toBe('api');
  });
});
