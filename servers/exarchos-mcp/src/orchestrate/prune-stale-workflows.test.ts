import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  selectPruneCandidates,
  handlePruneStaleWorkflows,
  type WorkflowListEntry,
  type PruneHandlerDeps,
  type PruneSafeguards,
} from './prune-stale-workflows.js';
import { orchestrateLogger } from '../logger.js';
import type { ToolResult } from '../format.js';
import type { Topology } from '../topology/phase-contract.js';

// #1334 (β-07/β-08): the handler now calls `getTopology()` to obtain the
// typed phase contracts that drive staleness scoring. The handler test
// suite below is module-isolated and never wires up the real topology
// loader, so we mock the loader to return a fixture topology by default.
// Individual tests can override via `mockGetTopology.mockImplementationOnce(...)`
// to exercise the "topology not loaded" skip path (β-08).
const mockGetTopology = vi.fn<() => Topology>();

vi.mock('../topology/loader.js', () => ({
  getTopology: () => mockGetTopology(),
  loadTopology: vi.fn(),
  __resetTopologyCacheForTesting: vi.fn(),
}));

/**
 * Build a minimal `Topology` fixture for prune-selector tests. Each phase
 * gets a `staleness` block matching the typed contract schema in
 * `topology/phase-contract.ts`. Defaults exercise the same single-signal
 * (`lastActivity` only) verdict the legacy heuristic produced for entries
 * without secondary signals, so existing assertions stay green when the
 * selector is rewired through `scoreEntryThroughTopology`.
 *
 * Override `phases` to construct multi-signal contracts inline.
 */
function buildTestTopology(
  phases?: Topology['phases'],
  options: { lastActivityThresholdMinutes?: number } = {},
): Topology {
  const threshold = options.lastActivityThresholdMinutes ?? 20_160;
  if (phases) return { phases };
  const lastActivityOnly = (): Topology['phases'][string] => ({
    staleness: {
      expectedMaxDwellMinutes: threshold,
      signals: [{ name: 'lastActivity', thresholdMinutes: threshold }],
      freshnessRequires: 'all',
    },
  });
  return {
    phases: {
      implementing: lastActivityOnly(),
      plan: lastActivityOnly(),
      delegate: lastActivityOnly(),
      review: lastActivityOnly(),
      synthesize: lastActivityOnly(),
      ideate: lastActivityOnly(),
      // Phases that the selector still consults a contract for, even
      // though they're often filtered upstream by phaseExclusions or
      // terminal-phase short-circuits. Pre-populate them so handler
      // tests with mixed-phase fixtures don't trip the loader's
      // missing-contract throw.
    },
  };
}

/**
 * Build the same default topology with the `lastActivity` threshold
 * pinned to a custom minute count. Used by tests that override
 * `thresholdMinutes` (e.g. 60 minutes for fast staleness assertions).
 */
function buildTestTopologyWithThreshold(thresholdMinutes: number): Topology {
  return buildTestTopology(undefined, {
    lastActivityThresholdMinutes: thresholdMinutes,
  });
}

/**
 * Build a minimal WorkflowListEntry fixture.
 * Staleness is computed from `_checkpoint.lastActivityTimestamp` vs an
 * injectable `now` in the tests, so fixtures only need to set the timestamp.
 */
function makeEntry(overrides: {
  featureId: string;
  workflowType?: string;
  phase?: string;
  lastActivityTimestamp: string;
}): WorkflowListEntry {
  return {
    featureId: overrides.featureId,
    workflowType: overrides.workflowType ?? 'feature',
    phase: overrides.phase ?? 'implementing',
    stateFile: `/tmp/${overrides.featureId}.state.json`,
    _checkpoint: {
      lastActivityTimestamp: overrides.lastActivityTimestamp,
    },
  };
}

// A fixed "now" for deterministic tests.
const NOW = new Date('2026-04-11T12:00:00.000Z');

// Helper: minutes-before-now as ISO string
function minutesAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60 * 1000).toISOString();
}

