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

// ─── #1333 / DR-6: resolver covers every agent literal ────────────────────
//
// Post-#1333 β-03 hard-cut: the runtime interface no longer carries
// `capabilities: readonly Capability[]`; capabilities flow from `posture` +
// `id` through `resolveCapabilities`. β-01's original RED form (set-
// equality vs the legacy array) is therefore stale — the legacy array is
// gone. The test now pins the per-agent canonical capability sets directly
// so a future posture-table edit (or a per-agent overlay change) that
// drops a capability from the audited surface fails loudly.
//
// The expected sets are duplicated here from the audited legacy arrays
// before the cut. If the trust surface needs to change (e.g. a new
// capability promoted to a posture, or a new overlay), update both this
// table and `posture-mapping.ts` in the same commit.

describe('resolveCapabilities covers every agent literal (#1333)', () => {
  /** Capability sets the legacy `capabilities[]` literals carried per agent. */
  const EXPECTED_PER_AGENT: Readonly<Record<string, ReadonlyArray<string>>> = {
    implementer: [
      'fs:read',
      'fs:write',
      'shell:exec',
      'mcp:exarchos',
      'isolation:worktree',
      'session:resume',
    ],
    fixer: [
      'fs:read',
      'fs:write',
      'shell:exec',
      'mcp:exarchos',
      'isolation:worktree',
    ],
    reviewer: ['fs:read', 'mcp:exarchos:readonly'],
    scaffolder: [
      'fs:read',
      'fs:write',
      'shell:exec',
      'mcp:exarchos',
      'isolation:worktree',
    ],
  };

  it('ResolveCapabilities_AllAgentLiterals_ProduceCanonicalSets', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const expected = EXPECTED_PER_AGENT[spec.id];
      expect(
        expected,
        `${spec.id}: missing canonical capability set in EXPECTED_PER_AGENT`,
      ).toBeDefined();

      const resolved = resolveCapabilities(spec.posture, spec.id);
      const expectedSet = new Set<string>(expected);
      const actualSet = new Set<string>(resolved);

      const missingFromResolved = [...expectedSet].filter((c) => !actualSet.has(c));
      const extraFromResolved = [...actualSet].filter((c) => !expectedSet.has(c));

      expect(
        missingFromResolved,
        `agent=${spec.id} posture=${spec.posture}: resolver missing caps: ${JSON.stringify(missingFromResolved)}`,
      ).toEqual([]);
      expect(
        extraFromResolved,
        `agent=${spec.id} posture=${spec.posture}: resolver returns extra caps: ${JSON.stringify(extraFromResolved)}`,
      ).toEqual([]);
    }
  });
});
