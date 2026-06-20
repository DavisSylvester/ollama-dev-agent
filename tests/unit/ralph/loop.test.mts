import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RalphLoop } from '../../../src/ralph/loop.mts';
import type { Task, ReviewDecision } from '../../../src/types/index.mts';
import { REACT_TIMEOUT_SENTINEL } from '../../../src/models/react-agent.mts';
import type { RalphRunnerDeps } from '../../../src/ralph/loop.mts';
import { toRelativePaths } from '../../../src/ralph/loop.mts';
import type { LintResult } from '../../../src/tools/run-linter.mts';
import type { StructuredTool } from '@langchain/core/tools';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-001',
    name: 'Test task',
    description: 'Do something',
    acceptanceCriteria: 'It works',
    testCommand: 'bun test',
    dependsOn: [],
    status: 'pending',
    iterationCount: 0,
    ...overrides,
  };
}

function makeShipDecision(feedback = 'Looks great!'): ReviewDecision {
  return { decision: 'ship', feedback, issues: [] };
}

function makeReviseDecision(issues: string[] = ['Fix something']): ReviewDecision {
  return { decision: 'revise', feedback: 'Needs work', issues };
}

// Default lint stub — clean, so the lint gate never blocks unless a test opts in.
// Injected as the first property of every deps block; tests exercising the lint
// gate override it with their own lintFn that follows.
function makeCleanLint(): (workingDirectory: string, fix: boolean) => Promise<LintResult> {
  return async () => ({ clean: true, output: 'No lint issues found.' });
}

const NO_TOOLS: StructuredTool[] = [];

// ---------------------------------------------------------------------------
// Test setup — real temp directory so ContextManager works
// ---------------------------------------------------------------------------

let tmpDir: string;
let loop: RalphLoop;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ralph-test-'));
  // Redirect the global knowledge base to a temp dir so tests never write to
  // the real repo KB.
  process.env['ODA_KB_DIR'] = join(tmpDir, 'kb');
  loop = new RalphLoop(tmpDir, 'my-feature', 'My Feature', 3);
});