describe('selectPruneCandidates', () => {
  it('excludes terminal phases (completed, cancelled)', () => {
    // Very stale so they'd otherwise qualify (> 10080 min default threshold)
    const stale = minutesAgo(30_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'a', phase: 'completed', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'b', phase: 'cancelled', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'c', phase: 'implementing', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, buildTestTopology(), {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['c']);
    const terminalExclusions = excluded.filter((e) => e.reason === 'terminal');
    expect(terminalExclusions.map((e) => e.featureId).sort()).toEqual(['a', 'b']);
  });

  it('excludes fresh workflows (within default threshold)', () => {
    // Default threshold is 20160 minutes (14 days), encoded on the
    // typed PhaseContract via `buildTestTopology()`.
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'fresh', lastActivityTimestamp: minutesAgo(60) }), // 1h
      makeEntry({ featureId: 'stale', lastActivityTimestamp: minutesAgo(30_000) }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, buildTestTopology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['stale']);
    const freshExclusions = excluded.filter((e) => e.reason === 'fresh');
    expect(freshExclusions.map((e) => e.featureId)).toEqual(['fresh']);
  });

  it('includes stale non-terminal entries', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({
        featureId: 'a',
        phase: 'implementing',
        lastActivityTimestamp: minutesAgo(30_000),
      }),
      makeEntry({
        featureId: 'b',
        phase: 'plan',
        lastActivityTimestamp: minutesAgo(30_000),
      }),
    ];

    const { candidates } = selectPruneCandidates(entries, buildTestTopology(), {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['a', 'b']);
    for (const candidate of candidates) {
      expect(candidate.stalenessMinutes).toBeGreaterThan(0);
      expect(candidate.workflowType).toBe('feature');
    }
  });

  it('respects a custom threshold (60 min)', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'a', lastActivityTimestamp: minutesAgo(30) }), // fresh vs 60
      makeEntry({ featureId: 'b', lastActivityTimestamp: minutesAgo(120) }), // stale vs 60
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopologyWithThreshold(60),
      {}, // threshold is sourced from the topology fixture (60 min)
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['b']);
    expect(excluded.map((e) => e.featureId)).toEqual(['a']);
    expect(excluded[0]?.reason).toBe('fresh');
  });

  it('excludes oneshot workflows when includeOneShot is false', () => {
    const stale = minutesAgo(30_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'os1', workflowType: 'oneshot', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'f1', workflowType: 'feature', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopology(),
      { includeOneShot: false },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['f1']);
    const oneshotExclusions = excluded.filter((e) => e.reason === 'oneshot-excluded');
    expect(oneshotExclusions.map((e) => e.featureId)).toEqual(['os1']);
  });

  it('includes oneshot workflows by default (includeOneShot defaults to true)', () => {
    const stale = minutesAgo(30_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'os1', workflowType: 'oneshot', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'f1', workflowType: 'feature', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, buildTestTopology(), {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['f1', 'os1']);
    expect(excluded.filter((e) => e.reason === 'oneshot-excluded')).toEqual([]);
  });

  // ─── Task 012: phaseExclusions filter ────────────────────────────────────

  it('selectPruneCandidates_DelegatePhase_ExcludedByDefault', () => {
    const stale = minutesAgo(30_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'del', phase: 'delegate', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'impl', phase: 'implementing', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopology(),
      { phaseExclusions: ['delegate', 'review', 'synthesize'] },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['impl']);
    expect(excluded.find((e) => e.featureId === 'del')?.reason).toBe('phase-excluded');
  });

  it('selectPruneCandidates_ReviewPhase_ExcludedByDefault', () => {
    const stale = minutesAgo(30_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'rev', phase: 'review', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'impl', phase: 'implementing', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopology(),
      { phaseExclusions: ['delegate', 'review', 'synthesize'] },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['impl']);
    expect(excluded.find((e) => e.featureId === 'rev')?.reason).toBe('phase-excluded');
  });

  it('selectPruneCandidates_SynthesizePhase_ExcludedByDefault', () => {
    const stale = minutesAgo(30_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'synth', phase: 'synthesize', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'impl', phase: 'implementing', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopology(),
      { phaseExclusions: ['delegate', 'review', 'synthesize'] },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['impl']);
    expect(excluded.find((e) => e.featureId === 'synth')?.reason).toBe('phase-excluded');
  });

  it('selectPruneCandidates_CustomExclusions_Honored', () => {
    const stale = minutesAgo(30_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'plan', phase: 'plan', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'impl', phase: 'implementing', lastActivityTimestamp: stale }),
    ];

    // Custom exclusions: only 'plan' excluded, 'implementing' is fine
    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopology(),
      { phaseExclusions: ['plan'] },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['impl']);
    expect(excluded.find((e) => e.featureId === 'plan')?.reason).toBe('phase-excluded');
  });

  // ─── C8 (#1117): multi-signal staleness ──────────────────────────────────
  //
  // The single-signal gate on `_checkpoint.lastActivityTimestamp` is refreshed
  // by ANY MCP read (`get`, `describe`), so a workflow polled by the
  // orchestrator looks "fresh" forever. Two secondary signals close the
  // false-fresh path:
  //
  // - `phaseTransitionTimestamp` — derived from the most-recent
  //   `workflow.transition` event. Captures "stuck in phase X for N days"
  //   even when reads keep `lastActivityTimestamp` fresh.
  // - `branchActivityTimestamp` — `git log -1 --format=%ct` on the tracked
  //   branch. Treats absence-of-activity in the threshold window as a
  //   stale signal. Skipped silently when no branch is tracked.
  //
  // #1334 (β-07): the legacy heuristic
  //   stale = phaseTransition stale AND (lastActivity stale OR branch inactive)
  // is no longer expressible — DR-7 (#1332) hard-cut the untyped scorer
  // and the contract reducer is `'all' | 'any'` only. These C8 tests now
  // express the same intent through a typed PhaseContract that declares
  // BOTH secondary signals with `freshnessRequires: 'any'`: the workflow
  // is fresh iff at least one secondary signal is fresh, matching the
  // semantics of "recent phase progress alone keeps fresh, recent branch
  // activity alone keeps fresh".
  function c8Topology(): Topology {
    return {
      phases: {
        implementing: {
          staleness: {
            expectedMaxDwellMinutes: 20_160,
            signals: [
              { name: 'phaseTransition', thresholdMinutes: 20_160 },
              { name: 'branchActivity', thresholdMinutes: 20_160 },
            ],
            freshnessRequires: 'any',
          },
        },
      },
    };
  }

  it('selectPruneCandidates_phaseStuckButReadActive_flagsAsStale', () => {
    // Repro of #1117: phase entered 7d ago, but lastActivityTimestamp is 1h
    // old because the orchestrator polls the workflow with read tools that
    // refresh the checkpoint. The pruner used to mark this fresh and never
    // touch it. Multi-signal scoring must catch it.
    const entries: WorkflowListEntry[] = [
      {
        featureId: 'stuck-but-polled',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/stuck-but-polled.state.json',
        _checkpoint: { lastActivityTimestamp: minutesAgo(60) }, // 1h — fresh
        phaseTransitionTimestamp: minutesAgo(60 * 24 * 21), // 21d — stale vs 14d default
      },
    ];

    const { candidates } = selectPruneCandidates(entries, c8Topology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['stuck-but-polled']);
  });

  it('selectPruneCandidates_branchInactiveAndPhaseStuck_flagsAsStale', () => {
    // Both secondary signals stale → flagged.
    const entries: WorkflowListEntry[] = [
      {
        featureId: 'branch-and-phase-stuck',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/branch-and-phase-stuck.state.json',
        _checkpoint: { lastActivityTimestamp: minutesAgo(60) }, // fresh by reads
        phaseTransitionTimestamp: minutesAgo(60 * 24 * 21), // 21d — stale vs 14d
        branchActivityTimestamp: minutesAgo(60 * 24 * 21), // 21d — stale vs 14d
      },
    ];

    const { candidates } = selectPruneCandidates(entries, c8Topology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['branch-and-phase-stuck']);
  });

  it('selectPruneCandidates_recentTransitionAndCommit_doesNotFlag', () => {
    // Recent phase transition AND recent branch activity → NOT flagged.
    // Pinned to prevent the new signals from creating false positives on
    // legitimately active workflows.
    const entries: WorkflowListEntry[] = [
      {
        featureId: 'actively-progressing',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/actively-progressing.state.json',
        // Even with an old lastActivityTimestamp, recent phase progress
        // should keep this fresh.
        _checkpoint: { lastActivityTimestamp: minutesAgo(60 * 24 * 30) }, // 30d
        phaseTransitionTimestamp: minutesAgo(60), // 1h — fresh
        branchActivityTimestamp: minutesAgo(60), // 1h — fresh
      },
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, c8Topology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual([]);
    expect(excluded.map((e) => e.featureId)).toEqual(['actively-progressing']);
  });

  // ─── #1334 β-06: typed-contract scoring through Topology ───────────────────
  //
  // The orchestrator-side multi-signal heuristic
  //   stale = phaseTransitionStale && (lastActivityStale || branchInactive)
  // is not expressible by the typed `PhaseContract`'s `freshnessRequires:
  // 'all' | 'any'` reducer, and DR-7 (#1332) hard-cut the untyped scorer
  // path. The selector must accept a `Topology` argument and delegate
  // staleness decisions to `scoreEntryThroughTopology`. This test asserts
  // the topology argument exists AND its verdict — not the legacy
  // heuristic — drives candidate selection.
  // Sentry #1338 review (HIGH): if topology.yaml renames/removes a phase
  // while a workflow still references the old name, `scoreEntryThroughTopology`
  // throws — and without per-entry isolation that throw bubbles out of
  // `selectPruneCandidates` and crashes the entire `handlePruneStaleWorkflows`
  // batch (no workflows pruned at all). The selector must instead record
  // the orphan-phase entry as a structured exclusion and keep going for
  // the rest of the batch. DIM-7 resilience; INV-5b spec-aligned output.
  it('SelectPruneCandidates_EntryWithPhaseAbsentFromTopology_ExcludedNotThrown', () => {
    const topology = buildTestTopology(); // declares implementing/plan/etc., NOT 'legacy_phase'
    const entries: WorkflowListEntry[] = [
      // Orphan-phase entry — should be excluded, not crash the batch.
      makeEntry({
        featureId: 'orphan',
        phase: 'legacy_phase',
        lastActivityTimestamp: minutesAgo(30_000),
      }),
      // Stale entry on a valid phase — must still be selected as a candidate.
      makeEntry({
        featureId: 'valid-stale',
        phase: 'implementing',
        lastActivityTimestamp: minutesAgo(30_000),
      }),
    ];

    // The selector must NOT throw — the prior implementation propagated
    // the scorer's exception. The new implementation pre-checks the
    // topology and emits an exclusion.
    const { candidates, excluded } = selectPruneCandidates(entries, topology, {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['valid-stale']);
    const orphan = excluded.find((e) => e.featureId === 'orphan');
    expect(orphan).toBeDefined();
    expect(orphan?.reason).toBe('phase-not-in-topology');
  });

  it('SelectPruneCandidates_WithTopologyArgument_ReturnsCandidatesScoredByPhaseContract', () => {
    // Topology: phase 'implementing' declares two signals with a 60-minute
    // threshold and `freshnessRequires: 'all'`. With 'all', the entry is
    // stale iff ANY declared signal is stale (or absent). Per
    // `scoreStaleness`, an absent signal is treated as stale.
    const topology = buildTestTopology({
      implementing: {
        staleness: {
          expectedMaxDwellMinutes: 60,
          signals: [
            { name: 'lastActivity', thresholdMinutes: 60 },
            { name: 'branchActivity', thresholdMinutes: 60 },
          ],
          freshnessRequires: 'all',
        },
      },
    });

    // Entry: lastActivity 30 min ago (fresh vs 60-min threshold), no
    // branchActivityTimestamp (absent → contract treats as stale).
    //
    // - Legacy heuristic verdict: no secondary signal → fall back to single
    //   signal vs default 20_160 min → 30 min < 20_160 → FRESH.
    // - Typed contract verdict: lastActivity fresh + branchActivity absent
    //   (stale) under `freshnessRequires: 'all'` → STALE.
    //
    // The two verdicts diverge, so this test pins which one the selector
    // produces when called WITH a topology argument.
    const entries: WorkflowListEntry[] = [
      {
        featureId: 'topology-driven',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/topology-driven.state.json',
        _checkpoint: { lastActivityTimestamp: minutesAgo(30) },
      },
    ];

    // The new signature threads `topology` as the second positional
    // argument. Once β-07 lands, this call compiles and passes.
    const { candidates, excluded } = selectPruneCandidates(
      entries,
      topology,
      {},
      NOW,
    );

    // Topology-driven verdict, NOT the legacy heuristic's "fresh".
    expect(candidates.map((c) => c.featureId)).toEqual(['topology-driven']);
    expect(excluded.filter((e) => e.reason === 'fresh')).toEqual([]);
  });
});

