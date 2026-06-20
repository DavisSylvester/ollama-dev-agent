import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePRD } from '../../../src/prd/generator.mts';
import type { PRDGeneratorDeps } from '../../../src/prd/generator.mts';
import { REACT_TIMEOUT_SENTINEL } from '../../../src/models/react-agent.mts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PRD = `# PRD: Notes API
**Feature Slug**: notes-api

## Overview
A simple notes API.

## Goals
- Persist notes

## Technical Approach
Elysia on Bun.

## Tasks
- [ ] **TASK-001**: Scaffold the server
  - **Description**: Create the Elysia entrypoint
  - **Acceptance**: server boots and /health returns 200
  - **Test Command**: \`bun test src/index.test.mts\`

## Acceptance Criteria
- [ ] API responds

## Out of Scope
- Auth
`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'prd-gen-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generatePRD — research-enabled planning', () => {
  it('parses the agent output into a structured PRD', async () => {
    const deps: PRDGeneratorDeps = {
      runAgentFn: async () => SAMPLE_PRD,
    };

    const prd = await generatePRD('build a notes api', tmpDir, undefined, deps);

    expect(prd.featureName).toBe('Notes API');
    expect(prd.featureSlug).toBe('notes-api');
    expect(prd.tasks).toHaveLength(1);
    expect(prd.tasks[0]!.id).toBe('TASK-001');
    expect(prd.goals).toContain('Persist notes');
    expect(prd.outOfScope).toContain('Auth');
  });

  it('passes the planner tools and step budget to the agent runner', async () => {
    let receivedTools: unknown[] = [];
    let receivedMaxSteps: number | undefined;

    const deps: PRDGeneratorDeps = {
      runAgentFn: async (_model, tools, _system, _user, maxSteps) => {
        receivedTools = tools;
        receivedMaxSteps = maxSteps;
        return SAMPLE_PRD;
      },
    };

    await generatePRD('build a notes api', tmpDir, undefined, deps);

    // Read-only research tools: read_file, list_directory, glob, grep, ddg, brave
    const toolNames = receivedTools.map((t) => (t as { name: string }).name);
    expect(toolNames).toContain('web_search_ddg');
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('grep_search');
    // No mutating tools leak into planning
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('shell_exec');
    expect(typeof receivedMaxSteps).toBe('number');
  });

  it('forwards tool-call events to the onToolCall callback', async () => {
    const calls: string[] = [];

    const deps: PRDGeneratorDeps = {
      runAgentFn: async (_model, _tools, _system, _user, _maxSteps, onToolCall) => {
        onToolCall?.('web_search_ddg', { query: 'elysia latest' });
        onToolCall?.('read_file', { path: 'package.json' });
        return SAMPLE_PRD;
      },
    };

    await generatePRD('build a notes api', tmpDir, (name) => calls.push(name), deps);

    expect(calls).toEqual(['web_search_ddg', 'read_file']);
  });

  it('writes prd.md and tasks.md under .ai/planning/<slug>', async () => {
    const deps: PRDGeneratorDeps = {
      runAgentFn: async () => SAMPLE_PRD,
    };

    await generatePRD('build a notes api', tmpDir, undefined, deps);

    const prdPath = join(tmpDir, '.ai', 'planning', 'notes-api', 'prd.md');
    const tasksPath = join(tmpDir, '.ai', 'planning', 'notes-api', 'tasks.md');

    const prdContent = await readFile(prdPath, 'utf-8');
    const tasksContent = await readFile(tasksPath, 'utf-8');

    expect(prdContent).toContain('# PRD: Notes API');
    expect(tasksContent).toContain('TASK-001');
  });

  it('throws when the planner exhausts its step budget', async () => {
    const deps: PRDGeneratorDeps = {
      runAgentFn: async () =>
        `${REACT_TIMEOUT_SENTINEL} (15) without a final answer. Tools attempted: web_search_ddg.`,
    };

    await expect(generatePRD('build a notes api', tmpDir, undefined, deps)).rejects.toThrow(
      /PRD generation failed/,
    );
  });
});
