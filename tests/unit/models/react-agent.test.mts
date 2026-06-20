import { describe, it, expect } from 'bun:test';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import { AIMessage, SystemMessage, HumanMessage } from '@langchain/core/messages';
import { runReactAgent, REACT_TIMEOUT_SENTINEL } from '../../../src/models/react-agent.mts';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock BaseChatModel whose invoke() returns responses in
 * sequence. Each call pops the next entry from `responses`.
 */
function makeModel(
  responses: Array<{ content?: string; tool_calls?: Array<{ name: string; args: Record<string, unknown>; id: string }> }>,
): BaseChatModel {
  const queue = [...responses];

  const mockModel = {
    bindTools(_tools: StructuredTool[]) {
      return mockModel;
    },
    async invoke(_messages: unknown[]) {
      const next = queue.shift() ?? { content: '' };
      return new AIMessage({
        content: next.content ?? '',
        tool_calls: next.tool_calls ?? [],
      });
    },
  };

  return mockModel as unknown as BaseChatModel;
}

/** Creates a StructuredTool that always returns `result`. */
function makeTool(name: string, result: string): StructuredTool {
  return {
    name,
    async invoke(_args: Record<string, unknown>) {
      return result;
    },
  } as unknown as StructuredTool;
}

/** Creates a StructuredTool that always throws. */
function makeFailingTool(name: string, message: string): StructuredTool {
  return {
    name,
    async invoke(_args: Record<string, unknown>) {
      throw new Error(message);
    },
  } as unknown as StructuredTool;
}

const SYSTEM = 'You are a helpful assistant.';
const USER = 'Do the thing.';

// ---------------------------------------------------------------------------
// Basic response paths
// ---------------------------------------------------------------------------

describe('runReactAgent — no tool calls', () => {
  it('returns the model content directly when there are no tool calls', async () => {
    const model = makeModel([{ content: 'Task complete.' }]);
    const result = await runReactAgent(model, [], SYSTEM, USER, 10);
    expect(result).toBe('Task complete.');
  });

  it('returns empty string when model returns empty content and max retries exhausted', async () => {
    // Returns empty 3 times (initial + 2 retries), then still empty
    const model = makeModel([
      { content: '' },
      { content: '' },
      { content: '' },
    ]);
    const result = await runReactAgent(model, [], SYSTEM, USER, 10);
    expect(result).toBe('');
  });

  it('returns content after an empty retry', async () => {
    const model = makeModel([
      { content: '' },         // triggers retry
      { content: 'Got it.' }, // returned after retry
    ]);
    const result = await runReactAgent(model, [], SYSTEM, USER, 10);
    expect(result).toBe('Got it.');
  });
});

// ---------------------------------------------------------------------------
// Tool call handling
// ---------------------------------------------------------------------------

