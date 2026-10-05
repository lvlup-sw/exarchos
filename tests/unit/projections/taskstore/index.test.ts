/**
 * The import of the `projections/taskstore` barrel registers `task-store@v1` with `defaultRegistry`.
 * The barrel registers at module load, so a caller can resolve the reducer by id after any import.
 */
import { describe, it, expect } from 'vitest';

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
