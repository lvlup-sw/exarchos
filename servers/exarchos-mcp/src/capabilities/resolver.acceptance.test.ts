// ─── Acceptance test: AgentPosture spec → EffectiveCapabilities ────────────
//
// DR-6 acceptance criterion of #1259 (durable event-store substrate):
//   "capabilities/resolver.ts exposes resolvePosture(spec, runtime) returning
//    EffectiveCapabilities. Posture-to-capabilities mapping documented in
//    capabilities/posture-mapping.ts ... Resolver continues to merge yaml ⊕
//    handshake; handshake declarations override resolved capabilities."
//
// This is the bundle-level acceptance test for T29..T34/T59. It is RED until
// every other RED→GREEN pair lands. It deliberately does NOT exercise the
// override-priority case — that is T59's concern. Here we only assert union
// + posture-derived inclusion.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolvePosture, createInMemoryResolver } from './resolver.js';
import type { Capability } from '../agents/capabilities.js';
import type { DispatchContext } from '../core/dispatch.js';
import { dispatch, stubCompositeHandler } from '../core/dispatch.js';
import { EventStore } from '../events/store.js';

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

    // Posture-derived caps from posture-mapping table for `task-isolated`.
    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(true);

    // Handshake-declared cap is unioned in.
    expect(effective.has('mcp:exarchos')).toBe(true);
  });
});

// ─── #1305 T14: read-only caller rejected at the resolver gate ─────────────
//
// INV-11 (make the illegal state unrepresentable-by-construction): a caller
// resolved as `read-only` (effective capability set = {mcp:exarchos:readonly},
// no mcp:exarchos) that attempts `merge_orchestrate` MUST be rejected at the
// resolver gate (`enforceReadonlyGate`) BEFORE the merge handler is reached.
//
// T13 declared `posture: 'shared-mutating'` on the merge_orchestrate
// registration; the capability resolver mints fs:write + shell:exec from that
// posture. This test proves the boundary the other way: the read-only tier is
// rejected structurally, and `handleMergeOrchestrate` is never entered.
//
// The proof exercises the real resolver→dispatch seam (not a unit stub): a
// genuine `dispatch()` call with a read-only `capabilityResolver`, with the
// composite handler replaced by a spy. Since `enforceReadonlyGate` runs in
// `dispatch()` BEFORE `coreHandler` (which routes `merge_orchestrate` to
// `handleMergeOrchestrate`) is ever constructed/invoked, the spy must never
// fire. Asserting the spy is uncalled — not merely that the result is an
// error — is the load-bearing guarantee (a handler that rejected internally
// would still have been entered).
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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects a read-only caller at the resolver gate without entering the merge handler', async () => {
    // Arrange — capability resolver reports ONLY the readonly tier (no
    // mcp:exarchos), modelling a `read-only` posture's effective capability
    // set. Confirm the modelling is faithful to the posture mapping.
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

    // Spy installed on the composite handler that, in production, routes
    // `merge_orchestrate` through `handleMergeOrchestrate`. If dispatch
    // reaches the handler, this spy runs — so its call count is the witness
    // for "handler entered."
    const compositeSpy = vi.fn(async () => ({ success: true as const, data: {} }));
    const restore = stubCompositeHandler('exarchos_orchestrate', compositeSpy);

    try {
      // Act — a valid merge_orchestrate payload (so schema validation passes
      // and we genuinely exercise the capability gate, not INVALID_INPUT).
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

      // Assert (1) — the gate rejected with a structured CAPABILITY_DENIED
      // identifying the tool/action so the caller can correlate.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CAPABILITY_DENIED');
      expect(result.error?.tool).toBe('exarchos_orchestrate');
      expect(result.error?.action).toBe('merge_orchestrate');

      // Assert (2) — THE load-bearing guarantee: the merge handler was never
      // entered. Rejection happens at the resolver gate, before dispatch
      // constructs/invokes the composite handler.
      expect(compositeSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
