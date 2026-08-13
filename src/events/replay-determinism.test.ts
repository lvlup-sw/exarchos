// ─── Replay Determinism — v2.9.0 Bug Cluster (Commit C9, #1109) ──────────────
//
// Closes the #1109 verification checklist by pinning the projection-
// determinism invariant across the v2.9.0 bug-cluster scenarios. For each
// closed-bug shape we:
//
//   1. Construct an event log that exercises the bug's failure mode.
//   2. Fold the log through `workflowStatusProjection` once.
//   3. Re-fold the same log from a fresh `init()` state.
//   4. Byte-compare the two projection states.
//
// A divergence here would indicate non-determinism in either the projection
// or in event-log ordering — the substrate invariant `AtomicAppender`
// (Commit C1) and the `task.completed` dedup (Commit C4) are designed to
// guarantee. This test pins those guarantees behind a regression gate so
// future projection changes can't silently re-introduce non-determinism.
//
// Per scenarios 1 (concurrent appends) we exercise the real `AtomicAppender`
// against a tmp-dir to also verify the substrate-side determinism story:
// the union of events written under concurrency must order deterministically
// when read back from JSONL.
//
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  workflowStatusProjection,
  type WorkflowStatusViewState,
} from '../projections/views/workflow-status-view.js';
import type { WorkflowEvent } from './schemas.js';
import { AtomicAppender } from './atomic-appender.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fold the projection over a list of events from a fresh `init()` state.
 * We intentionally avoid the `ViewMaterializer` cache here — replay
 * determinism is a pure-function property of the projection's `apply`
 * fold and using the cache would muddy the assertion (cache hits would
 * skip the fold entirely).
 */
function project(events: readonly WorkflowEvent[]): WorkflowStatusViewState {
  let state = workflowStatusProjection.init();
  for (const evt of events) {
    state = workflowStatusProjection.apply(state, evt);
  }
  return state;
}

/**
 * Build a structurally-valid `WorkflowEvent` from the minimum fields the
 * projection inspects. The schema-versioned fields (`schemaVersion`,
 * absent `correlationId`, etc.) are populated to defaults so the value
 * round-trips through any downstream Zod parse should one ever land
 * here. The projection itself reads only `type`, `data`, `timestamp`,
 * so the rest is incidental.
 */
