// ─── T15: End-to-End Integration Test — Prune Stale Workflows ───────────────
//
// Complements the unit tests in
// `orchestrate/prune-stale-workflows.test.ts` by exercising the handler
// against real on-disk state files via `handleInit`/`handleCancel` plus a
// real `EventStore` rooted at a `mkdtemp` directory. The only seams we
// stub are the safeguards (`hasOpenPR`, `hasRecentCommits`) — everything
// else is production wiring.
//
// What this test exists to catch that the unit test can't:
//   1. `handleList`'s state-file reader produces the exact `_checkpoint`
//      shape `selectPruneCandidates` expects (no schema drift).
//   2. Direct JSON mutation of `_checkpoint.lastActivityTimestamp` is
//      round-tripped through `readStateFile` cleanly.
//   3. `handleCancel` flips phase to `cancelled` on disk.
//   4. `workflow.pruned` events land in the real event stream and are
//      queryable via `EventStore.query`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit } from '../../workflow/tools.js';
import {
  handlePruneStaleWorkflows,
  type PruneHandlerDeps,
  type PruneHandlerResult,
  type PruneSafeguards,
} from '../../orchestrate/prune-stale-workflows.js';
import { handleList } from '../../workflow/tools.js';
import { handleCancel } from '../../workflow/cancel.js';
import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Direct write-through mutation of `_checkpoint.lastActivityTimestamp` on
 * an already-initialized state file. We deliberately read the JSON, patch
 * the nested field, and write it back rather than going through any helper
 * — the whole point of an integration test is to simulate what the
 * filesystem looks like after the workflow has been idle for N days,
 * without relying on the production write path.
 */
async function backdateCheckpoint(
  stateDir: string,
  featureId: string,
  timestamp: string,
): Promise<void> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const raw = await fs.readFile(stateFile, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const checkpoint = parsed._checkpoint as Record<string, unknown> | undefined;
  if (!checkpoint) {
    throw new Error(`State file for ${featureId} missing _checkpoint`);
  }
  checkpoint.lastActivityTimestamp = timestamp;
  // Also backdate the top-level timestamp so nothing else in the read path
  // flags it as freshly written.
  checkpoint.timestamp = timestamp;
  await fs.writeFile(stateFile, JSON.stringify(parsed, null, 2), 'utf-8');
}

/** Read the phase field directly from disk. */
async function readPhase(stateDir: string, featureId: string): Promise<string> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const raw = await fs.readFile(stateFile, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return String(parsed.phase);
}

/**
 * Build a PruneHandlerDeps bundle that uses real `handleList`/`handleCancel`
 * (wired to the temp stateDir and real EventStore) but injects stubbed
 * safeguards. Branch name is read via the default handler path.
 */
