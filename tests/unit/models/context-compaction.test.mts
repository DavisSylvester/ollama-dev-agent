import { describe, it, expect } from 'bun:test';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { compactConversation, estimateTokens } from '../../../src/models/react-agent.mts';

type Msg = SystemMessage | HumanMessage | AIMessage | ToolMessage;

// Build a conversation: system, human, then N (AI tool_call -> ToolMessage) turns.
function buildConversation(turns: number): Msg[] {
  const messages: Msg[] = [
    new SystemMessage('system prompt'),
    new HumanMessage('implement the task'),
  ];
  for (let i = 0; i < turns; i++) {
    messages.push(
      new AIMessage({ content: '', tool_calls: [{ name: 'read_file', args: { path: `f${i}.mts` }, id: `call-${i}` }] }),
    );
    messages.push(
      new ToolMessage({ tool_call_id: `call-${i}`, content: `BIG FILE CONTENT ${i} `.repeat(50) }),
    );
  }
  return messages;
}

const fakeSummarize = async (): Promise<string> => '- read several files\n- no errors yet';

describe('estimateTokens', () => {
  it('grows with content size', () => {
    const small = estimateTokens([new HumanMessage('hi')]);
    const big = estimateTokens([new HumanMessage('x'.repeat(4000))]);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeGreaterThanOrEqual(900); // ~4000 chars / 4
  });
});

describe('compactConversation', () => {
  it('returns the conversation unchanged when short enough', async () => {
    const msgs = buildConversation(1); // 2 + 2 = 4 messages, <= 2 + keepRecent
    const out = await compactConversation(msgs, fakeSummarize);
    expect(out).toBe(msgs);
  });

  it('replaces older turns with a single summary message', async () => {
    const msgs = buildConversation(10); // 22 messages
    const out = await compactConversation(msgs, fakeSummarize);
    expect(out.length).toBeLessThan(msgs.length);
    // system + human preserved
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect(out[1]).toBeInstanceOf(HumanMessage);
    // a summary message was inserted
    expect((out[2] as HumanMessage).content).toContain('Progress so far');
  });

  it('keeps the tail starting at a turn boundary (no orphaned ToolMessage)', async () => {
    const msgs = buildConversation(10);
    const out = await compactConversation(msgs, fakeSummarize);
    // After [system, human, summary], the first tail message must NOT be a
    // ToolMessage — otherwise tool-call/result pairing would be broken.
    expect(out[3]).not.toBeInstanceOf(ToolMessage);
  });

  it('every ToolMessage in the result is preceded by an AIMessage (valid pairing)', async () => {
    const msgs = buildConversation(12);
    const out = await compactConversation(msgs, fakeSummarize);
    for (let i = 0; i < out.length; i++) {
      if (out[i] instanceof ToolMessage) {
        expect(out[i - 1]).toBeInstanceOf(AIMessage);
      }
    }
  });

  it('falls back to a crude summary if the summarizer throws', async () => {
    const msgs = buildConversation(10);
    const failing = async (): Promise<string> => { throw new Error('summarizer down'); };
    const out = await compactConversation(msgs, failing);
    expect((out[2] as HumanMessage).content).toContain('semantic summary unavailable');
    // still produced a valid, shorter conversation
    expect(out.length).toBeLessThan(msgs.length);
  });
});