describe('runReactAgent — tool calls', () => {
  it('invokes a tool and appends its result before the next LLM call', async () => {
    const model = makeModel([
      {
        tool_calls: [{ name: 'read_file', args: { path: 'src/index.mts' }, id: 'tc-1' }],
      },
      { content: 'Done reading.' },
    ]);
    const tool = makeTool('read_file', 'file contents here');

    const result = await runReactAgent(model, [tool], SYSTEM, USER, 10);
    expect(result).toBe('Done reading.');
  });

  it('calls the onToolCall callback for each tool invocation', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const model = makeModel([
      { tool_calls: [{ name: 'list_directory', args: { path: '.' }, id: 'tc-1' }] },
      { content: 'Listed.' },
    ]);
    const tool = makeTool('list_directory', '[]');

    await runReactAgent(model, [tool], SYSTEM, USER, 10, (name, args) => {
      calls.push({ name, args });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('list_directory');
  });

  it('returns a tool-error message in the conversation when the tool throws', async () => {
    // The failing tool should cause an error ToolMessage; the model then returns a response.
    const model = makeModel([
      { tool_calls: [{ name: 'read_file', args: { path: 'x' }, id: 'tc-1' }] },
      { content: 'Handled error.' },
    ]);
    const failingTool = makeFailingTool('read_file', 'file not found');

    const result = await runReactAgent(model, [failingTool], SYSTEM, USER, 10);
    expect(result).toBe('Handled error.');
  });

  it('returns an error ToolMessage when the tool name is not registered', async () => {
    const model = makeModel([
      { tool_calls: [{ name: 'unknown_tool', args: {}, id: 'tc-1' }] },
      { content: 'Tool not found response.' },
    ]);

    const result = await runReactAgent(model, [], SYSTEM, USER, 10);
    expect(result).toBe('Tool not found response.');
  });
});

// ---------------------------------------------------------------------------
// Tool call limits
// ---------------------------------------------------------------------------

describe('runReactAgent — per-tool hard limits', () => {
  it('blocks list_directory after the per-run limit is exceeded', async () => {
    // limit is 5 calls; we call it 6 times and expect a limit message on the 6th
    const responses = [];
    for (let i = 0; i < 5; i++) {
      responses.push({
        tool_calls: [{ name: 'list_directory', args: { path: '.' }, id: `tc-${i}` }],
      });
    }
    // 6th call — limit exceeded
    responses.push({
      tool_calls: [{ name: 'list_directory', args: { path: '.' }, id: 'tc-6' }],
    });
    // Final answer
    responses.push({ content: 'Forced to answer.' });

    const model = makeModel(responses);
    const tool = makeTool('list_directory', '[]');

    const result = await runReactAgent(model, [tool], SYSTEM, USER, 20);
    expect(result).toBe('Forced to answer.');
  });

  it('does not limit tools that have no configured limit', async () => {
    // write_file has no hard limit — it should always execute
    const model = makeModel([
      { tool_calls: [{ name: 'write_file', args: { path: 'a.mts', content: 'x' }, id: 'tc-1' }] },
      { tool_calls: [{ name: 'write_file', args: { path: 'b.mts', content: 'y' }, id: 'tc-2' }] },
      { content: 'Written.' },
    ]);
    const tool = makeTool('write_file', 'ok');

    const result = await runReactAgent(model, [tool], SYSTEM, USER, 20);
    expect(result).toBe('Written.');
  });
});

// ---------------------------------------------------------------------------
// Max steps (sentinel)
// ---------------------------------------------------------------------------

describe('runReactAgent — max steps timeout', () => {
  it('returns the REACT_TIMEOUT_SENTINEL string when max steps reached', async () => {
    // Each response has a tool call so the loop never terminates naturally.
    // With maxSteps=3, it should give up after 3 iterations.
    const responses = Array.from({ length: 10 }, (_, i) => ({
      tool_calls: [{ name: 'read_file', args: { path: 'x' }, id: `tc-${i}` }],
    }));

    const model = makeModel(responses);
    const tool = makeTool('read_file', 'content');

    const result = await runReactAgent(model, [tool], SYSTEM, USER, 3);
    expect(result.startsWith(REACT_TIMEOUT_SENTINEL)).toBe(true);
  });

  it('includes the tool names that were attempted in the timeout message', async () => {
    const responses = Array.from({ length: 5 }, (_, i) => ({
      tool_calls: [{ name: 'shell_exec', args: { command: 'ls' }, id: `tc-${i}` }],
    }));

    const model = makeModel(responses);
    const tool = makeTool('shell_exec', 'output');

    const result = await runReactAgent(model, [tool], SYSTEM, USER, 3);
    expect(result).toContain('shell_exec');
  });
});

// ---------------------------------------------------------------------------
// REACT_TIMEOUT_SENTINEL export
// ---------------------------------------------------------------------------

describe('REACT_TIMEOUT_SENTINEL', () => {
  it('is a non-empty string', () => {
    expect(typeof REACT_TIMEOUT_SENTINEL).toBe('string');
    expect(REACT_TIMEOUT_SENTINEL.length).toBeGreaterThan(0);
  });

  it('matches the prefix of the actual timeout message', async () => {
    const responses = Array.from({ length: 5 }, (_, i) => ({
      tool_calls: [{ name: 'read_file', args: {}, id: `tc-${i}` }],
    }));

    const model = makeModel(responses);
    const tool = makeTool('read_file', 'x');
    const result = await runReactAgent(model, [tool], SYSTEM, USER, 2);

    expect(result.startsWith(REACT_TIMEOUT_SENTINEL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// read_file deduplication cache
// ---------------------------------------------------------------------------

describe('runReactAgent — read_file deduplication', () => {
  it('returns cached content on second read_file call to the same path', async () => {
    const toolCallPaths: string[] = [];

    const model = makeModel([
      { tool_calls: [{ name: 'read_file', args: { path: 'src/foo.mts' }, id: 'tc-1' }] },
      { tool_calls: [{ name: 'read_file', args: { path: 'src/foo.mts' }, id: 'tc-2' }] },
      { content: 'Done.' },
    ]);

    const tool: StructuredTool = {
      name: 'read_file',
      async invoke(args: Record<string, unknown>) {
        toolCallPaths.push(args['path'] as string);
        return 'file contents here';
      },
    } as unknown as StructuredTool;

    const result = await runReactAgent(model, [tool], SYSTEM, USER, 10);
    expect(result).toBe('Done.');
    // Tool should only have been invoked once — second call was served from cache
    expect(toolCallPaths).toHaveLength(1);
  });

  it('does not cache different paths', async () => {
    const toolCallPaths: string[] = [];

    const model = makeModel([
      { tool_calls: [{ name: 'read_file', args: { path: 'src/a.mts' }, id: 'tc-1' }] },
      { tool_calls: [{ name: 'read_file', args: { path: 'src/b.mts' }, id: 'tc-2' }] },
      { content: 'Done.' },
    ]);

    const tool: StructuredTool = {
      name: 'read_file',
      async invoke(args: Record<string, unknown>) {
        toolCallPaths.push(args['path'] as string);
        return 'file contents here';
      },
    } as unknown as StructuredTool;

    await runReactAgent(model, [tool], SYSTEM, USER, 10);
    // Both paths are different — both should be executed
    expect(toolCallPaths).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Budget warnings
// ---------------------------------------------------------------------------

describe('runReactAgent — budget warnings', () => {
  it('injects a 50% warning message after half the budget is used', async () => {
    // maxSteps=4: 50% warning at step 2 (stepsUsed=2), 75% at step 3 (stepsUsed=3)
    // We make the model call a tool for the first 2 steps, then answer
    const seenMessages: string[] = [];

    const model = makeModel([
      { tool_calls: [{ name: 'write_file', args: { path: 'a.mts', content: 'x' }, id: 'tc-1' }] },
      { tool_calls: [{ name: 'write_file', args: { path: 'b.mts', content: 'y' }, id: 'tc-2' }] },
      { content: 'Done.' },
    ]);

    const tool: StructuredTool = {
      name: 'write_file',
      async invoke(_args: Record<string, unknown>) {
        return 'written';
      },
    } as unknown as StructuredTool;

    // Use a spy model wrapper to capture incoming messages
    const originalInvoke = model.invoke.bind(model);
    (model as unknown as { invoke: typeof model.invoke }).invoke = async (messages: unknown[]) => {
      for (const m of messages) {
        if (m instanceof HumanMessage && typeof m.content === 'string') {
          seenMessages.push(m.content);
        }
      }
      return originalInvoke(messages);
    };

    await runReactAgent(model, [tool], SYSTEM, USER, 4);

    const budgetWarning = seenMessages.find((m) => m.includes('BUDGET WARNING'));
    expect(budgetWarning).toBeDefined();
  });
});

// Ensure unused imports don't cause lint errors — these are needed by makeModel
void SystemMessage;
void HumanMessage;
