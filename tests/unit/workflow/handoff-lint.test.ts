/**
 * Unit tests for `lintHandoff`. It runs the prose lint on each text field of a checkpoint handoff.
 * Each finding names the field that produced it.
 * `tools.test.ts` tests the warning and hard-fail behavior of `handleCheckpoint`.
 */

import { describe, it, expect } from 'vitest';
import { lintHandoff } from '../../../src/workflow/handoff-lint.js';

describe('lintHandoff (#1244)', () => {
  it('HandoffLint_CleanHandoff_NoFindings', () => {
    const handoff = {
      context: 'Implemented the parser. Tests pass. Ready for review.',
      nextSteps: ['Add docs entry', 'Cut release notes'],
      suggestions: ['Pin the parser version on the consumer side'],
    };

    const findings = lintHandoff(handoff);

    expect(findings).toEqual([]);
  });

  /** Each field holds one AI-vocabulary word, so each field produces at least one finding. */
  it('HandoffLint_ScansAllThreeFields_AnnotatesSourceField', () => {
    const handoff = {
      context: 'We delve into the parser internals.',
      nextSteps: ['Examine the rich tapestry of edge cases.'],
      suggestions: ['Leverage the existing reducer hook.'],
    };

    const findings = lintHandoff(handoff);

    const sources = findings.map((f) => f.source);
    expect(sources).toContain('context');
    expect(sources).toContain('nextSteps');
    expect(sources).toContain('suggestions');
  });

  /** The hard-fail response of the checkpoint handler returns these findings, so the wrapper keeps the prose-lint fields. */
  it('HandoffLint_PreservesProseLintShape_PatternLineExcerpt', () => {
    const handoff = { context: 'We delve into the design.' };

    const findings = lintHandoff(handoff);

    expect(findings.length).toBeGreaterThanOrEqual(1);
    const first = findings[0]!;
    expect(first.pattern).toBe('ai-vocabulary:delve');
    expect(typeof first.line).toBe('number');
    expect(typeof first.excerpt).toBe('string');
    expect(first.source).toBe('context');
  });

  it('HandoffLint_EmptyHandoff_NoFindings', () => {
    const handoff = {};

    const findings = lintHandoff(handoff);

    expect(findings).toEqual([]);
  });
});
