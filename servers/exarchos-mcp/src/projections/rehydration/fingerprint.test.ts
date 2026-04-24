import { describe, it, expect } from 'vitest';
import { loadPrefixFingerprint } from './fingerprint.js';

describe('prefix-fingerprint', () => {
  it('PrefixFingerprint_FileExists_ReturnsHash', () => {
    // T018 / DR-12 — placeholder scaffold. The real hash is wired in T046
    // (Q3 quality gate). For now, `loadPrefixFingerprint()` must read the
    // co-located `PREFIX_FINGERPRINT` file and return its contents as a
    // trimmed string. A placeholder value (e.g. `<unset>`) is acceptable.
    const fingerprint = loadPrefixFingerprint();

    expect(typeof fingerprint).toBe('string');
  });
});
