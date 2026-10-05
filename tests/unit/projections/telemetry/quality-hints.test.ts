/**
 * Tests for the catalog of quality-hint types. Each entry gives the NextAction
 * `verb` and a `reasonTemplate` for one stable id such as `output_tokens_high`.
 */

import { describe, it, expect } from 'vitest';
import {
  getQualityHintTypes,
  getQualityHintType,
  type QualityHintType,
} from '../../../../src/projections/telemetry/quality-hints.js';

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

  /** The reason text must name output tokens, so the agent that reads the hint understands it. */
  it('QualityHint_OutputTokensHighType_ReasonTemplateReferencesTokens', () => {
    const hint = getQualityHintType('output_tokens_high');
    expect(hint).toBeDefined();
    expect(hint!.reasonTemplate.toLowerCase()).toMatch(/output tokens/);
  });
});
