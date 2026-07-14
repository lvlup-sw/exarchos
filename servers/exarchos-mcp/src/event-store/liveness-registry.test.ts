import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { EventTypes, type EventType } from './schemas.js';
import {
  LIVENESS_REGISTRY,
  LIVENESS_DESCRIPTORS,
  getLivenessDescriptor,
  getLivenessDescriptorByStartType,
  computeInFlightInstances,
  livenessStartedAt,
  type LivenessEventLike,
} from './liveness-registry.js';

// ─── DR-2 (task 004): liveness descriptor registry conformance ─────────────
//
// One registry entry per INV-10 liveness surface (merge / launch / mutation /
// prune) defines the whole contract `ps` / `wait --operation` (tasks 006/010)
// will consume. The conformance test below drives its assertion off the REAL
// `EventTypes` catalog in `schemas.ts` — not a hand-mocked list — so adding a
// fifth `<surface>.executing_started` type without a matching registry entry
// fails loudly here rather than silently at the `ps`/`wait` consumer.

describe('LivenessRegistry conformance', () => {
  it('LivenessRegistry_EveryExecutingStartedInCatalog_HasEntryWithTerminalScopeAndKey', () => {
    // Drive off the REAL catalog — this is the whole point of the conformance
    // test: a real unregistered surface (a new `<x>.executing_started` type
    // added to `EventTypes` with no matching registry entry) must fail here.
    const startTypesInCatalog = EventTypes.filter((t) => t.endsWith('.executing_started'));

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
    }

    // Reverse direction: every registered descriptor's startType is itself a
    // real catalog type (no stale/renamed entry lingering in the registry).
    for (const descriptor of LIVENESS_DESCRIPTORS) {
      expect(EventTypes as readonly string[]).toContain(descriptor.startType);
      expect(descriptor.startType.endsWith('.executing_started')).toBe(true);
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

  it('LivenessRegistry_MutationInstanceKey_PrefersInstanceIdThenOperationIdLegacyFallback', () => {
    const { instanceKeyOf } = getLivenessDescriptor('mutation');
    expect(instanceKeyOf({ instanceId: 'op-1', operationId: 'op-legacy' })).toBe('op-1');
    // Legacy-mutation fallback: no instanceId, but an operationId is present.
    expect(instanceKeyOf({ operationId: 'op-legacy' })).toBe('op-legacy');
    // Neither present (the real `mutation-adequacy.ts` shape today) → undefined.
    expect(instanceKeyOf({ command: 'npx stryker run', repoRoot: '/repo' })).toBeUndefined();
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

    // B terminated → cleared. A has no terminal → still in flight.
    expect(inFlight.has('A')).toBe(true);
    expect(inFlight.has('B')).toBe(false);
    expect(inFlight.get('A')?.data).toEqual({ worktreeId: 'A' });
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
      { type: 'mutation.executing_started', data: { operationId: 'op-1' } },
      { type: 'mutation.executed', data: { operationId: 'op-1' } },
      { type: 'mutation.executing_started', data: { operationId: 'op-1' } },
    ];
    const inFlight = computeInFlightInstances(descriptor, events);
    expect(inFlight.has('op-1')).toBe(true);
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
