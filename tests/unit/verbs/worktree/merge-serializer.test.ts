// Tests for the `serialize_merge` lease. It allows at most one in-flight merge
// per `integrationRef` and calls `merge_orchestrate` unchanged. The concurrency
// test uses a real SQLite `EventStore`, because its stream-version check in the
// transaction is the guard across processes. The composition test runs the real
// merge in two temp git repos and compares the `merge.*` events without the
// commit SHAs. The routing test goes through `handleOrchestrate`, so a missing
// dispatch entry fails.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../../../../src/events/store.js';
import { EVENT_DATA_SCHEMAS } from '../../../../src/events/schemas.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync, rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { writeStateFile } from '../../../../src/workflow/state-store.js';
import type { ToolResult } from '../../../../src/format.js';

import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import {
  handleMergeOrchestrate,
  type HandleMergeOrchestrateInput,
} from '../../../../src/verbs/merge/merge-orchestrate.js';
import { serializeMerge } from '../../../../src/verbs/worktree/merge-serializer.js';
import { handleSerializeMerge } from '../../../../src/verbs/worktree/handlers.js';
import { WORKTREES_STREAM, WORKTREES_REDUCER } from '../../../../src/verbs/worktree/manager.js';
import type { WorktreesProjection } from '../../../../src/verbs/worktree/projections/worktrees.js';
import type { ProcessTableSource, ProcessRecord } from '../../../../src/verbs/worktree/pure/probe.js';
import type { SleepFn } from '../../../../src/verbs/worktree/git-retry.js';
import type { MergePreflightResult, GitExec } from '../../../../src/verbs/pure/merge-preflight.js';

interface Arm {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly ctx: DispatchContext;
}

const arms: Arm[] = [];
const repoDirs: string[] = [];

async function createArm(stateDirOverride?: string): Promise<Arm> {
  const stateDir = stateDirOverride ?? (await mkdtemp(path.join(tmpdir(), 'wlm-serialize-')));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  const arm = { stateDir, eventStore, ctx };
  arms.push(arm);
  return arm;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (arms.length > 0) {
    const arm = arms.pop();
    if (arm) {
      arm.eventStore.close();
      await rmrfAsync(arm.stateDir);
    }
  }
  while (repoDirs.length > 0) {
    const dir = repoDirs.pop();
    if (dir) rmrf(dir);
  }
});

/** A supported process table that lists only the given PID and start time pairs as alive. */
function liveTable(pairs: ReadonlyArray<{ pid: number; startTime: string }>): ProcessTableSource {
  const records: ProcessRecord[] = pairs.map(({ pid, startTime }) => ({
    pid,
    ppid: 1,
    cwd: `/proc-fixture/${pid}`,
    startTime,
  }));
  return { list: () => records };
}

/** A supported empty process table, so each probed PID is absent and provably dead. */
const EMPTY_TABLE: ProcessTableSource = { list: () => [] };

/**
 * An unsupported process table, as on a platform with no enumerator. `list()`
 * is `[]` and `isSupported()` is `false`, so a probed PID reads as `'unknown'`.
 * The lease must keep a holder that this table probes.
 */
const UNSUPPORTED_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => false,
};

/** A `merge_orchestrate` stub that records the `featureId` of each call. */
function recordingMerge(into: string[]): (input: { featureId: string }) => Promise<ToolResult> {
  return async (input) => {
    into.push(input.featureId);
    return { success: true, data: { phase: 'completed' } };
  };
}

/** Appends a `worktree.merge_requested` claim to the worktrees stream, so the lease is held. */
async function seedHolder(
  arm: Arm,
  holder: {
    integrationRef: string;
    operationId: string;
    sourceBranch: string;
    holderPid: number;
    holderStartedAt: string;
  },
): Promise<void> {
  await arm.eventStore.getAppender().append(
    WORKTREES_STREAM,
    [{ type: 'worktree.merge_requested', data: { ...holder } }],
    `worktree.merge_requested:${holder.operationId}`,
  );
}

