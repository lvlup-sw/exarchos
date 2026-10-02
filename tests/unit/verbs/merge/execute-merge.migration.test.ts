// `handleExecuteMerge` records the merge intent and the outcome as two events.
// Through the orchestrator, `merge.requested` is already in the stream, so the
// executor `decide` closure sees `state.phase === 'requested'` and appends
// nothing.
//
// A direct call has no upstream `merge.requested`. The executor then records
// the intent before the local git merge runs. This file tests that direct
// path. The `merge.rollback` path is out of scope.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

import { handleExecuteMerge } from '../../../../src/verbs/merge/execute-merge.js';
import '../../../../src/projections/merge-orchestrator/index.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

const scratchRoots: string[] = [];

async function makeScratchEventStore(): Promise<{
  eventStore: EventStore;
  stateDir: string;
}> {
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wave4-exec-merge-migration-'),
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

/** A `gitExec` stub. `git rev-parse HEAD` returns the rollback sha. */
function makeGitExec() {
  return vi.fn().mockImplementation((_repo: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  });
}

afterAll(async () => {
  await Promise.all(
    scratchRoots.map((p) => rmrf(p)),
  );
});

describe('handleExecuteMerge — Wave 4 / Task 4.3 two-event split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A direct call records `merge.requested` before `merge.executed` and runs the merge once. */
  it('ExecuteMerge_PostMigration_ProducesThreeEventSequence', async () => {
    const { eventStore, stateDir } = await makeScratchEventStore();
    const ctx = makeCtx(eventStore, stateDir);

    const vcsMerge = vi.fn().mockResolvedValue({ mergeSha: MERGE_SHA });
    const persistState = vi.fn().mockResolvedValue(undefined);

    const result = await handleExecuteMerge(
      {
        featureId: 'feat-exec-migration',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        vcsMerge,
        persistState,
        gitExec: makeGitExec(),
      },
      ctx,
    );

    expect(result.success).toBe(true);

    const events = await eventStore.query('feat-exec-migration');
    const types = events.map((e) => e.type);

    expect(types).toContain('merge.requested');
    expect(types).toContain('merge.executed');

    const idxRequested = types.indexOf('merge.requested');
    const idxExecuted = types.indexOf('merge.executed');
    expect(idxRequested).toBeLessThan(idxExecuted);

    expect(vcsMerge).toHaveBeenCalledTimes(1);

    const executedEvent = events.find((e) => e.type === 'merge.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent?.data as Record<string, unknown> | undefined;
    expect(data?.mergeSha).toBe(MERGE_SHA);
    expect(data?.rollbackSha).toBe(ROLLBACK_SHA);
  });
});
