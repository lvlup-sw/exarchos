// ─── DR-6 hard-cut guard test (T5b.1, v2.11 substrate-cut) ────────────────
//
// In v2.10, specs declaring legacy `capabilities: [...]` were accepted with
// a `spec.legacy_capabilities_array` deprecation event + `_meta.deprecation`
// envelope. v2.11 hard-cuts that path: legacy `capabilities[]` becomes a
// typed validation error, and `posture` is the only authority for
// declarative capability surfacing.
//
// This test fails on v2.10's accept-and-warn behaviour and passes after the
// hard-cut. Once the cut lands and the wider suite stays green, this guard
// can be deleted (the broader `spec.test.ts` suite covers the steady-state
// posture-only contract).

import { describe, it, expect } from 'vitest';
import { AgentSpecSchema } from '../../../../src/runtime/agents/spec.js';

const validBaseSpec = {
  id: 'implementer' as const,
  description: 'desc',
  systemPrompt: 'prompt',
  posture: 'task-isolated' as const,
  model: 'inherit' as const,
  skills: [],
  validationRules: [],
  resumable: true,
};

describe('AgentSpec DR-6 hard-cut: legacy capabilities[] rejected (T5b.1)', () => {
  it('AgentSpec_RejectsLegacyCapabilitiesArray', () => {
    // A spec carrying BOTH posture (the v2.11 replacement) AND a legacy
    // capabilities[] declaration must still hard-fail on the
    // capabilities key — pinning that the rejection is unconditional,
    // not just "missing posture means no validation."
    const result = AgentSpecSchema.safeParse({
      ...validBaseSpec,
      capabilities: ['fs:read', 'fs:write'],
    });

    // Hard-cut: legacy-array specs no longer parse.
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error must reference both `capabilities` (the offending field) and
      // `posture` (the replacement) so the operator's migration path is
      // unambiguous from the error alone.
      const message = JSON.stringify(result.error.issues);
      expect(message).toMatch(/capabilities/);
      expect(message).toMatch(/posture/);
    }
  });

  it('AgentSpec_PostureOnlySpec_StillValidates', () => {
    // Steady-state: a posture-only spec parses cleanly. Pinning this so the
    // hard-cut doesn't accidentally over-reject the canonical v2.11 shape.
    const result = AgentSpecSchema.safeParse({
      ...validBaseSpec,
      posture: 'task-isolated',
    });
    expect(result.success).toBe(true);
  });
});
