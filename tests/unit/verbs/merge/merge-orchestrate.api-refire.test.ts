/**
 * Tests that an OCC retry does not fire the merge executor again.
 * The executor merge is a side effect that is not idempotent. It runs after the retried `decide` boundary, never inside it.
 * If a change moves the executor call into a `withStateRetry` block, this test fails.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import type { MergePreflightResult } from '../../../../src/verbs/pure/merge-preflight.js';
import { ConcurrencyError } from '../../../../src/events/concurrency-error.js';
import '../../../../src/projections/merge-orchestrator/index.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { BYPASS_SECTION_0A } from '../../../helpers/section-0a-bypass.js';

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
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wave4-api-refire-'),
  );
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

describe('handleMergeOrchestrate — Wave 4 / Task 4.2b API-non-refire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The first `decide` throws `ConcurrencyError`, so `withStateRetry` runs the closure again. Later calls go to the real `decide`.
   * The mock executor counts its calls and appends `merge.executed`, as the real executor does.
   * The executor must run exactly once, and the retry must not append a second `merge.requested`.
   */
  it('MergeOrchestrate_PostMigration_DoesNotRefireExecutorOnOccRetry', async () => {
    const { eventStore, stateDir } = await makeScratchEventStore();
    const ctx = makeCtx(eventStore, stateDir);

    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    let executorCallCount = 0;
    const executeMerge = vi.fn().mockImplementation(async (input, innerCtx) => {
      executorCallCount += 1;
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

    const appender = eventStore.getAppender();
    const realDecide = appender.decide.bind(appender);
    let phaseAAttempts = 0;
    const decideSpy = vi
      .spyOn(appender, 'decide')
      .mockImplementation(async (...args) => {
        phaseAAttempts += 1;
        if (phaseAAttempts === 1) {
          throw new ConcurrencyError({
            streamId: String(args[0]),
            reducerId: String(args[1]),
            expectedVersion: 1,
            actualVersion: 2,
          });
        }
        return realDecide(...args);
      });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-api-refire',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
        readState,
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(result.success).toBe(true);

    expect(phaseAAttempts).toBeGreaterThanOrEqual(2);
    expect(executorCallCount).toBe(1);

    expect(executeMerge).toHaveBeenCalledTimes(1);

    const events = await eventStore.query('feat-api-refire');
    const types = events.map((e) => e.type);
    const requestedCount = types.filter((t) => t === 'merge.requested').length;
    const executedCount = types.filter((t) => t === 'merge.executed').length;
    expect(requestedCount).toBe(1);
    expect(executedCount).toBe(1);

    decideSpy.mockRestore();
  });
});
