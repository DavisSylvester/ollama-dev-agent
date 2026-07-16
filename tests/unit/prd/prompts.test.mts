import { describe, it, expect } from 'bun:test';
import {
  buildWorkerPrompt,
  buildReviewerPrompt,
  buildPRDGenerationPrompt,
  buildDebateProposalPrompt,
  buildPersonaCritiquePrompt,
  buildDebateSynthesisPrompt,
} from '../../../src/prd/prompts.mts';
import type { Task } from '../../../src/types/index.mts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PENDING_TASK: Task = {
  id: 'TASK-001',
  name: 'Initialize project',
  description: 'Set up tsconfig and directory structure',
  acceptanceCriteria: 'tsconfig.json exists with strict:true',
  testCommand: 'bun run build',
  dependsOn: [],
  domain: 'services',
  status: 'pending',
  iterationCount: 0,
};

// ---------------------------------------------------------------------------
// buildPRDGenerationPrompt
// ---------------------------------------------------------------------------

describe('buildPRDGenerationPrompt', () => {
  it('includes the user prompt verbatim', () => {
    const prompt = buildPRDGenerationPrompt('Build a kanban board');
    expect(prompt).toContain('Build a kanban board');
  });

  it('specifies the required PRD markdown format', () => {
    const prompt = buildPRDGenerationPrompt('anything');
    expect(prompt).toContain('**Feature Slug**');
    expect(prompt).toContain('TASK-001');
    expect(prompt).toContain('Test Command');
  });

  it('mentions BunJS and TypeScript strict mode', () => {
    const prompt = buildPRDGenerationPrompt('anything');
    expect(prompt).toContain('BunJS');
    expect(prompt).toContain('strict mode');
  });

  it('requires .mts extension', () => {
    const prompt = buildPRDGenerationPrompt('anything');
    expect(prompt).toContain('.mts');
  });

  it('includes explicit task-sizing rules (Phase 0.1)', () => {
    const prompt = buildPRDGenerationPrompt('anything');
    expect(prompt).toContain('Task Sizing');
    expect(prompt).toContain('one focused pass');
    expect(prompt).toContain('Split tasks that span multiple concerns');
  });

  it('explains dependsOn ordering and parallelism (Phase 0.2)', () => {
    const prompt = buildPRDGenerationPrompt('anything');
    expect(prompt).toContain('Depends On');
    expect(prompt).toContain('in parallel');
    expect(prompt).toMatch(/later stories MUST declare/i);
  });

  it('includes the research-tools section by default', () => {
    const prompt = buildPRDGenerationPrompt('anything');
    expect(prompt).toContain('Research Tools');
    expect(prompt).toContain('web_search_ddg');
  });

  it('omits the research-tools section when research is disabled', () => {
    const prompt = buildPRDGenerationPrompt('anything', false);
    expect(prompt).not.toContain('Research Tools');
    expect(prompt).not.toContain('web_search_ddg');
    // Still a valid PRD prompt
    expect(prompt).toContain('TASK-001');
  });
});

// ---------------------------------------------------------------------------
// buildWorkerPrompt — iteration 1 (no prior feedback)
// ---------------------------------------------------------------------------

describe('buildWorkerPrompt — first iteration, with directory listing', () => {
  const listing = 'src/\n  index.mts\n  env.mts\npackage.json';
  const prompt = buildWorkerPrompt(
    PENDING_TASK,
    1,
    '',
    'Kanban Board',
    '/project',
    '',
    listing,
  );

  it('includes task id, name, description, and acceptance criteria', () => {
    expect(prompt).toContain('TASK-001');
    expect(prompt).toContain('Initialize project');
    expect(prompt).toContain('Set up tsconfig and directory structure');
    expect(prompt).toContain('tsconfig.json exists with strict:true');
  });

  it('includes the test command', () => {
    expect(prompt).toContain('bun run build');
  });

  it('includes the working directory', () => {
    expect(prompt).toContain('/project');
  });

  it('includes the feature name', () => {
    expect(prompt).toContain('Kanban Board');
  });

  it('does NOT include a reviewer feedback section on iteration 1', () => {
    expect(prompt).not.toContain('Reviewer Feedback');
  });

  it('includes the step budget table', () => {
    expect(prompt).toContain('Step Budget');
    expect(prompt).toContain('Exploration');
    expect(prompt).toContain('Implementation');
    expect(prompt).toContain('Verification');
  });

  it('injects the directory listing and forbids list_directory', () => {
    expect(prompt).toContain('Working Directory Structure');
    expect(prompt).toContain('src/');
    expect(prompt).toContain('index.mts');
    expect(prompt).toContain('Do NOT call `list_directory`');
  });

  it('step 1 tells the worker to review the listing, not call list_directory', () => {
    expect(prompt).toContain('Review the **Working Directory Structure**');
  });
});

