import { describe, it, expect } from 'vitest';
import { computePrefixFingerprint, loadPrefixFingerprint } from './fingerprint.js';

describe('prefix-fingerprint', () => {
  it('PrefixFingerprint_FileExists_ReturnsHash', () => {
    // T018 / DR-12 — placeholder scaffold. The real hash is wired in T046
    // (Q3 quality gate). For now, `loadPrefixFingerprint()` must read the
    // co-located `PREFIX_FINGERPRINT` file and return its contents as a
    // trimmed string. A placeholder value (e.g. `<unset>`) is acceptable.
    const fingerprint = loadPrefixFingerprint();

    expect(typeof fingerprint).toBe('string');
  });

  it('PrefixFingerprint_StableAcrossTwoRuns_Matches', () => {
    // T046 / DR-12 — the computation must be deterministic across invocations
    // inside a single process. If this fails, the fingerprint is not a stable
    // cache-invariant over the prefix bytes and the CI gate is meaningless.
    const first = computePrefixFingerprint();
    const second = computePrefixFingerprint();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('PrefixFingerprint_TemplateEdit_Diverges', () => {
    // T046 / DR-12 — if any byte of the input set changes, the hash must
    // diverge. `computePrefixFingerprint()` accepts an optional inputs
    // override so tests can exercise the divergence path without mutating
    // the real schema or registry.
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

  it('PrefixFingerprint_CommittedValueMatches', () => {
    // T046 / DR-12 — the committed `PREFIX_FINGERPRINT` file must match the
    // computed hash. CI (T047) wraps this comparison; the test makes the
    // assertion visible at the unit level so a local `vitest` run catches
    // drift before push.
    const committed = loadPrefixFingerprint();
    const computed = computePrefixFingerprint();

    expect(committed).toBe(computed);
  });
});
