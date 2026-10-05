// End-to-end integration test for the prune of stale workflows.
//
// The unit tests in `verbs/team/prune-stale-workflows.test.ts` stub the handler dependencies. This
// test runs the handler on real state files, through `handleInit`, `handleList` and `handleCancel`,
// with a real `EventStore` in a `mkdtemp` directory. The stubs are the safeguards (`hasOpenPR`,
// `hasRecentCommits`), the branch name and the two second-signal readers.
//
// The test pins what the unit tests cannot:
//   1. `handleList` returns the `_checkpoint` shape that `selectPruneCandidates` reads.
//   2. A direct JSON edit of `_checkpoint.lastActivityTimestamp` survives the state-file reader.
//   3. `handleCancel` sets the phase to `cancelled` on disk.
//   4. `workflow.pruned` events reach the real event stream, and `EventStore.query` returns them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit } from '../../src/workflow/tools.js';
import {
  handlePruneStaleWorkflows,
  type PruneHandlerDeps,
  type PruneHandlerResult,
  type PruneSafeguards,
} from '../../src/verbs/team/prune-stale-workflows.js';
import { handleList } from '../../src/workflow/tools.js';
import { handleCancel } from '../../src/workflow/cancel.js';
import { EventStore } from '../../src/events/store.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import {
  loadTopology,
  __resetTopologyCacheForTesting,
} from '../../src/workflow/topology/loader.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/**
 * Writes `_checkpoint.lastActivityTimestamp` directly into a state file. The direct write
 * simulates an idle workflow without the production write path. It also backdates
 * `_checkpoint.timestamp`, so no other reader sees a fresh write.
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
 * Builds deps with the real `handleList` and `handleCancel`, on the temp state directory and the
 * real EventStore, and with stub safeguards.
 * - `readBranchName` always returns a branch. A workflow from `handleInit` has no `branchName`, and
 *   the handler skips the safeguards for a workflow with no branch.
 * - The two second-signal readers return `undefined`, because the tests seed no
 *   `workflow.transition` events and no branches. Selection then uses `lastActivity` only.
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
    readBranchName: async (featureId) => `feat/${featureId}`,
    safeguards,
    readPhaseTransitionTimestamp: async () => undefined,
    readBranchActivityTimestamp: async () => undefined,
  };
}

let tmpDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;

/**
 * Gives the ISO time `days` days before the current time. `handleInit` stamps
 * `lastActivityTimestamp` with the current time. A fresh workflow keeps that stamp, and
 * `backdateCheckpoint` overwrites it for a stale workflow.
 */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The handler reads the typed staleness contract from a loaded topology. The hook writes a minimal
 * `topology.yaml` that gives each phase a `lastActivity` threshold of 14 days (20160 minutes), and
 * loads it.
 */
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prune-integration-'));
  eventStore = new EventStore(tmpDir);
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };

  __resetTopologyCacheForTesting();
  const topologyPath = path.join(tmpDir, 'topology.yaml');
  const topologyYaml = `
phases:
  ideate:
    staleness:
      expectedMaxDwellMinutes: 20160
      signals:
        - name: lastActivity
          thresholdMinutes: 20160
      freshnessRequires: all
  plan:
    staleness:
      expectedMaxDwellMinutes: 20160
      signals:
        - name: lastActivity
          thresholdMinutes: 20160
      freshnessRequires: all
  delegate:
    staleness:
      expectedMaxDwellMinutes: 20160
      signals:
        - name: lastActivity
          thresholdMinutes: 20160
      freshnessRequires: all
  review:
    staleness:
      expectedMaxDwellMinutes: 20160
      signals:
        - name: lastActivity
          thresholdMinutes: 20160
      freshnessRequires: all
  synthesize:
    staleness:
      expectedMaxDwellMinutes: 20160
      signals:
        - name: lastActivity
          thresholdMinutes: 20160
      freshnessRequires: all
  implementing:
    staleness:
      expectedMaxDwellMinutes: 20160
      signals:
        - name: lastActivity
          thresholdMinutes: 20160
      freshnessRequires: all
`;
  await fs.writeFile(topologyPath, topologyYaml, 'utf-8');
  await loadTopology({ topologyPath });
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
  __resetTopologyCacheForTesting();
});

