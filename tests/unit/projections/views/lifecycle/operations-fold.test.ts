import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  foldInFlightOperations,
  type OperationEventLike,
} from '../../../../../src/projections/views/lifecycle/operations-fold.js';
import {
  LIVENESS_DESCRIPTORS,
  getLivenessDescriptor,
  type LivenessDescriptor,
} from '../../../../../src/events/liveness-registry.js';
import type { EventType } from '../../../../../src/events/schemas.js';
import { EventStore } from '../../../../../src/events/store.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import { percentile } from '../../../../../src/projections/telemetry/percentile.js';
import { WORKTREES_STREAM } from '../../../../../src/verbs/worktree/manager.js';

const RUN_BENCHMARKS = process.env.RUN_BENCHMARKS === 'true';

// ─── DR-3 (task 006): generic `ps` operations fold ──────────────────────────
//
// `foldInFlightOperations` is driven ENTIRELY by the REAL liveness-registry
// (`LIVENESS_DESCRIPTORS`, imported — never hand-rolled) — every test below
// exercises the real registry's real descriptors, real `startType`/
// `terminalTypes`, and real `instanceKeyOf` derivations. The only exception is
// the conformance test at the bottom, which passes a caller-supplied registry
// override to prove the fold itself carries zero surface-specific code — the
// DR-3 acceptance criterion ("adding a surface to the registry must add it to
// `ps` with no fold change").

