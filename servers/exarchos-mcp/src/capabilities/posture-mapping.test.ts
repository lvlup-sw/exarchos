// ─── Posture → capability set table properties (T32, DR-6) ────────────────
//
// Property tests on the canonical posture mapping. The mapping is the
// trust-boundary contract for capability derivation, so we pin two
// properties that catch regressions structurally rather than relying on
// per-row assertions:
//
//   1. Every posture maps to at least one capability — empty postures would
//      let agents through with no declared trust surface, defeating DIM-2.
//   2. No two postures map to identical capability sets — duplicates would
//      collapse the three-tier model into a two- or one-tier one without
//      anyone noticing.

import { describe, it, expect } from 'vitest';
import { POSTURE_CAPABILITY_MAP, listPostures } from './posture-mapping.js';
import type { AgentPosture } from '../agents/spec.js';

describe('Posture-to-capability mapping properties (T32, DR-6)', () => {
  it('PostureMapping_AllPosturesMapToAtLeastOneCapability', () => {
    for (const posture of listPostures()) {
      const caps = POSTURE_CAPABILITY_MAP[posture];
      expect(caps.size, `posture=${posture} must map to ≥1 capability`).toBeGreaterThan(0);
    }
  });

  it('PostureMapping_NoTwoPosturesIdentical', () => {
    const postures = listPostures();
    for (let i = 0; i < postures.length; i++) {
      for (let j = i + 1; j < postures.length; j++) {
        const a = POSTURE_CAPABILITY_MAP[postures[i] as AgentPosture];
        const b = POSTURE_CAPABILITY_MAP[postures[j] as AgentPosture];
        const sameSize = a.size === b.size;
        const sameMembers = sameSize && [...a].every((c) => b.has(c));
        expect(
          sameMembers,
          `postures ${postures[i]} and ${postures[j]} have identical capability sets`,
        ).toBe(false);
      }
    }
  });
});
