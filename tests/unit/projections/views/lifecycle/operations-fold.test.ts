// Tests for `foldInFlightOperations`, the generic `ps` operations fold. Each
// test uses the real `LIVENESS_DESCRIPTORS` registry. The fifth-surface test
// alone passes a registry override, to show that the fold has no code for one
// specific surface. The last statement is a type-level use of
// `getLivenessDescriptor`, and it never runs.

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
import { WORKTREES_STREAM } from '../../../../../src/verbs/worktree/manager.js';

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

  /** Both starts use one stream scope and one surface, so only the instance key separates them. */
  it('OperationsFold_ConcurrentSameStreamOps_PairsByInstanceKey', () => {
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

  /** `mutation` is a `feature`-scope surface. It goes through the same loop as a `worktrees`-scope surface. */
  it('OperationsFold_MutationSurface_ListedGenerically', () => {
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

  /**
   * The row has no `instanceId` and no `worktreeId`. `launch` has no singleton fallback, so the
   * key is `undefined` and the fold skips the row.
   */
  it('OperationsFold_UnresolvableKey_SkippedNeverThrows', () => {
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

  /** The four surfaces each have one start in one event list. One fold must list all four. */
  it('OperationsFold_EveryRegisteredSurface_ObservableInOneFold', () => {
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

  /**
   * Two feature workflows use the same merge `instanceKey`, and only the merge of `feat-b` ends.
   * A terminal on one stream must not clear the start on the other stream. The row names the
   * workflow that is stuck.
   */
  it('OperationsFold_SameMergeKeyDifferentFeatureStreams_TerminalDoesNotCrossClear', () => {
    const events: OperationEventLike[] = [
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-a', timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-b', timestamp: '2026-07-13T00:00:01.000Z' },
      { type: 'merge.executed', data: { instanceId: 'T11' }, streamId: 'feat-b', timestamp: '2026-07-13T00:00:02.000Z' },
    ];

    const rows = foldInFlightOperations(events);
    const merges = rows.filter((r) => r.surface === 'merge');

    expect(merges).toHaveLength(1);
    expect(merges[0]?.instanceKey).toBe('T11');
    expect(merges[0]?.streamId).toBe('feat-a');
    expect(merges[0]?.featureId).toBe('feat-a');
  });

  /**
   * `launch` uses the shared `worktrees` stream, so two instances on that stream pair by key alone.
   * A `worktrees`-scope row has no `featureId`.
   */
  it('OperationsFold_WorktreesScope_SameKeyOneStream_PairsByKeyAcrossInstances', () => {
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

  /**
   * The reference model is a set of compound keys. A start adds a key and a terminal removes it.
   * A `feature`-scope surface keys on the stream and the instance key. A `worktrees`-scope surface
   * keys on the instance key alone. The model reads only `surface` and `streamScope` from the registry.
   */
  it('OperationsFold_InFlightListing_MatchesReferenceModelOverArbitraryStreamInterleavings', () => {
    const keyAlphabet = ['A', 'B', 'C'] as const;
    const streamAlphabet = ['s1', 's2'] as const;
    const opArb = fc.record({
      surfaceIndex: fc.constantFrom(0, 1, 2, 3),
      op: fc.constantFrom<'start' | 'terminal'>('start', 'terminal'),
      key: fc.constantFrom(...keyAlphabet),
      stream: fc.constantFrom(...streamAlphabet),
    });

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

  /** A fixed case of the property test: two `mutation` starts share one key on two feature streams, and one ends. */
  it('OperationsFold_FeatureSurface_SameKeyDistinctStreams_PairIndependently', () => {
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

  /**
   * The `registry` option adds a `deploy` descriptor that the real registry does not hold. The fold
   * lists its start with no change to the fold. A real `merge` pair in the same list still pairs.
   */
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
      { type: 'merge.executing_started', data: { instanceId: 'M1' }, timestamp: '2026-07-13T00:00:00.000Z' },
      { type: 'merge.executed', data: { instanceId: 'M1' }, timestamp: '2026-07-13T00:00:01.000Z' },
    ];

    const rows = foldInFlightOperations(events, { registry });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'deploy', instanceKey: 'D1' });
  });

  /** The events go through a real `EventStore` (append, query, fold), so the fold reads stored `WorkflowEvent` rows. */
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

      expect(bySurface.get('merge')).toBe('T1');
      expect(bySurface.get('launch')).toBe('/wt/a');
      expect(bySurface.has('mutation')).toBe(false);
      expect(bySurface.has('prune')).toBe(false);
      expect(rows).toHaveLength(2);
    });
  });
});

void ((): void => {
  const _ = getLivenessDescriptor('merge');
  void _;
});
