// The shared-mutating posture gate must stay absent. This file proves that it is gone, because a later edit can add it again by accident.
// The gate is wrong for three reasons:
//
// - Postures are not an authority order. `task-isolated` holds a strict superset of the `shared-mutating` capabilities.
//   A gate that denies `task-isolated` denies the more capable tier.
// - Such a gate claims that a `task-isolated` agent cannot write outside its worktree. The invariants catalog forbids that claim.
//   The launcher cwd and worktree ownership never prove write confinement.
// - In production, the dispatch resolver holds the capabilities of the local process, not the posture of the calling agent.
//   Thus a posture gate at dispatch cannot judge that agent.
//   Agent postures apply at render time, through `resolveCapabilities` and the `isolation: worktree` frontmatter of the agent.
//
// The `serialize_merge` single-writer lease, the merge preflight ancestry check, and launcher-owned placement protect the shared ref.
// `enforceReadonlyGate` keeps state authority, so dispatch still rejects the read-only caller below.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import * as resolverModule from '../../../../src/workflow/capabilities/resolver.js';
import { capabilitiesForPosture } from '../../../../src/workflow/capabilities/posture-mapping.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { dispatch, stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../../../../src/dispatch/caller-identity.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('shared-mutating posture gate — removed (INV-11)', () => {
  let tmpDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  const taskIsolatedCaps = [...capabilitiesForPosture('task-isolated')];
  const readOnlyCaps = [...capabilitiesForPosture('read-only')];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-mutating-gate-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(tmpDir);
  });

  it('SharedMutatingGate_IsNotExported_SoItCannotBeRewired', () => {
    expect(
      (resolverModule as Record<string, unknown>).enforceSharedMutatingGate,
      'enforceSharedMutatingGate was deleted under INV-11 — see the header of ' +
        'this file before re-introducing it.',
    ).toBeUndefined();
  });

  /**
   * If a posture-table edit makes a capability-ordered gate possible, this test fails.
   * The size check stops an empty set from passing the subset check.
   */
  it('PostureCapabilities_TaskIsolated_IsAStrictSupersetOfSharedMutating', () => {
    const taskIsolated = capabilitiesForPosture('task-isolated');
    const sharedMutating = capabilitiesForPosture('shared-mutating');

    expect(sharedMutating.size).toBeGreaterThan(0);
    for (const cap of sharedMutating) {
      expect(taskIsolated.has(cap), `task-isolated is missing ${cap}`).toBe(true);
    }
    expect(taskIsolated.size).toBeGreaterThan(sharedMutating.size);
  });

  /**
   * A `task-isolated` caller of `serialize_merge` must reach the handler and not get CAPABILITY_DENIED.
   * Admission takes capabilities from the trusted caller, so the context sets `callerIdentity`.
   * Without an identity, admission counts no capability for the caller and refuses the call before the handler.
   * The spy call is the proof, because a result without CAPABILITY_DENIED can still come from an earlier refusal.
   */
  it('TaskIsolatedCaller_SerializeMerge_ReachesTheHandler', async () => {
    const resolver = createInMemoryResolver(taskIsolatedCaps);
    expect(resolver.has('isolation:worktree')).toBe(true);

    const taskIsolatedCtx: DispatchContext = {
      ...ctx,
      capabilityResolver: resolver,
      callerIdentity: deriveLocalOperatorIdentity(tmpDir),
    };
    const compositeSpy = vi.fn(async () => ({ success: true as const, data: {} }));
    const restore = stubCompositeHandler('exarchos_orchestrate', compositeSpy);
    try {
      const result = await dispatch(
        'exarchos_orchestrate',
        {
          action: 'serialize_merge',
          featureId: 'feat-x',
          integrationRef: 'integration',
          sourceBranch: 'feat/x',
          strategy: 'squash',
        },
        taskIsolatedCtx,
      );

      expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
      expect(compositeSpy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  /** The absent posture gate must not widen state authority, so the read-only gate still rejects this call. */
  it('ReadOnlyCaller_PruneWorktrees_IsStillRejected_ByTheReadonlyGate', async () => {
    const resolver = createInMemoryResolver(readOnlyCaps);
    expect(resolver.has('mcp:exarchos:readonly')).toBe(true);
    expect(resolver.has('fs:write')).toBe(false);

    const readOnlyCtx: DispatchContext = { ...ctx, capabilityResolver: resolver };
    const streamsBefore = eventStore.listStreams();

    const compositeSpy = vi.fn(async () => ({ success: true as const, data: {} }));
    const restore = stubCompositeHandler('exarchos_orchestrate', compositeSpy);
    try {
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'prune_worktrees', repoRoot: '/tmp/repo' },
        readOnlyCtx,
      );

      expect(result.success).toBe(false);
      expect(compositeSpy).not.toHaveBeenCalled();
      expect(eventStore.listStreams()).toEqual(streamsBefore);
    } finally {
      restore();
    }
  });
});