async function foldWorktrees(arm: Arm): Promise<WorktreesProjection> {
  const { aggregate } = await arm.eventStore
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

/**
 * A repo in which `main`, the integration ref, is an ancestor of `feat`, the
 * source. `main` has commit A, and `feat` adds commit C. HEAD stays on `feat`,
 * which is not protected, so the merge preflight passes.
 */
async function setupMergeableRepo(): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'wlm-serialize-repo-'));
  repoDirs.push(repoRoot);
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repoRoot, 'a.txt'), 'A\n');
  await git(repoRoot, ['add', 'a.txt']);
  await git(repoRoot, ['commit', '-m', 'A', '-q']);
  await git(repoRoot, ['checkout', '-b', 'feat', '-q']);
  writeFileSync(path.join(repoRoot, 'c.txt'), 'C\n');
  await git(repoRoot, ['add', 'c.txt']);
  await git(repoRoot, ['commit', '-m', 'C', '-q']);
  return repoRoot;
}

async function seedFeatureState(stateDir: string, featureId: string): Promise<void> {
  const now = new Date().toISOString();
  await writeStateFile(
    path.join(stateDir, `${featureId}.state.json`),
    {
      version: '1.1',
      workflowType: 'feature',
      featureId,
      phase: 'delegate',
      createdAt: now,
      updatedAt: now,
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      integration: null,
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
      mergeOrchestrator: { phase: 'pending', sourceBranch: 'feat', targetBranch: 'main' },
    } as never,
  );
}

/** Reduces a `merge.*` event to its stable fields, without volatile values or SHAs. */
function normalizeMergeEvent(e: { type: string; data?: Record<string, unknown> }): Record<string, unknown> {
  const d = e.data ?? {};
  return {
    type: e.type,
    sourceBranch: d.sourceBranch,
    targetBranch: d.targetBranch,
    ...(d.strategy !== undefined ? { strategy: d.strategy } : {}),
    ...(d.passed !== undefined ? { passed: d.passed } : {}),
  };
}

describe('serialize_merge — single-writer ordering', () => {
  /**
   * F1 holds the lease under the live PID 999. The injected sleep releases F1 on
   * its first call, so F2 waits at least one poll. F2 claims only after the
   * `worktree.merge_executed` of F1, and the lease ends clear.
   */
  it('SerializeMerge_TwoFeatureIdsSameBranch_SecondWaitsForFirstExecutedBeforeClaiming', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/main';
    const f1OpId = 'f1-holder-op';

    await seedHolder(arm, {
      integrationRef,
      operationId: f1OpId,
      sourceBranch: 'feat/1',
      holderPid: 999,
      holderStartedAt: 'alive-999',
    });

    let sleepCalls = 0;
    let released = false;
    const sleep: SleepFn = async () => {
      sleepCalls += 1;
      if (!released) {
        released = true;
        await arm.eventStore.getAppender().append(
          WORKTREES_STREAM,
          [{ type: 'worktree.merge_executed', data: { integrationRef, operationId: f1OpId, sourceBranch: 'feat/1' } }],
          `worktree.merge_executed:${f1OpId}`,
        );
      }
    };

    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F2', integrationRef, sourceBranch: 'feat/2', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      {
        sleep,
        processTableSource: liveTable([{ pid: 999, startTime: 'alive-999' }]),
        selfPid: 222,
        selfStartedAt: 'self-222',
        mergeOrchestrate: recordingMerge(merged),
        readIntegrationHead: () => 'head-sha',
      },
    );

    expect(result.success).toBe(true);
    expect(merged).toEqual(['F2']);
    expect(sleepCalls).toBeGreaterThanOrEqual(1);

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const f1ExecIdx = events.findIndex(
      (e) => e.type === 'worktree.merge_executed' && e.data?.operationId === f1OpId,
    );
    const f2ReqIdx = events.findIndex(
      (e) => e.type === 'worktree.merge_requested' && e.data?.operationId !== f1OpId,
    );
    expect(f1ExecIdx).toBeGreaterThanOrEqual(0);
    expect(f2ReqIdx).toBeGreaterThan(f1ExecIdx);

    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

describe('serialize_merge — unsupported process table (DR-7 fail-closed)', () => {
  /**
   * The holder PID is not in the empty list of the unsupported table. A supported
   * empty table reads that PID as dead, but this table reads it as `'unknown'`,
   * so the holder must stay. The injected sleep advances a fake clock, so the
   * wait times out and the merge does not run.
   */
  it('SerializeMerge_UnsupportedProcessTable_DoesNotReclaimLiveHolder', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/unsupported';
    const holderOpId = 'live-holder-op';

    await seedHolder(arm, {
      integrationRef,
      operationId: holderOpId,
      sourceBranch: 'feat/held',
      holderPid: 9090,
      holderStartedAt: 'boot-9090',
    });

    let clock = 0;
    const sleep: SleepFn = async (ms) => {
      clock += ms;
    };
    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/new', strategy: 'merge', timeoutMs: 1_000 },
      arm.ctx,
      {
        now: () => clock,
        sleep,
        processTableSource: UNSUPPORTED_TABLE,
        selfPid: 222,
        selfStartedAt: 'self-222',
        mergeOrchestrate: recordingMerge(merged),
        readIntegrationHead: () => 'head-sha',
      },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_SLOT_TIMEOUT');
    expect((result.data as { reason?: string }).reason).toBe('merge-slot-timeout');
    expect(merged).toEqual([]);
    const projection = await foldWorktrees(arm);
    expect(projection.inFlightMerges[integrationRef]?.operationId).toBe(holderOpId);
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const reclaims = events.filter(
      (e) => e.type === 'worktree.merge_executed' && e.data?.operationId === holderOpId,
    );
    expect(reclaims).toHaveLength(0);
  });
});

