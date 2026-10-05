// Conformance tests for the liveness descriptor registry.
//
// One registry entry for each liveness surface (merge, launch, mutation, prune) defines the whole
// contract that `ps` and `wait --operation` read. The conformance test starts from the real
// `EventTypes` catalog in `schemas.ts`. A new `<surface>.executing_started` type with no registry
// entry thus fails here and not at a consumer.
//
// The `void` statement at the end of the file is a type-level check only: each `startType` must
// be an `EventType`. It has no runtime effect.

import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { z } from 'zod';
import { EventTypes, type EventType, EVENT_DATA_SCHEMAS, livenessInstanceFields } from '../../../src/events/schemas.js';
import {
  LIVENESS_REGISTRY,
  LIVENESS_DESCRIPTORS,
  MUTATION_LEGACY_SINGLETON_KEY,
  getLivenessDescriptor,
  getLivenessDescriptorByStartType,
  computeInFlightInstances,
  everyExecutingStartedType,
  livenessStartedAt,
  type LivenessDescriptor,
  type LivenessEventLike,
} from '../../../src/events/liveness-registry.js';

/**
 * Reports whether a `<surface>.executing_started` data schema requires `instanceId`.
 * It tests the field alone: an optional field admits `undefined`, and a required field rejects it.
 * The other fields of the schema do not matter, so it works for the shape of each surface.
 */
function startSchemaRequiresInstanceId(schema: z.ZodTypeAny): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const field = (schema.shape as Record<string, z.ZodTypeAny | undefined>).instanceId;
  if (field === undefined) return false;
  return !field.safeParse(undefined).success;
}

