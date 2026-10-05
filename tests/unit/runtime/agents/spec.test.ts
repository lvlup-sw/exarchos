// `AgentSpecSchema` validates an inbound agent spec before a consumer trusts it. This suite pins
// the `posture` field: the schema accepts the three known values and rejects an unknown value.
// `spec.dr6-removal.test.ts` covers the rejection of a `capabilities` array.

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

    const bad = AgentSpecSchema.safeParse({ ...validBaseSpec, posture: 'bogus' });
    expect(bad.success).toBe(false);
  });
});
