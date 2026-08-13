/**
 * Tests for the `merge-orchestrator@v1` barrel registration (Wave 2B.4 / #1304).
 *
 * DR-1 convention: concrete projections self-register against the process-wide
 * `defaultRegistry` at module-import time so downstream consumers can resolve
 * the reducer by its stable id. This test imports the barrel for its side
 * effect and asserts the registration landed.
 */
import { describe, it, expect } from 'vitest';
import { defaultRegistry } from '../registry.js';

// Side-effect import — registers `merge-orchestrator@v1` with `defaultRegistry`.
import './index.js';

describe('merge-orchestrator barrel registration (Wave 2B.4)', () => {
  it('MergeOrchestratorReducer_RegistersOnBarrelImport', () => {
    // GIVEN: the barrel was imported above as a side effect.
    // WHEN: we look up the canonical id on the process-wide registry.
    const registered = defaultRegistry.get('merge-orchestrator@v1');
    // THEN: it resolves to the reducer instance, with the expected scope.
    expect(registered).toBeDefined();
    expect(registered?.id).toBe('merge-orchestrator@v1');
    expect(registered?.version).toBe(1);
    expect(registered?.scope).toBe('stream');
  });
});