describe('LivenessRegistry conformance', () => {
  /**
   * The test starts from the real catalog through `everyExecutingStartedType`, which must agree
   * with a raw `EventTypes` filter. A catalog with no start types passes vacuously, so the count
   * comes first.
   * Each start type needs a descriptor with real terminal types, a known stream scope, and an
   * `instanceKeyOf` that never throws. A descriptor with no legacy fallback has no old rows, so
   * its start schema must require `instanceId`.
   * In the other direction, each registered `startType` must be a real catalog type.
   */
  it('LivenessRegistry_EveryExecutingStartedInCatalog_HasEntryWithTerminalScopeAndKey', () => {
    const startTypesInCatalog = everyExecutingStartedType();

    expect([...startTypesInCatalog].sort()).toEqual(
      EventTypes.filter((t) => t.endsWith('.executing_started')).sort(),
    );

    expect(startTypesInCatalog.length).toBeGreaterThanOrEqual(4);

    for (const startType of startTypesInCatalog) {
      const descriptor = getLivenessDescriptorByStartType(startType);
      expect(descriptor, `expected a registry entry for real type ${startType}`).toBeDefined();

      expect(descriptor!.terminalTypes.length).toBeGreaterThan(0);
      for (const terminal of descriptor!.terminalTypes) {
        expect(EventTypes as readonly string[]).toContain(terminal);
      }

      expect(['feature', 'worktrees']).toContain(descriptor!.streamScope);

      expect(typeof descriptor!.instanceKeyOf).toBe('function');
      expect(() => descriptor!.instanceKeyOf(undefined)).not.toThrow();
      expect(() => descriptor!.instanceKeyOf({})).not.toThrow();

      if (!descriptor!.hasLegacyFallback) {
        const startSchema = EVENT_DATA_SCHEMAS[startType as EventType];
        expect(startSchema, `start schema for new surface ${startType}`).toBeDefined();
        expect(
          startSchemaRequiresInstanceId(startSchema!),
          `descriptor '${descriptor!.surface}' has no legacy fallback → its start schema MUST require instanceId (.min(1), non-optional)`,
        ).toBe(true);
      }
    }

    for (const descriptor of LIVENESS_DESCRIPTORS) {
      expect(EventTypes as readonly string[]).toContain(descriptor.startType);
      expect(descriptor.startType.endsWith('.executing_started')).toBe(true);
    }
  });

  /**
   * Each shipped surface has a legacy fallback, so the branch for a surface with none is vacuous
   * in the conformance loop. These assertions prove that `startSchemaRequiresInstanceId`
   * discriminates. The shared shape leaves `instanceId` optional, a new-surface shape requires it,
   * and a shape with no such field fails.
   */
  it('LivenessRegistry_NewSurfaceRule_RequiresInstanceIdPredicate_Discriminates', () => {
    const optionalShape = z.object({ command: z.string().min(1), ...livenessInstanceFields });
    expect(startSchemaRequiresInstanceId(optionalShape)).toBe(false);

    const requiredShape = z.object({ command: z.string().min(1), instanceId: z.string().min(1) });
    expect(startSchemaRequiresInstanceId(requiredShape)).toBe(true);

    const noneShape = z.object({ command: z.string().min(1) });
    expect(startSchemaRequiresInstanceId(noneShape)).toBe(false);
  });

  /**
   * Each of the four surfaces accepts rows from before `instanceId`, so each has a legacy fallback.
   * A new surface must set `hasLegacyFallback: false` and require `instanceId`.
   */
  it('LivenessRegistry_AllShippedSurfaces_DeclareLegacyFallback', () => {
    for (const descriptor of LIVENESS_DESCRIPTORS) {
      expect(descriptor.hasLegacyFallback, `${descriptor.surface} legacy fallback`).toBe(true);
    }
  });

  /** `getLivenessDescriptorByStartType` is the reverse lookup and must agree. */
  it('LivenessRegistry_Lookup_ReturnsDescriptorForSurface', () => {
    const merge = getLivenessDescriptor('merge');
    expect(merge.startType).toBe('merge.executing_started');
    expect(merge.terminalTypes).toEqual(['merge.executed', 'merge.recovered']);
    expect(merge.streamScope).toBe('feature');

    const launch = getLivenessDescriptor('launch');
    expect(launch.startType).toBe('launch.executing_started');
    expect(launch.terminalTypes).toEqual(['launch.executed']);
    expect(launch.streamScope).toBe('worktrees');

    const mutation = getLivenessDescriptor('mutation');
    expect(mutation.startType).toBe('mutation.executing_started');
    expect(mutation.terminalTypes).toEqual(['mutation.executed']);
    expect(mutation.streamScope).toBe('feature');

    const prune = getLivenessDescriptor('prune');
    expect(prune.startType).toBe('prune.executing_started');
    expect(prune.terminalTypes).toEqual(['prune.executed']);
    expect(prune.streamScope).toBe('worktrees');

    expect(getLivenessDescriptorByStartType('merge.executing_started')).toBe(
      LIVENESS_REGISTRY.merge,
    );
    expect(getLivenessDescriptorByStartType('unknown.executing_started')).toBeUndefined();
  });

  /**
   * The order is `instanceId`, then `taskId`, then the `<source>→<target>` pair of a row with
   * neither. A payload with no key gives `undefined` and does not throw.
   */
  it('LivenessRegistry_MergeInstanceKey_PrefersInstanceIdThenTaskIdThenBranchPair', () => {
    const { instanceKeyOf } = getLivenessDescriptor('merge');
    expect(
      instanceKeyOf({ instanceId: 'T11', taskId: 'T99', sourceBranch: 'a', targetBranch: 'b' }),
    ).toBe('T11');
    expect(instanceKeyOf({ taskId: 'T11', sourceBranch: 'a', targetBranch: 'b' })).toBe('T11');
    expect(instanceKeyOf({ sourceBranch: 'feat/y', targetBranch: 'integration' })).toBe(
      'feat/y→integration',
    );
    expect(instanceKeyOf({})).toBeUndefined();
    expect(instanceKeyOf(undefined)).toBeUndefined();
  });

  it('LivenessRegistry_LaunchInstanceKey_PrefersInstanceIdThenWorktreeId', () => {
    const { instanceKeyOf } = getLivenessDescriptor('launch');
    expect(instanceKeyOf({ instanceId: '/wt/a', worktreeId: '/wt/b' })).toBe('/wt/a');
    expect(instanceKeyOf({ worktreeId: '/wt/b' })).toBe('/wt/b');
    expect(instanceKeyOf({})).toBeUndefined();
  });

  /**
   * The order is `instanceId`, then the legacy `operationId`. A legacy row with neither field gets
   * the singleton key, so a keyless start still pairs with its keyless terminal.
   */
  it('LivenessRegistry_MutationInstanceKey_PrefersInstanceIdThenOperationIdThenSingleton', () => {
    const { instanceKeyOf } = getLivenessDescriptor('mutation');
    expect(instanceKeyOf({ instanceId: 'op-1', operationId: 'op-legacy' })).toBe('op-1');
    expect(instanceKeyOf({ operationId: 'op-legacy' })).toBe('op-legacy');
    expect(instanceKeyOf({ command: 'npx stryker run', repoRoot: '/repo' })).toBe(
      MUTATION_LEGACY_SINGLETON_KEY,
    );
    expect(instanceKeyOf({})).toBe(MUTATION_LEGACY_SINGLETON_KEY);
    expect(instanceKeyOf(undefined)).toBe(MUTATION_LEGACY_SINGLETON_KEY);
  });

  /**
   * A keyless start and a keyless terminal on the same stream pair and clear.
   * A keyless start with no terminal stays in flight with the singleton instance key.
   */
  it('LivenessRegistry_MutationSingleton_KeylessStartPairsWithKeylessTerminal', () => {
    const descriptor = getLivenessDescriptor('mutation');
    const paired = computeInFlightInstances(descriptor, [
      { type: 'mutation.executing_started', data: { command: 'x', repoRoot: '/r' }, streamId: 'feat-a' },
      { type: 'mutation.executed', data: { command: 'x', repoRoot: '/r' }, streamId: 'feat-a' },
    ]);
    expect(paired.size).toBe(0);

    const inFlight = computeInFlightInstances(descriptor, [
      { type: 'mutation.executing_started', data: { command: 'x', repoRoot: '/r' }, streamId: 'feat-a' },
    ]);
    expect(inFlight.size).toBe(1);
    expect([...inFlight.values()][0]?.instanceKey).toBe(MUTATION_LEGACY_SINGLETON_KEY);
  });

  it('LivenessRegistry_PruneInstanceKey_PrefersInstanceIdThenOperationId', () => {
    const { instanceKeyOf } = getLivenessDescriptor('prune');
    expect(instanceKeyOf({ instanceId: 'op-1', operationId: 'op-1' })).toBe('op-1');
    expect(instanceKeyOf({ operationId: 'op-1' })).toBe('op-1');
    expect(instanceKeyOf({})).toBeUndefined();
  });

  it('LivenessRegistry_StartedAt_DerivesFromEnvelopeTimestamp', () => {
    expect(livenessStartedAt({ timestamp: '2026-07-13T00:00:00.000Z' })).toBe(
      '2026-07-13T00:00:00.000Z',
    );
    expect(livenessStartedAt({})).toBeUndefined();
    expect(livenessStartedAt({ timestamp: '' })).toBeUndefined();
  });

  /**
   * B has a terminal and clears. A has none and stays in flight. `launch` has the `worktrees`
   * scope, so the pairing key is the instance key.
   */
  it('LivenessRegistry_InstanceKey_PairsConcurrentOpsCorrectly', () => {
    const descriptor = getLivenessDescriptor('launch');
    const events: LivenessEventLike[] = [
      { type: 'launch.executing_started', data: { worktreeId: 'A' } },
      { type: 'launch.executing_started', data: { worktreeId: 'B' } },
      { type: 'launch.executed', data: { worktreeId: 'B' } },
    ];

    const inFlight = computeInFlightInstances(descriptor, events);
    const keys = new Set([...inFlight.values()].map((i) => i.instanceKey));

    expect(keys.has('A')).toBe(true);
    expect(keys.has('B')).toBe(false);
    expect([...inFlight.values()].find((i) => i.instanceKey === 'A')?.startEvent.data).toEqual({
      worktreeId: 'A',
    });
  });

  /**
   * `merge` has the `feature` scope, so the pairing key is the stream id and the instance key.
   * One merge key on two feature streams is two instances. A terminal on `feat-b` must not clear
   * the instance on `feat-a`.
   */
  it('LivenessRegistry_FeatureScope_SameKeyDifferentStreams_PairPerStream', () => {
    const descriptor = getLivenessDescriptor('merge');
    const events: LivenessEventLike[] = [
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-a' },
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-b' },
      { type: 'merge.executed', data: { instanceId: 'T11' }, streamId: 'feat-b' },
    ];

    const inFlight = computeInFlightInstances(descriptor, events);
    const survivors = [...inFlight.values()];

    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.instanceKey).toBe('T11');
    expect(survivors[0]?.streamId).toBe('feat-a');
  });

  it('LivenessRegistry_InstanceKey_TerminalWithNoMatchingStartIsANoop', () => {
    const descriptor = getLivenessDescriptor('prune');
    const events: LivenessEventLike[] = [
      { type: 'prune.executed', data: { operationId: 'op-orphan' } },
    ];
    const inFlight = computeInFlightInstances(descriptor, events);
    expect(inFlight.size).toBe(0);
  });

  /** A start after a terminal opens the instance again: exactly one instance is in flight. */
  it('LivenessRegistry_InstanceKey_RestartAfterTerminalReopensTheInstance', () => {
    const descriptor = getLivenessDescriptor('mutation');
    const events: LivenessEventLike[] = [
      { type: 'mutation.executing_started', data: { operationId: 'op-1' }, streamId: 'feat-a' },
      { type: 'mutation.executed', data: { operationId: 'op-1' }, streamId: 'feat-a' },
      { type: 'mutation.executing_started', data: { operationId: 'op-1' }, streamId: 'feat-a' },
    ];
    const inFlight = computeInFlightInstances(descriptor, events);
    expect(inFlight.size).toBe(1);
    expect([...inFlight.values()][0]?.instanceKey).toBe('op-1');
  });

  /**
   * Property test. The reference model is a plain `Set<string>`: a start adds a key and a
   * terminal removes it. The model shares no code with `computeInFlightInstances`.
   * The test compares both over 200 random sequences from a small key alphabet. The sequences
   * cover repeated starts, terminals before starts, and restarts after a terminal.
   */
  it('LivenessRegistry_InstanceKey_PairingMatchesReferenceModelOverArbitraryInterleavings', () => {
    const keyAlphabet = ['A', 'B', 'C'] as const;
    const opArb = fc.record({
      op: fc.constantFrom<'start' | 'terminal'>('start', 'terminal'),
      key: fc.constantFrom(...keyAlphabet),
    });

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 50 }), (ops) => {
        const descriptor = getLivenessDescriptor('prune');
        const events: LivenessEventLike[] = ops.map(({ op, key }) => ({
          type: op === 'start' ? descriptor.startType : descriptor.terminalTypes[0],
          data: { operationId: key },
        }));

        const actual = computeInFlightInstances(descriptor, events);

        const expected = new Set<string>();
        for (const { op, key } of ops) {
          if (op === 'start') expected.add(key);
          else expected.delete(key);
        }

        expect(new Set(actual.keys())).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });
});

void ((): void => {
  const _surfaces: readonly EventType[] = LIVENESS_DESCRIPTORS.map((d) => d.startType);
  void _surfaces;
});
