// ─── AgentSpec Zod schema tests (T30 / DR-6, post-v2.11 hard-cut) ─────────
//
// `AgentSpec` is the runtime shape; `AgentSpecSchema` is the Zod-validated
// surface that consumers (loaders, MCP tools, tests) hit before trusting an
// inbound spec. These tests pin the validation contract:
//   - T30: `posture` field accepts the three known values, rejects unknown.
//
// Removed in v2.11 substrate-cut (Phase 5b / DR-6):
//   - T31: posture/capabilities mutual exclusivity (legacy capabilities[]
//     is now hard-rejected, so the exclusivity rule is moot — any presence
//     of the field is rejected unconditionally; covered by the surviving
//     guard in `spec.dr6-removal.test.ts` until that guard is also pruned).
//   - T34: legacy capabilities[] deprecation envelope + event emission
//     (the deprecation path was removed; nothing left to assert).

import { describe, it, expect } from 'vitest';
import { AgentSpecSchema } from '../../../../src/runtime/agents/spec.js';

const validBaseSpec = {
  id: 'implementer' as const,
  description: 'desc',
  systemPrompt: 'prompt',
  model: 'inherit' as const,
  skills: [],
  validationRules: [],
  resumable: true,
};

describe('AgentSpec posture field (T30, DR-6)', () => {
  it('AgentSpec_ValidatesPostureField_AcceptsThreeKnownValues', () => {
    for (const posture of ['read-only', 'task-isolated', 'shared-mutating'] as const) {
      const result = AgentSpecSchema.safeParse({ ...validBaseSpec, posture });
      expect(result.success, `posture=${posture} should validate`).toBe(true);
    }

    // Unknown posture rejected.
    const bad = AgentSpecSchema.safeParse({ ...validBaseSpec, posture: 'bogus' });
    expect(bad.success).toBe(false);
  });
});
