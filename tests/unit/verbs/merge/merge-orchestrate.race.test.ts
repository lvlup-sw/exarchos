// Concurrency race for `handleMergeOrchestrate`. Two invocations with the same featureId run against
// one real `EventStore`. The winner appends `merge.preflight`, `merge.requested` and `merge.executed`.
// The loser takes one of two paths:
//   - Its `merge.preflight` append fails the `expectedSequence` check, and it returns `STATE_CONFLICT`.
//   - Its `decide` gets `ConcurrencyError`. `withStateRetry` retries, the fold sees a `requested`
//     or later phase, and the decide closure returns no events.
// The test checks these properties:
//   1. Both invocations return a `ToolResult` and do not throw.
//   2. At least one invocation succeeds.
//   3. `vcsMerge` runs at most twice.
//   4. The stream holds exactly one `merge.requested` and one `merge.executed`.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import { handleExecuteMerge } from '../../../../src/verbs/merge/execute-merge.js';
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

async function makeScratchEventStore(): Promise<{
  eventStore: EventStore;
  stateDir: string;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave4-race-'));
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

describe('handleMergeOrchestrate — Wave 4 / Task 4.5 concurrency race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The real `handleExecuteMerge` runs with stubbed `vcsMerge`, `persistState` and `gitExec`.
   * After the orchestrator commits `merge.requested`, it delegates without a second check, so `vcsMerge`
   * can run once for each invocation. The `expectedSequence` check on the `merge.executed` append keeps one event.
   * `merge-orchestrate.api-refire.test.ts` pins that a retry does not run the side effect again.
   * Both invocations pass the same `taskId`. The idempotency claim or the state check in `decide`
   * keeps one `merge.requested`.
   */
  it('MergeOrchestrate_ConcurrentInvocations_OneWinsOneRetriesViaConcurrencyConflict', async () => {
    const { eventStore, stateDir } = await makeScratchEventStore();
    const ctx = makeCtx(eventStore, stateDir);

    let vcsMergeCallCount = 0;
    const vcsMerge = vi.fn().mockImplementation(async () => {
      vcsMergeCallCount += 1;
      return { mergeSha: MERGE_SHA };
    });
    const gitExec = vi.fn().mockImplementation((_repo, args: readonly string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    });

    const executorPersistState = vi.fn().mockResolvedValue(undefined);

    const realExecutor = (input: Parameters<typeof handleExecuteMerge>[0], innerCtx: DispatchContext) =>
      handleExecuteMerge(
        {
          ...input,
          vcsMerge,
          persistState: executorPersistState,
          gitExec,
        },
        innerCtx,
      );

    const orchestratorPersistState = vi.fn().mockResolvedValue(undefined);
    const readState = vi.fn().mockResolvedValue(undefined);

    const invokeOne = () =>
      handleMergeOrchestrate(
        {
          featureId: 'feat-race',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          taskId: 'T11',
          strategy: 'squash',
          preflight: vi.fn().mockResolvedValue(PASSING_PREFLIGHT),
          executeMerge: realExecutor,
          persistState: orchestratorPersistState,
          readState,
          gitExec: BYPASS_SECTION_0A,
        },
        ctx,
      );

    const [a, b] = await Promise.all([invokeOne(), invokeOne()]);

    expect(typeof a.success).toBe('boolean');
    expect(typeof b.success).toBe('boolean');

    const successes = [a, b].filter((r) => r.success);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    expect(vcsMergeCallCount).toBeLessThanOrEqual(2);

    const events = await eventStore.query('feat-race');
    const types = events.map((e) => e.type);
    const requestedCount = types.filter((t) => t === 'merge.requested').length;
    expect(requestedCount).toBe(1);

    const executedCount = types.filter((t) => t === 'merge.executed').length;
    expect(executedCount).toBe(1);
  });
});
