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

// ─── DR-2 (task 004): liveness descriptor registry conformance ─────────────
//
// One registry entry per INV-10 liveness surface (merge / launch / mutation /
// prune) defines the whole contract `ps` / `wait --operation` (tasks 006/010)
// will consume. The conformance test below drives its assertion off the REAL
// `EventTypes` catalog in `schemas.ts` — not a hand-mocked list — so adding a
// fifth `<surface>.executing_started` type without a matching registry entry
// fails loudly here rather than silently at the `ps`/`wait` consumer.

/**
 * Whether a `<surface>.executing_started` data schema REQUIRES a non-optional
 * `instanceId`. Tests the field in isolation: an optional field admits
 * `undefined`, a required one rejects it — independent of the schema's other
 * fields, so it works for any surface's shape (finding 4 / DR-2 new-surface rule).
 */
function startSchemaRequiresInstanceId(schema: z.ZodTypeAny): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const field = (schema.shape as Record<string, z.ZodTypeAny | undefined>).instanceId;
  if (field === undefined) return false;
  // Required iff the field itself rejects an omitted (`undefined`) value.
  return !field.safeParse(undefined).success;
}

describe('LivenessRegistry conformance', () => {
  it('LivenessRegistry_EveryExecutingStartedInCatalog_HasEntryWithTerminalScopeAndKey', () => {
    // Drive off the REAL catalog via the exported helper (not a re-derived inline
    // filter) — this is the whole point of the conformance test: a real
    // unregistered surface (a new `<x>.executing_started` type added to
    // `EventTypes` with no matching registry entry) must fail here.
    const startTypesInCatalog = everyExecutingStartedType();

    // The helper agrees with the catalog it is derived from (guards a drift
    // between `everyExecutingStartedType()` and a raw `EventTypes` filter).
    expect([...startTypesInCatalog].sort()).toEqual(
      EventTypes.filter((t) => t.endsWith('.executing_started')).sort(),
    );

    // Sanity: the catalog actually has liveness-start types to check (a
    // vacuous conformance test would silently pass on an empty catalog).
    expect(startTypesInCatalog.length).toBeGreaterThanOrEqual(4);

    for (const startType of startTypesInCatalog) {
      const descriptor = getLivenessDescriptorByStartType(startType);
      expect(descriptor, `expected a registry entry for real type ${startType}`).toBeDefined();

      // Terminal: at least one terminal type, and every declared terminal is
      // itself a real, registered `EventType` (catches a typo'd terminal).
      expect(descriptor!.terminalTypes.length).toBeGreaterThan(0);
      for (const terminal of descriptor!.terminalTypes) {
        expect(EventTypes as readonly string[]).toContain(terminal);
      }

      // Scope: declared and one of the two known stream families.
      expect(['feature', 'worktrees']).toContain(descriptor!.streamScope);

      // Key: instanceKeyOf is present and callable without throwing, even on
      // an empty/undefined payload (the "never throws" contract).
      expect(typeof descriptor!.instanceKeyOf).toBe('function');
      expect(() => descriptor!.instanceKeyOf(undefined)).not.toThrow();
      expect(() => descriptor!.instanceKeyOf({})).not.toThrow();

      // New-surface rule (DR-2 AC): a descriptor WITHOUT a legacy fallback has no
      // pre-retrofit rows to accommodate, so its start schema MUST require a
      // non-optional `instanceId` (`.min(1)`). A descriptor WITH a fallback may
      // leave `instanceId` optional (legacy rows pair via the fallback).
      if (!descriptor!.hasLegacyFallback) {
        const startSchema = EVENT_DATA_SCHEMAS[startType as EventType];
        expect(startSchema, `start schema for new surface ${startType}`).toBeDefined();
        expect(
          startSchemaRequiresInstanceId(startSchema!),
          `descriptor '${descriptor!.surface}' has no legacy fallback → its start schema MUST require instanceId (.min(1), non-optional)`,
        ).toBe(true);
      }
    }

    // Reverse direction: every registered descriptor's startType is itself a
    // real catalog type (no stale/renamed entry lingering in the registry).
    for (const descriptor of LIVENESS_DESCRIPTORS) {
      expect(EventTypes as readonly string[]).toContain(descriptor.startType);
      expect(descriptor.startType.endsWith('.executing_started')).toBe(true);
    }
  });

  // ── The new-surface rule's guard is not a no-op (finding 4) ────────────────
  //
  // Every SHIPPED surface has a legacy fallback, so the conformance loop's
  // fallback-less branch is currently vacuous. These focused assertions prove
  // the `startSchemaRequiresInstanceId` predicate the rule rests on actually
  // discriminates — so a future fallback-less surface with an OPTIONAL
  // `instanceId` really would be caught, not silently admitted.
  it('LivenessRegistry_NewSurfaceRule_RequiresInstanceIdPredicate_Discriminates', () => {
    // The current shared shape leaves `instanceId` optional (additive retrofit).
    const optionalShape = z.object({ command: z.string().min(1), ...livenessInstanceFields });
    expect(startSchemaRequiresInstanceId(optionalShape)).toBe(false);

    // A new-surface shape requires it non-optional (`.min(1)`).
    const requiredShape = z.object({ command: z.string().min(1), instanceId: z.string().min(1) });
    expect(startSchemaRequiresInstanceId(requiredShape)).toBe(true);

    // A shape with NO instanceId field at all does not satisfy the rule either.
    const noneShape = z.object({ command: z.string().min(1) });
    expect(startSchemaRequiresInstanceId(noneShape)).toBe(false);
  });

  it('LivenessRegistry_AllShippedSurfaces_DeclareLegacyFallback', () => {
    // All four INV-10 surfaces accommodate pre-retrofit rows, so each carries a
    // legacy fallback. (When a genuinely new surface is added it must set
    // `hasLegacyFallback: false` AND require `instanceId` — enforced above.)
    for (const descriptor of LIVENESS_DESCRIPTORS) {
      expect(descriptor.hasLegacyFallback, `${descriptor.surface} legacy fallback`).toBe(true);
    }
  });

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

    // getLivenessDescriptorByStartType is the reverse lookup and must agree.
    expect(getLivenessDescriptorByStartType('merge.executing_started')).toBe(
      LIVENESS_REGISTRY.merge,
    );
    expect(getLivenessDescriptorByStartType('unknown.executing_started')).toBeUndefined();
  });

  // ── instanceKeyOf canonical-key derivations (mirrors task 003's emitters) ──

  it('LivenessRegistry_MergeInstanceKey_PrefersInstanceIdThenTaskIdThenBranchPair', () => {
    const { instanceKeyOf } = getLivenessDescriptor('merge');
    // instanceId present → wins over everything else.
    expect(
      instanceKeyOf({ instanceId: 'T11', taskId: 'T99', sourceBranch: 'a', targetBranch: 'b' }),
    ).toBe('T11');
    // No instanceId, taskId present → taskId.
    expect(instanceKeyOf({ taskId: 'T11', sourceBranch: 'a', targetBranch: 'b' })).toBe('T11');
    // Neither → `<source>→<target>` fallback (pre-retrofit shape, DR-2/INV-10).
    expect(instanceKeyOf({ sourceBranch: 'feat/y', targetBranch: 'integration' })).toBe(
      'feat/y→integration',
    );
    // Nothing resolvable → undefined, never throws.
    expect(instanceKeyOf({})).toBeUndefined();
    expect(instanceKeyOf(undefined)).toBeUndefined();
  });

  it('LivenessRegistry_LaunchInstanceKey_PrefersInstanceIdThenWorktreeId', () => {
    const { instanceKeyOf } = getLivenessDescriptor('launch');
    expect(instanceKeyOf({ instanceId: '/wt/a', worktreeId: '/wt/b' })).toBe('/wt/a');
    expect(instanceKeyOf({ worktreeId: '/wt/b' })).toBe('/wt/b');
    expect(instanceKeyOf({})).toBeUndefined();
  });

  it('LivenessRegistry_MutationInstanceKey_PrefersInstanceIdThenOperationIdThenSingleton', () => {
    const { instanceKeyOf } = getLivenessDescriptor('mutation');
    expect(instanceKeyOf({ instanceId: 'op-1', operationId: 'op-legacy' })).toBe('op-1');
    // Legacy-mutation fallback: no instanceId, but an operationId is present.
    expect(instanceKeyOf({ operationId: 'op-legacy' })).toBe('op-legacy');
    // DR-2 singleton fallback (finding 3): a truly keyless legacy row (neither
    // field) resolves to the singleton key so a keyless START still pairs with
    // its keyless TERMINAL, instead of being silently skipped.
    expect(instanceKeyOf({ command: 'npx stryker run', repoRoot: '/repo' })).toBe(
      MUTATION_LEGACY_SINGLETON_KEY,
    );
    expect(instanceKeyOf({})).toBe(MUTATION_LEGACY_SINGLETON_KEY);
    expect(instanceKeyOf(undefined)).toBe(MUTATION_LEGACY_SINGLETON_KEY);
  });

  it('LivenessRegistry_MutationSingleton_KeylessStartPairsWithKeylessTerminal', () => {
    // The DR-2 "keyless mutation → singleton instance" AC at the fold level:
    // a keyless start followed by a keyless terminal on the SAME stream pairs
    // and clears (was: silently skipped → forever "in flight" / never waitable).
    const descriptor = getLivenessDescriptor('mutation');
    const paired = computeInFlightInstances(descriptor, [
      { type: 'mutation.executing_started', data: { command: 'x', repoRoot: '/r' }, streamId: 'feat-a' },
      { type: 'mutation.executed', data: { command: 'x', repoRoot: '/r' }, streamId: 'feat-a' },
    ]);
    expect(paired.size).toBe(0);

    // A keyless start with NO terminal stays in flight (visible), carrying the
    // singleton instance key.
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

  // ── envelope-derived startedAt ──────────────────────────────────────────

  it('LivenessRegistry_StartedAt_DerivesFromEnvelopeTimestamp', () => {
    expect(livenessStartedAt({ timestamp: '2026-07-13T00:00:00.000Z' })).toBe(
      '2026-07-13T00:00:00.000Z',
    );
    expect(livenessStartedAt({})).toBeUndefined();
    expect(livenessStartedAt({ timestamp: '' })).toBeUndefined();
  });

  // ── pairing helper: concurrent-instance correlation ─────────────────────

  it('LivenessRegistry_InstanceKey_PairsConcurrentOpsCorrectly', () => {
    const descriptor = getLivenessDescriptor('launch');
    const events: LivenessEventLike[] = [
      { type: 'launch.executing_started', data: { worktreeId: 'A' } },
      { type: 'launch.executing_started', data: { worktreeId: 'B' } },
      { type: 'launch.executed', data: { worktreeId: 'B' } },
    ];

    const inFlight = computeInFlightInstances(descriptor, events);
    const keys = new Set([...inFlight.values()].map((i) => i.instanceKey));

    // B terminated → cleared. A has no terminal → still in flight. `launch` is a
    // `worktrees`-scope surface, so the pairing key IS the instanceKey.
    expect(keys.has('A')).toBe(true);
    expect(keys.has('B')).toBe(false);
    expect([...inFlight.values()].find((i) => i.instanceKey === 'A')?.startEvent.data).toEqual({
      worktreeId: 'A',
    });
  });

  it('LivenessRegistry_FeatureScope_SameKeyDifferentStreams_PairPerStream', () => {
    // Finding 1 (S-6): the SAME merge instanceKey on two DIFFERENT feature
    // streams is two DISTINCT in-flight instances. Terminating one must NOT
    // clear the other. (`merge` is `feature`-scoped → keyed by (streamId, key).)
    const descriptor = getLivenessDescriptor('merge');
    const events: LivenessEventLike[] = [
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-a' },
      { type: 'merge.executing_started', data: { instanceId: 'T11' }, streamId: 'feat-b' },
      // Terminal on feat-b ONLY.
      { type: 'merge.executed', data: { instanceId: 'T11' }, streamId: 'feat-b' },
    ];

    const inFlight = computeInFlightInstances(descriptor, events);
    const survivors = [...inFlight.values()];

    // feat-a's T11 merge is still stuck; feat-b's was cleared.
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

  it('LivenessRegistry_InstanceKey_RestartAfterTerminalReopensTheInstance', () => {
    const descriptor = getLivenessDescriptor('mutation');
    const events: LivenessEventLike[] = [
      { type: 'mutation.executing_started', data: { operationId: 'op-1' }, streamId: 'feat-a' },
      { type: 'mutation.executed', data: { operationId: 'op-1' }, streamId: 'feat-a' },
      { type: 'mutation.executing_started', data: { operationId: 'op-1' }, streamId: 'feat-a' },
    ];
    const inFlight = computeInFlightInstances(descriptor, events);
    // Reopened → exactly one in-flight instance for op-1 on feat-a.
    expect(inFlight.size).toBe(1);
    expect([...inFlight.values()][0]?.instanceKey).toBe('op-1');
  });

  // ── property test (state-machine): pairing correctness over arbitrary
  //    start/terminal key interleavings ──────────────────────────────────
  //
  // An independent reference model (a plain `Set<string>` mutated by the same
  // start-adds / terminal-removes semantics) is compared against
  // `computeInFlightInstances` over hundreds of randomly generated start/
  // terminal event sequences drawn from a small key alphabet — exercising
  // interleavings a hand-written example test would never enumerate (repeated
  // starts, terminals-before-starts, restarts after termination, etc).
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

        // Reference model: independent from the implementation under test —
        // a bare Set mutated by the same start-adds/terminal-removes rule.
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

// ── Type-level guard: registry stays keyed by every LivenessSurface ────────
// (compile-time only — `LIVENESS_REGISTRY` is `Record<LivenessSurface, ...>`,
// so a surface added to the union without a registry entry is a TS error.)
void ((): void => {
  const _surfaces: readonly EventType[] = LIVENESS_DESCRIPTORS.map((d) => d.startType);
  void _surfaces;
});
