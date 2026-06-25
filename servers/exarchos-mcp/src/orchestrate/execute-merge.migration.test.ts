// ─── Wave 4 / Task 4.3 — execute-merge two-event split migration ────────────
//
// The orchestrator (Task 4.2) emits `merge.requested` before delegating to
// the executor. When `handleExecuteMerge` is called via the orchestrator the
// upstream `merge.requested` is already present; the executor's own Phase A
// `decide` closure observes `state.phase === 'requested'` and short-circuits
// to `[]` (a no-op).
//
// When `handleExecuteMerge` is invoked DIRECTLY (e.g., via CLI's
// `exarchos execute-merge` adapter or by tests bypassing the orchestrator),
// nobody upstream has emitted `merge.requested` yet, so the executor itself
// becomes responsible for recording the durable INTENT before the local git
// merge side effect fires. That is the test case captured here:
//
//   Pre-migration (preview.1):  [ merge.executed ]
//   Post-migration (Wave 4):    [ merge.requested, merge.executed ]
//
// The `merge.rollback` path is OUTSIDE the two-event split — it's the
// exception branch (Phase B rolled back), not the canonical
// intent → outcome record path. Untouched here.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

import { handleExecuteMerge } from './execute-merge.js';
import '../projections/merge-orchestrator/index.js';
import { rmrf } from '../test-helpers/temp-dir.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

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

// gitExec stub: `git rev-parse HEAD` returns the rollback sha, mirrors
// the executor's existing happy-path expectations from execute-merge.test.ts.
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

  it('ExecuteMerge_PostMigration_ProducesThreeEventSequence', async () => {
    // Direct invocation (no upstream orchestrator) — the executor must
    // record both `merge.requested` (Phase A) and `merge.executed` (Phase C).
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

    // Capture the full stream.
    const events = await eventStore.query('feat-exec-migration');
    const types = events.map((e) => e.type);

    // Pre-migration (preview.1) shape: ['merge.executed']. Post-migration
    // (this commit) the new `merge.requested` intent record lands FIRST.
    expect(types).toContain('merge.requested');
    expect(types).toContain('merge.executed');

    // Ordering: requested precedes executed.
    const idxRequested = types.indexOf('merge.requested');
    const idxExecuted = types.indexOf('merge.executed');
    expect(idxRequested).toBeLessThan(idxExecuted);

    // The side effect (vcsMerge) fires EXACTLY ONCE between the two
    // events (the canonical "side effect outside any retry boundary"
    // property — exercised here on the happy path; OCC-retry behavior
    // is covered by the executor's race test, not this migration test).
    expect(vcsMerge).toHaveBeenCalledTimes(1);

    // Outcome-data parity: `merge.executed` carries mergeSha + rollbackSha
    // as before the migration.
    const executedEvent = events.find((e) => e.type === 'merge.executed');
    expect(executedEvent).toBeDefined();
    const data = executedEvent?.data as Record<string, unknown> | undefined;
    expect(data?.mergeSha).toBe(MERGE_SHA);
    expect(data?.rollbackSha).toBe(ROLLBACK_SHA);
  });
});