describe('serialize_merge — cross-process OCC', () => {
  /**
   * Two `EventStore` instances over one database file race as two processes.
   * The merge stub holds the lease for 120 ms, longer than the first retry
   * backoff of the loser, so the loser folds a live holder. The sleep yields a
   * macrotask, so the loser does not starve the winner. A walk of the committed
   * log then checks that no two claims for the ref are open at once.
   */
  it('SerializeMerge_ConcurrentClaims_OccResolvesSingleHolderCrossProcess', async () => {
    const armA = await createArm();
    const armB = await createArm(armA.stateDir);
    const integrationRef = 'integration/shared';

    let active = 0;
    let maxActive = 0;
    const merged: string[] = [];
    const mergeOrchestrate = async (input: { featureId: string }): Promise<ToolResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 120));
      active -= 1;
      merged.push(input.featureId);
      return { success: true, data: { phase: 'completed' } };
    };

    const sleep: SleepFn = () => new Promise((r) => setImmediate(r));
    const table = liveTable([
      { pid: 5001, startTime: 'start-A' },
      { pid: 5002, startTime: 'start-B' },
    ]);

    const [rA, rB] = await Promise.all([
      serializeMerge(
        { featureId: 'F-A', integrationRef, sourceBranch: 'feat/a', strategy: 'merge', timeoutMs: 15_000 },
        armA.ctx,
        { sleep, processTableSource: table, selfPid: 5001, selfStartedAt: 'start-A', mergeOrchestrate, readIntegrationHead: () => 'head-a' },
      ),
      serializeMerge(
        { featureId: 'F-B', integrationRef, sourceBranch: 'feat/b', strategy: 'merge', timeoutMs: 15_000 },
        armB.ctx,
        { sleep, processTableSource: table, selfPid: 5002, selfStartedAt: 'start-B', mergeOrchestrate, readIntegrationHead: () => 'head-b' },
      ),
    ]);

    expect(rA.success).toBe(true);
    expect(rB.success).toBe(true);
    expect(maxActive).toBe(1);
    expect([...merged].sort()).toEqual(['F-A', 'F-B']);

    const events = await armA.eventStore.query(WORKTREES_STREAM);
    const claims = events.filter((e) => e.type === 'worktree.merge_requested');
    const releases = events.filter((e) => e.type === 'worktree.merge_executed');
    expect(claims).toHaveLength(2);
    expect(releases).toHaveLength(2);
    expect((await foldWorktrees(armA)).inFlightMerges[integrationRef]).toBeUndefined();

    let activeClaims = 0;
    let maxActiveClaims = 0;
    for (const e of events) {
      if (e.type === 'worktree.merge_requested' && e.data?.integrationRef === integrationRef) {
        activeClaims += 1;
        maxActiveClaims = Math.max(maxActiveClaims, activeClaims);
      } else if (e.type === 'worktree.merge_executed' && e.data?.integrationRef === integrationRef) {
        activeClaims -= 1;
      }
    }
    expect(maxActiveClaims).toBe(1);
  });
});

