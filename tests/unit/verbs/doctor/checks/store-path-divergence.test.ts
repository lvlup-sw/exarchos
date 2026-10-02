import { describe, it, expect } from 'vitest';
import { storePathDivergence } from '../../../../../src/verbs/doctor/checks/store-path-divergence.js';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { CheckResultSchema } from '../../../../../src/verbs/doctor/schema.js';

const signal = new AbortController().signal;

describe('store-path-divergence (DR-11 B-5)', () => {
  /**
   * Without `WORKFLOW_STATE_DIR`, the CLI uses `~/.exarchos/state` and the plugin uses `~/.claude/workflow-state`.
   * The message checks home-independent substrings. A Warning must carry a fix to pass the schema.
   */
  it('doctor_DivergentStorePaths_DetectedAndReported', async () => {
    const probes = makeStubProbes({ env: {} });

    const result = await storePathDivergence(probes, signal);

    expect(result.category).toBe('storage');
    expect(result.name).toBe('store-path-divergence');
    expect(result.status).toBe('Warning');
    expect(result.message).toContain('.exarchos/state');
    expect(result.message).toContain('.claude/workflow-state');
    expect(result.fix).toContain('WORKFLOW_STATE_DIR');
    expect(CheckResultSchema.safeParse(result).success).toBe(true);
  });

  /** `WORKFLOW_STATE_DIR` wins the precedence in CLI mode and in plugin mode, so both surfaces share one store. */
  it('StorePathDivergence_UnifiedByEnvOverride_ReturnsPass', async () => {
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
