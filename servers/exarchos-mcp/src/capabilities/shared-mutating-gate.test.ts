// ─── DR-4 / INV-11: shared-mutating resolver gate (task-012) ────────────────
//
// `serialize_merge` and `prune_worktrees` declare `posture: 'shared-mutating'`.
// The resolver-seam gate (`enforceSharedMutatingGate`, wired into `dispatch()`
// right after `enforceReadonlyGate`) MUST reject a task-isolated or read-only
// caller BEFORE the composite handler runs, with a structured CAPABILITY_DENIED
// error and NO side effect.
//
// These tests exercise the REAL resolver → dispatch seam (not a unit stub): a
// genuine `dispatch()` call with a wired `capabilityResolver`, the composite
// handler replaced by a spy. Because the gate returns before dispatch
// constructs/invokes the composite handler, the spy must never fire on a
// rejection — asserting the spy is uncalled (not merely that the result is an
// error) is the load-bearing "handler never entered" guarantee. "No side
// effect" is additionally pinned by event-store emptiness: nothing is appended.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInMemoryResolver } from './resolver.js';
import { capabilitiesForPosture } from './posture-mapping.js';
import type { DispatchContext } from '../core/dispatch.js';
import { dispatch, stubCompositeHandler } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';

describe('shared-mutating resolver gate (DR-4, INV-11, task-012)', () => {
  let tmpDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  // Model the three caller tiers with their canonical capability sets so the
  // resolver fixtures stay faithful to posture-mapping.ts (the trust boundary),
  // rather than hand-listing capability strings that could drift.
  const taskIsolatedCaps = [...capabilitiesForPosture('task-isolated')];
  const readOnlyCaps = [...capabilitiesForPosture('read-only')];
  const sharedMutatingCaps = [...capabilitiesForPosture('shared-mutating')];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-mutating-gate-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    eventStore.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Resolver_TaskIsolatedCaller_SerializeMerge_RejectedBeforeHandler', async () => {
    // Sanity: a task-isolated caller carries isolation:worktree AND full
    // mcp:exarchos — so it PASSES the readonly gate; only the shared-mutating
    // gate can reject it.
    const resolver = createInMemoryResolver(taskIsolatedCaps);
    expect(resolver.has('isolation:worktree')).toBe(true);
    expect(resolver.has('mcp:exarchos')).toBe(true);
    expect(resolver.has('mcp:exarchos:readonly')).toBe(false);

    const taskIsolatedCtx: DispatchContext = { ...ctx, capabilityResolver: resolver };
    const streamsBefore = eventStore.listStreams();

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

      // (1) structured rejection identifying tool + action.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CAPABILITY_DENIED');
      expect(result.error?.tool).toBe('exarchos_orchestrate');
      expect(result.error?.action).toBe('serialize_merge');

      // (2) no side effect: handler never entered, nothing appended.
      expect(compositeSpy).not.toHaveBeenCalled();
      expect(eventStore.listStreams()).toEqual(streamsBefore);
      expect(await eventStore.query('worktrees')).toEqual([]);
    } finally {
      restore();
    }
  });

  it('Resolver_ReadOnlyCaller_PruneWorktrees_RejectedBeforeHandler', async () => {
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

      // (1) structured rejection identifying tool + action.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CAPABILITY_DENIED');
      expect(result.error?.tool).toBe('exarchos_orchestrate');
      expect(result.error?.action).toBe('prune_worktrees');

      // (2) no side effect: handler never entered, nothing appended.
      expect(compositeSpy).not.toHaveBeenCalled();
      expect(eventStore.listStreams()).toEqual(streamsBefore);
      expect(await eventStore.query('worktrees')).toEqual([]);
    } finally {
      restore();
    }
  });

  it('Resolver_SharedMutatingCaller_Proceeds', async () => {
    // A genuine shared-mutating caller ({fs:read, fs:write, shell:exec}, NO
    // isolation:worktree, NO mcp:exarchos:readonly) satisfies the tier: it
    // passes the readonly gate (no readonly tier) and the shared-mutating gate
    // (has fs:write, no isolation:worktree), so dispatch reaches the handler.
    const resolver = createInMemoryResolver(sharedMutatingCaps);
    expect(resolver.has('fs:write')).toBe(true);
    expect(resolver.has('isolation:worktree')).toBe(false);
    expect(resolver.has('mcp:exarchos:readonly')).toBe(false);

    const sharedMutatingCtx: DispatchContext = { ...ctx, capabilityResolver: resolver };

    const compositeSpy = vi.fn(async () => ({ success: true as const, data: {} }));
    const restore = stubCompositeHandler('exarchos_orchestrate', compositeSpy);
    try {
      const result = await dispatch(
        'exarchos_orchestrate',
        { action: 'prune_worktrees', repoRoot: '/tmp/repo' },
        sharedMutatingCtx,
      );

      // The gate let the call through to the (stubbed) composite handler.
      expect(compositeSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    } finally {
      restore();
    }
  });
});
