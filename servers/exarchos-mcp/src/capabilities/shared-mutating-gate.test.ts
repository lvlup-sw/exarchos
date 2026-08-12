// The shared-mutating posture gate is removed. This file used to prove it
// rejected task-isolated and read-only callers of `serialize_merge` /
// `prune_worktrees`; it now proves the gate stays gone, because "we deleted
// this" is a guarantee somebody can revoke by accident.
//
// Three reasons it went, worth keeping because re-adding it sounds reasonable:
//
// It never ran on real postures. The dispatch resolver is built in
// `index.ts` and `core/context.ts` as `createInMemoryResolver([])` or
// `[ANTHROPIC_NATIVE_CACHING])` — a response-cache flag that is not even a
// `Capability`. Nothing feeds agent postures into it. So `has('fs:write')` was
// always false and the gate denied every caller that reached it, which is how
// `serialize_merge` came to answer CAPABILITY_DENIED unconditionally. It
// passed its own suite because the suite hand-built the one input production
// never supplies. Agent postures do matter, but at RENDER time:
// `resolveCapabilities` → `adapters/claude.ts` → the agent's
// `isolation: worktree` frontmatter, which is Claude Code's native isolation.
// That path is untouched.
//
// It was not an authority ordering anyway. `task-isolated` holds a strict
// superset of `shared-mutating`'s capabilities, so the denied tier was the more
// capable one — the gate was reading `isolation:worktree` as a location marker,
// not a permission. Asserted below, since it is the structural reason.
//
// INV-11 forbids the claim it made. Write confinement "must never be inferred
// from the launcher's cwd or worktree ownership", and the catalog says to flag
// any claim that a task-isolated agent cannot write outside its worktree. The
// denial message made exactly that claim. Confinement is not ours until a hook
// standard or kernel sandbox owns the write path.
//
// The shared ref is still protected by `serialize_merge`'s single-writer lease,
// the merge preflight's ancestry check, and launcher-owned placement. State
// authority still lives in `enforceReadonlyGate` — hence the read-only case
// below.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInMemoryResolver } from './resolver.js';
import * as resolverModule from './resolver.js';
import { capabilitiesForPosture } from './posture-mapping.js';
import type { DispatchContext } from '../core/dispatch.js';
import { dispatch, stubCompositeHandler } from '../core/dispatch.js';
import { EventStore } from '../events/store.js';

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
    // Cheapest possible detector: the symbol is gone.
    expect(
      (resolverModule as Record<string, unknown>).enforceSharedMutatingGate,
      'enforceSharedMutatingGate was deleted under INV-11 — see the header of ' +
        'this file before re-introducing it.',
    ).toBeUndefined();
  });

  it('PostureCapabilities_TaskIsolated_IsAStrictSupersetOfSharedMutating', () => {
    // The structural fact that made the gate incoherent. If a posture-table
    // edit ever makes a capability-ordered gate expressible, it fails here.
    const taskIsolated = capabilitiesForPosture('task-isolated');
    const sharedMutating = capabilitiesForPosture('shared-mutating');

    // Non-empty denominator: an empty set satisfies "subset" vacuously.
    expect(sharedMutating.size).toBeGreaterThan(0);
    for (const cap of sharedMutating) {
      expect(taskIsolated.has(cap), `task-isolated is missing ${cap}`).toBe(true);
    }
    expect(taskIsolated.size).toBeGreaterThan(sharedMutating.size);
  });

  it('TaskIsolatedCaller_SerializeMerge_ReachesTheHandler', async () => {
    // The behaviour change: the tier the gate rejected now reaches the handler.
    // This is what unblocks the real failure — `serialize_merge` answering
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
      // Handler entry is the real assertion; a result that merely stopped
      // saying CAPABILITY_DENIED could still have been refused earlier.
      expect(compositeSpy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('ReadOnlyCaller_PruneWorktrees_IsStillRejected_ByTheReadonlyGate', async () => {
    // Removing the posture gate must not widen state authority. Without this
    // case, "the posture gate is gone" reads the same as "all gating is gone".
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
