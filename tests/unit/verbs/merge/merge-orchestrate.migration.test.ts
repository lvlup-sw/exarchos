// Pins the two-event split in `handleMergeOrchestrate`.
// The handler appends `merge.preflight`, then commits `merge.requested` through the pure decide closure under `withStateRetry`.
// The executor side effect runs outside that retry boundary, so a lost OCC race does not fire the side effect again.
// The side-effect import of `merge-orchestrator/index.js` registers the `merge-orchestrator@v1` reducer for `decide`.
// This test mocks the executor, so it pins only this sequence:
//
//   merge.preflight → merge.requested → merge.executed

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import type { MergePreflightResult } from '../../../../src/verbs/pure/merge-preflight.js';
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

/** Creates a real EventStore in a scratch dir, with the `workflow-state` directory that the surrounding context expects. */
async function makeScratchEventStore(): Promise<{
  eventStore: EventStore;
  stateDir: string;
}> {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wave4-merge-orch-migration-'),
  );
  scratchRoots.push(stateDir);
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

  /**
   * The mocked executor appends `merge.executed` with the merge SHAs, as the real executor does.
   * The `persistState` and `readState` mocks are no-ops.
   * The test checks the order of the three events, and that `merge.executed` still carries `mergeSha` and `rollbackSha`.
   */
  it('MergeOrchestrate_PostMigration_ProducesThreeEventSequence', async () => {
    const { eventStore, stateDir } = await makeScratchEventStore();
    const ctx = makeCtx(eventStore, stateDir);

    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(result.success).toBe(true);

    const events = await eventStore.query('feat-wave4-migration');
    const types = events.map((e) => e.type);

    expect(types).toContain('merge.requested');
    expect(types).toContain('merge.preflight');
    expect(types).toContain('merge.executed');

    const idxPreflight = types.indexOf('merge.preflight');
    const idxRequested = types.indexOf('merge.requested');
    const idxExecuted = types.indexOf('merge.executed');
    expect(idxPreflight).toBeLessThan(idxRequested);
    expect(idxRequested).toBeLessThan(idxExecuted);

    const executedEvent = events.find((e) => e.type === 'merge.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent?.data as Record<string, unknown> | undefined;
    expect(data?.mergeSha).toBe(MERGE_SHA);
    expect(data?.rollbackSha).toBe(ROLLBACK_SHA);
  });
});
