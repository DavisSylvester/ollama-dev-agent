import { describe, expect, it } from 'bun:test';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { modelProgressLabel } from '../../../src/ui/App.tsx';
import { withReviewNudge } from '../../../src/ralph/reviewer.mts';
import { ThinkingBudgetExceededError, ModelCallTimeoutError } from '../../../src/models/ollama-client.mts';

describe('modelProgressLabel', () => {
  it('says what a running call is doing', () => {
    expect(modelProgressLabel({ label: 'worker.invoke', phase: 'thinking', thinkingTokens: 12_400 }))
      .toBe('worker model thinking… ~12.4k tokens');
    expect(modelProgressLabel({ label: 'reviewer.invoke', phase: 'writing', outputTokens: 900 }))
      .toBe('reviewer model writing… ~0.9k tokens');
    expect(modelProgressLabel({ label: 'worker.invoke', phase: 'waiting' }))
      .toBe('worker model: waiting for the first response');
  });
});

describe('withReviewNudge', () => {
  const base = [new SystemMessage('s'), new HumanMessage('u')];

  it('asks for the verdict after runaway thinking', () => {
    const out = withReviewNudge(base, new ThinkingBudgetExceededError(9000));
    expect(out).toHaveLength(3);
    expect(String(out[2]?.content)).toContain('DECISION line now');
  });

  it('repeats the request unchanged after any other failure', () => {
    expect(withReviewNudge(base, new ModelCallTimeoutError(1000))).toHaveLength(2);
    expect(withReviewNudge(base, undefined)).toHaveLength(2);
  });
});
