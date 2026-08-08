// ─── INV-11: the shared-mutating posture gate is REMOVED, and stays removed ──
//
// This file used to prove that `enforceSharedMutatingGate` rejected a
// task-isolated or read-only caller of `serialize_merge` / `prune_worktrees`
// before the handler ran. That gate has been deleted, so those expectations are
// gone with it — but the file is NOT deleted, because "the gate no longer
// exists" is itself a guarantee somebody can revoke by accident. What follows
// pins the removal.
//
// WHY IT WAS REMOVED (recorded here because a future reader will find the gate
// a reasonable-sounding thing to re-add):
//
//   1. It was never an authority ordering. `task-isolated` holds
//      {fs:read, fs:write, shell:exec, isolation:worktree, mcp:exarchos} — a
//      strict SUPERSET of `shared-mutating`'s {fs:read, fs:write, shell:exec}.
//      The DENIED tier was the more capable one. The gate was really testing
//      `isolation:worktree` as a location marker ("I am inside a worktree"), a
//      context assertion wearing a capability's clothes. The superset relation
//      is asserted below, because it is the structural reason the gate could
//      not have been a permission check.
//
//   2. INV-11 forbids it in terms. Spatial write confinement "must never be
//      inferred from the launcher's cwd or worktree ownership", and the catalog
//      directs a reviewer to flag "any claim that a task-isolated agent CANNOT
//      write outside its worktree". The gate's denial message made exactly that
//      claim. Confinement is EXCLUDED from Exarchos's by-construction claims
//      until a hook standard or kernel sandbox owns the write path.
//
//   3. Being self-declared, it bounded nothing. Capabilities arrive from the
//      handshake, so a caller could decline to declare `isolation:worktree`;
//      and with no sandbox in play a denied agent still runs `git merge` in
//      Bash. Its only measured effect was to route merges AROUND the audited
//      path — refusing the verb that takes the lease and emits events, while
//      the unaudited shell path stayed open.
//
// WHAT STILL PROTECTS THE SHARED REF (unchanged): `serialize_merge`'s
// single-writer lease, the merge preflight's ancestry check, and the launcher's
// ownership of top-level worktree placement. STATE authority — the half INV-11
// does assign to the dispatch handler — is still enforced by
// `enforceReadonlyGate`, which is why the read-only case below still fails.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInMemoryResolver } from './resolver.js';
import * as resolverModule from './resolver.js';
import { capabilitiesForPosture } from './posture-mapping.js';
import type { DispatchContext } from '../core/dispatch.js';
import { dispatch, stubCompositeHandler } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';

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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('SharedMutatingGate_IsNotExported_SoItCannotBeRewired', () => {
    // The cheapest possible regression detector: the symbol is gone. If someone
    // re-adds it, this fails and they are routed to the rationale above rather
    // than discovering it after the fact.
    expect(
      (resolverModule as Record<string, unknown>).enforceSharedMutatingGate,
      'enforceSharedMutatingGate was deleted under INV-11 — see the header of ' +
        'this file before re-introducing it.',
    ).toBeUndefined();
  });

  it('PostureCapabilities_TaskIsolated_IsAStrictSupersetOfSharedMutating', () => {
    // The structural fact that made the old gate incoherent. Asserted rather
    // than narrated so that a future edit to the posture table which would make
    // a capability-ordered gate genuinely expressible shows up HERE, as a
    // failure, instead of silently making the deleted gate look justified again.
    const taskIsolated = capabilitiesForPosture('task-isolated');
    const sharedMutating = capabilitiesForPosture('shared-mutating');

    // Non-empty denominator: an empty posture set would satisfy "subset" vacuously.
    expect(sharedMutating.size).toBeGreaterThan(0);
    for (const cap of sharedMutating) {
      expect(taskIsolated.has(cap), `task-isolated is missing ${cap}`).toBe(true);
    }
    expect(taskIsolated.size).toBeGreaterThan(sharedMutating.size);
  });

  it('TaskIsolatedCaller_SerializeMerge_ReachesTheHandler', async () => {
    // The behaviour change, stated positively. A task-isolated caller — the
    // tier the deleted gate rejected — now reaches the composite handler. This
    // is what unblocks the real-world failure: `serialize_merge` answering
    // CAPABILITY_DENIED and sending the operator to a manual `git merge`.
    const resolver = createInMemoryResolver(taskIsolatedCaps);
    expect(resolver.has('isolation:worktree')).toBe(true);

    const taskIsolatedCtx: DispatchContext = { ...ctx, capabilityResolver: resolver };
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
      // Handler ENTRY is the load-bearing assertion — a result that merely
      // stopped being CAPABILITY_DENIED could still have been refused earlier.
      expect(compositeSpy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('ReadOnlyCaller_PruneWorktrees_IsStillRejected_ByTheReadonlyGate', async () => {
    // Removing the posture gate must not have widened STATE authority. The
    // read-only tier is still refused these verbs — by `enforceReadonlyGate`,
    // since they are absent from READ_ONLY_ACTIONS. Without this case the
    // removal above could not be distinguished from "all gating is gone".
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
