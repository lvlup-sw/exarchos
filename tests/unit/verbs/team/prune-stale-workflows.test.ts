import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  selectPruneCandidates,
  handlePruneStaleWorkflows,
  type WorkflowListEntry,
  type PruneHandlerDeps,
  type PruneSafeguards,
} from '../../../../src/verbs/team/prune-stale-workflows.js';
import { orchestrateLogger } from '../../../../src/logger.js';
import type { ToolResult } from '../../../../src/format.js';
import type { Topology } from '../../../../src/workflow/topology/phase-contract.js';

/**
 * The handler suite never loads a real topology file. It mocks the loader to
 * report an explicit topology that loaded a fixture. A test can make
 * `mockGetTopology` throw to exercise the skip path for a topology file that
 * failed to load.
 */
const mockGetTopology = vi.fn<() => Topology>();

/** Whether the mocked loader reports that a topology file was requested. */
const mockExplicitTopologyRequested = vi.fn<() => boolean>();

vi.mock('../../../../src/workflow/topology/loader.js', () => ({
  getTopology: () => mockGetTopology(),
  isExplicitTopologyRequested: () => mockExplicitTopologyRequested(),
  loadTopology: vi.fn(),
  __resetTopologyCacheForTesting: vi.fn(),
}));

/**
 * Build a minimal `Topology` fixture. Each default phase has one `lastActivity`
 * signal at the threshold, which defaults to 20160 minutes. The defaults include
 * `delegate`, `review`, `synthesize`, and `ideate`, so mixed-phase handler tests
 * reach scoring. Pass `phases` to build a multi-signal contract inline.
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
    },
  };
}

/** Build the default topology with a custom `lastActivity` threshold in minutes. */
function buildTestTopologyWithThreshold(thresholdMinutes: number): Topology {
  return buildTestTopology(undefined, {
    lastActivityThresholdMinutes: thresholdMinutes,
  });
}

/**
 * Build a minimal `WorkflowListEntry`. The tests pass a fixed `now`, so a
 * fixture sets only the last-activity timestamp.
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

/** A fixed "now" for deterministic tests. */
const NOW = new Date('2026-04-11T12:00:00.000Z');

/** The ISO time `mins` minutes before `NOW`. */
function minutesAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60 * 1000).toISOString();
}