// ─── Handler Tests ──────────────────────────────────────────────────────────

/**
 * Build a `handleList`-shaped ToolResult payload from minimal fixture data.
 * Includes all fields the handler's pipeline reads (featureId, workflowType,
 * phase, stateFile, _checkpoint.lastActivityTimestamp).
 */
function makeListResult(
  items: Array<{
    featureId: string;
    workflowType?: string;
    phase?: string;
    lastActivityTimestamp: string;
  }>,
): ToolResult {
  return {
    success: true,
    data: items.map((i) => ({
      featureId: i.featureId,
      workflowType: i.workflowType ?? 'feature',
      phase: i.phase ?? 'implementing',
      stateFile: `/tmp/${i.featureId}.state.json`,
      _checkpoint: {
        lastActivityTimestamp: i.lastActivityTimestamp,
      },
    })),
  };
}

/** Minimal append-spy stubbing the shape handler reaches through `ctx.eventStore`. */
function makeEventStoreStub(): {
  append: ReturnType<typeof vi.fn>;
  ctx: { eventStore: { append: ReturnType<typeof vi.fn> } };
} {
  const append = vi.fn().mockResolvedValue({ sequence: 1, type: 'workflow.pruned' });
  return { append, ctx: { eventStore: { append } } };
}

/** Build a DI bundle with stubs. Defaults: safeguards always pass, branchName present. */
function makeDeps(overrides: Partial<PruneHandlerDeps> = {}): PruneHandlerDeps & {
  listSpy: ReturnType<typeof vi.fn>;
  cancelSpy: ReturnType<typeof vi.fn>;
  branchSpy: ReturnType<typeof vi.fn>;
  safeguards: PruneSafeguards;
} {
  const listSpy = vi.fn().mockResolvedValue(makeListResult([]));
  const cancelSpy = vi
    .fn()
    .mockResolvedValue({ success: true, data: { phase: 'cancelled' } });
  const branchSpy = vi.fn().mockResolvedValue('feat/x');
  const safeguards: PruneSafeguards = {
    hasOpenPR: vi.fn().mockResolvedValue(false),
    hasRecentCommits: vi.fn().mockResolvedValue(false),
  };
  // C8 (#1117): default to "no signal" for the secondary staleness signals.
  // Existing handler tests gated only on `_checkpoint.lastActivityTimestamp`;
  // returning `undefined` keeps the selector on the legacy single-signal
  // path so those tests retain their semantics.
  const phaseTransitionSpy = vi.fn().mockResolvedValue(undefined);
  const branchActivitySpy = vi.fn().mockResolvedValue(undefined);
  return {
    handleList: listSpy,
    handleCancel: cancelSpy,
    readBranchName: branchSpy,
    safeguards,
    readPhaseTransitionTimestamp: phaseTransitionSpy,
    readBranchActivityTimestamp: branchActivitySpy,
    listSpy,
    cancelSpy,
    branchSpy,
    ...overrides,
  } as PruneHandlerDeps & {
    listSpy: ReturnType<typeof vi.fn>;
    cancelSpy: ReturnType<typeof vi.fn>;
    branchSpy: ReturnType<typeof vi.fn>;
    safeguards: PruneSafeguards;
  };
}

