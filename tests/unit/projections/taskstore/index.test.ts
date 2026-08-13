/**
 * Wave 2A.5 — barrel-import registration test (#1284).
 *
 * Verifies that importing `projections/taskstore` (side-effect import)
 * registers `task-store@v1` with the process-wide `defaultRegistry`. The
 * `register` call must be at module-load time, not lazy, so production
 * call sites that resolve the reducer by id from `defaultRegistry` work
 * the moment the barrel is imported anywhere in the dependency graph.
 */
import { describe, it, expect } from 'vitest';

// Side-effect import — module load triggers register call.
import '../../../../src/projections/taskstore/index.js';
import { defaultRegistry } from '../../../../src/projections/registry.js';

describe('taskstore barrel registration (Wave 2A.5)', () => {
  it('TaskStoreReducer_RegistersOnBarrelImport', () => {
    const registered = defaultRegistry.get('task-store@v1');
    expect(registered).toBeDefined();
    expect(registered?.id).toBe('task-store@v1');
    expect(registered?.version).toBe(1);
    expect(registered?.scope).toBe('stream');
  });
});
