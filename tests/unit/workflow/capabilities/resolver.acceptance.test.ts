// Acceptance test: an agent posture spec resolves to effective capabilities.
// `resolvePosture(spec, runtime)` returns the posture-derived set unioned with the handshake declarations.
// The first suite asserts the union and the posture-derived members. It does not test the override priority.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolvePosture, createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import type { Capability } from '../../../../src/runtime/agents/capabilities.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { dispatch, stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('Capability_PostureSpec_ResolverDerivesEffectiveCapabilities (DR-6)', () => {
  it('derives effective capabilities from posture unioned with handshake declarations', () => {
    const spec = {
      id: 'implementer' as const,
      posture: 'task-isolated' as const,
    };
    const runtime = {
      capabilities: ['mcp:exarchos'] as readonly Capability[],
    };

    const effective = resolvePosture(spec, runtime);

    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(true);

    expect(effective.has('mcp:exarchos')).toBe(true);
  });
});

/**
 * A `read-only` caller has `mcp:exarchos:readonly` and no `mcp:exarchos`.
 * Dispatch must reject its `merge_orchestrate` call at `enforceReadonlyGate`, before the composite handler runs.
 * The test makes a real `dispatch()` call with a spy as the composite handler.
 * The uncalled spy is the proof, because a handler that rejects internally still runs.
 */
describe('Resolver_ReadOnlyCaller_RejectedBeforeMergeHandler (#1305 T14)', () => {
  let tmpDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolver-gate-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * The first assertions confirm that the `read-only` posture resolves to the readonly tier only.
   * The payload is valid, so the call passes schema validation and the capability gate is what rejects it.
   */
  it('rejects a read-only caller at the resolver gate without entering the merge handler', async () => {
    const readOnlyCaps = resolvePosture(
      { posture: 'read-only' },
      {},
    );
    expect(readOnlyCaps.has('mcp:exarchos:readonly')).toBe(true);
    expect(readOnlyCaps.has('mcp:exarchos')).toBe(false);
    expect(readOnlyCaps.has('fs:write')).toBe(false);
    expect(readOnlyCaps.has('shell:exec')).toBe(false);

    const readonlyCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
    };

    const compositeSpy = vi.fn(async () => ({ success: true as const, data: {} }));
    const restore = stubCompositeHandler('exarchos_orchestrate', compositeSpy);

    try {
      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'merge_orchestrate',
          featureId: 'feat-x',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          strategy: 'squash',
        },
        readonlyCtx,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CAPABILITY_DENIED');
      expect(result.error?.tool).toBe('exarchos_orchestrate');
      expect(result.error?.action).toBe('merge_orchestrate');

      expect(compositeSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
