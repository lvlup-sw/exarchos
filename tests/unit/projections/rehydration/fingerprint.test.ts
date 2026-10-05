import { describe, it, expect } from 'vitest';
import { computePrefixFingerprint, loadPrefixFingerprint } from '../../../../src/projections/rehydration/fingerprint.js';

describe('prefix-fingerprint', () => {
  it('PrefixFingerprint_FileExists_ReturnsHash', () => {
    const fingerprint = loadPrefixFingerprint();

    expect(typeof fingerprint).toBe('string');
  });

  /** A digest that changes between two calls in one process makes the CI gate meaningless. */
  it('PrefixFingerprint_StableAcrossTwoRuns_Matches', () => {
    const first = computePrefixFingerprint();
    const second = computePrefixFingerprint();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  /** The input overrides change one input each, so the real schema and registry stay untouched. */
  it('PrefixFingerprint_TemplateEdit_Diverges', () => {
    const baseline = computePrefixFingerprint();
    const mutated = computePrefixFingerprint({
      schemaJson: '{"mutated":true}',
    });
    const mutatedDescription = computePrefixFingerprint({
      toolDescriptionBytes: 'MUTATED tool description bytes',
    });

    expect(mutated).not.toBe(baseline);
    expect(mutatedDescription).not.toBe(baseline);
    expect(mutated).not.toBe(mutatedDescription);
  });

  /** CI makes the same comparison. This test shows the drift in a local run before a push. */
  it('PrefixFingerprint_CommittedValueMatches', () => {
    const committed = loadPrefixFingerprint();
    const computed = computePrefixFingerprint();

    expect(committed).toBe(computed);
  });
});