function makeRealDeps(
  stateDir: string,
  eventStore: EventStore,
  safeguards: PruneSafeguards,
): PruneHandlerDeps {
  return {
    handleList: (dir) => handleList({}, dir),
    handleCancel: (args, dir) =>
      handleCancel(
        { featureId: args.featureId, reason: args.reason ?? 'stale-prune' },
        dir,
        eventStore,
      ),
    // Workflows initialized via `handleInit` don't carry a `branchName`
    // field at the top level, so safeguards would be short-circuited. Force
    // a non-undefined value so safeguard stubs are actually consulted.
    readBranchName: async (featureId) => `feat/${featureId}`,
    safeguards,
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;

// NB: `handleInit` stamps `lastActivityTimestamp` to "now". Fresh workflows
// use that stamp; stale workflows get their checkpoint overwritten
// post-init via `backdateCheckpoint`.
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * NOTE — handler bug fixed by this integration test:
 *
 * `handleList` in `workflow/tools.ts` now includes `_checkpoint` on each
 * entry so that `extractListEntries` in the prune handler can read
 * `lastActivityTimestamp` directly. Before the fix, `_checkpoint` was
 * stripped and `extractListEntries` fell back to `new Date(0)` (the
 * epoch), which made every non-terminal workflow look maximally stale and
 * silently disabled the freshness filter in production.
 *
 * The `pruneIntegration_respectsThresholdInProduction` test below pins
 * that wiring: it uses real `handleInit` + real `handleList` (no stubs)
 * and backdates only one workflow, then asserts only the backdated
 * workflow is pruned. If `handleList` ever stops returning `_checkpoint`
 * the fresh workflows would re-collapse to the epoch and this test would
 * start pruning them too — regression protection for T15.
 */

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prune-integration-'));
  eventStore = new EventStore(tmpDir);
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Test 1: Dry-run then apply ─────────────────────────────────────────────

describe('pruneIntegration_dryRunThenApply_cleansStaleWorkflows', () => {
  it('lists 2 stale candidates on dry-run and cancels them on apply', async () => {
    // Arrange: three workflows.
    //   terminal-wf-1 — initialized then cancelled (terminal; excluded by
    //                   the pure selector's terminal-phase filter)
    //   stale-wf-2    — initialized, then backdated to 30 days ago
    //   stale-wf-3    — initialized, then backdated to 20 days ago
    //
    // Why `terminal-wf-1` instead of a "fresh" one? See the handler-bug
    // note above — `handleList` doesn't return `_checkpoint`, so the
    // freshness filter is currently a no-op. We rely on terminal-phase
    // exclusion to prove the handler actually filters *something* in the
    // end-to-end path.
    for (const featureId of ['terminal-wf-1', 'stale-wf-2', 'stale-wf-3']) {
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        tmpDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);
    }
    await backdateCheckpoint(tmpDir, 'stale-wf-2', daysAgoIso(30));
    await backdateCheckpoint(tmpDir, 'stale-wf-3', daysAgoIso(20));

    // Flip terminal-wf-1 into the 'cancelled' terminal phase BEFORE the
    // prune run, using the real `handleCancel` path.
    const preCancelResult = await handleCancel(
      { featureId: 'terminal-wf-1', reason: 'pre-test-setup' },
      tmpDir,
      eventStore,
    );
    expect(preCancelResult.success).toBe(true);
    expect(await readPhase(tmpDir, 'terminal-wf-1')).toBe('cancelled');

    // Sanity: the two stale workflows are still non-terminal at this point.
    for (const featureId of ['stale-wf-2', 'stale-wf-3']) {
      const phase = await readPhase(tmpDir, featureId);
      expect(phase).not.toBe('cancelled');
      expect(phase).not.toBe('completed');
    }

    // Stubbed safeguards — always clear so selection is the only filter.
    const safeguards: PruneSafeguards = {
      hasOpenPR: async () => false,
      hasRecentCommits: async () => false,
    };
    const deps = makeRealDeps(tmpDir, eventStore, safeguards);

    // Act: dry-run phase.
    const dryRunResult = await handlePruneStaleWorkflows(
      { dryRun: true },
      tmpDir,
      ctx,
      deps,
    );

    // Assert: dry-run surfaces the two stale workflows as candidates and
    // excludes terminal-wf-1 (terminal phase filter).
    expect(dryRunResult.success).toBe(true);
    const dryData = dryRunResult.data as PruneHandlerResult;
    const dryIds = dryData.candidates.map((c) => c.featureId).sort();
    expect(dryIds).toEqual(['stale-wf-2', 'stale-wf-3']);
    expect(dryIds).not.toContain('terminal-wf-1');
    expect(dryData.pruned).toEqual([]);
    expect(dryData.skipped).toEqual([]);

    // Disk state must be untouched after dry-run.
    expect(await readPhase(tmpDir, 'terminal-wf-1')).toBe('cancelled'); // unchanged
    for (const featureId of ['stale-wf-2', 'stale-wf-3']) {
      const phase = await readPhase(tmpDir, featureId);
      expect(phase).not.toBe('cancelled');
      expect(phase).not.toBe('completed');
    }

    // Act: apply phase, `force: true` bypasses safeguards entirely.
    const applyResult = await handlePruneStaleWorkflows(
      { dryRun: false, force: true },
      tmpDir,
      ctx,
      deps,
    );

    // Assert: both stale workflows cancelled on disk.
    expect(applyResult.success).toBe(true);
    const applyData = applyResult.data as PruneHandlerResult;
    const prunedIds = applyData.pruned.map((p) => p.featureId).sort();
    expect(prunedIds).toEqual(['stale-wf-2', 'stale-wf-3']);
    expect(applyData.skipped).toEqual([]);

    expect(await readPhase(tmpDir, 'stale-wf-2')).toBe('cancelled');
    expect(await readPhase(tmpDir, 'stale-wf-3')).toBe('cancelled');

    // Assert: workflow.pruned events landed in the real event stream.
    const staleEvents2 = await eventStore.query('stale-wf-2', {
      type: 'workflow.pruned',
    });
    const staleEvents3 = await eventStore.query('stale-wf-3', {
      type: 'workflow.pruned',
    });
    expect(staleEvents2.length).toBe(1);
    expect(staleEvents3.length).toBe(1);
    expect(staleEvents2[0]?.data).toMatchObject({
      featureId: 'stale-wf-2',
      triggeredBy: 'manual',
    });
    // force:true causes the skippedSafeguards marker to be recorded.
    expect(staleEvents2[0]?.data).toHaveProperty('skippedSafeguards');

    // terminal-wf-1 should have NO workflow.pruned event in its stream
    // (it was excluded from candidates).
    const terminalEvents = await eventStore.query('terminal-wf-1', {
      type: 'workflow.pruned',
    });
    expect(terminalEvents).toEqual([]);
  });
});

// ─── Test 2: open-PR safeguard gates one of the candidates ──────────────────

describe('pruneIntegration_safeguardOpenPrSkipsOneCandidate', () => {
  it('skips the candidate with an open PR and prunes the other', async () => {
    // Arrange: three stale workflows. All past threshold; no `force`, so
    // safeguards are consulted for each.
    for (const featureId of ['stale-wf-1', 'stale-wf-2', 'stale-wf-3']) {
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        tmpDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);
      await backdateCheckpoint(tmpDir, featureId, daysAgoIso(30));
    }

    // Stub only `stale-wf-2` as having an open PR.
    const safeguards: PruneSafeguards = {
      hasOpenPR: async (featureId: string) => featureId === 'stale-wf-2',
      hasRecentCommits: async () => false,
    };
    const deps = makeRealDeps(tmpDir, eventStore, safeguards);

    // Act: apply mode (safeguards engaged).
    const result = await handlePruneStaleWorkflows(
      { dryRun: false },
      tmpDir,
      ctx,
      deps,
    );

    // Assert: stale-wf-2 was skipped, the other two were pruned.
    expect(result.success).toBe(true);
    const data = result.data as PruneHandlerResult;
    const prunedIds = data.pruned.map((p) => p.featureId).sort();
    expect(prunedIds).toEqual(['stale-wf-1', 'stale-wf-3']);

    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0]?.featureId).toBe('stale-wf-2');
    expect(data.skipped[0]?.reason).toBe('open-pr');

    // stale-wf-2 still non-terminal on disk (proof: skip did not cancel).
    const skippedPhase = await readPhase(tmpDir, 'stale-wf-2');
    expect(skippedPhase).not.toBe('cancelled');
    expect(skippedPhase).not.toBe('completed');

    // The other two are cancelled.
    expect(await readPhase(tmpDir, 'stale-wf-1')).toBe('cancelled');
    expect(await readPhase(tmpDir, 'stale-wf-3')).toBe('cancelled');

    // And no workflow.pruned event was emitted for the skipped one.
    const skippedEvents = await eventStore.query('stale-wf-2', {
      type: 'workflow.pruned',
    });
    expect(skippedEvents).toEqual([]);
  });
});

