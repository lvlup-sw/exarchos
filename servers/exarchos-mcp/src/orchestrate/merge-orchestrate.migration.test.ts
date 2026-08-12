// ─── Wave 4 / Task 4.2 — merge-orchestrate two-event split migration ───────
//
// Audit §F1.2: pre-migration `handleMergeOrchestrate` runs preflight → emits
// `merge.preflight` → delegates to executor, which emits `merge.executed`. The
// orchestrator never records a durable INTENT before the side effect (executor
// call) fires. If anything inside the side-effect boundary retried (e.g., an
// HTTP-style PR merge), the API would re-fire on every OCC loss.
//
// Wave 4's two-event split inserts `merge.requested` BETWEEN preflight pass
// and executor delegation: the pure decide closure runs under `withStateRetry`,
// commits `merge.requested`, and the side effect (executor) fires OUTSIDE that
// retry boundary. The executor still emits `merge.executed` (its own Phase C);
// the orchestrator's own Phase C is implicit (the executor's `merge.executed`
// is the durable outcome record).
//
// Note on `merge.completed`: the design pseudocode (lines 525-577) does NOT
// include a `merge.completed` event in the two-event split — only
// `merge.requested` and `merge.executed`. The `merge.completed` event type is
// referenced in the projection's phase machine for the eventual full
// lifecycle, but it is NOT yet registered in `events/schemas.ts`'s
// `EventTypes` table. Adding it would be out of scope per the Wave 4 prompt
// ("Do NOT add new event types beyond `merge.requested`"). The migration
// therefore pins the canonical post-migration sequence as:
//
//   merge.preflight → merge.requested → merge.executed
//
// RED expectation BEFORE GREEN: the orchestrator never emits `merge.requested`
// today; the captured event types come out as `['merge.preflight',
// 'merge.executed']`. The `toContain('merge.requested')` assertion fails.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';

import { handleMergeOrchestrate } from './merge-orchestrate.js';
import type { MergePreflightResult } from './pure/merge-preflight.js';
// Side-effect import — registers merge-orchestrator@v1 with defaultRegistry so
// the Wave 3 primitives (decide / aggregateStream) can resolve the reducer
// when the migration commits `merge.requested` and the executor commits
// `merge.executed`.
import '../projections/merge-orchestrator/index.js';
import { rmrf } from '../test-helpers/temp-dir.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

const PASSING_PREFLIGHT: MergePreflightResult = {
  passed: true,
  ancestry: { passed: true, checks: ['ancestry'] },
  currentBranchProtection: { blocked: false, currentBranch: 'feat/x' },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [] as string[],
    indexStale: false,
    detachedHead: false,
  },
};

// ─── Per-test scratch tmp dirs (real EventStore needs disk) ────────────────

const scratchRoots: string[] = [];

async function makeScratchEventStore(): Promise<{
  eventStore: EventStore;
  stateDir: string;
}> {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wave4-merge-orch-migration-'),
  );
  scratchRoots.push(stateDir);
  // Eagerly write the workflow state file so the orchestrator's default
  // `persistState` (workflow-state/<feature>.state.json) can read+CAS it.
  // The handler's preflight-pass + executor-success path does not touch
  // the file directly (the executor owns its own persistState), but the
  // surrounding context expects a workflow-state directory to exist.
  await fs.mkdir(path.join(stateDir, 'workflow-state'), { recursive: true });
  const eventStore = new EventStore(stateDir);
  return { eventStore, stateDir };
}

function makeCtx(eventStore: EventStore, stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
  } as unknown as DispatchContext;
}

afterAll(async () => {
  await Promise.all(
    scratchRoots.map((p) => rmrf(p)),
  );
});

describe('handleMergeOrchestrate — Wave 4 / Task 4.2 two-event split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('MergeOrchestrate_PostMigration_ProducesThreeEventSequence', async () => {
    // Setup: identical feature stream + identical incoming command pre/post
    // migration. We exercise the post-migration handler and capture the
    // event sequence by querying the stream after the handler returns.
    const { eventStore, stateDir } = await makeScratchEventStore();
    const ctx = makeCtx(eventStore, stateDir);

    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn().mockImplementation(async (input, innerCtx) => {
      // Real executor would `vcsMerge` + append `merge.executed`. We mimic
      // the append portion directly here so the stream reflects the
      // executor's contribution. Use `appendUnkeyed` via the EventStore's
      // public `append` helper so the substrate sees a real persisted event.
      await innerCtx.eventStore.append(input.featureId, {
        type: 'merge.executed',
        data: {
          taskId: input.taskId,
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          strategy: input.strategy,
          mergeSha: MERGE_SHA,
          rollbackSha: ROLLBACK_SHA,
        },
      });
      return {
        success: true as const,
        data: {
          phase: 'completed' as const,
          mergeSha: MERGE_SHA,
          rollbackSha: ROLLBACK_SHA,
        },
      };
    });
    // The default `persistState` reads/writes the workflow state file at
    // `<stateDir>/<featureId>.state.json`. The post-migration handler may
    // or may not persist on the happy path (it's no-op when phase is
    // 'completed' from the executor); bypass with a no-op mock.
    const persistState = vi.fn().mockResolvedValue(undefined);
    const readState = vi.fn().mockResolvedValue(undefined);

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-wave4-migration',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
        readState,
      },
      ctx,
    );

    // The handler must return success on the happy path.
    expect(result.success).toBe(true);

    // Capture the stream's full event sequence (chronological per substrate).
    const events = await eventStore.query('feat-wave4-migration');
    const types = events.map((e) => e.type);

    // Pre-migration shape (legacy preview.1): ['merge.preflight',
    // 'merge.executed']. Post-migration (this commit) the new
    // `merge.requested` event lands between them. Captured here as a golden
    // assertion so any future refactor that drops `merge.requested` (or
    // re-orders the split) trips this fixture.
    expect(types).toContain('merge.requested');
    expect(types).toContain('merge.preflight');
    expect(types).toContain('merge.executed');

    // Ordering: preflight first, requested next, executed last.
    const idxPreflight = types.indexOf('merge.preflight');
    const idxRequested = types.indexOf('merge.requested');
    const idxExecuted = types.indexOf('merge.executed');
    expect(idxPreflight).toBeLessThan(idxRequested);
    expect(idxRequested).toBeLessThan(idxExecuted);

    // Outcome-data parity: the `merge.executed` event still carries the
    // mergeSha + rollbackSha the executor produced. Wave 4's split must not
    // strip outcome fields from the final event.
    const executedEvent = events.find((e) => e.type === 'merge.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent?.data as Record<string, unknown> | undefined;
    expect(data?.mergeSha).toBe(MERGE_SHA);
    expect(data?.rollbackSha).toBe(ROLLBACK_SHA);
  });
});