describe('selectPruneCandidates', () => {
  it('excludes terminal phases (completed, cancelled)', () => {
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

  /** The default fixture threshold is 20160 minutes (14 days). */
  it('excludes fresh workflows (within default threshold)', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'fresh', lastActivityTimestamp: minutesAgo(60) }),
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

  /** The threshold comes from the topology fixture, not from the config argument. */
  it('respects a custom threshold (60 min)', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'a', lastActivityTimestamp: minutesAgo(30) }),
      makeEntry({ featureId: 'b', lastActivityTimestamp: minutesAgo(120) }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopologyWithThreshold(60),
      {},
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

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopology(),
      { phaseExclusions: ['plan'] },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['impl']);
    expect(excluded.find((e) => e.featureId === 'plan')?.reason).toBe('phase-excluded');
  });

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

  /**
   * Reads refresh `lastActivityTimestamp`, so a polled workflow looks fresh.
   * `c8Topology` scores `phaseTransition` and `branchActivity` with
   * `freshnessRequires: 'any'`. Here the phase transition is 21 days old and the
   * branch signal is absent, so both signals are stale.
   */
  it('selectPruneCandidates_phaseStuckButReadActive_flagsAsStale', () => {
    const entries: WorkflowListEntry[] = [
      {
        featureId: 'stuck-but-polled',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/stuck-but-polled.state.json',
        _checkpoint: { lastActivityTimestamp: minutesAgo(60) },
        phaseTransitionTimestamp: minutesAgo(60 * 24 * 21),
      },
    ];

    const { candidates } = selectPruneCandidates(entries, c8Topology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['stuck-but-polled']);
  });

  it('selectPruneCandidates_branchInactiveAndPhaseStuck_flagsAsStale', () => {
    const entries: WorkflowListEntry[] = [
      {
        featureId: 'branch-and-phase-stuck',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/branch-and-phase-stuck.state.json',
        _checkpoint: { lastActivityTimestamp: minutesAgo(60) },
        phaseTransitionTimestamp: minutesAgo(60 * 24 * 21),
        branchActivityTimestamp: minutesAgo(60 * 24 * 21),
      },
    ];

    const { candidates } = selectPruneCandidates(entries, c8Topology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['branch-and-phase-stuck']);
  });

  /**
   * Recent phase and branch activity keep the entry fresh, even with a 30-day-old
   * `lastActivityTimestamp`. This guards against false positives.
   */
  it('selectPruneCandidates_recentTransitionAndCommit_doesNotFlag', () => {
    const entries: WorkflowListEntry[] = [
      {
        featureId: 'actively-progressing',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/actively-progressing.state.json',
        _checkpoint: { lastActivityTimestamp: minutesAgo(60 * 24 * 30) },
        phaseTransitionTimestamp: minutesAgo(60),
        branchActivityTimestamp: minutesAgo(60),
      },
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, c8Topology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual([]);
    expect(excluded.map((e) => e.featureId)).toEqual(['actively-progressing']);
  });

  /**
   * A phase with no contract in the topology gives a `phase-not-in-topology`
   * exclusion. The selector does not throw, so one orphan entry does not stop
   * the batch.
   */
  it('SelectPruneCandidates_EntryWithPhaseAbsentFromTopology_ExcludedNotThrown', () => {
    const topology = buildTestTopology();
    const entries: WorkflowListEntry[] = [
      makeEntry({
        featureId: 'orphan',
        phase: 'legacy_phase',
        lastActivityTimestamp: minutesAgo(30_000),
      }),
      makeEntry({
        featureId: 'valid-stale',
        phase: 'implementing',
        lastActivityTimestamp: minutesAgo(30_000),
      }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, topology, {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['valid-stale']);
    const orphan = excluded.find((e) => e.featureId === 'orphan');
    expect(orphan).toBeDefined();
    expect(orphan?.reason).toBe('phase-not-in-topology');
  });

  it('SelectPruneCandidates_TypeOutsideCoveredWorkflowTypes_ExcludedAsWorkflowTypeNotInTopology', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'custom-plan', workflowType: 'custom-flow', phase: 'plan', lastActivityTimestamp: minutesAgo(30_000) }),
      makeEntry({ featureId: 'feature-plan', workflowType: 'feature', phase: 'plan', lastActivityTimestamp: minutesAgo(30_000) }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      buildTestTopology(),
      { coveredWorkflowTypes: new Set(['feature']) },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['feature-plan']);
    expect(excluded).toEqual([{ featureId: 'custom-plan', reason: 'workflow-type-not-in-topology' }]);
  });

  it('SelectPruneCandidates_NoCoveredWorkflowTypes_ScoresEveryWorkflowType', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'custom-plan', workflowType: 'custom-flow', phase: 'plan', lastActivityTimestamp: minutesAgo(30_000) }),
      makeEntry({ featureId: 'feature-plan', workflowType: 'feature', phase: 'plan', lastActivityTimestamp: minutesAgo(30_000) }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, buildTestTopology(), {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['custom-plan', 'feature-plan']);
    expect(excluded).toEqual([]);
  });

  /**
   * The `implementing` contract has two 60-minute signals and `freshnessRequires: 'all'`.
   * `lastActivity` is fresh, but `branchActivity` is absent and counts as stale.
   * So the topology verdict is stale.
   */
  it('SelectPruneCandidates_WithTopologyArgument_ReturnsCandidatesScoredByPhaseContract', () => {
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

    const entries: WorkflowListEntry[] = [
      {
        featureId: 'topology-driven',
        workflowType: 'feature',
        phase: 'implementing',
        stateFile: '/tmp/topology-driven.state.json',
        _checkpoint: { lastActivityTimestamp: minutesAgo(30) },
      },
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      topology,
      {},
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['topology-driven']);
    expect(excluded.filter((e) => e.reason === 'fresh')).toEqual([]);
  });
});

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