// ─── Test 3: Production threshold filter — the regression the bug note warned
// about. Uses real `handleList` with NO stubs of its own; backdates ONE of
// three initialized workflows and asserts only that one is pruned. If
// `handleList` regresses to dropping `_checkpoint`, the two "fresh" workflows
// would fall through to the epoch and get pruned, making this test fail
// loudly. That's the exact bug this ticket fixes.
describe('pruneIntegration_respectsThresholdInProduction', () => {
  it(
    'handlePruneStaleWorkflows_respectsThresholdInProduction_readingRealStateFiles',
    async () => {
      // Arrange: three newly-initialized workflows. Only the third is
      // backdated past the 7-day default threshold.
      for (const featureId of ['fresh-a', 'fresh-b', 'stale-c']) {
        const initResult = await handleInit(
          { featureId, workflowType: 'feature' },
          tmpDir,
          eventStore,
        );
        expect(initResult.success).toBe(true);
      }
      await backdateCheckpoint(tmpDir, 'stale-c', daysAgoIso(30));

      // Stubbed safeguards — we want the selection filter to be the only gate.
      const safeguards: PruneSafeguards = {
        hasOpenPR: async () => false,
        hasRecentCommits: async () => false,
      };
      const deps = makeRealDeps(tmpDir, eventStore, safeguards);

      // Act: apply mode with default threshold (10080 min = 7 days).
      const applyResult = await handlePruneStaleWorkflows(
        { dryRun: false, force: true },
        tmpDir,
        ctx,
        deps,
      );

      // Assert: only stale-c was pruned. fresh-a/fresh-b must remain
      // non-terminal on disk. This assertion fails against the pre-fix
      // code because `handleList` dropped `_checkpoint`, making ALL three
      // workflows appear stale (epoch fallback) and thus all three would
      // be pruned.
      expect(applyResult.success).toBe(true);
      const applyData = applyResult.data as PruneHandlerResult;
      const prunedIds = applyData.pruned.map((p) => p.featureId).sort();
      expect(prunedIds).toEqual(['stale-c']);

      expect(await readPhase(tmpDir, 'stale-c')).toBe('cancelled');
      for (const featureId of ['fresh-a', 'fresh-b']) {
        const phase = await readPhase(tmpDir, featureId);
        expect(phase).not.toBe('cancelled');
        expect(phase).not.toBe('completed');
      }

      // And only stale-c's stream has a workflow.pruned event.
      const staleEvents = await eventStore.query('stale-c', {
        type: 'workflow.pruned',
      });
      expect(staleEvents.length).toBe(1);
      for (const featureId of ['fresh-a', 'fresh-b']) {
        const events = await eventStore.query(featureId, {
          type: 'workflow.pruned',
        });
        expect(events).toEqual([]);
      }
    },
  );
});