describe('serialize_merge — composition', () => {
  /**
   * Runs the serialized path through `handleOrchestrate` with `dryRun: false`,
   * so `merge_orchestrate` runs. Runs the direct `handleMergeOrchestrate` path
   * on an equal second repo. The `merge.*` events of the feature stream must
   * match without ids, timestamps, sequences, and commit SHAs.
   */
  it('SerializeMerge_MergeOrchestrateComposedUnchanged_FeatureStreamEventsMatchModuloVolatileAndShas', async () => {
    const featureId = 'feat-compose';

    const repoSerial = await setupMergeableRepo();
    const armSerial = await createArm();
    await seedFeatureState(armSerial.stateDir, featureId);
    const serialResult = await handleOrchestrate(
      {
        action: 'serialize_merge',
        featureId,
        integrationRef: 'main',
        sourceBranch: 'feat',
        strategy: 'merge',
        repoRoot: repoSerial,
        dryRun: false,
      },
      armSerial.ctx,
    );
    expect(serialResult.success).toBe(true);

    const repoDirect = await setupMergeableRepo();
    const armDirect = await createArm();
    await seedFeatureState(armDirect.stateDir, featureId);
    const directResult = await handleMergeOrchestrate(
      { featureId, sourceBranch: 'feat', targetBranch: 'main', strategy: 'merge', repoRoot: repoDirect },
      armDirect.ctx,
    );
    expect(directResult.success).toBe(true);

    const serialMerge = (await armSerial.eventStore.query(featureId))
      .filter((e) => e.type.startsWith('merge.'))
      .map(normalizeMergeEvent);
    const directMerge = (await armDirect.eventStore.query(featureId))
      .filter((e) => e.type.startsWith('merge.'))
      .map(normalizeMergeEvent);

    expect(serialMerge.length).toBeGreaterThan(0);
    expect(serialMerge).toEqual(directMerge);
    expect(serialMerge.map((e) => e.type)).toContain('merge.executed');
  });
});

describe('serialize_merge — release semantics', () => {
  /**
   * The composed merge appends an unrelated event, so the stream tail moves past
   * the claim sequence before the release. A release pinned to the claim
   * sequence conflicts here, and a plain keyed append does not. The release
   * call must carry no `AppendOptions`, and the slot must end clear.
   */
  it('SerializeMerge_ReleaseIsPlainKeyedAppend_NotCasPinnedToClaimSeq', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/release';
    const appender = arm.eventStore.getAppender();
    const appendSpy = vi.spyOn(appender, 'append');

    const mergeOrchestrate = async (): Promise<ToolResult> => {
      await appender.append(
        WORKTREES_STREAM,
        [{ type: 'worktree.adopted', data: { worktreeId: '/tmp/unrelated-wt', path: '/tmp/unrelated-wt', featureId: null } }],
        'worktree.adopted:unrelated-advance',
      );
      return { success: true, data: { phase: 'completed' } };
    };

    const result = await serializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/x', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      { mergeOrchestrate, readIntegrationHead: () => null, selfPid: 333, selfStartedAt: 'self-333' },
    );
    expect(result.success).toBe(true);

    const releaseCall = appendSpy.mock.calls.find((c) => {
      const events = c[1] as Array<{ type: string }>;
      return events[0]?.type === 'worktree.merge_executed';
    });
    expect(releaseCall).toBeDefined();
    expect(releaseCall![3]).toBeUndefined();

    const fold = await foldWorktrees(arm);
    expect(fold.inFlightMerges[integrationRef]).toBeUndefined();
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const adoptIdx = events.findIndex((e) => e.type === 'worktree.adopted');
    const releaseIdx = events.findIndex((e) => e.type === 'worktree.merge_executed');
    expect(adoptIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(adoptIdx);
  });
});

describe('serialize_merge — the lease IS the serialization', () => {
  /**
   * The static check strips comments from the serializer source first, so its
   * own prose cannot match. The behavioral check walks `stateDir` in Node and
   * does not run `find`, because on Windows `find` is a different program.
   */
  it('SerializeMerge_WritesNoLockFile_ImportsNoFlockLib', async () => {
    const sourcePath = fileURLToPath(new URL('../../../../src/verbs/worktree/merge-serializer.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf-8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const importSpecifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of importSpecifiers) {
      expect(spec.toLowerCase()).not.toContain('lock');
    }
    expect(code).not.toMatch(/flockSync|O_EXLOCK|proper-lockfile|lockfile|\.lock\b/i);

    const arm = await createArm();
    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F', integrationRef: 'integration/nolock', sourceBranch: 'feat/x', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      { mergeOrchestrate: recordingMerge(merged), readIntegrationHead: () => null, selfPid: 444, selfStartedAt: 'self-444' },
    );
    expect(result.success).toBe(true);

    const lockFiles = readdirSync(arm.stateDir, { recursive: true }).filter((entry) =>
      entry.toString().endsWith('.lock'),
    );
    expect(lockFiles).toEqual([]);
  });
});