afterEach(async () => {
  delete process.env['ODA_KB_DIR'];
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Already-complete short-circuit
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — already complete', () => {
  it('returns complete immediately without calling worker or reviewer', async () => {
    const task = makeTask();

    // Pre-mark as complete so the short-circuit fires
    const { ContextManager } = await import('../../../src/ralph/context-manager.mts');
    const ctx = new ContextManager(tmpDir, 'my-feature');
    await ctx.markTaskComplete(task.id);

    let workerCalled = false;
    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => { workerCalled = true; return ''; },
      reviewerFn: async () => makeShipDecision(),
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('complete');
    expect(task.status).toBe('complete');
    expect(workerCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Successful path — SHIP on first iteration
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — SHIP on first iteration', () => {
  it('returns complete and sets task status', async () => {
    const task = makeTask();
    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => 'Implementation done.',
      reviewerFn: async () => makeShipDecision(),
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('complete');
    expect(task.status).toBe('complete');
    expect(task.iterationCount).toBe(1);
  });

  it('fires the correct event callbacks', async () => {
    const task = makeTask();
    const fired: string[] = [];

    const events = {
      onIterationStart: () => fired.push('iterationStart'),
      onWorkerStart: () => fired.push('workerStart'),
      onWorkerComplete: () => fired.push('workerComplete'),
      onReviewerStart: () => fired.push('reviewerStart'),
      onReviewerComplete: () => fired.push('reviewerComplete'),
    };

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => 'done',
      reviewerFn: async () => makeShipDecision(),
    };

    await loop.runTask(task, NO_TOOLS, events, deps);

    expect(fired).toEqual([
      'iterationStart',
      'workerStart',
      'workerComplete',
      'reviewerStart',
      'reviewerComplete',
    ]);
  });
});

// ---------------------------------------------------------------------------
// REVISE then SHIP
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — REVISE then SHIP', () => {
  it('retries and eventually ships', async () => {
    const task = makeTask();
    let calls = 0;

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => { calls++; return `output ${calls}`; },
      reviewerFn: async () =>
        calls === 1 ? makeReviseDecision() : makeShipDecision(),
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('complete');
    expect(task.iterationCount).toBe(2);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Max iterations exhausted
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — max iterations', () => {
  it('returns failed when all iterations result in REVISE', async () => {
    const task = makeTask();
    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => 'incomplete',
      reviewerFn: async () => makeReviseDecision(),
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('failed');
    expect(task.status).toBe('failed');
    expect(task.iterationCount).toBe(3); // maxIterations = 3
  });
});

// ---------------------------------------------------------------------------
// Worker error handling
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — worker throws', () => {
  it('still calls the reviewer after a worker exception', async () => {
    const task = makeTask();
    let reviewerCalled = false;

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => { throw new Error('model crashed'); },
      reviewerFn: async () => { reviewerCalled = true; return makeShipDecision(); },
    };

    // The reviewer SHIPs even after the worker error → task is complete in 1 iteration
    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);
    expect(result).toBe('complete');
    expect(reviewerCalled).toBe(true);
  });

  it('loops to iteration 2 when the reviewer REVISEs after a worker error', async () => {
    const task = makeTask();
    let workerCalls = 0;
    let reviewerCalls = 0;

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => {
        workerCalls++;
        if (workerCalls === 1) throw new Error('model crashed');
        return 'recovered';
      },
      reviewerFn: async () => {
        reviewerCalls++;
        // REVISE on first review (after worker error), SHIP on second
        return reviewerCalls === 1 ? makeReviseDecision() : makeShipDecision();
      },
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);
    expect(result).toBe('complete');
    expect(workerCalls).toBe(2);
  });

  it('fires onWorkerComplete even when the worker throws', async () => {
    const task = makeTask();
    let completeFired = false;

    const events = {
      onWorkerComplete: () => { completeFired = true; },
    };

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => { throw new Error('boom'); },
      reviewerFn: async () => makeShipDecision(),
    };

    await loop.runTask(task, NO_TOOLS, events, deps);
    expect(completeFired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sentinel detection — worker timeout
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — worker timeout sentinel', () => {
  it('skips reviewer and forces REVISE when worker returns the sentinel', async () => {
    const task = makeTask();
    let reviewerCalled = false;
    let workerCalls = 0;

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => {
        workerCalls++;
        if (workerCalls === 1) {
          return `${REACT_TIMEOUT_SENTINEL} (20) without a final answer. Tools attempted: read_file.`;
        }
        return 'Completed properly.';
      },
      reviewerFn: async () => {
        reviewerCalled = true;
        return makeShipDecision();
      },
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('complete');
    expect(workerCalls).toBe(2);
    // Reviewer should NOT have been called on iteration 1 (the timeout)
    // but IS called on iteration 2 (the successful one)
    expect(reviewerCalled).toBe(true);
  });

  it('fails the task when every iteration times out', async () => {
    const task = makeTask();
    let reviewerCalled = false;

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () =>
        `${REACT_TIMEOUT_SENTINEL} (20) without a final answer. Tools attempted: none.`,
      reviewerFn: async () => {
        reviewerCalled = true;
        return makeShipDecision();
      },
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('failed');
    expect(reviewerCalled).toBe(false); // reviewer never called
  });

  it('saves timeout feedback via context manager for next iteration', async () => {
    const task = makeTask();
    let workerCalls = 0;
    let receivedFeedback = '';

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async (params) => {
        workerCalls++;
        receivedFeedback = params.reviewerFeedback;
        if (workerCalls === 1) {
          return `${REACT_TIMEOUT_SENTINEL} (20) without a final answer. Tools attempted: none.`;
        }
        return 'Done.';
      },
      reviewerFn: async () => makeShipDecision(),
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    // On the second call the worker receives the timeout feedback
    expect(receivedFeedback).toContain('step budget');
  });
});

