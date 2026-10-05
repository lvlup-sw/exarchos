/**
 * Tests that the `merge-orchestrator@v1` barrel registers its reducer.
 * A projection barrel registers its reducer with the process-wide `defaultRegistry` at module import.
 * This test imports the barrel only for that side effect.
 */
import { describe, it, expect } from 'vitest';
import { defaultRegistry } from '../../../../src/projections/registry.js';

import '../../../../src/projections/merge-orchestrator/index.js';

describe('merge-orchestrator barrel registration (Wave 2B.4)', () => {
  it('MergeOrchestratorReducer_RegistersOnBarrelImport', () => {
    const registered = defaultRegistry.get('merge-orchestrator@v1');
    expect(registered).toBeDefined();
    expect(registered?.id).toBe('merge-orchestrator@v1');
    expect(registered?.version).toBe(1);
    expect(registered?.scope).toBe('stream');
  });
});
