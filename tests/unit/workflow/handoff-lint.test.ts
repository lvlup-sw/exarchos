// ─── #1244: markdown-aware handoff lint at handleCheckpoint ────────────────
//
// `lintHandoff` is a thin wrapper over the canonical prose-lint
// (`projections/rehydration/prose-lint.ts`) that scans all three text
// fields of a `CheckpointHandoffSchema` payload — `context`, `nextSteps`,
// `suggestions` — and tags each finding with the field it originated in.
//
// The wrapper does NOT duplicate the lint catalog; it only fans out
// per-field and annotates the per-finding `source` so the downstream
// checkpoint handler (and human readers) can localize the offending text.
//
// Scope: unit-tier helper. The integration-tier behavior (soft-warning
// vs hard-fail at `handleCheckpoint`) is covered in `tools.test.ts` so
// the wrapper can stay free of state-file / event-store wiring.

import { describe, it, expect } from 'vitest';
import { lintHandoff } from '../../../src/workflow/handoff-lint.js';

describe('lintHandoff (#1244)', () => {
  it('HandoffLint_CleanHandoff_NoFindings', () => {
    // GIVEN: a handoff payload with prose that contains none of the
    // catalogued AI-writing tells.
    const handoff = {
      context: 'Implemented the parser. Tests pass. Ready for review.',
      nextSteps: ['Add docs entry', 'Cut release notes'],
      suggestions: ['Pin the parser version on the consumer side'],
    };

    // WHEN: the wrapper lints the payload.
    const findings = lintHandoff(handoff);

    // THEN: zero findings — clean prose flows through untouched.
    expect(findings).toEqual([]);
  });

  it('HandoffLint_ScansAllThreeFields_AnnotatesSourceField', () => {
    // GIVEN: a handoff with at least one prose-lint tell in each of the
    // three text fields. We use `delve` (ai-vocabulary), `tapestry`
    // (ai-vocabulary), and `leverage` (ai-vocabulary) so the pattern
    // catalog flags one finding per field.
    const handoff = {
      context: 'We delve into the parser internals.',
      nextSteps: ['Examine the rich tapestry of edge cases.'],
      suggestions: ['Leverage the existing reducer hook.'],
    };

    // WHEN: the wrapper lints the payload.
    const findings = lintHandoff(handoff);

    // THEN: at least one finding per field, each tagged with its
    // originating `source`. The wrapper's only job is to fan out and
    // annotate; the pattern-detection logic stays in prose-lint.
    const sources = findings.map((f) => f.source);
    expect(sources).toContain('context');
    expect(sources).toContain('nextSteps');
    expect(sources).toContain('suggestions');
  });

  it('HandoffLint_PreservesProseLintShape_PatternLineExcerpt', () => {
    // GIVEN: a handoff whose `context` triggers a single prose-lint
    // pattern (`delve`).
    const handoff = { context: 'We delve into the design.' };

    // WHEN: the wrapper lints the payload.
    const findings = lintHandoff(handoff);

    // THEN: each finding carries the full prose-lint shape plus the
    // `source` annotation. The wrapper must NOT reshape or summarize
    // the underlying `pattern` / `line` / `excerpt` fields — downstream
    // consumers (event hints, hard-fail data block) rely on them.
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const first = findings[0]!;
    expect(first.pattern).toBe('ai-vocabulary:delve');
    expect(typeof first.line).toBe('number');
    expect(typeof first.excerpt).toBe('string');
    expect(first.source).toBe('context');
  });

  it('HandoffLint_EmptyHandoff_NoFindings', () => {
    // GIVEN: an empty handoff payload — none of the optional fields set.
    // This is the common case for pre-#1240 callers that omit handoff.
    const handoff = {};

    // WHEN: the wrapper lints the payload.
    const findings = lintHandoff(handoff);

    // THEN: zero findings; the wrapper short-circuits on absent fields
    // rather than feeding empty strings into prose-lint.
    expect(findings).toEqual([]);
  });
});
