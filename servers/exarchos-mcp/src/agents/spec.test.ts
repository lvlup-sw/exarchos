// ─── AgentSpec Zod schema tests (T30, T31, T34 / DR-6) ─────────────────────
//
// `AgentSpec` is the runtime shape; `AgentSpecSchema` is the Zod-validated
// surface that consumers (loaders, MCP tools, tests) hit before trusting an
// inbound spec. These tests pin the validation contract:
//   - T30: `posture` field accepts the three known values, rejects unknown.
//   - T31: `posture` and `capabilities` are mutually exclusive (single source
//     of truth per spec).
//   - T34: legacy `capabilities[]` emits `spec.legacy_capabilities_array` +
//     surfaces `_meta.deprecation` envelope.

import { describe, it, expect } from 'vitest';
import { AgentSpecSchema, validateAgentSpec } from './spec.js';

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

describe('AgentSpec posture vs capabilities exclusivity (T31, DR-6)', () => {
  it('AgentSpec_BothPostureAndCapabilities_FailsValidationWithStructuredError', () => {
    const result = AgentSpecSchema.safeParse({
      ...validBaseSpec,
      posture: 'task-isolated',
      capabilities: ['fs:read'],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Error must reference both fields so the operator knows what to remove.
      const message = JSON.stringify(result.error.issues);
      expect(message).toMatch(/posture/);
      expect(message).toMatch(/capabilities/);
    }
  });
});