describe('OperationsFold — generic in-flight operations (DR-3)', () => {
  it('OperationsFold_StartedWithoutTerminal_ListedInFlight', () => {
    const events: OperationEventLike[] = [
      {
        type: 'launch.executing_started',
        data: { instanceId: 'wt-A' },
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    ];

    const rows = foldInFlightOperations(events, { now: () => Date.parse('2026-07-13T00:00:05.000Z') });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: 'launch',
      instanceKey: 'wt-A',
      streamScope: 'worktrees',
      startType: 'launch.executing_started',
      startedAt: '2026-07-13T00:00:00.000Z',
      ageMs: 5000,
    });
  });

  it('OperationsFold_TerminalPresent_Excluded', () => {
    const events: OperationEventLike[] = [
      {
        type: 'launch.executing_started',
        data: { instanceId: 'wt-A' },
        timestamp: '2026-07-13T00:00:00.000Z',
      },
      {
        type: 'launch.executed',
        data: { instanceId: 'wt-A' },
        timestamp: '2026-07-13T00:00:01.000Z',
      },
    ];

    const rows = foldInFlightOperations(events);

    expect(rows).toHaveLength(0);
  });

  it('OperationsFold_ConcurrentSameStreamOps_PairsByInstanceKey', () => {
    // start A, start B, terminal B → exactly A listed. Both events ride the
    // SAME stream scope (`worktrees`) and the SAME surface (`launch`) — the
    // pairing must discriminate purely by instance key, not by ordinal
    // position or event count.
    const events: OperationEventLike[] = [
      { type: 'launch.executing_started', data: { instanceId: 'A' }, timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'launch.executing_started', data: { instanceId: 'B' }, timestamp: '2026-07-13T00:00:01.000Z' },
      { type: 'launch.executed', data: { instanceId: 'B' }, timestamp: '2026-07-13T00:00:02.000Z' },
    ];

    const rows = foldInFlightOperations(events);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.instanceKey).toBe('A');
    expect(rows[0]?.surface).toBe('launch');
  });

  it('OperationsFold_MutationSurface_ListedGenerically', () => {
    // Proves the fold carries no mutation-specific code: the mutation surface
    // (a `'feature'`-scope surface, unlike the two `'worktrees'`-scope
    // surfaces exercised above) flows through the exact same generic
    // registry-driven loop with no special-casing anywhere in
    // `operations-fold.ts` — grep the module: there is no `'mutation'`
    // string literal branch to have hit.
    const events: OperationEventLike[] = [
      {
        type: 'mutation.executing_started',
        data: { instanceId: 'op-mut-1', command: 'npx stryker run', repoRoot: '/repo' },
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    ];

    const rows = foldInFlightOperations(events);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: 'mutation',
      instanceKey: 'op-mut-1',
      streamScope: 'feature',
      startType: 'mutation.executing_started',
    });
  });

  it('OperationsFold_RestartAfterTerminal_ReopensTheInstance', () => {
    const events: OperationEventLike[] = [
      { type: 'prune.executing_started', data: { instanceId: 'op-1' }, timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'prune.executed', data: { instanceId: 'op-1' }, timestamp: '2026-07-13T00:00:01.000Z' },
      { type: 'prune.executing_started', data: { instanceId: 'op-1' }, timestamp: '2026-07-13T00:00:02.000Z' },
    ];

    const rows = foldInFlightOperations(events);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.startedAt).toBe('2026-07-13T00:00:02.000Z');
  });

  it('OperationsFold_UnresolvableKey_SkippedNeverThrows', () => {
    // A `launch` row carrying neither instanceId nor worktreeId — `instanceKeyOf`
    // returns undefined (launch has no singleton fallback) and the fold must not
    // throw or list a phantom entry for it. (Mutation now resolves keyless rows
    // to the DR-2 singleton, so `launch` is the surface that stays unresolvable.)
    const events: OperationEventLike[] = [
      {
        type: 'launch.executing_started',
        data: { holderPid: 4242 },
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    ];

    expect(() => foldInFlightOperations(events)).not.toThrow();
    expect(foldInFlightOperations(events)).toHaveLength(0);
  });

  it('OperationsFold_EveryRegisteredSurface_ObservableInOneFold', () => {
    // All four INV-10 surfaces, interleaved in one event list, each with one
    // in-flight start — the fold's per-descriptor loop must surface every
    // one of them in a single pass, independently of stream/surface identity.
    const events: OperationEventLike[] = [
      { type: 'merge.executing_started', data: { instanceId: 'M1' }, timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'launch.executing_started', data: { instanceId: 'L1' }, timestamp: '2026-07-13T00:00:01.000Z' },
      { type: 'mutation.executing_started', data: { instanceId: 'MU1' }, timestamp: '2026-07-13T00:00:02.000Z' },
      { type: 'prune.executing_started', data: { instanceId: 'P1' }, timestamp: '2026-07-13T00:00:03.000Z' },
    ];

    const rows = foldInFlightOperations(events);
    const bySurface = new Map(rows.map((r) => [r.surface, r.instanceKey]));

    expect(bySurface.get('merge')).toBe('M1');
    expect(bySurface.get('launch')).toBe('L1');
    expect(bySurface.get('mutation')).toBe('MU1');
    expect(bySurface.get('prune')).toBe('P1');
    expect(rows).toHaveLength(4);
  });

  // ── S-6 regression: cross-stream mis-pairing (finding 1) ───────────────────
  //
  // Two feature workflows whose merge `instanceKey` COLLIDES (a recurring taskId
  // `T11`, or a shared branch pair) must pair PER STREAM. A terminal on
  // workflow-B's stream may only clear B's in-flight merge — it must NOT clear
  // workflow-A's genuinely-stuck merge, which would make A vanish from `ps
  // operations`. This is the exact S-6 failure the feature exists to prevent; a
  // mutation that drops stream-scoping (pairing by `(surface, instanceKey)`
  // alone) fails this test.
  it('OperationsFold_SameMergeKeyDifferentFeatureStreams_TerminalDoesNotCrossClear', () => {
    const events: OperationEventLike[] = [
      // feat-a starts a merge with key T11.
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-a', timestamp: '2026-07-13T00:00:00.000Z' },
      // feat-b starts a merge with the SAME key T11.
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-b', timestamp: '2026-07-13T00:00:01.000Z' },
      // Only feat-b's merge terminates.
      { type: 'merge.executed', data: { instanceId: 'T11' }, streamId: 'feat-b', timestamp: '2026-07-13T00:00:02.000Z' },
    ];

    const rows = foldInFlightOperations(events);
    const merges = rows.filter((r) => r.surface === 'merge');

    // feat-a's T11 merge is STILL in flight; feat-b's was cleared.
    expect(merges).toHaveLength(1);
    expect(merges[0]?.instanceKey).toBe('T11');
    expect(merges[0]?.streamId).toBe('feat-a');
    // The row names the stuck workflow so a consumer can answer "which is stuck?".
    expect(merges[0]?.featureId).toBe('feat-a');
  });

  it('OperationsFold_WorktreesScope_SameKeyOneStream_PairsByKeyAcrossInstances', () => {
    // The dual of the S-6 case: launch is `worktrees`-scoped (one shared
    // singleton stream), so cross-instance concurrency on that one stream is
    // NORMAL and pairs by key alone. A `featureId` is never attributed to a
    // worktrees-scoped op (it names no workflow).
    const events: OperationEventLike[] = [
      { type: 'launch.executing_started', data: { instanceId: 'wt-A' }, streamId: 'worktrees', timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'launch.executing_started', data: { instanceId: 'wt-B' }, streamId: 'worktrees', timestamp: '2026-07-13T00:00:01.000Z' },
      { type: 'launch.executed', data: { instanceId: 'wt-B' }, streamId: 'worktrees', timestamp: '2026-07-13T00:00:02.000Z' },
    ];

    const rows = foldInFlightOperations(events);
    const launches = rows.filter((r) => r.surface === 'launch');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.instanceKey).toBe('wt-A');
    expect(launches[0]?.streamId).toBe('worktrees');
    expect(launches[0]?.featureId).toBeUndefined();
  });

  // ── Property test (state-machine): pairing correctness over arbitrary
  //    start/terminal/surface/STREAM interleavings (finding 2) ─────────────
  //
  // An independent reference model — a plain `Set<string>` of compound keys,
  // mutated by the same start-adds/terminal-removes rule the registry documents
  // — is compared against `foldInFlightOperations` over hundreds of randomly
  // generated event sequences spanning ALL FOUR surfaces, a small key alphabet,
  // AND a stream dimension. It proves three isolations at once:
  //   • cross-surface: a `launch` START for `'A'` is never cleared by a `merge`
  //     TERMINAL for the same literal `'A'`;
  //   • cross-stream (the S-6 property): a `feature`-scoped START for `'A'` on
  //     stream `s1` is never cleared by a TERMINAL for `'A'` on stream `s2`;
  //   • singleton-stream collapse: a `worktrees`-scoped surface pairs by key
  //     alone, so the stream dimension is IGNORED for it (concurrent ops on the
  //     one shared stream is the normal case).
  // The reference model's compound key mirrors that scope-dependent rule exactly.
  it('OperationsFold_InFlightListing_MatchesReferenceModelOverArbitraryStreamInterleavings', () => {
    const keyAlphabet = ['A', 'B', 'C'] as const;
    const streamAlphabet = ['s1', 's2'] as const;
    const opArb = fc.record({
      surfaceIndex: fc.constantFrom(0, 1, 2, 3),
      op: fc.constantFrom<'start' | 'terminal'>('start', 'terminal'),
      key: fc.constantFrom(...keyAlphabet),
      stream: fc.constantFrom(...streamAlphabet),
    });

    // The reference model's identity for an instance: feature-scoped surfaces
    // are per-(stream,key); worktrees-scoped surfaces are per-key (stream elided).
    const refId = (surfaceIndex: number, stream: string, key: string): string => {
      const descriptor = LIVENESS_DESCRIPTORS[surfaceIndex];
      return descriptor.streamScope === 'feature'
        ? `${descriptor.surface}:${stream}:${key}`
        : `${descriptor.surface}:${key}`;
    };

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 80 }), (ops) => {
        const events: OperationEventLike[] = ops.map(({ surfaceIndex, op, key, stream }, i) => {
          const descriptor = LIVENESS_DESCRIPTORS[surfaceIndex];
          return {
            type: op === 'start' ? descriptor.startType : descriptor.terminalTypes[0],
            data: { instanceId: key },
            streamId: stream,
            timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          };
        });

        const rows = foldInFlightOperations(events);
        const actual = new Set(
          rows.map((r) => {
            const idx = LIVENESS_DESCRIPTORS.findIndex((d) => d.surface === r.surface);
            return refId(idx, r.streamId ?? '', r.instanceKey);
          }),
        );

        // Reference model: independent from the implementation under test.
        const expected = new Set<string>();
        for (const { surfaceIndex, op, key, stream } of ops) {
          const id = refId(surfaceIndex, stream, key);
          if (op === 'start') expected.add(id);
          else expected.delete(id);
        }

        expect(actual).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('OperationsFold_FeatureSurface_SameKeyDistinctStreams_PairIndependently', () => {
    // A focused witness of the cross-stream property the generator explores:
    // two mutation starts for key `'K'` on different feature streams, one
    // terminated, leaves exactly the other in flight (same-key/different-stream
    // feature ops pair independently — finding 2).
    const events: OperationEventLike[] = [
      { type: 'mutation.executing_started', data: { instanceId: 'K' }, streamId: 'feat-a', timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'mutation.executing_started', data: { instanceId: 'K' }, streamId: 'feat-b', timestamp: '2026-07-13T00:00:01.000Z' },
      { type: 'mutation.executed', data: { instanceId: 'K' }, streamId: 'feat-a', timestamp: '2026-07-13T00:00:02.000Z' },
    ];
    const rows = foldInFlightOperations(events).filter((r) => r.surface === 'mutation');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.streamId).toBe('feat-b');
    expect(rows[0]?.instanceKey).toBe('K');
  });

  // ── DR-3 acceptance criterion: a hypothetical fifth surface requires ZERO
  //    fold change ──────────────────────────────────────────────────────
  //
  // `foldInFlightOperations` accepts an optional `registry` override
  // precisely so this conformance test can prove genericity: a descriptor
  // for a surface that does NOT exist in the real registry (a synthetic
  // `'deploy'` surface, standing in for "whatever task 004+N adds next") is
  // paired and surfaced correctly with no code change to
  // `operations-fold.ts` — only the caller-supplied descriptor list grew.
  // Production callers never pass this option; it defaults to the real
  // `LIVENESS_DESCRIPTORS`.
  it('OperationsFold_HypotheticalFifthSurface_RequiresNoFoldChange', () => {
    const syntheticDescriptor: LivenessDescriptor = {
      surface: 'deploy' as unknown as LivenessDescriptor['surface'],
      startType: 'deploy.executing_started' as unknown as EventType,
      terminalTypes: ['deploy.executed' as unknown as EventType],
      streamScope: 'feature',
      instanceKeyOf: (data) =>
        typeof data?.instanceId === 'string' ? data.instanceId : undefined,
    };

    const registry = [...LIVENESS_DESCRIPTORS, syntheticDescriptor];

    const events: OperationEventLike[] = [
      {
        type: 'deploy.executing_started' as unknown as string,
        data: { instanceId: 'D1' },
        timestamp: '2026-07-13T00:00:00.000Z',
      },
      // A real, registered surface stays correctly paired alongside the
      // synthetic one — proves the fold treats every descriptor uniformly.
      { type: 'merge.executing_started', data: { instanceId: 'M1' }, timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'merge.executed', data: { instanceId: 'M1' }, timestamp: '2026-07-13T00:00:01.000Z' },
    ];

    const rows = foldInFlightOperations(events, { registry });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'deploy', instanceKey: 'D1' });
  });

  // ── Boundary: real registry + a REAL event store (not hand-mocked) ──────
  //
  // Every test above hand-builds `OperationEventLike` literals (matching the
  // sibling `liveness-registry.test.ts` convention) but always against the
  // REAL imported registry. This test additionally routes events through a
  // REAL `EventStore` (append → query → fold) so the fold is proven against
  // genuine store-backed `WorkflowEvent` rows, not just literals shaped by
  // hand.
  describe('real EventStore boundary', () => {
    let tmpDir: string;
    let store: EventStore;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-fold-bench-'));
      store = new EventStore(tmpDir);
      await store.initialize();
    });

    afterEach(async () => {
      store.close();
      await rmrfAsync(tmpDir);
    });

    it('OperationsFold_RealEventStoreEvents_MatchesGenericFold', async () => {
      const featureStream = 'feat-ops-fold-boundary';

      // `merge` and `mutation` ride the feature stream.
      await store.append(featureStream, {
        type: 'merge.executing_started',
        data: {
          taskId: 'T1',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          recoveryPointSha: 'deadbeef',
          startedAt: '2026-07-13T00:00:00.000Z',
          instanceId: 'T1',
        },
      });
      await store.append(featureStream, {
        type: 'mutation.executing_started',
        data: { command: 'npx stryker run', repoRoot: '/repo', instanceId: 'op-mut-1' },
      });
      await store.append(featureStream, {
        type: 'mutation.executed',
        data: {
          command: 'npx stryker run',
          repoRoot: '/repo',
          passed: true,
          exitCode: 0,
          instanceId: 'op-mut-1',
        },
      });

      // `launch` and `prune` ride the singleton worktrees stream.
      await store.append(WORKTREES_STREAM, {
        type: 'launch.executing_started',
        data: { worktreeId: '/wt/a', holderPid: 4242, holderStartedAt: null, instanceId: '/wt/a' },
      });
      await store.append(WORKTREES_STREAM, {
        type: 'prune.executing_started',
        data: { operationId: 'op-prune-1', repoRoot: '/repo', instanceId: 'op-prune-1' },
      });
      await store.append(WORKTREES_STREAM, {
        type: 'prune.executed',
        data: { operationId: 'op-prune-1', repoRoot: '/repo', instanceId: 'op-prune-1' },
      });

      const featureEvents = await store.query(featureStream);
      const worktreesEvents = await store.query(WORKTREES_STREAM);
      const merged = [...featureEvents, ...worktreesEvents];

      const rows = foldInFlightOperations(merged);
      const bySurface = new Map(rows.map((r) => [r.surface, r.instanceKey]));

      // merge (in flight — no terminal) and launch (in flight — no terminal)
      // are listed; mutation and prune both reached a terminal and are
      // excluded.
      expect(bySurface.get('merge')).toBe('T1');
      expect(bySurface.get('launch')).toBe('/wt/a');
      expect(bySurface.has('mutation')).toBe(false);
      expect(bySurface.has('prune')).toBe(false);
      expect(rows).toHaveLength(2);
    });

    // ── Benchmark: cold fold over 10k real store-backed events ────────────
    //
    // Boundary/offline cadence (RUN_BENCHMARKS=true), never the default inner
    // loop — matches the sibling `telemetry/benchmarks/*.test.ts` convention.
    // 10k events across all four surfaces (a realistic mix of in-flight and
    // terminated instances) are appended to a real `EventStore`, queried back
    // once (cold — no prior fold on this data), then folded repeatedly to
    // compute a p95 over real wall-clock runs.
    it.skipIf(!RUN_BENCHMARKS)('operations-fold-cold-10k-events', async () => {
      const streamId = 'bench-ops-fold-cold-10k';
      const surfaces = LIVENESS_DESCRIPTORS;
      const eventCount = 10_000;

      const batch: Array<{ type: string; data: Record<string, unknown>; timestamp: string }> = [];
      for (let i = 0; i < eventCount; i++) {
        const descriptor = surfaces[i % surfaces.length];
        // Every 3rd instance is left in flight (start with no terminal);
        // the other two thirds get their terminal appended immediately
        // after — a realistic mostly-quiescent-with-some-stragglers mix.
        const key = `k-${i}`;
        const isInFlight = i % 3 === 0;
        batch.push({
          type: descriptor.startType,
          data: { instanceId: key },
          timestamp: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
        });
        if (!isInFlight) {
          batch.push({
            type: descriptor.terminalTypes[0],
            data: { instanceId: key },
            timestamp: new Date(2026, 0, 1, 0, 0, 1, i).toISOString(),
          });
        }
      }

      await store.batchAppend(streamId, batch);
      const events = await store.query(streamId);
      expect(events.length).toBeGreaterThanOrEqual(eventCount);

      // Act — repeated cold folds over the same (already-queried) event
      // list, timing each run independently to compute a p95.
      const elapsedRuns: number[] = [];
      for (let run = 0; run < 15; run++) {
        const start = performance.now();
        foldInFlightOperations(events);
        elapsedRuns.push(performance.now() - start);
      }

      const p95 = percentile(elapsedRuns, 0.95);
      console.log(
        `[operations-fold] cold ${events.length} events, p95 over 15 runs: ${p95.toFixed(3)}ms`,
      );
      expect(p95).toBeLessThan(250);
    });
  });
});

// ── Type-level guard: LIVENESS_DESCRIPTORS export shape stays stable ───────
void ((): void => {
  const _ = getLivenessDescriptor('merge');
  void _;
});
