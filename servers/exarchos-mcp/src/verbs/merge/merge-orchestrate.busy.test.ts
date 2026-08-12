// ─── Wave 4 / Task 4.5a — storage-busy contention recovery fixture ─────────
//
// Audit §F2.1: the R-2 primitive layer raises `StorageBusyError` when the
// SQLite substrate's `BEGIN IMMEDIATE` retry budget exhausts. That signal
// is SEMANTICALLY EQUIVALENT to `ConcurrencyError` for the retry boundary —
// both are transient. Task 4.1's widened `withStateRetry` recognizes both
// classes; this fixture verifies the full loop closes end-to-end when only
// the substrate-contention class is injected.
//
// Setup: spy on `appender.decide` and throw a synthetic `StorageBusyError`
// on the first call (the substrate's BEGIN IMMEDIATE budget exhausted),
// then delegate to the real implementation on subsequent calls (the other
// writer committed; the lock is free).
//
// Asserts:
//   - Handler returns success.
//   - `decide` was invoked ≥ 2 times (withStateRetry kicked in).
//   - Final event sequence is canonical
//     (`merge.preflight → merge.requested → merge.executed`).

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';

import { handleMergeOrchestrate } from './merge-orchestrate.js';
import type { MergePreflightResult } from '../pure/merge-preflight.js';
import { StorageBusyError } from '../../events/storage-busy-error.js';
import '../../projections/merge-orchestrator/index.js';
import { rmrf } from '../../test-helpers/temp-dir.js';

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

const scratchRoots: string[] = [];

async function makeScratchEventStore(): Promise<{
  eventStore: EventStore;
  stateDir: string;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave4-busy-'));
  scratchRoots.push(stateDir);
  await fs.mkdir(path.join(stateDir, 'workflow-state'), { recursive: true });
  return { eventStore: new EventStore(stateDir), stateDir };
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

describe('handleMergeOrchestrate — Wave 4 / Task 4.5a storage-busy contention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('MergeOrchestrate_StorageBusyContention_RetriesViaWithStateRetryAndEventuallySucceeds', async () => {
    const { eventStore, stateDir } = await makeScratchEventStore();
    const ctx = makeCtx(eventStore, stateDir);

    const executeMerge = vi.fn().mockImplementation(async (input, innerCtx) => {
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

    const persistState = vi.fn().mockResolvedValue(undefined);
    const readState = vi.fn().mockResolvedValue(undefined);

    // Fault-inject: first `decide` call throws synthetic `StorageBusyError`
    // (the substrate's `BEGIN IMMEDIATE` retry budget exhausted), then
    // delegates to the real implementation on subsequent calls.
    // `withStateRetry` (Task 4.1 GREEN) catches the typed error and
    // re-runs the closure.
    const appender = eventStore.getAppender();
    const realDecide = appender.decide.bind(appender);
    let decideAttempts = 0;
    const decideSpy = vi
      .spyOn(appender, 'decide')
      .mockImplementation(async (...args) => {
        decideAttempts += 1;
        if (decideAttempts === 1) {
          throw new StorageBusyError({
            streamId: String(args[0]),
            attempts: 5,
            cause: new Error('SQLITE_BUSY (fault-injected, attempts=5)'),
          });
        }
        return realDecide(...args);
      });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-busy',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        preflight: vi.fn().mockResolvedValue(PASSING_PREFLIGHT),
        executeMerge,
        persistState,
        readState,
      },
      ctx,
    );

    // Property 1: the handler eventually succeeds despite the transient
    // contention signal. `withStateRetry` recognized `StorageBusyError`
    // (Task 4.1 GREEN), waited for the backoff window, and re-ran the
    // closure to a successful commit on attempt 2.
    expect(result.success).toBe(true);

    // Property 2: the retry loop engaged — `decide` was invoked at least
    // twice (first throws StorageBusyError; second succeeds).
    expect(decideAttempts).toBeGreaterThanOrEqual(2);

    // Property 3: the final event sequence is canonical. No missing
    // events (the retry observed the same closure produced the same
    // intent), no duplicates (substrate idempotency_claims + the
    // state-check-in-decide short-circuit both contribute).
    const events = await eventStore.query('feat-busy');
    const types = events.map((e) => e.type);
    expect(types).toContain('merge.preflight');
    expect(types).toContain('merge.requested');
    expect(types).toContain('merge.executed');

    const requestedCount = types.filter((t) => t === 'merge.requested').length;
    const executedCount = types.filter((t) => t === 'merge.executed').length;
    expect(requestedCount).toBe(1);
    expect(executedCount).toBe(1);

    decideSpy.mockRestore();
  });
});
