// Property tests on the posture-to-capability map, which is the trust-boundary contract for capability derivation.
// Every posture maps to at least one capability, so no agent passes with an empty trust surface.
// No two postures map to the same set, so the three tiers stay distinct.

import { describe, it, expect } from 'vitest';
import {
  POSTURE_CAPABILITY_MAP,
  listPostures,
  resolveCapabilities,
} from '../../../../src/workflow/capabilities/posture-mapping.js';
import type { AgentPosture } from '../../../../src/runtime/agents/spec.js';
import { ALL_AGENT_SPECS } from '../../../../src/runtime/agents/definitions.js';

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

/**
 * Capabilities come from `posture` and `id` through `resolveCapabilities`.
 * `EXPECTED_PER_AGENT` pins the audited capability set of each agent.
 * A posture or overlay change that drops a capability fails here. Change this table and `posture-mapping.ts` together.
 */
describe('resolveCapabilities covers every agent literal (#1333)', () => {
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