function makeEvent(
  streamId: string,
  sequence: number,
  type: string,
  data: Record<string, unknown>,
  timestampMs = 1_700_000_000_000,
): WorkflowEvent {
  return {
    streamId,
    sequence,
    timestamp: new Date(timestampMs + sequence * 1000).toISOString(),
    type,
    data,
    schemaVersion: '1.0',
  } as WorkflowEvent;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('replay determinism (C9, #1109 verification)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-determinism-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  describe('replay_v29BugClusterScenarios_reconstructsIdenticalState', () => {
    /**
     * Scenario 1 — concurrent appends through `AtomicAppender`.
     *
     * Three concurrent `append` calls on the same stream must (a) succeed
     * without sequence collision and (b) produce a JSONL whose reader
     * yields a deterministic event order. We project the resulting log
     * twice and byte-compare. This is the C1 invariant in projection
     * terms: even when the writer order is non-deterministic, the
     * *committed* ordering is what the projection sees.
     */
    it('Scenario1_concurrentAppends_reproject_byteIdentical', async () => {
      const streamId = 'replay-scenario-1';
      const appender = new AtomicAppender({ stateDir: tmpDir });

      // Three concurrent appends, each carrying one task lifecycle event.
      // Distinct idempotencyKeys so all three are admitted.
      const results = await Promise.all([
        appender.append(streamId, [
          { type: 'workflow.started', data: { featureId: streamId, workflowType: 'feature' } },
        ], `${streamId}:k1`),
        appender.append(streamId, [
          { type: 'task.assigned', data: { taskId: 't1' } },
        ], `${streamId}:k2`),
        appender.append(streamId, [
          { type: 'task.completed', data: { taskId: 't1' } },
        ], `${streamId}:k3`),
      ]);
      for (const r of results) {
        expect(r.ok).toBe(true);
      }

      // Read the events back via the SQLite substrate (post v2.11
      // substrate-cut: JSONL is gone, the DB is authoritative).
      const backend = appender.getSqliteBackend();
      if (!backend) throw new Error('SQLite backend not initialized');
      const events = (await backend.queryEvents(streamId)) as WorkflowEvent[];

      // Project twice from the same log; byte-compare.
      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
    });

    /**
     * Scenario 2 — refinement checkpoints in same phase (C3 / #1241).
     *
     * Before the C3 fix, two checkpoint events with the same featureId +
     * phase + version collapsed to one because the idempotencyKey didn't
     * include a digest of the handoff payload. After C3, distinct
     * handoffs land as distinct events. The projection treats
     * `workflow.checkpoint` as unhandled, so this scenario doesn't move
     * the projection's counters — but it MUST still byte-compare across
     * re-projection. Determinism is the thing under test.
     */
    it('Scenario2_refinementCheckpoints_reproject_byteIdentical', () => {
      const streamId = 'replay-scenario-2';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        // Two checkpoints in the same phase with distinct handoffs.
        // Cast through `any` for `handoff` since the schema doesn't yet
        // declare it (mirrors handleCheckpoint's forward-compat read).
        makeEvent(streamId, 2, 'workflow.checkpoint', {
          counter: 0,
          phase: 'started',
          featureId: streamId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handoff: { delivered: 'design-v1' } as any,
        }),
        makeEvent(streamId, 3, 'workflow.checkpoint', {
          counter: 0,
          phase: 'started',
          featureId: streamId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handoff: { delivered: 'design-v2' } as any,
        }),
      ];

      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
    });

    /**
     * Scenario 3 — duplicate `task.completed` for same taskId (C4 / #1226).
     *
     * Whether the duplicate originated as a #1228 retry survivor or as a
     * historical replay artifact, the projection must dedup by taskId.
     * The C4 fix uses `_seenCompletedTaskIds` to count once. Here we
     * additionally pin the determinism property: re-projecting yields
     * a byte-identical state.
     */
    it('Scenario3_duplicateTaskCompleted_reproject_byteIdentical', () => {
      const streamId = 'replay-scenario-3';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        makeEvent(streamId, 2, 'task.assigned', { taskId: 't1' }),
        makeEvent(streamId, 3, 'task.completed', { taskId: 't1' }),
        // Duplicate `task.completed` — same taskId. Post-C4 must not
        // double-count. Pin the dedup outcome and the determinism.
        makeEvent(streamId, 4, 'task.completed', { taskId: 't1' }),
      ];

      const p1 = project(events);
      const p2 = project(events);

      // Byte-equal under re-projection.
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
      // The C4 invariant: duplicate counts once, never exceeding total.
      expect(p1.tasksCompleted).toBe(1);
      expect(p1.tasksTotal).toBe(1);
      expect(p1.tasksCompleted <= p1.tasksTotal).toBe(true);
    });

    /**
     * Scenario 4 — failed-then-passed guard (C7 / #1225).
     *
     * Before C7, a guard failure could be followed by a `workflow.transition`
     * event ~6s later, leaving both in the log. After C7's fail_closed,
     * the log carries either guard-failed or transition for a given
     * attempt — never both. We can't replay the C7 substrate guarantee
     * here (that's covered by `hsm-transition-guard.test.ts`), but we
     * pin determinism for the historical-log shape: an event log that
     * happens to carry both must still re-project byte-identically.
     */
    it('Scenario4_failedThenPassedGuard_reproject_byteIdentical', () => {
      const streamId = 'replay-scenario-4';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        // Historical-shape: guard failure followed by transition. Pinning
        // determinism, not the C7 atomicity property.
        makeEvent(streamId, 2, 'workflow.guard-failed', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          reason: 'all-tasks-complete failed',
        }),
        makeEvent(streamId, 3, 'workflow.transition', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          trigger: 'manual',
        }),
      ];

      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
      // The transition event is the last one folded; phase reflects it.
      expect(p1.phase).toBe('review');
    });

    /**
     * Combined scenario — all four bug shapes interleaved on one log.
     *
     * The strongest version of the #1109 invariant: the union of bug
     * shapes folded as one log re-projects byte-identically. Demonstrates
     * that determinism is a property of the projection over the entire
     * cluster, not just per-bug locality.
     */
    it('CombinedScenario_allBugShapes_reproject_byteIdentical', () => {
      const streamId = 'replay-combined';
      const events: WorkflowEvent[] = [
        makeEvent(streamId, 1, 'workflow.started', { featureId: streamId, workflowType: 'feature' }),
        makeEvent(streamId, 2, 'task.assigned', { taskId: 'tA' }),
        makeEvent(streamId, 3, 'task.assigned', { taskId: 'tB' }),
        // Duplicate task.assigned (#1226 dedup also applies to total).
        makeEvent(streamId, 4, 'task.assigned', { taskId: 'tA' }),
        makeEvent(streamId, 5, 'workflow.checkpoint', { counter: 0, phase: 'delegate', featureId: streamId }),
        makeEvent(streamId, 6, 'task.completed', { taskId: 'tA' }),
        // Duplicate task.completed (#1226).
        makeEvent(streamId, 7, 'task.completed', { taskId: 'tA' }),
        // Refinement checkpoint with handoff (#1241 — distinct event after C3).
        makeEvent(streamId, 8, 'workflow.checkpoint', {
          counter: 0,
          phase: 'delegate',
          featureId: streamId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handoff: { delivered: 'wave-2-summary' } as any,
        }),
        makeEvent(streamId, 9, 'task.completed', { taskId: 'tB' }),
        makeEvent(streamId, 10, 'workflow.guard-failed', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          reason: 'team-disbanded missing',
        }),
        makeEvent(streamId, 11, 'workflow.transition', {
          featureId: streamId,
          from: 'delegate',
          to: 'review',
          trigger: 'manual',
        }),
      ];

      const p1 = project(events);
      const p2 = project(events);
      expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));

      // Sanity: invariants from the cluster fixes — tasksCompleted (=2)
      // never exceeds tasksTotal (=2 distinct, dedup'd). Phase advances
      // to the last applied transition's `to`.
      expect(p1.tasksTotal).toBe(2);
      expect(p1.tasksCompleted).toBe(2);
      expect(p1.tasksCompleted <= p1.tasksTotal).toBe(true);
      expect(p1.phase).toBe('review');
    });
  });
});