describe('handlePruneStaleWorkflows', () => {
  const STATE_DIR = '/tmp/exarchos-test';
  const NOW_ISO = '2026-04-11T12:00:00.000Z';
  function staleIso(mins: number): string {
    return new Date(new Date(NOW_ISO).getTime() - mins * 60 * 1000).toISOString();
  }

  // Reset the topology mock between tests; default to a successfully-loaded
  // fixture so the handler stays on its happy path. β-08 tests opt out
  // by reassigning the mock to throw "load before".
  beforeEach(() => {
    mockGetTopology.mockReset();
    mockGetTopology.mockImplementation(() => buildTestTopology());
  });

  // Restore all spies between tests (e.g. orchestrateLogger.warn spies in
  // the β-08 + deprecation-warn cases) so spy call history doesn't leak
  // across the suite. CodeRabbit #1338 review.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── #1334 β-08: graceful skip when topology not loaded ────────────────────
  //
  // The CLI fast path (e.g. running `prune` outside a fully-bootstrapped
  // MCP server) may invoke this handler before the lifecycle has called
  // `loadTopology()`. Rather than letting the loader's "Topology not
  // loaded: call loadTopology() before getTopology()" throw escape and
  // surface as an unhandled rejection, the handler must catch it,
  // return a structured `{ aborted: true, reason: 'topology_not_loaded' }`
  // envelope, and emit a warning log so operators see why the prune ran
  // produced no candidates. Field is `aborted` (not `skipped`) so it
  // doesn't collide with `PruneHandlerResult.skipped: PruneSkipped[]`.
  it('PruneStaleWorkflows_TopologyNotLoaded_SkipsPruningWithLoggedReason', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    // Simulate loadTopology() never having been called: getTopology()
    // throws the canonical "load before" error from `topology/loader.ts`.
    mockGetTopology.mockImplementationOnce(() => {
      throw new Error(
        'Topology not loaded: call loadTopology() before getTopology()',
      );
    });

    const warnSpy = vi
      .spyOn(orchestrateLogger, 'warn')
      .mockImplementation((() => {}) as never);

    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'wf-a', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      aborted: true,
      reason: 'topology_not_loaded',
    });

    // The handler MUST have logged a warning carrying the same reason
    // string so operators see why the run produced no candidates.
    expect(warnSpy).toHaveBeenCalled();
    const warnedWithReason = warnSpy.mock.calls.some((call) => {
      const meta = call[0];
      return (
        typeof meta === 'object' &&
        meta !== null &&
        (meta as Record<string, unknown>).reason === 'topology_not_loaded'
      );
    });
    expect(warnedWithReason).toBe(true);

    // Skip path is read-only — no cancel, no list invocation needed
    // beyond the no-op load — and certainly no event-append.
    expect(deps.cancelSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // ─── DR-9: the removed `thresholdMinutes` knob is REJECTED, not warned ─────
  //
  // #1334 made `topology.yaml` `staleness` blocks the single source of
  // staleness policy; `thresholdMinutes` was accepted-but-ignored until the
  // debloat wave removed it. A legacy caller still passing it now gets an
  // actionable removal error (pointing at topology.yaml) BEFORE the handler
  // touches handleList/cancel/event-store — INV-5b honest contract, not a
  // silent no-op.
  it('PruneAction_LegacyKnobPassed_ActionableRemovalError', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      // `thresholdMinutes` is no longer part of `PruneHandlerArgs`; a legacy
      // caller supplies it off-contract, so cast through the raw arg shape.
      { thresholdMinutes: 60, dryRun: true, now: NOW_ISO } as unknown as Parameters<
        typeof handlePruneStaleWorkflows
      >[0],
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    // Actionable: names the removed knob AND the replacement surface.
    expect(result.error?.message).toContain('thresholdMinutes');
    expect(result.error?.message).toContain('topology.yaml');
    // Fail-closed: rejected before any list / cancel / event-append side effect.
    expect(deps.listSpy).not.toHaveBeenCalled();
    expect(deps.cancelSpy).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('PruneAction_LegacyKnobPassedInApplyMode_RejectedBeforeAnyCancel', async () => {
    // Even in apply mode (dryRun:false) — where a legacy `-1` could once have
    // classified every workflow as stale and bulk-cancelled — the knob is
    // rejected up front regardless of its value.
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();

    const result = await handlePruneStaleWorkflows(
      { thresholdMinutes: -1, dryRun: false, now: NOW_ISO } as unknown as Parameters<
        typeof handlePruneStaleWorkflows
      >[0],
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(deps.listSpy).not.toHaveBeenCalled();
    expect(deps.cancelSpy).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('dry run returns candidates without calling cancel', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'stale1', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'fresh1', lastActivityTimestamp: staleIso(60) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      candidates: Array<{ featureId: string }>;
      skipped: unknown[];
      pruned?: unknown[];
    };
    expect(data.candidates.map((c) => c.featureId)).toEqual(['stale1']);
    // Dry-run must omit `pruned` entirely — surfacing an empty array would
    // blur the distinction between "preview" and "nothing was pruned in
    // apply mode". The design spec shape has `pruned?` for this reason.
    expect(data).not.toHaveProperty('pruned');
    expect(deps.cancelSpy).not.toHaveBeenCalled();
    // No workflow.pruned events in dry-run (prune.diagnostics is fine)
    const prunedEvents = ctx.eventStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as { type: string }).type === 'workflow.pruned',
    );
    expect(prunedEvents).toHaveLength(0);
  });

  it('apply mode calls handleCancel for each approved candidate', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.cancelSpy).toHaveBeenCalledTimes(2);
    const calledIds = deps.cancelSpy.mock.calls.map((c) => (c[0] as { featureId: string }).featureId);
    expect(calledIds.sort()).toEqual(['a', 'b']);
    const data = result.data as { pruned: Array<{ featureId: string }> };
    expect(data.pruned.map((p) => p.featureId).sort()).toEqual(['a', 'b']);
  });

  it('safeguard (open PR) skips candidate and records reason', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps({
      safeguards: {
        hasOpenPR: vi.fn().mockImplementation(async (featureId: string) => featureId === 'a'),
        hasRecentCommits: vi.fn().mockResolvedValue(false),
      },
    });
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    const data = result.data as {
      pruned: Array<{ featureId: string }>;
      skipped: Array<{ featureId: string; reason: string }>;
    };
    expect(data.pruned.map((p) => p.featureId)).toEqual(['b']);
    expect(data.skipped.map((s) => s.featureId)).toEqual(['a']);
    expect(data.skipped[0]?.reason).toBe('open-pr');
  });

  it('safeguard (recent commits) skips candidate and records reason', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps({
      safeguards: {
        hasOpenPR: vi.fn().mockResolvedValue(false),
        hasRecentCommits: vi
          .fn()
          .mockImplementation(async (branch: string | undefined) => branch === 'feat/b'),
      },
      readBranchName: vi.fn().mockImplementation(async (id: string) => `feat/${id}`),
    });
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    const data = result.data as {
      pruned: Array<{ featureId: string }>;
      skipped: Array<{ featureId: string; reason: string }>;
    };
    expect(data.pruned.map((p) => p.featureId)).toEqual(['a']);
    expect(data.skipped.map((s) => s.featureId)).toEqual(['b']);
    expect(data.skipped[0]?.reason).toBe('active-branch');
  });

  it('force=true bypasses safeguards and emits skippedSafeguards in event payload', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps({
      safeguards: {
        hasOpenPR: vi.fn().mockResolvedValue(true),
        hasRecentCommits: vi.fn().mockResolvedValue(true),
      },
    });
    deps.listSpy.mockResolvedValue(
      makeListResult([{ featureId: 'a', lastActivityTimestamp: staleIso(30_000) }]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, force: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    // When forced, safeguards must not even be consulted.
    expect(deps.safeguards.hasOpenPR).not.toHaveBeenCalled();
    expect(deps.safeguards.hasRecentCommits).not.toHaveBeenCalled();
    const data = result.data as { pruned: Array<{ featureId: string }> };
    expect(data.pruned.map((p) => p.featureId)).toEqual(['a']);

    // Emitted event carries the skippedSafeguards marker
    const prunedCalls = append.mock.calls.filter(
      (call: unknown[]) => (call[1] as { type: string }).type === 'workflow.pruned',
    );
    expect(prunedCalls).toHaveLength(1);
    const [streamId, payload] = prunedCalls[0];
    expect(streamId).toBe('a');
    const envelope = payload as { type: string; data: Record<string, unknown> };
    expect(envelope.type).toBe('workflow.pruned');
    expect(envelope.data.featureId).toBe('a');
    expect(envelope.data.skippedSafeguards).toEqual(['open-pr', 'active-branch']);
  });

  it('emits workflow.pruned event per successful cancel', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'x', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'y', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    const prunedCalls = append.mock.calls.filter(
      (call: unknown[]) => (call[1] as { type: string }).type === 'workflow.pruned',
    );
    expect(prunedCalls).toHaveLength(2);
    for (const call of prunedCalls) {
      const envelope = call[1] as { type: string; data: Record<string, unknown> };
      expect(envelope.type).toBe('workflow.pruned');
      expect(typeof envelope.data.featureId).toBe('string');
      expect(envelope.data.triggeredBy).toBe('manual');
      expect(typeof envelope.data.stalenessMinutes).toBe('number');
    }
  });

  it('skips both safeguards when branchName missing, still prunes', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps({
      readBranchName: vi.fn().mockResolvedValue(undefined),
      safeguards: {
        // Purposely throwing — they must not be called.
        hasOpenPR: vi.fn().mockRejectedValue(new Error('must-not-be-called')),
        hasRecentCommits: vi.fn().mockRejectedValue(new Error('must-not-be-called')),
      },
    });
    deps.listSpy.mockResolvedValue(
      makeListResult([{ featureId: 'nobrn', lastActivityTimestamp: staleIso(30_000) }]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(deps.safeguards.hasOpenPR).not.toHaveBeenCalled();
    expect(deps.safeguards.hasRecentCommits).not.toHaveBeenCalled();
    const data = result.data as { pruned: Array<{ featureId: string }> };
    expect(data.pruned.map((p) => p.featureId)).toEqual(['nobrn']);
  });

  it('handlePruneStaleWorkflows_eventAppendThrows_recordsInSkippedNotPruned', async () => {
    // HIGH-2 regression: when eventStore.append throws after a successful
    // cancel, the feature must appear in `skipped` with reason
    // `event-append-failed` and MUST NOT appear in `pruned`.
    const append = vi.fn().mockRejectedValue(new Error('append boom'));
    const ctx = { eventStore: { append } };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'ea-fail', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    // The cancel MUST still have been invoked — the append failure happens
    // AFTER the cancel succeeds.
    expect(deps.cancelSpy).toHaveBeenCalledTimes(1);

    const data = result.data as {
      pruned: Array<{ featureId: string }>;
      skipped: Array<{ featureId: string; reason: string; message?: string }>;
    };
    // NOT in pruned (this is the core HIGH-2 assertion)
    expect(data.pruned).toEqual([]);
    // IS in skipped with the new distinct reason
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0]?.featureId).toBe('ea-fail');
    expect(data.skipped[0]?.reason).toBe('event-append-failed');
    expect(data.skipped[0]?.message).toContain('append boom');
  });

  it('handlePruneStaleWorkflows_applyModeWithoutEventStore_returnsStructuredError', async () => {
    // MEDIUM-1 regression: apply mode without ctx must not silently no-op
    // on the append — it must refuse upfront with a structured error.
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'missing-ctx', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      undefined, // no ctx
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_CONTEXT');
    expect(result.error?.message).toContain('eventStore');
    // Must refuse BEFORE touching handleCancel (no partial mutations).
    expect(deps.cancelSpy).not.toHaveBeenCalled();
  });

  it('handlePruneStaleWorkflows_dryRunWithoutEventStore_stillAllowed', async () => {
    // Dry-run is read-only — no event emission needed, so the precondition
    // does not apply. This guards against overly-broad refusals.
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'dry', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      undefined,
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.cancelSpy).not.toHaveBeenCalled();
  });

  it('reports partial failure when one of several cancels fails', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'c', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );
    deps.cancelSpy.mockImplementation(async (args: { featureId: string }) => {
      if (args.featureId === 'b') {
        return { success: false, error: { code: 'CANCEL_FAILED', message: 'boom' } };
      }
      return { success: true, data: { phase: 'cancelled' } };
    });

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      pruned: Array<{ featureId: string }>;
      skipped: Array<{ featureId: string; reason: string; message?: string }>;
    };
    expect(data.pruned.map((p) => p.featureId).sort()).toEqual(['a', 'c']);
    const failed = data.skipped.find((s) => s.featureId === 'b');
    expect(failed?.reason).toBe('cancel-failed');
    // Only successful cancels emit workflow.pruned events.
    const prunedCalls = append.mock.calls.filter(
      (call: unknown[]) => (call[1] as { type: string }).type === 'workflow.pruned',
    );
    expect(prunedCalls).toHaveLength(2);
  });

  // ─── F1: fail-closed malformed-entry validation ───────────────────────────
  // Shepherd iter 2 (CodeRabbit finding): the handler must refuse to prune
  // handleList entries that are missing required fields. Previously, missing
  // `_checkpoint` was coerced to `new Date(0)` which made them look
  // maximally stale — if handleList ever regressed (as it did in T15), every
  // workflow would be bulk-cancelled in apply mode. The handler now moves
  // malformed entries to a separate `malformed` bucket and excludes them
  // from candidates/pruned entirely.
  it('handlePruneStaleWorkflows_malformedEntries_excludedFromCandidates', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    // Bypass makeListResult() — it always produces valid entries — and
    // construct a raw mixed payload directly so we can inject malformed
    // shapes.
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        // Valid, stale → should land in candidates + pruned
        {
          featureId: 'valid-stale',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-stale.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        // Missing _checkpoint → malformed
        {
          featureId: 'no-checkpoint',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/no-checkpoint.state.json',
        },
        // Missing featureId → malformed (and featureId omitted in report)
        {
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/anon.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        // Invalid timestamp string → malformed
        {
          featureId: 'bad-timestamp',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-timestamp.state.json',
          _checkpoint: { lastActivityTimestamp: 'not-a-date' },
        },
        // Missing workflowType → malformed
        {
          featureId: 'no-type',
          phase: 'implementing',
          stateFile: '/tmp/no-type.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
      ],
    });

    // Silence the malformed-entries warning for the duration of the test —
    // we assert on the return shape, not stderr. Also asserts the warning
    // path fires: handler must call orchestrateLogger.warn when malformed
    // entries are present so operators see the upstream regression.
    const warnSpy = vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    expect(result.success).toBe(true);
    const data = result.data as {
      candidates: Array<{ featureId: string }>;
      pruned: Array<{ featureId: string }>;
      skipped: unknown[];
      malformed: Array<{ featureId?: string; reason: string }>;
    };

    // Only the valid entry made it to candidates + pruned.
    expect(data.candidates.map((c) => c.featureId)).toEqual(['valid-stale']);
    expect(data.pruned.map((p) => p.featureId)).toEqual(['valid-stale']);

    // The 4 malformed entries are reported separately.
    expect(data.malformed).toHaveLength(4);
    const malformedIds = data.malformed
      .map((m) => m.featureId)
      .filter((id): id is string => id !== undefined)
      .sort();
    // `no-checkpoint`, `bad-timestamp`, `no-type` all have featureId; the
    // missing-featureId entry reports undefined.
    expect(malformedIds).toEqual(['bad-timestamp', 'no-checkpoint', 'no-type']);
    // One malformed entry has no featureId (it's the first field checked,
    // so the missing-featureId case omits it from the report).
    expect(
      data.malformed.filter((m) => m.featureId === undefined),
    ).toHaveLength(1);
    // Every malformed entry has a human-readable reason string.
    for (const m of data.malformed) {
      expect(typeof m.reason).toBe('string');
      expect(m.reason.length).toBeGreaterThan(0);
    }

    // Critical: malformed entries must NOT appear in candidates or pruned,
    // and must NOT have been cancelled.
    const allMalformedIds = new Set(['no-checkpoint', 'bad-timestamp', 'no-type']);
    expect(
      data.candidates.some((c) => allMalformedIds.has(c.featureId)),
    ).toBe(false);
    expect(data.pruned.some((p) => allMalformedIds.has(p.featureId))).toBe(false);
    // handleCancel called exactly once — for the valid-stale entry only.
    expect(deps.cancelSpy).toHaveBeenCalledTimes(1);
    expect(
      (deps.cancelSpy.mock.calls[0]?.[0] as { featureId: string }).featureId,
    ).toBe('valid-stale');
  });

  // ─── F2: `now` input validation ────────────────────────────────────────────
  // Shepherd iter 2 (CodeRabbit finding): an invalid `now` must be rejected up
  // front with a structured INVALID_INPUT error, BEFORE touching handleList,
  // cancel, or the event store. (The `thresholdMinutes` shape-validation cases
  // this block once carried were removed with the knob itself — DR-9 — and are
  // now covered by the `PruneAction_LegacyKnobPassed_*` removal tests above.)

  it('handlePruneStaleWorkflows_rejectsInvalidNow', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: 'not-a-date' },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('now');
    expect(deps.listSpy).not.toHaveBeenCalled();
  });

  it('handlePruneStaleWorkflows_defaultThreshold_appliedWhenOmitted', async () => {
    // When `thresholdMinutes` is omitted and no projectConfig, the handler
    // should default to 20160 (14 days). Verify by constructing an entry
    // that is just barely stale vs the default (20161 min) — it should be
    // a candidate.
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'just-stale', lastActivityTimestamp: staleIso(20_161) },
        { featureId: 'just-fresh', lastActivityTimestamp: staleIso(20_159) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO }, // thresholdMinutes intentionally omitted
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { candidates: Array<{ featureId: string }> };
    expect(data.candidates.map((c) => c.featureId)).toEqual(['just-stale']);
  });

  // ─── Task 009: Diagnostics field ──────────────────────────────────────────

  it('handlePrune_MalformedEntries_ReturnsDiagnosticsField', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        // Valid stale entry
        {
          featureId: 'valid-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-1.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        // Missing _checkpoint → malformed
        {
          featureId: 'bad-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-1.state.json',
        },
        // Missing featureId → malformed
        {
          workflowType: 'feature',
          phase: 'implementing',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
      ],
    });
    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      diagnostics: {
        malformedCount: number;
        malformedEntries: Array<{ featureId?: string; reasons: string[] }>;
        candidateCount: number;
      };
    };
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics.malformedCount).toBe(2);
    expect(data.diagnostics.candidateCount).toBe(1);
    expect(data.diagnostics.malformedEntries).toHaveLength(2);
  });

  it('handlePrune_NoMalformed_ReturnsDiagnosticsWithZeroCount', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'valid-1', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      diagnostics: {
        malformedCount: number;
        malformedEntries: Array<unknown>;
        candidateCount: number;
      };
    };
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics.malformedCount).toBe(0);
    expect(data.diagnostics.malformedEntries).toEqual([]);
    expect(data.diagnostics.candidateCount).toBe(1);
  });

  it('handlePrune_MalformedEntries_IncludesPerEntryReasons', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        // Missing _checkpoint → malformed
        {
          featureId: 'bad-checkpoint',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-checkpoint.state.json',
        },
        // Unparsable timestamp → malformed
        {
          featureId: 'bad-timestamp',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-timestamp.state.json',
          _checkpoint: { lastActivityTimestamp: 'not-a-date' },
        },
      ],
    });
    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      diagnostics: {
        malformedEntries: Array<{ featureId?: string; reasons: string[] }>;
      };
    };
    for (const entry of data.diagnostics.malformedEntries) {
      expect(entry.featureId).toBeDefined();
      expect(Array.isArray(entry.reasons)).toBe(true);
      expect(entry.reasons.length).toBeGreaterThan(0);
      for (const reason of entry.reasons) {
        expect(typeof reason).toBe('string');
      }
    }
  });

  it('handlePrune_DryRun_IncludesDiagnostics', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      diagnostics: { malformedCount: number; candidateCount: number };
    };
    expect(data.diagnostics).toBeDefined();
    expect(typeof data.diagnostics.malformedCount).toBe('number');
    expect(typeof data.diagnostics.candidateCount).toBe('number');
  });

  it('handlePrune_CorruptState_ReturnsDiagnosticsNotThrow', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        // Completely corrupt: not even an object
        42,
        null,
        'garbage',
        // Object but missing everything
        {},
        // Valid entry to confirm pipeline continues
        {
          featureId: 'valid-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-1.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
      ],
    });
    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      diagnostics: {
        malformedCount: number;
        candidateCount: number;
        malformedEntries: Array<{ featureId?: string; reasons: string[] }>;
      };
    };
    expect(data.diagnostics.malformedCount).toBe(4);
    expect(data.diagnostics.candidateCount).toBe(1);
  });

  // ─── Task 010: prune.diagnostics event emission ───────────────────────────

  it('handlePrune_WithMalformed_EmitsPruneDiagnosticsEvent', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        {
          featureId: 'valid-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-1.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        // Malformed: missing _checkpoint
        {
          featureId: 'bad-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-1.state.json',
        },
      ],
    });
    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    // Find the prune.diagnostics event among all appended events
    const diagnosticsCall = append.mock.calls.find(
      (call: unknown[]) => {
        const envelope = call[1] as { type: string };
        return envelope.type === 'prune.diagnostics';
      },
    );
    expect(diagnosticsCall).toBeDefined();
    const [, payload] = diagnosticsCall!;
    const envelope = payload as { type: string; data: Record<string, unknown> };
    expect(envelope.data.malformedCount).toBe(1);
    expect(envelope.data.candidateCount).toBe(1);
  });

  it('handlePrune_NoMalformed_StillEmitsDiagnosticsEvent', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'valid-1', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    const diagnosticsCall = append.mock.calls.find(
      (call: unknown[]) => {
        const envelope = call[1] as { type: string };
        return envelope.type === 'prune.diagnostics';
      },
    );
    expect(diagnosticsCall).toBeDefined();
    const [, payload] = diagnosticsCall!;
    const envelope = payload as { type: string; data: Record<string, unknown> };
    expect(envelope.data.malformedCount).toBe(0);
    expect(envelope.data.candidateCount).toBe(1);
  });

  // ─── Task 011: Wire prune config from .exarchos.yml ───────────────────────

  it('handlePrune_WithConfig_UsesConfiguredThreshold', async () => {
    const { append, ctx: baseCtx } = makeEventStoreStub();
    // #1334 (β-07): per-phase staleness thresholds live on the typed
    // PhaseContract, so the topology fixture drives the 30-day threshold
    // this assertion exercises. (DR-9: the legacy `staleAfterDays` config
    // knob was removed — the topology contract is the sole source now.)
    const ctx = {
      ...baseCtx,
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: false,
        },
      },
    };
    mockGetTopology.mockImplementation(() =>
      buildTestTopologyWithThreshold(30 * 24 * 60 /* 30d in minutes */),
    );
    const deps = makeDeps();
    // Entry at 20000 min is ~14 days — stale at default 7d, but fresh at 30d
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'under-30d', lastActivityTimestamp: staleIso(30_000) },
        // 50000 min ≈ 35 days — stale at 30d
        { featureId: 'over-30d', lastActivityTimestamp: staleIso(50_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { candidates: Array<{ featureId: string }> };
    // Only the 35-day-old entry should be a candidate when threshold = 30 days
    expect(data.candidates.map((c) => c.featureId)).toEqual(['over-30d']);
  });

  it('handlePrune_NoConfig_UsesDefaultThreshold14Days', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    // 14 days = 20160 minutes. Entry at 20161 min should be stale (just over 14d)
    // Entry at 20000 min ≈ 13.9 days should be fresh
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'just-over-14d', lastActivityTimestamp: staleIso(20_161) },
        { featureId: 'just-under-14d', lastActivityTimestamp: staleIso(20_159) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { candidates: Array<{ featureId: string }> };
    expect(data.candidates.map((c) => c.featureId)).toEqual(['just-over-14d']);
  });

  // ─── Task 013: maxBatchSize cap ───────────────────────────────────────────

  it('handlePrune_ExceedsBatchSize_TruncatesCandidates', async () => {
    const { ctx: baseCtx } = makeEventStoreStub();
    const ctx = {
      ...baseCtx,
      projectConfig: {
        prune: {
          maxBatchSize: 3,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: false,
        },
      },
    };
    const deps = makeDeps();
    // Create 10 stale entries with different staleness values
    const items = Array.from({ length: 10 }, (_, i) => ({
      featureId: `stale-${i}`,
      lastActivityTimestamp: staleIso(30_000 + i * 100),
    }));
    deps.listSpy.mockResolvedValue(makeListResult(items));

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      pruned: Array<{ featureId: string }>;
      truncated?: boolean;
      totalCandidates?: number;
    };
    // Only 3 should be pruned due to maxBatchSize
    expect(data.pruned).toHaveLength(3);
    expect(data.truncated).toBe(true);
    expect(data.totalCandidates).toBe(10);
  });

  it('handlePrune_UnderBatchSize_PrunesAll', async () => {
    const { ctx: baseCtx } = makeEventStoreStub();
    const ctx = {
      ...baseCtx,
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: false,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(30_100) },
        { featureId: 'c', lastActivityTimestamp: staleIso(30_200) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      pruned: Array<{ featureId: string }>;
      truncated?: boolean;
    };
    expect(data.pruned).toHaveLength(3);
    // No truncation when under the limit
    expect(data.truncated).toBeUndefined();
  });

  it('handlePrune_BatchSizeFromConfig_Honored', async () => {
    const { ctx: baseCtx } = makeEventStoreStub();
    const ctx = {
      ...baseCtx,
      projectConfig: {
        prune: {
          maxBatchSize: 2,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: false,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(30_100) },
        { featureId: 'c', lastActivityTimestamp: staleIso(30_200) },
        { featureId: 'd', lastActivityTimestamp: staleIso(30_300) },
        { featureId: 'e', lastActivityTimestamp: staleIso(30_400) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      candidates: Array<{ featureId: string }>;
      truncated?: boolean;
      totalCandidates?: number;
    };
    expect(data.candidates).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.totalCandidates).toBe(5);
  });

  // ─── Task 014: malformedHandling modes ────────────────────────────────────

  it('handlePrune_MalformedHandlingReport_SurfacesDiagnostics', async () => {
    const { ctx: baseCtx } = makeEventStoreStub();
    const ctx = {
      ...baseCtx,
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: false,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        {
          featureId: 'valid-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-1.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        // Malformed: missing _checkpoint
        {
          featureId: 'bad-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-1.state.json',
        },
      ],
    });
    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      diagnostics: { malformedCount: number };
      candidates: Array<{ featureId: string }>;
    };
    // Diagnostics visible
    expect(data.diagnostics.malformedCount).toBe(1);
    // Malformed entry excluded from candidates
    expect(data.candidates.map((c) => c.featureId)).toEqual(['valid-1']);
  });

  it('handlePrune_MalformedHandlingInclude_TreatsAsCandidates', async () => {
    const { ctx: baseCtx } = makeEventStoreStub();
    const ctx = {
      ...baseCtx,
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'include' as const,
          requireDryRun: false,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        {
          featureId: 'valid-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-1.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        // Malformed: missing _checkpoint
        {
          featureId: 'bad-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-1.state.json',
        },
      ],
    });
    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      candidates: Array<{ featureId: string; stalenessMinutes: number }>;
    };
    // Both valid and malformed entries should be candidates
    const ids = data.candidates.map((c) => c.featureId).sort();
    expect(ids).toEqual(['bad-1', 'valid-1']);
    // Malformed entry treated with Infinity staleness
    const malformedCandidate = data.candidates.find((c) => c.featureId === 'bad-1');
    expect(malformedCandidate?.stalenessMinutes).toBe(Infinity);
  });

  it('handlePrune_MalformedHandlingSkip_SilentlyExcludes', async () => {
    const { ctx: baseCtx } = makeEventStoreStub();
    const ctx = {
      ...baseCtx,
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'skip' as const,
          requireDryRun: false,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        {
          featureId: 'valid-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-1.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        // Malformed: missing _checkpoint
        {
          featureId: 'bad-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-1.state.json',
        },
      ],
    });
    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      candidates: Array<{ featureId: string }>;
      diagnostics?: unknown;
    };
    // Malformed entry excluded
    expect(data.candidates.map((c) => c.featureId)).toEqual(['valid-1']);
    // No diagnostics field in skip mode
    expect(data.diagnostics).toBeUndefined();
  });

  // ─── Task 015: requireDryRun enforcement ──────────────────────────────────

  it('handlePrune_ApplyWithoutPriorDryRun_RejectsWhenRequired', async () => {
    const append = vi.fn().mockResolvedValue({ sequence: 1, type: 'workflow.pruned' });
    const query = vi.fn().mockResolvedValue([]); // No prior dry-run events
    const ctx = {
      eventStore: { append, query },
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: true,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('dry-run');
  });

  it('handlePrune_ApplyAfterDryRun_Succeeds', async () => {
    const append = vi.fn().mockResolvedValue({ sequence: 1, type: 'workflow.pruned' });
    // Simulate a prior prune.diagnostics event (from a previous dry-run)
    const query = vi.fn().mockResolvedValue([
      {
        type: 'prune.diagnostics',
        data: { malformedCount: 0, candidateCount: 1 },
        timestamp: new Date().toISOString(),
        sequence: 1,
      },
    ]);
    const ctx = {
      eventStore: { append, query },
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: true,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
  });

  // ─── Task 022: E2E prune config integration test ──────────────────────────

  it('handlePrune_FullConfigApplied_AllKnobsEffective', async () => {
    // E2E test: provide a full config with non-default values and verify ALL
    // config knobs take effect simultaneously in a single pipeline run.
    //
    // Config under test (all non-default):
    //   maxBatchSize:       5   (default 25)
    //   phaseExclusions:  ['ideate']  (default ['delegate','review','synthesize'])
    //   malformedHandling: 'include'  (default 'report')
    //   requireDryRun:     false      (default true)
    // (DR-9: the 30-day staleness window is driven by the topology fixture
    // below — the `staleAfterDays` config knob was removed.)

    const append = vi.fn().mockResolvedValue({ sequence: 1, type: 'workflow.pruned' });
    const ctx = {
      eventStore: { append },
      projectConfig: {
        prune: {
          maxBatchSize: 5,
          phaseExclusions: ['ideate'] as readonly string[],
          malformedHandling: 'include' as const,
          requireDryRun: false,
        },
      },
    };
    // #1334 (β-07): per-phase staleness thresholds live on the typed
    // PhaseContract. The fixture mirrors the configured 30-day window.
    mockGetTopology.mockImplementation(() =>
      buildTestTopologyWithThreshold(30 * 24 * 60),
    );
    const deps = makeDeps();

    // Construct a diverse entry set that exercises every knob:
    //
    // 1. 'stale-45d' — 45 days old, implementing → stale at 30d threshold → CANDIDATE
    // 2. 'stale-35d' — 35 days old, implementing → stale at 30d threshold → CANDIDATE
    // 3. 'stale-32d' — 32 days old, implementing → stale at 30d threshold → CANDIDATE
    // 4. 'stale-31d' — 31 days old, implementing → stale at 30d threshold → CANDIDATE
    // 5. 'stale-31d-b' — 31 days old, plan       → stale at 30d threshold → CANDIDATE
    // 6. 'fresh-20d'  — 20 days old, implementing → fresh at 30d threshold → EXCLUDED (fresh)
    // 7. 'ideate-40d' — 40 days old, ideate phase → EXCLUDED (phase-excluded by config)
    // 8. 'delegate-40d' — 40 days old, delegate   → NOT excluded (delegate is NOT in our custom exclusions)
    //                                              → stale at 30d → CANDIDATE
    // 9. 'completed-50d' — 50 days old, completed → EXCLUDED (terminal phase, always)
    // 10. malformed entry (missing _checkpoint)    → malformedHandling='include' → promoted to CANDIDATE
    //
    // Valid candidates: #1-5, #8 = 6 valid candidates + #10 malformed promoted = 7 total
    // maxBatchSize = 5 → only 5 should survive (oldest-first = highest staleness)

    const daysToMinutes = (d: number) => d * 24 * 60;

    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        {
          featureId: 'stale-45d',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/stale-45d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(45)) },
        },
        {
          featureId: 'stale-35d',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/stale-35d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(35)) },
        },
        {
          featureId: 'stale-32d',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/stale-32d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(32)) },
        },
        {
          featureId: 'stale-31d',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/stale-31d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(31)) },
        },
        {
          featureId: 'stale-31d-b',
          workflowType: 'feature',
          phase: 'plan',
          stateFile: '/tmp/stale-31d-b.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(31)) },
        },
        {
          featureId: 'fresh-20d',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/fresh-20d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(20)) },
        },
        {
          featureId: 'ideate-40d',
          workflowType: 'feature',
          phase: 'ideate',
          stateFile: '/tmp/ideate-40d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(40)) },
        },
        {
          featureId: 'delegate-40d',
          workflowType: 'feature',
          phase: 'delegate',
          stateFile: '/tmp/delegate-40d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(40)) },
        },
        {
          featureId: 'completed-50d',
          workflowType: 'feature',
          phase: 'completed',
          stateFile: '/tmp/completed-50d.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(daysToMinutes(50)) },
        },
        // Malformed entry: missing _checkpoint entirely
        {
          featureId: 'malformed-no-cp',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/malformed-no-cp.state.json',
        },
      ],
    });

    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

    // Apply mode (dryRun=false) without a prior dry-run — requireDryRun=false
    // means this should succeed.
    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      candidates: Array<{ featureId: string; stalenessMinutes: number }>;
      pruned: Array<{ featureId: string; stalenessMinutes: number }>;
      skipped: Array<{ featureId: string; reason: string }>;
      malformed: Array<{ featureId?: string; reason: string }>;
      diagnostics: {
        malformedCount: number;
        malformedEntries: Array<{ featureId?: string; reasons: string[] }>;
        candidateCount: number;
      };
      truncated?: boolean;
      totalCandidates?: number;
    };

    // ── Knob 1: topology 30-day threshold (43200 minutes) ──
    // 'fresh-20d' (20 days) must be excluded — it's under the 30-day threshold.
    // All entries >= 31 days should be candidates (before batch cap).
    const candidateIds = data.candidates.map((c) => c.featureId);
    expect(candidateIds).not.toContain('fresh-20d');

    // ── Knob 2: phaseExclusions=['ideate'] ──
    // 'ideate-40d' must be excluded even though it's stale (custom exclusion).
    // 'delegate-40d' must NOT be excluded — it would be excluded under default
    // config (['delegate','review','synthesize']), but our custom config only
    // excludes 'ideate'.
    expect(candidateIds).not.toContain('ideate-40d');
    // 'completed-50d' is terminal — always excluded regardless of config.
    expect(candidateIds).not.toContain('completed-50d');

    // ── Knob 3: malformedHandling='include' ──
    // The malformed entry ('malformed-no-cp') should be promoted to a candidate
    // with stalenessMinutes=Infinity.
    // Diagnostics should still report the malformed entry.
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics.malformedCount).toBe(1);
    expect(data.diagnostics.malformedEntries).toHaveLength(1);
    expect(data.diagnostics.malformedEntries[0]?.featureId).toBe('malformed-no-cp');

    // ── Knob 4: maxBatchSize=5 ──
    // Before truncation: valid stale candidates = stale-45d, stale-35d, stale-32d,
    // stale-31d, stale-31d-b, delegate-40d = 6, plus malformed-no-cp promoted = 7 total.
    // After maxBatchSize=5 truncation (oldest/most-stale first):
    //   The 5 with highest stalenessMinutes should survive.
    //   malformed-no-cp has Infinity staleness → always first.
    //   Then: stale-45d (45d), delegate-40d (40d), stale-35d (35d), stale-32d (32d).
    expect(data.truncated).toBe(true);
    expect(data.totalCandidates).toBe(7);
    expect(data.candidates).toHaveLength(5);

    // Verify the top 5 by staleness descending: Infinity, 45d, 40d, 35d, 32d
    expect(data.candidates[0]?.featureId).toBe('malformed-no-cp');
    expect(data.candidates[0]?.stalenessMinutes).toBe(Infinity);
    expect(data.candidates[1]?.featureId).toBe('stale-45d');
    expect(data.candidates[2]?.featureId).toBe('delegate-40d');
    expect(data.candidates[3]?.featureId).toBe('stale-35d');
    expect(data.candidates[4]?.featureId).toBe('stale-32d');

    // ── Knob 5: requireDryRun=false ──
    // Apply mode succeeded — pruned array should be present with all 5 candidates.
    expect(data.pruned).toHaveLength(5);
    const prunedIds = data.pruned.map((p) => p.featureId).sort();
    expect(prunedIds).toEqual(
      ['delegate-40d', 'malformed-no-cp', 'stale-32d', 'stale-35d', 'stale-45d'].sort(),
    );

    // Cancel should have been called exactly 5 times (once per non-skipped candidate).
    expect(deps.cancelSpy).toHaveBeenCalledTimes(5);

    // workflow.pruned events emitted for each pruned candidate.
    const prunedEvents = append.mock.calls.filter(
      (call: unknown[]) => (call[1] as { type: string }).type === 'workflow.pruned',
    );
    expect(prunedEvents).toHaveLength(5);
  });

  it('handlePrune_RequireDryRunFalse_SkipsEnforcement', async () => {
    const append = vi.fn().mockResolvedValue({ sequence: 1, type: 'workflow.pruned' });
    const query = vi.fn().mockResolvedValue([]); // No prior dry-run events
    const ctx = {
      eventStore: { append, query },
      projectConfig: {
        prune: {
          maxBatchSize: 25,
          phaseExclusions: [],
          malformedHandling: 'report' as const,
          requireDryRun: false,
        },
      },
    };
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx as unknown as Parameters<typeof handlePruneStaleWorkflows>[2],
      deps,
    );

    // Should succeed without prior dry-run
    expect(result.success).toBe(true);
    // query should not have been called for enforcement
    expect(query).not.toHaveBeenCalled();
  });
});
