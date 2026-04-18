import { describe, it, expect, vi } from 'vitest';
import {
  selectPruneCandidates,
  handlePruneStaleWorkflows,
  type WorkflowListEntry,
  type PruneHandlerDeps,
  type PruneSafeguards,
} from './prune-stale-workflows.js';
import { orchestrateLogger } from '../logger.js';
import type { ToolResult } from '../format.js';

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
    const stale = minutesAgo(20_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'a', phase: 'completed', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'b', phase: 'cancelled', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'c', phase: 'implementing', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['c']);
    const terminalExclusions = excluded.filter((e) => e.reason === 'terminal');
    expect(terminalExclusions.map((e) => e.featureId).sort()).toEqual(['a', 'b']);
  });

  it('excludes fresh workflows (within default threshold)', () => {
    // Default threshold is 10080 minutes (7 days)
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'fresh', lastActivityTimestamp: minutesAgo(60) }), // 1h
      makeEntry({ featureId: 'stale', lastActivityTimestamp: minutesAgo(20_000) }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, {}, NOW);

    expect(candidates.map((c) => c.featureId)).toEqual(['stale']);
    const freshExclusions = excluded.filter((e) => e.reason === 'fresh');
    expect(freshExclusions.map((e) => e.featureId)).toEqual(['fresh']);
  });

  it('includes stale non-terminal entries', () => {
    const entries: WorkflowListEntry[] = [
      makeEntry({
        featureId: 'a',
        phase: 'implementing',
        lastActivityTimestamp: minutesAgo(20_000),
      }),
      makeEntry({
        featureId: 'b',
        phase: 'plan',
        lastActivityTimestamp: minutesAgo(20_000),
      }),
    ];

    const { candidates } = selectPruneCandidates(entries, {}, NOW);

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
      { thresholdMinutes: 60 },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['b']);
    expect(excluded.map((e) => e.featureId)).toEqual(['a']);
    expect(excluded[0]?.reason).toBe('fresh');
  });

  it('excludes oneshot workflows when includeOneShot is false', () => {
    const stale = minutesAgo(20_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'os1', workflowType: 'oneshot', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'f1', workflowType: 'feature', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(
      entries,
      { includeOneShot: false },
      NOW,
    );

    expect(candidates.map((c) => c.featureId)).toEqual(['f1']);
    const oneshotExclusions = excluded.filter((e) => e.reason === 'oneshot-excluded');
    expect(oneshotExclusions.map((e) => e.featureId)).toEqual(['os1']);
  });

  it('includes oneshot workflows by default (includeOneShot defaults to true)', () => {
    const stale = minutesAgo(20_000);
    const entries: WorkflowListEntry[] = [
      makeEntry({ featureId: 'os1', workflowType: 'oneshot', lastActivityTimestamp: stale }),
      makeEntry({ featureId: 'f1', workflowType: 'feature', lastActivityTimestamp: stale }),
    ];

    const { candidates, excluded } = selectPruneCandidates(entries, {}, NOW);

    expect(candidates.map((c) => c.featureId).sort()).toEqual(['f1', 'os1']);
    expect(excluded.filter((e) => e.reason === 'oneshot-excluded')).toEqual([]);
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
  return {
    handleList: listSpy,
    handleCancel: cancelSpy,
    readBranchName: branchSpy,
    safeguards,
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

  it('dry run returns candidates without calling cancel', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'stale1', lastActivityTimestamp: staleIso(20_000) },
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
    expect(ctx.eventStore.append).not.toHaveBeenCalled();
  });

  it('apply mode calls handleCancel for each approved candidate', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'a', lastActivityTimestamp: staleIso(20_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(20_000) },
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
        { featureId: 'a', lastActivityTimestamp: staleIso(20_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(20_000) },
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
        { featureId: 'a', lastActivityTimestamp: staleIso(20_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(20_000) },
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
      makeListResult([{ featureId: 'a', lastActivityTimestamp: staleIso(20_000) }]),
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
    expect(append).toHaveBeenCalledTimes(1);
    const [streamId, payload] = append.mock.calls[0];
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
        { featureId: 'x', lastActivityTimestamp: staleIso(20_000) },
        { featureId: 'y', lastActivityTimestamp: staleIso(20_000) },
      ]),
    );

    await handlePruneStaleWorkflows(
      { dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(append).toHaveBeenCalledTimes(2);
    for (const call of append.mock.calls) {
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
      makeListResult([{ featureId: 'nobrn', lastActivityTimestamp: staleIso(20_000) }]),
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
        { featureId: 'ea-fail', lastActivityTimestamp: staleIso(20_000) },
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
        { featureId: 'missing-ctx', lastActivityTimestamp: staleIso(20_000) },
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
        { featureId: 'dry', lastActivityTimestamp: staleIso(20_000) },
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
        { featureId: 'a', lastActivityTimestamp: staleIso(20_000) },
        { featureId: 'b', lastActivityTimestamp: staleIso(20_000) },
        { featureId: 'c', lastActivityTimestamp: staleIso(20_000) },
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
    // Only successful cancels emit events.
    expect(append).toHaveBeenCalledTimes(2);
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
          _checkpoint: { lastActivityTimestamp: staleIso(20_000) },
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
          _checkpoint: { lastActivityTimestamp: staleIso(20_000) },
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
          _checkpoint: { lastActivityTimestamp: staleIso(20_000) },
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

  // ─── F2: thresholdMinutes + now input validation ──────────────────────────
  // Shepherd iter 2 (CodeRabbit finding): invalid `thresholdMinutes` or
  // `now` must be rejected up front with a structured INVALID_INPUT error,
  // BEFORE touching handleList, cancel, or the event store. A negative or
  // NaN threshold would otherwise cause bulk-cancel in apply mode.
  it('handlePruneStaleWorkflows_rejectsNegativeThreshold', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();

    const result = await handlePruneStaleWorkflows(
      { thresholdMinutes: -1, dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('thresholdMinutes');
    // Refuses BEFORE touching handleList — no partial state changes.
    expect(deps.listSpy).not.toHaveBeenCalled();
    expect(deps.cancelSpy).not.toHaveBeenCalled();
  });

  it('handlePruneStaleWorkflows_rejectsZeroThreshold', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();

    const result = await handlePruneStaleWorkflows(
      { thresholdMinutes: 0, dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(deps.listSpy).not.toHaveBeenCalled();
  });

  it('handlePruneStaleWorkflows_rejectsNaNThreshold', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();

    const result = await handlePruneStaleWorkflows(
      { thresholdMinutes: Number.NaN, dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(deps.listSpy).not.toHaveBeenCalled();
  });

  it('handlePruneStaleWorkflows_rejectsInfiniteThreshold', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();

    const result = await handlePruneStaleWorkflows(
      { thresholdMinutes: Number.POSITIVE_INFINITY, dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('handlePruneStaleWorkflows_rejectsNonIntegerThreshold', async () => {
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();

    const result = await handlePruneStaleWorkflows(
      { thresholdMinutes: 1.5, dryRun: false, now: NOW_ISO },
      STATE_DIR,
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

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
    // When `thresholdMinutes` is omitted, the handler should default to
    // 10080 (7 days). Verify by constructing an entry that is just barely
    // stale vs the default (10081 min) — it should be a candidate.
    const { ctx } = makeEventStoreStub();
    const deps = makeDeps();
    deps.listSpy.mockResolvedValue(
      makeListResult([
        { featureId: 'just-stale', lastActivityTimestamp: staleIso(10_081) },
        { featureId: 'just-fresh', lastActivityTimestamp: staleIso(10_079) },
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
          _checkpoint: { lastActivityTimestamp: staleIso(20_000) },
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
          _checkpoint: { lastActivityTimestamp: staleIso(20_000) },
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
        { featureId: 'valid-1', lastActivityTimestamp: staleIso(20_000) },
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
        { featureId: 'a', lastActivityTimestamp: staleIso(20_000) },
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
          _checkpoint: { lastActivityTimestamp: staleIso(20_000) },
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
});
