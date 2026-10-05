// Guard for the `capabilities` rejection in `AgentSpecSchema`. A spec that declares a `capabilities`
// array fails with a typed validation error. `posture` is the only capability declaration.

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
  /**
   * The spec declares `posture` and `capabilities` together, so the rejection does not depend on a
   * missing `posture`. The error names the two fields, and thus shows the operator the replacement.
   */
  it('AgentSpec_RejectsLegacyCapabilitiesArray', () => {
    const result = AgentSpecSchema.safeParse({
      ...validBaseSpec,
      capabilities: ['fs:read', 'fs:write'],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toMatch(/capabilities/);
      expect(message).toMatch(/posture/);
    }
  });

  /** The rejection of `capabilities` must not reject a spec that declares only `posture`. */
  it('AgentSpec_PostureOnlySpec_StillValidates', () => {
    const result = AgentSpecSchema.safeParse({
      ...validBaseSpec,
      posture: 'task-isolated',
    });
    expect(result.success).toBe(true);
  });
});
