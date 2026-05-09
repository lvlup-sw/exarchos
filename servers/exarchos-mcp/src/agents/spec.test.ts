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

describe('AgentSpec legacy capabilities[] deprecation (T34, DR-6)', () => {
  it('AgentSpec_LegacyCapabilitiesArray_EmitsDeprecationEventAndEnvelope', async () => {
    const result = validateAgentSpec({
      ...validBaseSpec,
      capabilities: ['fs:read', 'fs:write'],
    });

    // Event emitted via the canonical `spec.legacy_capabilities_array`
    // type (registered in event-store/schemas.ts).
    expect(result.events.length).toBe(1);
    expect(result.events[0].type).toBe('spec.legacy_capabilities_array');
    expect(result.events[0].data.specName).toBe('implementer');
    expect(result.events[0].data.capabilities).toEqual(['fs:read', 'fs:write']);

    // Canonical event-emission path: payload must validate against the
    // registered `EVENT_DATA_SCHEMAS['spec.legacy_capabilities_array']`
    // schema. validateAgentSpec must run the registered schema so any
    // future drift between spec validator and event store fails fast.
    const { EVENT_DATA_SCHEMAS } = await import('../event-store/schemas.js');
    const eventSchema = EVENT_DATA_SCHEMAS['spec.legacy_capabilities_array'];
    const parsed = eventSchema.safeParse(result.events[0].data);
    expect(parsed.success).toBe(true);

    // Consumer-facing deprecation envelope surfaces in `_meta.deprecation`.
    expect(result._meta?.deprecation).toEqual({
      since: '2.10.0',
      removeIn: '2.11.0',
      replacement: 'posture',
    });

    // wrapResponseWithDeprecation: any consumer response that consumes the
    // validated spec must surface `_meta.deprecation` automatically.
    const { wrapResponseWithDeprecation } = await import('./spec.js');
    const wrapped = wrapResponseWithDeprecation({ result: 'ok' }, result);
    expect((wrapped as { _meta?: { deprecation?: unknown } })._meta?.deprecation).toEqual({
      since: '2.10.0',
      removeIn: '2.11.0',
      replacement: 'posture',
    });

    // A spec using posture (no legacy capabilities[]) emits no event AND
    // wrapping is a no-op.
    const modern = validateAgentSpec({ ...validBaseSpec, posture: 'task-isolated' });
    expect(modern.events.length).toBe(0);
    expect(modern._meta).toBeUndefined();
    const modernWrapped = wrapResponseWithDeprecation({ result: 'ok' }, modern);
    expect((modernWrapped as { _meta?: unknown })._meta).toBeUndefined();
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