/**
 * Build a DI bundle with stubs. By default the safeguards pass, the branch name
 * is `feat/x`, and the second staleness signals are absent.
 */
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

  /** Each test starts with a loaded topology fixture. A test can make the loader throw. */
  beforeEach(() => {
    mockGetTopology.mockReset();
    mockGetTopology.mockImplementation(() => buildTestTopology());
    mockExplicitTopologyRequested.mockReset();
    mockExplicitTopologyRequested.mockReturnValue(true);
  });

  /** Restore the spies, such as `orchestrateLogger.warn`, so call history does not leak between tests. */
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The handler logs a warning with the same reason and cancels nothing. */
  it('PruneStaleWorkflows_TopologyYamlFailedToLoad_SkipsPruningWithLoggedReason', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    mockExplicitTopologyRequested.mockReturnValue(true);
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

    expect(deps.cancelSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  /** Without `topology.yaml`, the built-in topology covers only the built-in workflow types. */
  it('PruneStaleWorkflows_NoTopologyYamlApplyMode_CustomWorkflowTypeInABuiltInPhaseIsNotCancelled', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    mockExplicitTopologyRequested.mockReturnValue(false);
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'custom-plan', workflowType: 'custom-flow', phase: 'plan', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'feature-plan', workflowType: 'feature', phase: 'plan', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { candidates: Array<{ featureId: string }>; pruned: Array<{ featureId: string }> };
    expect(data.candidates.map((c) => c.featureId)).toEqual(['feature-plan']);
    expect(data.pruned.map((p) => p.featureId)).toEqual(['feature-plan']);
    const cancelledIds = deps.cancelSpy.mock.calls.map((c) => (c[0] as { featureId: string }).featureId);
    expect(cancelledIds).toEqual(['feature-plan']);
  });

  it('PruneStaleWorkflows_ExplicitTopology_CustomWorkflowTypeIsStillScored', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    mockExplicitTopologyRequested.mockReturnValue(true);
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'custom-plan', workflowType: 'custom-flow', phase: 'plan', lastActivityTimestamp: staleIso(30_000) },
        { featureId: 'feature-plan', workflowType: 'feature', phase: 'plan', lastActivityTimestamp: staleIso(30_000) },
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
    expect(data.candidates.map((c) => c.featureId)).toEqual(['custom-plan', 'feature-plan']);
  });

  /**
   * A dry run omits `pruned`, so a preview differs from an apply run that pruned
   * nothing. It appends no `workflow.pruned` event.
   */
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
    expect(data).not.toHaveProperty('pruned');
    expect(deps.cancelSpy).not.toHaveBeenCalled();
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
    expect(deps.safeguards.hasOpenPR).not.toHaveBeenCalled();
    expect(deps.safeguards.hasRecentCommits).not.toHaveBeenCalled();
    const data = result.data as { pruned: Array<{ featureId: string }> };
    expect(data.pruned.map((p) => p.featureId)).toEqual(['a']);

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

  /**
   * The `workflow.pruned` append throws after a successful cancel. The entry goes
   * to `skipped` with `event-append-failed`, not to `pruned`.
   */
  it('handlePruneStaleWorkflows_eventAppendThrows_recordsInSkippedNotPruned', async () => {
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
    expect(deps.cancelSpy).toHaveBeenCalledTimes(1);

    const data = result.data as {
      pruned: Array<{ featureId: string }>;
      skipped: Array<{ featureId: string; reason: string; message?: string }>;
    };
    expect(data.pruned).toEqual([]);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0]?.featureId).toBe('ea-fail');
    expect(data.skipped[0]?.reason).toBe('event-append-failed');
    expect(data.skipped[0]?.message).toContain('append boom');
  });

  /** Apply mode without an event store fails with `MISSING_CONTEXT` before any cancel. */
  it('handlePruneStaleWorkflows_applyModeWithoutEventStore_returnsStructuredError', async () => {
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'missing-ctx', lastActivityTimestamp: staleIso(30_000) },
      ]),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      undefined,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_CONTEXT');
    expect(result.error?.message).toContain('eventStore');
    expect(deps.cancelSpy).not.toHaveBeenCalled();
  });

  /** A dry run cancels nothing, so it runs without an event store. */
  it('handlePruneStaleWorkflows_dryRunWithoutEventStore_stillAllowed', async () => {
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
    const prunedCalls = append.mock.calls.filter(
      (call: unknown[]) => (call[1] as { type: string }).type === 'workflow.pruned',
    );
    expect(prunedCalls).toHaveLength(2);
  });

  /**
   * The handler does not prune a `handleList` entry that lacks a required field.
   * It reports the entry in `malformed` and logs a warning, so a broken
   * `handleList` cannot cancel every workflow.
   */
  it('handlePruneStaleWorkflows_malformedEntries_excludedFromCandidates', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue({
      success: true,
      data: [
        {
          featureId: 'valid-stale',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/valid-stale.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        {
          featureId: 'no-checkpoint',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/no-checkpoint.state.json',
        },
        {
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/anon.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
        {
          featureId: 'bad-timestamp',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-timestamp.state.json',
          _checkpoint: { lastActivityTimestamp: 'not-a-date' },
        },
        {
          featureId: 'no-type',
          phase: 'implementing',
          stateFile: '/tmp/no-type.state.json',
          _checkpoint: { lastActivityTimestamp: staleIso(30_000) },
        },
      ],
    });

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

    expect(data.candidates.map((c) => c.featureId)).toEqual(['valid-stale']);
    expect(data.pruned.map((p) => p.featureId)).toEqual(['valid-stale']);

    expect(data.malformed).toHaveLength(4);
    const malformedIds = data.malformed
      .map((m) => m.featureId)
      .filter((id): id is string => id !== undefined)
      .sort();
    expect(malformedIds).toEqual(['bad-timestamp', 'no-checkpoint', 'no-type']);
    expect(
      data.malformed.filter((m) => m.featureId === undefined),
    ).toHaveLength(1);
    for (const m of data.malformed) {
      expect(typeof m.reason).toBe('string');
      expect(m.reason.length).toBeGreaterThan(0);
    }

    const allMalformedIds = new Set(['no-checkpoint', 'bad-timestamp', 'no-type']);
    expect(
      data.candidates.some((c) => allMalformedIds.has(c.featureId)),
    ).toBe(false);
    expect(data.pruned.some((p) => allMalformedIds.has(p.featureId))).toBe(false);
    expect(deps.cancelSpy).toHaveBeenCalledTimes(1);
    expect(
      (deps.cancelSpy.mock.calls[0]?.[0] as { featureId: string }).featureId,
    ).toBe('valid-stale');
  });

  /** An invalid `now` fails with `INVALID_INPUT` before the handler calls `handleList`. */
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

  /**
   * The default fixture threshold is 20160 minutes (14 days). An entry one minute
   * past it is a candidate, and an entry one minute short is not.
   */
  it('handlePruneStaleWorkflows_defaultThreshold_appliedWhenOmitted', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'just-stale', lastActivityTimestamp: staleIso(20_161) },
        { featureId: 'just-fresh', lastActivityTimestamp: staleIso(20_159) },
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
    expect(data.candidates.map((c) => c.featureId)).toEqual(['just-stale']);
  });

  it('handlePrune_MalformedEntries_ReturnsDiagnosticsField', async () => {
    const { ctx } = makeEventStoreStub();
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
        {
          featureId: 'bad-1',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-1.state.json',
        },
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
        {
          featureId: 'bad-checkpoint',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/bad-checkpoint.state.json',
        },
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
        42,
        null,
        'garbage',
        {},
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

  it('handlePrune_DiagnosticsAppend_SettlesBeforeTheHandlerReturns', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();
    let appendSettled = false;
    append.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            appendSettled = true;
            resolve({ sequence: 1, type: 'prune.diagnostics' });
          }, 5);
        }),
    );

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(appendSettled).toBe(true);
  });

  it('handlePrune_DiagnosticsAppendRejects_PruneStillSucceeds', async () => {
    const { append, ctx } = makeEventStoreStub();
    const deps = makeDeps();
    append.mockRejectedValue(new Error('append failed'));

    const result = await handlePruneStaleWorkflows(
      { dryRun: true, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
  });

  /**
   * The project config holds no threshold. The topology fixture sets 30 days, so
   * only the 35-day entry is a candidate.
   */
  it('handlePrune_WithConfig_UsesConfiguredThreshold', async () => {
    const { append, ctx: baseCtx } = makeEventStoreStub();
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
      buildTestTopologyWithThreshold(30 * 24 * 60),
    );
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'under-30d', lastActivityTimestamp: staleIso(30_000) },
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
    expect(data.candidates.map((c) => c.featureId)).toEqual(['over-30d']);
  });

  /**
   * Fourteen days is 20160 minutes. The entry at 20161 minutes is stale, and the
   * entry at 20159 minutes is fresh.
   */
  it('handlePrune_NoConfig_UsesDefaultThreshold14Days', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
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
    expect(data.diagnostics.malformedCount).toBe(1);
    expect(data.candidates.map((c) => c.featureId)).toEqual(['valid-1']);
  });

  /** In `include` mode, a malformed entry with a `featureId` becomes a candidate with infinite staleness. */
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
    const ids = data.candidates.map((c) => c.featureId).sort();
    expect(ids).toEqual(['bad-1', 'valid-1']);
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
    expect(data.candidates.map((c) => c.featureId)).toEqual(['valid-1']);
    expect(data.diagnostics).toBeUndefined();
  });

  /**
   * With `requireDryRun`, apply mode needs a `prune.diagnostics` event from an
   * earlier dry run.
   */
  it('handlePrune_ApplyWithoutPriorDryRun_RejectsWhenRequired', async () => {
    const append = vi.fn().mockResolvedValue({ sequence: 1, type: 'workflow.pruned' });
    const query = vi.fn().mockResolvedValue([]);
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

  /**
   * One apply run with a 30-day topology threshold and the config
   * `phaseExclusions: ['ideate']`, `malformedHandling: 'include'`, `maxBatchSize: 5`,
   * and `requireDryRun: false`. Seven entries qualify, and the cap keeps the five
   * most stale. The malformed entry has infinite staleness, so it sorts first.
   */
  it('handlePrune_FullConfigApplied_AllKnobsEffective', async () => {

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
    mockGetTopology.mockImplementation(() =>
      buildTestTopologyWithThreshold(30 * 24 * 60),
    );
    const deps = makeDeps();

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
        {
          featureId: 'malformed-no-cp',
          workflowType: 'feature',
          phase: 'implementing',
          stateFile: '/tmp/malformed-no-cp.state.json',
        },
      ],
    });

    vi.spyOn(orchestrateLogger, 'warn').mockImplementation((() => {}) as never);

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

    const candidateIds = data.candidates.map((c) => c.featureId);
    expect(candidateIds).not.toContain('fresh-20d');

    expect(candidateIds).not.toContain('ideate-40d');
    expect(candidateIds).not.toContain('completed-50d');

    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics.malformedCount).toBe(1);
    expect(data.diagnostics.malformedEntries).toHaveLength(1);
    expect(data.diagnostics.malformedEntries[0]?.featureId).toBe('malformed-no-cp');

    expect(data.truncated).toBe(true);
    expect(data.totalCandidates).toBe(7);
    expect(data.candidates).toHaveLength(5);

    expect(data.candidates[0]?.featureId).toBe('malformed-no-cp');
    expect(data.candidates[0]?.stalenessMinutes).toBe(Infinity);
    expect(data.candidates[1]?.featureId).toBe('stale-45d');
    expect(data.candidates[2]?.featureId).toBe('delegate-40d');
    expect(data.candidates[3]?.featureId).toBe('stale-35d');
    expect(data.candidates[4]?.featureId).toBe('stale-32d');

    expect(data.pruned).toHaveLength(5);
    const prunedIds = data.pruned.map((p) => p.featureId).sort();
    expect(prunedIds).toEqual(
      ['delegate-40d', 'malformed-no-cp', 'stale-32d', 'stale-35d', 'stale-45d'].sort(),
    );

    expect(deps.cancelSpy).toHaveBeenCalledTimes(5);

    const prunedEvents = append.mock.calls.filter(
      (call: unknown[]) => (call[1] as { type: string }).type === 'workflow.pruned',
    );
    expect(prunedEvents).toHaveLength(5);
  });

  it('handlePrune_RequireDryRunFalse_SkipsEnforcement', async () => {
    const append = vi.fn().mockResolvedValue({ sequence: 1, type: 'workflow.pruned' });
    const query = vi.fn().mockResolvedValue([]);
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

    expect(result.success).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
});