describe('buildWorkerPrompt — first iteration, no directory listing (fallback)', () => {
  const prompt = buildWorkerPrompt(
    PENDING_TASK,
    1,
    '',
    'Kanban Board',
    '/project',
    '',
    '',
  );

  it('uses the fallback opt-in exploration instruction', () => {
    expect(prompt).toContain('Only call `list_directory` if the task truly requires');
  });

  it('does NOT show the Working Directory Structure section', () => {
    expect(prompt).not.toContain('Working Directory Structure');
  });
});

// ---------------------------------------------------------------------------
// buildWorkerPrompt — subsequent iteration with reviewer feedback
// ---------------------------------------------------------------------------

describe('buildWorkerPrompt — revision iteration', () => {
  const feedback = 'Missing return type on createStore function';
  const prompt = buildWorkerPrompt(
    PENDING_TASK,
    2,
    feedback,
    'Kanban Board',
    '/project',
    '',
    '',
  );

  it('includes the reviewer feedback section', () => {
    expect(prompt).toContain('Reviewer Feedback');
    expect(prompt).toContain(feedback);
  });

  it('shows the current iteration number', () => {
    expect(prompt).toContain('2');
  });

  it('includes iteration hint about existing files', () => {
    expect(prompt).toContain('previous attempts may already exist');
  });
});

describe('buildWorkerPrompt — iteration 2, empty feedback', () => {
  it('does NOT include feedback section when feedback is blank', () => {
    const prompt = buildWorkerPrompt(PENDING_TASK, 2, '   ', 'Feature', '/dir', '', '');
    expect(prompt).not.toContain('Reviewer Feedback');
  });
});

// ---------------------------------------------------------------------------
// buildReviewerPrompt
// ---------------------------------------------------------------------------

describe('buildReviewerPrompt', () => {
  const workerOutput = 'I created src/types/card.mts with the Card interface.';
  const prompt = buildReviewerPrompt(PENDING_TASK, workerOutput, 'Kanban Board');

  it('includes the feature name', () => {
    expect(prompt).toContain('Kanban Board');
  });

  it('includes task id and name', () => {
    expect(prompt).toContain('TASK-001');
    expect(prompt).toContain('Initialize project');
  });

  it('includes acceptance criteria and test command', () => {
    expect(prompt).toContain('tsconfig.json exists with strict:true');
    expect(prompt).toContain('bun run build');
  });

  it('requires a pre-completion checklist before the decision (Phase 1.4)', () => {
    expect(prompt).toContain('Pre-Completion Checklist');
    expect(prompt).toContain('CHECKLIST:');
    expect(prompt).toMatch(/Only output DECISION: SHIP if every checklist item/i);
  });

  it('includes the worker output', () => {
    expect(prompt).toContain(workerOutput);
  });

  it('requires a DECISION: SHIP or DECISION: REVISE ending', () => {
    expect(prompt).toContain('DECISION: SHIP');
    expect(prompt).toContain('DECISION: REVISE');
  });

  it('specifies TypeScript quality checks', () => {
    expect(prompt).toContain('any');
    expect(prompt).toContain('import type');
    expect(prompt).toContain('.mts');
  });

  it('flags fetch and new Request as violations requiring REVISE', () => {
    expect(prompt).toContain('fetch(');
    expect(prompt).toContain('new Request(');
    expect(prompt).toContain('REVISE immediately');
  });
});

