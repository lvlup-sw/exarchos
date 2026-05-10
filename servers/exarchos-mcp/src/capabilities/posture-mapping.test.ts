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
import {
  POSTURE_CAPABILITY_MAP,
  listPostures,
  resolveCapabilities,
} from './posture-mapping.js';
import type { AgentPosture } from '../agents/spec.js';
import { ALL_AGENT_SPECS } from '../agents/definitions.js';

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

// ─── #1333 / DR-6: resolver covers every agent literal's legacy array ─────
//
// β-01 contract: enumerate every agent in `ALL_AGENT_SPECS` and assert that
// `resolveCapabilities(spec.posture, spec.id)` produces exactly the same
// capability set as the literal's legacy `capabilities[]` array. When this
// passes, dropping the runtime-interface field becomes safe — the resolver
// is the single source of truth.
//
// The test enumerates ALL_AGENT_SPECS at runtime so adding a new agent is
// caught automatically. RED until β-02 extends the posture mapping.

describe('resolveCapabilities covers every agent literal (#1333 β-01)', () => {
  it('ResolveCapabilities_AllAgentLiterals_ProduceSameSetAsLegacyArrays', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const posture = spec.posture;
      expect(
        posture,
        `agent ${spec.id} must declare a posture so the resolver can derive its caps`,
      ).toBeDefined();
      if (!posture) continue; // guard for type narrowing

      const resolved = resolveCapabilities(posture, spec.id);
      const expected = new Set<string>(spec.capabilities);
      const actual = new Set<string>(resolved);

      // Symmetric set-difference report — name the agent and the missing
      // capabilities on either side so a failure points directly at the
      // posture-mapping row that needs to grow.
      const missingFromResolved = [...expected].filter((c) => !actual.has(c));
      const extraFromResolved = [...actual].filter((c) => !expected.has(c));

      expect(
        missingFromResolved,
        `agent=${spec.id} posture=${posture}: resolver missing caps from legacy array: ${JSON.stringify(missingFromResolved)}`,
      ).toEqual([]);
      expect(
        extraFromResolved,
        `agent=${spec.id} posture=${posture}: resolver returns caps not in legacy array: ${JSON.stringify(extraFromResolved)}`,
      ).toEqual([]);
    }
  });
});
