import { describe, it, expect } from 'vitest';
import { storePathDivergence } from './store-path-divergence.js';
import { makeStubProbes } from './__shared__/make-stub-probes.js';
import { CheckResultSchema } from '../schema.js';

const signal = new AbortController().signal;

describe('store-path-divergence (DR-11 B-5)', () => {
  it('doctor_DivergentStorePaths_DetectedAndReported', async () => {
    // No WORKFLOW_STATE_DIR override in the env snapshot → the CLI surface
    // defaults to ~/.exarchos/state while the plugin surface defaults to
    // ~/.claude/workflow-state. The check must FIRE and report both paths.
    const probes = makeStubProbes({ env: {} });

    const result = await storePathDivergence(probes, signal);

    expect(result.category).toBe('storage');
    expect(result.name).toBe('store-path-divergence');
    expect(result.status).toBe('Warning');
    // The message names BOTH divergent surfaces (home-independent substrings).
    expect(result.message).toContain('.exarchos/state');
    expect(result.message).toContain('.claude/workflow-state');
    // The fix is actionable: it points at the documented precedence key.
    expect(result.fix).toContain('WORKFLOW_STATE_DIR');
    // Schema-valid (a Warning MUST carry a fix).
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  it('StorePathDivergence_UnifiedByEnvOverride_ReturnsPass', async () => {
    // WORKFLOW_STATE_DIR wins the precedence in BOTH modes → one shared store,
    // no divergence.
    const probes = makeStubProbes({ env: { WORKFLOW_STATE_DIR: '/srv/shared-state' } });

    const result = await storePathDivergence(probes, signal);

    expect(result.category).toBe('storage');
    expect(result.name).toBe('store-path-divergence');
    expect(result.status).toBe('Pass');
    expect(result.message).toContain('/srv/shared-state/exarchos.db');
    expect(result.fix).toBeUndefined();
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });
});