// ---------------------------------------------------------------------------
// Activity log passed to worker on retry
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — activity log', () => {
  it('passes a non-empty activity log to the worker on iteration 2 after a timeout', async () => {
    const task = makeTask();
    let workerCalls = 0;
    let secondIterationActivityLog = '';

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async (params) => {
        workerCalls++;
        if (workerCalls === 1) {
          return `${REACT_TIMEOUT_SENTINEL} (20) without a final answer. Tools attempted: read_file.`;
        }
        secondIterationActivityLog = params.activityLog;
        return 'Done.';
      },
      reviewerFn: async () => makeShipDecision(),
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(workerCalls).toBe(2);
    expect(secondIterationActivityLog).toContain('TIMED OUT');
  });

  it('passes a non-empty activity log to the worker on iteration 2 after a REVISE', async () => {
    const task = makeTask();
    let workerCalls = 0;
    let secondIterationActivityLog = '';

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async (params) => {
        workerCalls++;
        if (workerCalls === 2) {
          secondIterationActivityLog = params.activityLog;
        }
        return 'output';
      },
      reviewerFn: async () =>
        workerCalls === 1 ? makeReviseDecision(['Fix the types']) : makeShipDecision(),
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(workerCalls).toBe(2);
    expect(secondIterationActivityLog).toContain('REVISE');
    expect(secondIterationActivityLog).toContain('Fix the types');
  });

  it('passes empty activity log on the first iteration', async () => {
    const task = makeTask();
    let firstIterationActivityLog = 'not-set';

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async (params) => {
        firstIterationActivityLog = params.activityLog;
        return 'done';
      },
      reviewerFn: async () => makeShipDecision(),
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(firstIterationActivityLog).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Reviewer error handling
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — reviewer throws', () => {
  it('treats a reviewer exception as REVISE and loops', async () => {
    const task = makeTask();
    let reviewerCalls = 0;

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async () => 'output',
      reviewerFn: async () => {
        reviewerCalls++;
        if (reviewerCalls === 1) throw new Error('reviewer crashed');
        return makeShipDecision();
      },
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);
    expect(result).toBe('complete');
    expect(reviewerCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Mandatory lint gate
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — lint gate', () => {
  it('skips the reviewer and forces REVISE when lint has unfixable errors', async () => {
    const task = makeTask();
    let reviewerCalled = false;
    let workerCalls = 0;
    let lintCalls = 0;

    const deps: RalphRunnerDeps = {
      workerFn: async () => { workerCalls++; return 'output'; },
      reviewerFn: async () => { reviewerCalled = true; return makeShipDecision(); },
      lintFn: async () => {
        lintCalls++;
        // First iteration: lint never clean → forces REVISE without reviewer.
        // Second iteration: clean → reviewer runs and ships.
        if (workerCalls === 1) {
          return { clean: false, output: "src/foo.mts\n  1:1  error  'x' is unused" };
        }
        return { clean: true, output: 'No lint issues found.' };
      },
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('complete');
    expect(workerCalls).toBe(2);
    expect(lintCalls).toBeGreaterThan(0);
    // Reviewer must NOT run on the lint-failed iteration, but DOES on the clean one.
    expect(reviewerCalled).toBe(true);
  });

  it('lints only the files the worker wrote this iteration', async () => {
    const task = makeTask();
    let lintedFiles: readonly string[] | undefined;

    const deps: RalphRunnerDeps = {
      workerFn: async (params) => {
        // Simulate the worker writing/editing some files and reading another.
        params.onToolCall?.('write_file', { path: 'libs/auth0-mgmt/src/create-user.mts', content: 'x' });
        params.onToolCall?.('edit_file', { path: 'apps/api/src/index.mts', old_text: 'a', new_text: 'b' });
        params.onToolCall?.('read_file', { path: 'package.json' });
        return 'output';
      },
      reviewerFn: async () => makeShipDecision(),
      // Capture the file list passed to the *check* pass (fix === false).
      lintFn: async (_dir, fix, files) => {
        if (fix === false) lintedFiles = files;
        return { clean: true, output: 'No lint issues found.' };
      },
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(lintedFiles).toEqual([
      'libs/auth0-mgmt/src/create-user.mts',
      'apps/api/src/index.mts',
    ]);
    // read_file targets must NOT be linted
    expect(lintedFiles).not.toContain('package.json');
  });

  it('fails the task when every iteration fails lint', async () => {
    const task = makeTask();
    let reviewerCalled = false;

    const deps: RalphRunnerDeps = {
      workerFn: async () => 'output',
      reviewerFn: async () => { reviewerCalled = true; return makeShipDecision(); },
      lintFn: async () => ({ clean: false, output: 'persistent lint error' }),
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('failed');
    expect(reviewerCalled).toBe(false); // reviewer never runs while lint is dirty
  });

  it('runs lint with --fix before the check pass', async () => {
    const task = makeTask();
    const fixFlags: boolean[] = [];

    const deps: RalphRunnerDeps = {
      workerFn: async () => 'output',
      reviewerFn: async () => makeShipDecision(),
      lintFn: async (_dir, fix) => {
        fixFlags.push(fix);
        return { clean: true, output: 'No lint issues found.' };
      },
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    // First call is the auto-fix pass (true), second is the verification pass (false).
    expect(fixFlags).toEqual([true, false]);
  });

  it('logs an anti-pattern entry when the worker loops on run_tests in one iteration', async () => {
    const task = makeTask();
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const deps: RalphRunnerDeps = {
      workerFn: async (params) => {
        // Simulate the worker re-running tests 4 times in a single iteration.
        for (let i = 0; i < 4; i++) params.onToolCall?.('run_tests', {});
        params.onToolCall?.('write_file', { path: 'src/x.mts', content: 'x' });
        return 'output';
      },
      reviewerFn: async () => makeShipDecision(),
      lintFn: async () => ({ clean: true, output: 'clean' }),
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    // ODA_KB_DIR was redirected to tmpDir/kb in beforeEach.
    const apiKb = await readFile(join(process.env['ODA_KB_DIR']!, 'api.json'), 'utf-8');
    expect(apiKb).toContain('run_tests');
    expect(apiKb).toContain('anti-pattern');
  });

  it('logs an anti-pattern when the worker edits the same file repeatedly (Phase 1.3)', async () => {
    const task = makeTask();
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const deps: RalphRunnerDeps = {
      workerFn: async (params) => {
        // Simulate rewriting the same file 4 times in one iteration (doom loop).
        for (let i = 0; i < 4; i++) {
          params.onToolCall?.('edit_file', { path: 'src/server.mts', old_text: 'a', new_text: 'b' });
        }
        return 'output';
      },
      reviewerFn: async () => makeShipDecision(),
      lintFn: async () => ({ clean: true, output: 'clean' }),
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    const apiKb = await readFile(join(process.env['ODA_KB_DIR']!, 'api.json'), 'utf-8');
    expect(apiKb).toContain('src/server.mts');
    expect(apiKb).toContain('edited the same file');
  });

  it('flushes a lint issue to the knowledge base immediately (not only at task end)', async () => {
    const task = makeTask();
    let workerCalls = 0;
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const deps: RalphRunnerDeps = {
      workerFn: async () => { workerCalls++; return 'output'; },
      reviewerFn: async () => makeShipDecision(),
      // Fail lint on iteration 1 (logged immediately), pass on iteration 2.
      lintFn: async () =>
        workerCalls === 1
          ? { clean: false, output: "src/foo.mts  1:1  error  'x' is unused" }
          : { clean: true, output: 'clean' },
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    const apiKb = JSON.parse(await readFile(join(process.env['ODA_KB_DIR']!, 'api.json'), 'utf-8')) as Array<{ metadata: { status?: string } }>;
    // At least one entry logged during the run with the 'lint' status.
    expect(apiKb.some((e) => e.metadata.status === 'lint')).toBe(true);
  });

  it('records the exact fix (worker summary + files) in the resolved KB entry', async () => {
    const task = makeTask();
    let workerCalls = 0;
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const summary = 'Added page/limit query params to src/users.mts and updated the service to slice results.';
    const deps: RalphRunnerDeps = {
      workerFn: async () => {
        workerCalls++;
        return workerCalls === 1 ? 'first attempt' : summary;
      },
      reviewerFn: async () => makeShipDecision(),
      // Fail lint on iteration 1 so an issue is logged; clean on iteration 2 → ships.
      lintFn: async () =>
        workerCalls === 1
          ? { clean: false, output: "src/users.mts  1:1  error  'x' unused" }
          : { clean: true, output: 'clean' },
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    const apiKb = JSON.parse(await readFile(join(process.env['ODA_KB_DIR']!, 'api.json'), 'utf-8')) as Array<{ actual_resolution: string; metadata: { status?: string } }>;
    const resolved = apiKb.find((e) => e.metadata.status === 'resolved');
    expect(resolved).toBeDefined();
    // The resolution must be the exact fix, NOT a vague "Resolved after N iterations".
    expect(resolved!.actual_resolution).toContain(summary);
    expect(resolved!.actual_resolution).not.toMatch(/^Resolved after \d+ iteration/);
  });

  it('fires onLintComplete with the lint result', async () => {
    const task = makeTask();
    const lintEvents: Array<{ clean: boolean; output: string }> = [];

    const events = {
      onLintComplete: (_taskId: string, clean: boolean, output: string) =>
        lintEvents.push({ clean, output }),
    };

    const deps: RalphRunnerDeps = {
      workerFn: async () => 'output',
      reviewerFn: async () => makeShipDecision(),
      lintFn: async () => ({ clean: true, output: 'No lint issues found.' }),
    };

    await loop.runTask(task, NO_TOOLS, events, deps);

    expect(lintEvents).toHaveLength(1);
    expect(lintEvents[0]).toEqual({ clean: true, output: 'No lint issues found.' });
  });

  it('treats a lint execution error as a lint failure', async () => {
    const task = makeTask();
    let reviewerCalled = false;

    const deps: RalphRunnerDeps = {
      workerFn: async () => 'output',
      reviewerFn: async () => { reviewerCalled = true; return makeShipDecision(); },
      lintFn: async () => { throw new Error('eslint exploded'); },
    };

    const result = await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(result).toBe('failed');
    expect(reviewerCalled).toBe(false);
  });

  it('passes lint feedback to the worker on the next iteration', async () => {
    const task = makeTask();
    let workerCalls = 0;
    let secondIterationFeedback = '';

    const deps: RalphRunnerDeps = {
      workerFn: async (params) => {
        workerCalls++;
        if (workerCalls === 2) secondIterationFeedback = params.reviewerFeedback;
        return 'output';
      },
      reviewerFn: async () => makeShipDecision(),
      lintFn: async () =>
        workerCalls === 1
          ? { clean: false, output: "src/foo.mts  1:1  error  'x' is unused" }
          : { clean: true, output: 'No lint issues found.' },
    };

    await loop.runTask(task, NO_TOOLS, undefined, deps);

    expect(workerCalls).toBe(2);
    expect(secondIterationFeedback).toContain('ESLint');
  });
});

// ---------------------------------------------------------------------------
// onToolCall event forwarding
// ---------------------------------------------------------------------------

describe('RalphLoop.runTask — onToolCall forwarding', () => {
  it('forwards tool calls from the worker to the event handler', async () => {
    const task = makeTask();
    const toolCalls: string[] = [];

    const events = {
      onToolCall: (name: string) => toolCalls.push(name),
    };

    const deps: RalphRunnerDeps = {
      lintFn: makeCleanLint(),
      workerFn: async (params) => {
        // Simulate what the worker's onToolCall would fire
        params.onToolCall?.('read_file', { path: 'src/index.mts' });
        params.onToolCall?.('write_file', { path: 'src/out.mts', content: 'x' });
        return 'done';
      },
      reviewerFn: async () => makeShipDecision(),
    };

    await loop.runTask(task, NO_TOOLS, events, deps);

    expect(toolCalls).toEqual(['read_file', 'write_file']);
  });
});

// ---------------------------------------------------------------------------
// toRelativePaths — knowledge base must never store absolute paths
// ---------------------------------------------------------------------------

describe('toRelativePaths', () => {
  const BS = String.fromCharCode(92); // backslash, avoids escaping noise

  it('strips a Windows absolute working-dir prefix (backslashes)', () => {
    const wd = ['C:', 'projects', 'oda', 'test-run', 'auth0-admin'].join(BS);
    const rel = ['apps', 'api', 'index.mts'].join(BS);
    const text = `${wd}${BS}${rel}  1:1  error  'x' unused`;
    const out = toRelativePaths(text, wd);
    expect(out).not.toContain(`C:${BS}projects`);
    expect(out).toContain(rel);
  });

  it('strips a POSIX absolute working-dir prefix (forward slashes)', () => {
    const wd = '/home/u/oda/test-run/auth0-admin';
    const text = '/home/u/oda/test-run/auth0-admin/libs/auth0-mgmt/src/create-user.mts has an issue';
    const out = toRelativePaths(text, wd);
    expect(out).not.toContain('/home/u');
    expect(out).toContain('libs/auth0-mgmt/src/create-user.mts');
  });

  it('handles separator mismatch between working dir and text', () => {
    const wd = 'C:/projects/oda/app';
    const rel = ['src', 'x.mts'].join(BS);
    const text = `error in C:${BS}projects${BS}oda${BS}app${BS}${rel}`;
    expect(toRelativePaths(text, wd)).toContain(rel);
    expect(toRelativePaths(text, wd)).not.toContain(`C:${BS}projects`);
  });

  it('leaves text without the working dir untouched', () => {
    expect(toRelativePaths('a plain message', '/some/wd')).toBe('a plain message');
  });
});