describe('serialize_merge — unresolvable create-time (Sentry #15023070/1)', () => {
  /**
   * The process source cannot resolve the create time of the caller, and the
   * test does not inject `selfStartedAt`. The claim must carry a `null`
   * `holderStartedAt`, not an empty string. The schema accepts `null` and
   * rejects `''`.
   */
  it('SerializeMerge_UnresolvedStartTime_EmitsNullHolderStartedAt_SchemaValid', async () => {
    const arm = await createArm();
    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F', integrationRef: 'integration/nostart', sourceBranch: 'feat/x', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      {
        processSource: { getStartTime: () => ({ status: 'absent' as const }) },
        selfPid: 555,
        mergeOrchestrate: recordingMerge(merged),
        readIntegrationHead: () => null,
      },
    );
    expect(result.success).toBe(true);

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const claim = events.find((e) => e.type === 'worktree.merge_requested');
    expect(claim).toBeDefined();
    expect((claim!.data as { holderStartedAt?: unknown }).holderStartedAt).toBeNull();

    const schema = EVENT_DATA_SCHEMAS['worktree.merge_requested'];
    expect(() => schema.parse(claim!.data)).not.toThrow();
    expect(() => schema.parse({ ...claim!.data, holderStartedAt: '' })).toThrow();
  });

  /**
   * The release event must carry the required `status`. It must not carry
   * `sourceBranch`, which only the claim has. Then the stored event matches the
   * release schema.
   */
  it('SerializeMerge_Release_EmitsSchemaValidStatus_NoStraySourceBranch', async () => {
    const arm = await createArm();
    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F', integrationRef: 'integration/release', sourceBranch: 'feat/y', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      {
        selfPid: 777,
        selfStartedAt: 'self-777',
        mergeOrchestrate: recordingMerge(merged),
        readIntegrationHead: () => null,
      },
    );
    expect(result.success).toBe(true);

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const release = events.find((e) => e.type === 'worktree.merge_executed');
    expect(release).toBeDefined();
    const data = release!.data as Record<string, unknown>;
    expect(data.status).toBe('merged');
    expect('sourceBranch' in data).toBe(false);
    expect(() => EVENT_DATA_SCHEMAS['worktree.merge_executed'].parse(data)).not.toThrow();
  });
});

describe('serialize_merge — dispatch wiring', () => {
  /**
   * The dispatch omits required fields, so the handler returns `INVALID_INPUT`.
   * An `UNKNOWN_ACTION` means that the action is missing from the dispatch table.
   */
  it('HandleOrchestrate_SerializeMerge_RoutesToHandler_NotUnknownAction', async () => {
    const arm = await createArm();
    const result = await handleOrchestrate(
      { action: 'serialize_merge', featureId: 'F' },
      arm.ctx,
    );
    expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});

describe('serialize_merge — bounded wait + reclamation', () => {
  /** The injected sleep advances a fake clock, so the deadline is deterministic. The live holder keeps the slot. */
  it('SerializeMerge_LiveHolderPastDeadline_ReturnsMergeSlotTimeout', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/timeout';
    await seedHolder(arm, {
      integrationRef,
      operationId: 'live-holder-op',
      sourceBranch: 'feat/held',
      holderPid: 777,
      holderStartedAt: 'alive-777',
    });

    let clock = 0;
    const result = await serializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/x', strategy: 'merge', timeoutMs: 1000 },
      arm.ctx,
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pollIntervalMs: 200,
        processTableSource: liveTable([{ pid: 777, startTime: 'alive-777' }]),
        mergeOrchestrate: async () => {
          throw new Error('merge_orchestrate must NOT run on a timed-out slot');
        },
        readIntegrationHead: () => null,
        selfPid: 111,
        selfStartedAt: 'self-111',
      },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_SLOT_TIMEOUT');
    expect((result.data as { reason?: string }).reason).toBe('merge-slot-timeout');
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]?.operationId).toBe('live-holder-op');
  });

  /**
   * The holder PID is absent from a supported empty table, so the holder is dead.
   * The lease reclaims it with no wait. The release of the dead holder carries its
   * own `operationId`, and the slot ends clear.
   */
  it('SerializeMerge_DeadHolder_ReclaimedInline_ThenClaimsAndMerges', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/dead';
    await seedHolder(arm, {
      integrationRef,
      operationId: 'dead-holder-op',
      sourceBranch: 'feat/dead',
      holderPid: 4242,
      holderStartedAt: 'gone',
    });

    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/live', strategy: 'merge', timeoutMs: 5000 },
      arm.ctx,
      {
        processTableSource: EMPTY_TABLE,
        sleep: async () => {
          throw new Error('reclamation should clear the slot without waiting');
        },
        mergeOrchestrate: recordingMerge(merged),
        readIntegrationHead: () => null,
        selfPid: 111,
        selfStartedAt: 'self-111',
      },
    );

    expect(result.success).toBe(true);
    expect(merged).toEqual(['F']);

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const deadRelease = events.find(
      (e) => e.type === 'worktree.merge_executed' && e.data?.operationId === 'dead-holder-op',
    );
    expect(deadRelease).toBeDefined();
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

