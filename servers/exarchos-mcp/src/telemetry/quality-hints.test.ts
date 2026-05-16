// ─── Quality-hint catalog tests (#1262) ─────────────────────────────────────
//
// PR A2 / T03: A catalog of structured quality-hint *types* keyed by a stable
// identifier (e.g. `output_tokens_high`). Each entry declares:
//
//   - `verb` — the NextAction verb to surface (e.g. `checkpoint`).
//   - `reasonTemplate` — a printf-style template populated by the projection.
//
// The projection looks up a hint by id and uses the template to build the
// `next_actions[].reason` string. Keeping the catalog separate from the
// projection means the verb/template can evolve without touching the
// threshold-detection logic, and the parity tests can reason about hint
// payloads without instantiating the full projection state.

import { describe, it, expect } from 'vitest';
import {
  getQualityHintTypes,
  getQualityHintType,
  type QualityHintType,
} from './quality-hints.js';

describe('QualityHintCatalog', () => {
  it('QualityHint_OutputTokensHighType_RegisteredInCatalog', () => {
    const types = getQualityHintTypes();
    const hint = types['output_tokens_high'];
    expect(hint).toBeDefined();
    expect(hint.verb).toBe('checkpoint');
    expect(typeof hint.reasonTemplate).toBe('string');
    expect(hint.reasonTemplate.length).toBeGreaterThan(0);
  });

  it('QualityHint_GetByName_ReturnsTypedEntry', () => {
    const hint: QualityHintType | undefined = getQualityHintType('output_tokens_high');
    expect(hint).toBeDefined();
    expect(hint?.verb).toBe('checkpoint');
  });

  it('QualityHint_GetByName_UnknownReturnsUndefined', () => {
    const hint = getQualityHintType('does_not_exist');
    expect(hint).toBeUndefined();
  });

  it('QualityHint_OutputTokensHighType_ReasonTemplateReferencesTokens', () => {
    const hint = getQualityHintType('output_tokens_high');
    expect(hint).toBeDefined();
    // The template should mention "output tokens" so the rendered reason
    // is comprehensible to the agent reading the hint.
    expect(hint!.reasonTemplate.toLowerCase()).toMatch(/output tokens/);
  });
});
