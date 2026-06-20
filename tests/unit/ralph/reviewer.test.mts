import { describe, it, expect } from 'bun:test';
import { parseReviewDecision } from '../../../src/ralph/reviewer.mts';

// ---------------------------------------------------------------------------
// parseReviewDecision — all branches
// ---------------------------------------------------------------------------

describe('parseReviewDecision', () => {
  describe('SHIP decision', () => {
    it('returns ship when response contains DECISION: SHIP', () => {
      const response = `
The implementation looks correct and all tests pass.

\`\`\`
DECISION: SHIP
\`\`\`
`;
      const result = parseReviewDecision(response);
      expect(result.decision).toBe('ship');
      expect(result.issues).toHaveLength(0);
      expect(result.feedback).toBe(response);
    });

    it('is case-insensitive for SHIP', () => {
      const result = parseReviewDecision('DECISION: ship');
      expect(result.decision).toBe('ship');
    });

    it('handles inline DECISION: SHIP without code block', () => {
      const result = parseReviewDecision('All good. DECISION: SHIP');
      expect(result.decision).toBe('ship');
    });
  });

  describe('REVISE decision with issues', () => {
    it('returns revise with extracted issues', () => {
      const response = `
Missing return types.

DECISION: REVISE
ISSUES:
- src/store.mts line 12: missing return type on getBoard
- src/types/card.mts: no readonly on id property

`;
      const result = parseReviewDecision(response);
      expect(result.decision).toBe('revise');
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]).toBe('src/store.mts line 12: missing return type on getBoard');
      expect(result.issues[1]).toBe('src/types/card.mts: no readonly on id property');
    });

    it('is case-insensitive for REVISE', () => {
      const result = parseReviewDecision('DECISION: revise\nISSUES:\n- fix it\n\n');
      expect(result.decision).toBe('revise');
    });

    it('returns empty issues array when ISSUES block is absent', () => {
      const result = parseReviewDecision('DECISION: REVISE\nNo structured issues.');
      expect(result.decision).toBe('revise');
      expect(result.issues).toHaveLength(0);
    });

    it('filters blank lines from issues list', () => {
      const response = 'DECISION: REVISE\nISSUES:\n- real issue\n-  \n- another issue\n\n';
      const result = parseReviewDecision(response);
      expect(result.issues).toHaveLength(2);
    });

    it('strips leading dash and whitespace from each issue', () => {
      const response = 'DECISION: REVISE\nISSUES:\n-   leading spaces issue\n\n';
      const result = parseReviewDecision(response);
      expect(result.issues[0]).toBe('leading spaces issue');
    });
  });

  describe('fallback — no explicit decision', () => {
    it('falls back to revise when no DECISION keyword is present', () => {
      const response = 'The code looks incomplete but I cannot decide.';
      const result = parseReviewDecision(response);
      expect(result.decision).toBe('revise');
    });

    it('attaches full response as feedback in the fallback case', () => {
      const response = 'No decision here.';
      const result = parseReviewDecision(response);
      expect(result.feedback).toBe(response);
    });

    it('includes a sentinel issue explaining the missing decision', () => {
      const result = parseReviewDecision('Ambiguous response.');
      expect(result.issues[0]).toContain('explicit DECISION');
    });

    it('returns revise for an empty response', () => {
      const result = parseReviewDecision('');
      expect(result.decision).toBe('revise');
    });
  });

  describe('feedback is always the full response', () => {
    it('sets feedback to the full response for SHIP', () => {
      const response = 'Everything passes. DECISION: SHIP';
      expect(parseReviewDecision(response).feedback).toBe(response);
    });

    it('sets feedback to the full response for REVISE', () => {
      const response = 'Fix it. DECISION: REVISE\nISSUES:\n- something\n\n';
      expect(parseReviewDecision(response).feedback).toBe(response);
    });
  });
});

// ---------------------------------------------------------------------------
// Pre-completion checklist gate (Phase 1.4)
// ---------------------------------------------------------------------------

describe('parseReviewDecision — pre-completion checklist', () => {
  it('parses the checklist items with met/not-met state', () => {
    const response = [
      'CHECKLIST:',
      '- [x] returns 200 on /health',
      '- [ ] validates the request body',
      'DECISION: REVISE',
      'ISSUES:',
      '- body validation missing',
    ].join('\n');
    const result = parseReviewDecision(response);
    expect(result.checklist).toEqual([
      { criterion: 'returns 200 on /health', met: true },
      { criterion: 'validates the request body', met: false },
    ]);
  });

  it('SHIP with all items met stays SHIP', () => {
    const response = [
      'CHECKLIST:',
      '- [x] a',
      '- [x] b',
      'DECISION: SHIP',
    ].join('\n');
    const result = parseReviewDecision(response);
    expect(result.decision).toBe('ship');
  });

  it('overrides SHIP to REVISE when any checklist item is unmet', () => {
    const response = [
      'CHECKLIST:',
      '- [x] a',
      '- [ ] b',
      'DECISION: SHIP', // reviewer wrongly said SHIP
    ].join('\n');
    const result = parseReviewDecision(response);
    expect(result.decision).toBe('revise');
    expect(result.issues.some((i) => i.includes('Acceptance criterion not met: b'))).toBe(true);
  });

  it('does not block SHIP when no checklist is present (graceful)', () => {
    const result = parseReviewDecision('DECISION: SHIP');
    expect(result.decision).toBe('ship');
    expect(result.checklist).toEqual([]);
  });
});