describe('handleSerializeMerge — input guards', () => {
  it('HandleSerializeMerge_MissingStrategy_RejectsInvalidInput', async () => {
    const arm = await createArm();
    const result = await handleSerializeMerge(
      { featureId: 'F', integrationRef: 'main', sourceBranch: 'feat/x' },
      arm.ctx,
      { mergeOrchestrate: recordingMerge([]), readIntegrationHead: () => null, selfPid: 1, selfStartedAt: 's' },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/strategy/i);
  });
});

/** A passing preflight result. The lease guard of `merge_orchestrate` runs before the preflight. */
const GUARD_PASSING_PREFLIGHT: MergePreflightResult = {
  passed: true,
  ancestry: { passed: true, checks: ['ancestry'] },
  currentBranchProtection: { blocked: false, currentBranch: 'feat/x' },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: { clean: true, uncommittedFiles: [], indexStale: false, detachedHead: false },
};

/** A `gitExec` that fails each call, so the git worktree probe of `merge_orchestrate` finds nothing. */
const GUARD_NO_GIT: GitExec = () => ({ exitCode: 1, stdout: '', stderr: '' });

/**
 * A `mergeOrchestrate` dep that runs the real `handleMergeOrchestrate` and its
 * lease guard, with stubs for the preflight, the executor, and git. The guard
 * reads `table`. The dep records the `leaseOperationId` that the caller passes.
 */
function realMergeCapturingLease(
  captured: { leaseOperationId?: string },
  table: ProcessTableSource,
): (input: HandleMergeOrchestrateInput, ctx: DispatchContext) => Promise<ToolResult> {
  return async (input, ctx) => {
    captured.leaseOperationId = input.leaseOperationId;
    return handleMergeOrchestrate(
      {
        ...input,
        preflight: async () => GUARD_PASSING_PREFLIGHT,
        executeMerge: async () => ({
          success: true,
          data: {
            phase: 'completed' as const,
            mergeSha: 'a'.repeat(40),
            recoveryPointSha: 'b'.repeat(40),
          },
        }),
        gitExec: GUARD_NO_GIT,
        processTableSource: table,
      },
      ctx,
    );
  };
}

/**
 * `merge_orchestrate` fails closed when another live holder has the lease on the
 * target ref. The serializer holds its own lease first, so it must pass that
 * `operationId` as `leaseOperationId`. Otherwise the guard blocks the own claim
 * of the serializer as a foreign holder.
 */
describe('serialize_merge — DR-2 lease threading through the guard', () => {
  /**
   * The guard table reads the identity of the serializer as alive, so a missing
   * `leaseOperationId` fails closed. The passed value must equal the
   * `operationId` of the claim.
   */
  it('SerializeMerge_OwnLeaseThreadedThroughComposedCall_PassesGuard', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/own-lease';
    const captured: { leaseOperationId?: string } = {};
    const table = liveTable([{ pid: 222, startTime: 'self-222' }]);

    const result = await serializeMerge(
      { featureId: 'F', integrationRef, sourceBranch: 'feat/mine', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      {
        selfPid: 222,
        selfStartedAt: 'self-222',
        processTableSource: table,
        mergeOrchestrate: realMergeCapturingLease(captured, table),
        readIntegrationHead: () => null,
      },
    );

    expect(result.success).toBe(true);

    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const claim = events.find((e) => e.type === 'worktree.merge_requested');
    expect(claim).toBeDefined();
    const claimOpId = (claim!.data as { operationId: string }).operationId;
    expect(captured.leaseOperationId).toBe(claimOpId);
    expect(typeof captured.leaseOperationId).toBe('string');
  });
});