describe('pruneIntegration_dryRunThenApply_cleansStaleWorkflows', () => {
  /**
   * `terminal-wf-1` is cancelled before the prune run, so the terminal-phase filter excludes it.
   * `stale-wf-2` and `stale-wf-3` are 30 and 20 days old. The safeguards always pass, so selection
   * is the only filter. A dry run must omit `pruned`, because `[]` reads as an apply run that
   * pruned nothing. The dry run must not change the state on disk. The apply run uses
   * `force: true`, which skips the safeguards and records `skippedSafeguards` on the event.
   */
  it('lists 2 stale candidates on dry-run and cancels them on apply', async () => {
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

    const preCancelResult = await handleCancel(
      { featureId: 'terminal-wf-1', reason: 'pre-test-setup' },
      tmpDir,
      eventStore,
    );
    expect(preCancelResult.success).toBe(true);
    expect(await readPhase(tmpDir, 'terminal-wf-1')).toBe('cancelled');

    for (const featureId of ['stale-wf-2', 'stale-wf-3']) {
      const phase = await readPhase(tmpDir, featureId);
      expect(phase).not.toBe('cancelled');
      expect(phase).not.toBe('completed');
    }

    const safeguards: PruneSafeguards = {
      hasOpenPR: async () => false,
      hasRecentCommits: async () => false,
    };
    const deps = makeRealDeps(tmpDir, eventStore, safeguards);

    const dryRunResult = await handlePruneStaleWorkflows(
      { dryRun: true },
      tmpDir,
      ctx,
      deps,
    );

    expect(dryRunResult.success).toBe(true);
    const dryData = dryRunResult.data as PruneHandlerResult;
    const dryIds = dryData.candidates.map((c) => c.featureId).sort();
    expect(dryIds).toEqual(['stale-wf-2', 'stale-wf-3']);
    expect(dryIds).not.toContain('terminal-wf-1');
    expect(dryData.pruned).toBeUndefined();
    expect(dryData.skipped).toEqual([]);

    expect(await readPhase(tmpDir, 'terminal-wf-1')).toBe('cancelled');
    for (const featureId of ['stale-wf-2', 'stale-wf-3']) {
      const phase = await readPhase(tmpDir, featureId);
      expect(phase).not.toBe('cancelled');
      expect(phase).not.toBe('completed');
    }

    const applyResult = await handlePruneStaleWorkflows(
      { dryRun: false, force: true },
      tmpDir,
      ctx,
      deps,
    );

    expect(applyResult.success).toBe(true);
    const applyData = applyResult.data as PruneHandlerResult;
    const prunedIds = applyData.pruned.map((p) => p.featureId).sort();
    expect(prunedIds).toEqual(['stale-wf-2', 'stale-wf-3']);
    expect(applyData.skipped).toEqual([]);

    expect(await readPhase(tmpDir, 'stale-wf-2')).toBe('cancelled');
    expect(await readPhase(tmpDir, 'stale-wf-3')).toBe('cancelled');

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
    expect(staleEvents2[0]?.data).toHaveProperty('skippedSafeguards');

    const terminalEvents = await eventStore.query('terminal-wf-1', {
      type: 'workflow.pruned',
    });
    expect(terminalEvents).toEqual([]);
  });
});

describe('pruneIntegration_safeguardOpenPrSkipsOneCandidate', () => {
  /**
   * The three workflows are all past the threshold. The run has no `force`, so the handler asks
   * the safeguards about each one. Only `stale-wf-2` has an open PR. The skipped workflow stays
   * non-terminal on disk and gets no `workflow.pruned` event.
   */
  it('skips the candidate with an open PR and prunes the other', async () => {
    for (const featureId of ['stale-wf-1', 'stale-wf-2', 'stale-wf-3']) {
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        tmpDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);
      await backdateCheckpoint(tmpDir, featureId, daysAgoIso(30));
    }

    const safeguards: PruneSafeguards = {
      hasOpenPR: async (featureId: string) => featureId === 'stale-wf-2',
      hasRecentCommits: async () => false,
    };
    const deps = makeRealDeps(tmpDir, eventStore, safeguards);

    const result = await handlePruneStaleWorkflows(
      { dryRun: false },
      tmpDir,
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    const data = result.data as PruneHandlerResult;
    const prunedIds = data.pruned.map((p) => p.featureId).sort();
    expect(prunedIds).toEqual(['stale-wf-1', 'stale-wf-3']);

    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0]?.featureId).toBe('stale-wf-2');
    expect(data.skipped[0]?.reason).toBe('open-pr');

    const skippedPhase = await readPhase(tmpDir, 'stale-wf-2');
    expect(skippedPhase).not.toBe('cancelled');
    expect(skippedPhase).not.toBe('completed');

    expect(await readPhase(tmpDir, 'stale-wf-1')).toBe('cancelled');
    expect(await readPhase(tmpDir, 'stale-wf-3')).toBe('cancelled');

    const skippedEvents = await eventStore.query('stale-wf-2', {
      type: 'workflow.pruned',
    });
    expect(skippedEvents).toEqual([]);
  });
});

/**
 * This case uses the real `handleList` and backdates one of three workflows. The handler must
 * prune only that workflow. If `handleList` stops returning `_checkpoint`, the handler finds no
 * valid entry and prunes nothing, so the case fails.
 */
describe('pruneIntegration_respectsThresholdInProduction', () => {
  /**
   * Only `stale-c` is backdated past the 14-day threshold of the topology. The fresh workflows
   * must stay non-terminal on disk, with no `workflow.pruned` event.
   */
  it(
    'handlePruneStaleWorkflows_respectsThresholdInProduction_readingRealStateFiles',
    async () => {
      for (const featureId of ['fresh-a', 'fresh-b', 'stale-c']) {
        const initResult = await handleInit(
          { featureId, workflowType: 'feature' },
          tmpDir,
          eventStore,
        );
        expect(initResult.success).toBe(true);
      }
      await backdateCheckpoint(tmpDir, 'stale-c', daysAgoIso(30));

      const safeguards: PruneSafeguards = {
        hasOpenPR: async () => false,
        hasRecentCommits: async () => false,
      };
      const deps = makeRealDeps(tmpDir, eventStore, safeguards);

      const applyResult = await handlePruneStaleWorkflows(
        { dryRun: false, force: true },
        tmpDir,
        ctx,
        deps,
      );

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