describe('buildWorkerPrompt — one-read-per-file rule', () => {
  it('includes the one-read-per-file rule in the step budget section', () => {
    const prompt = buildWorkerPrompt(PENDING_TASK, 1, '', 'Feature', '/dir', '', '');
    expect(prompt).toContain('One read per file');
    expect(prompt).toContain('read_file');
  });
});

describe('buildWorkerPrompt — available packages section', () => {
  it('includes the available packages section when packages are provided', () => {
    const packages = 'dependencies:    axios, luxon\ndevDependencies: typescript';
    const prompt = buildWorkerPrompt(PENDING_TASK, 1, '', 'Feature', '/dir', '', '', packages);
    expect(prompt).toContain('Available Packages');
    expect(prompt).toContain('axios, luxon');
    expect(prompt).toContain('Do NOT run `bun add`');
  });

  it('omits the available packages section when no packages are provided', () => {
    const prompt = buildWorkerPrompt(PENDING_TASK, 1, '', 'Feature', '/dir', '', '');
    expect(prompt).not.toContain('Available Packages');
  });

  it('omits the available packages section when packages string is blank', () => {
    const prompt = buildWorkerPrompt(PENDING_TASK, 1, '', 'Feature', '/dir', '', '', '   ');
    expect(prompt).not.toContain('Available Packages');
  });
});

describe('buildReviewerPrompt — hallucination guard', () => {
  const workerOutput = 'I created src/store.mts with the store.';
  const prompt = buildReviewerPrompt(PENDING_TASK, workerOutput, 'Kanban Board');

  it('includes the critical review constraints section', () => {
    expect(prompt).toContain('Critical Review Constraints');
  });

  it('instructs reviewer to only flag things that are present in the code', () => {
    expect(prompt).toContain('only flag violations for things that ARE PRESENT');
  });

  it('instructs reviewer not to flag missing features', () => {
    expect(prompt).toContain('Do NOT flag missing features');
  });

  it('states that per-technology checks are conditional on presence', () => {
    expect(prompt).toContain('check 4 does not apply');
    expect(prompt).toContain('check 5 does not apply');
  });
});

describe('buildWorkerPrompt — HTTP client rule', () => {
  const prompt = buildWorkerPrompt(PENDING_TASK, 1, '', 'Feature', '/dir', '', '');

  it('requires axios for all HTTP requests', () => {
    expect(prompt).toContain('axios');
    expect(prompt).toContain('HTTP Requests');
  });

  it('forbids fetch and new Request', () => {
    expect(prompt).toContain('fetch');
    expect(prompt).toContain('new Request()');
  });

  it('applies the rule to test files as well', () => {
    expect(prompt).toContain('test files');
  });
});

describe('buildPRDGenerationPrompt — domain partitioning', () => {
  it('instructs the drafter to tag every task with a Domain', () => {
    const prompt = buildPRDGenerationPrompt('build a notes app', false);
    expect(prompt).toContain('**Domain**');
    expect(prompt).toContain('ui, api, services, database, auth, iac, e2e, ci');
  });
});

describe('debate prompts', () => {
  const task: Task = {
    id: 'TASK-001', name: 'big', description: 'build the whole thing',
    acceptanceCriteria: 'a; b; c', testCommand: 'bun test', dependsOn: [],
    domain: 'database', status: 'pending', iterationCount: 0,
  };

  it('proposal prompt asks the architect for a JSON array of stories', () => {
    const p = buildDebateProposalPrompt(task);
    expect(p).toContain('Solution Architect');
    expect(p).toContain('acceptanceCriteria');
    expect(p).toContain(task.id);
  });

  it('critique prompt frames the persona and asks for a verdict', () => {
    const p = buildPersonaCritiquePrompt('scrum_master', task, [
      { name: 's', description: 'd', acceptanceCriteria: 'a' },
    ], 1);
    expect(p).toContain('Scrum Master');
    expect(p).toContain('verdict');
    expect(p.toLowerCase()).toContain('agree');
  });

  it("synthesis prompt includes the personas' comments", () => {
    const p = buildDebateSynthesisPrompt(task, [
      { name: 's', description: 'd', acceptanceCriteria: 'a' },
    ], [{ persona: 'developer', verdict: 'revise', comments: 'too big still' }]);
    expect(p).toContain('too big still');
    expect(p).toContain('acceptanceCriteria');
  });
});
