// ─── serialize_merge — integration-branch merge lease tests (DR-7) ────────────
//
// The optimistic lease: at most one in-flight merge per `integrationRef`,
// composing `merge_orchestrate` UNCHANGED. Concurrency tests run against a real
// SQLite EventStore (the substrate's in-transaction stream-version gate is the
// cross-process guard); the composition test runs the REAL merge over two real
// temp git repos so the per-featureId `merge.*` events are compared modulo the
// commit-derived SHAs. Every behavioral test drives the handler / lease with
// deterministic injected seams (no real timers, no OS process probe); the
// routing test drives `handleOrchestrate` so a missing dispatch wiring goes red.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { writeStateFile } from '../../workflow/state-store.js';
import type { ToolResult } from '../../format.js';

import { handleOrchestrate } from '../composite.js';
import { handleMergeOrchestrate } from '../merge-orchestrate.js';
import { serializeMerge } from './merge-serializer.js';
import { handleSerializeMerge } from './handlers.js';
import { WORKTREES_STREAM, WORKTREES_REDUCER } from './manager.js';
import type { WorktreesProjection } from './projections/worktrees.js';
import type { ProcessTableSource, ProcessRecord } from './pure/probe.js';
import type { SleepFn } from './git-retry.js';

// ─── Arm: one stateDir + EventStore + ctx ────────────────────────────────────

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
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Live process table reporting exactly the listed (pid, startTime) pairs alive. */
function liveTable(pairs: ReadonlyArray<{ pid: number; startTime: string }>): ProcessTableSource {
  const records: ProcessRecord[] = pairs.map(({ pid, startTime }) => ({
    pid,
    ppid: 1,
    cwd: `/proc-fixture/${pid}`,
    startTime,
  }));
  return { list: () => records };
}

/** Empty process table — every probed pid reads as absent (provably dead). */
const EMPTY_TABLE: ProcessTableSource = { list: () => [] };

/** A merge_orchestrate stub that records the featureIds it ran for. */
function recordingMerge(into: string[]): (input: { featureId: string }) => Promise<ToolResult> {
  return async (input) => {
    into.push(input.featureId);
    return { success: true, data: { phase: 'completed' } };
  };
}

/** Directly seed a held lease (CLAIM) on the worktrees stream. */
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

// ─── Real-git helpers (composition test) ─────────────────────────────────────

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * A repo where `main` (the integration ref) IS an ancestor of `feat` (the
 * source): main@A, feat@A→C. HEAD is left on `feat` (a non-protected branch) so
 * merge-preflight passes — ancestry, current-branch, main-worktree, drift all
 * clean — and `git merge --no-ff feat` lands a clean merge commit on main.
 */
function setupMergeableRepo(): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'wlm-serialize-repo-'));
  repoDirs.push(repoRoot);
  git(repoRoot, ['init', '--initial-branch=main', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repoRoot, 'a.txt'), 'A\n');
  git(repoRoot, ['add', 'a.txt']);
  git(repoRoot, ['commit', '-m', 'A', '-q']);
  git(repoRoot, ['checkout', '-b', 'feat', '-q']);
  writeFileSync(path.join(repoRoot, 'c.txt'), 'C\n');
  git(repoRoot, ['add', 'c.txt']);
  git(repoRoot, ['commit', '-m', 'C', '-q']);
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

/** Normalize a `merge.*` event to its stable (non-volatile, non-SHA) projection. */
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

// ─── Test 1: second claimant waits for the first's release before claiming ────

describe('serialize_merge — single-writer ordering', () => {
  it('SerializeMerge_TwoFeatureIdsSameBranch_SecondWaitsForFirstExecutedBeforeClaiming', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/main';
    const f1OpId = 'f1-holder-op';

    // F1 holds the lease under a LIVE pid (999).
    await seedHolder(arm, {
      integrationRef,
      operationId: f1OpId,
      sourceBranch: 'feat/1',
      holderPid: 999,
      holderStartedAt: 'alive-999',
    });

    // The injected sleep releases F1 on its FIRST call, so F2 must wait at least
    // one poll iteration and can only claim AFTER F1's worktree.merge_executed.
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
    expect(sleepCalls).toBeGreaterThanOrEqual(1); // F2 blocked at least once.

    // Ordering: F2's CLAIM lands strictly AFTER F1's RELEASE.
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const f1ExecIdx = events.findIndex(
      (e) => e.type === 'worktree.merge_executed' && e.data?.operationId === f1OpId,
    );
    const f2ReqIdx = events.findIndex(
      (e) => e.type === 'worktree.merge_requested' && e.data?.operationId !== f1OpId,
    );
    expect(f1ExecIdx).toBeGreaterThanOrEqual(0);
    expect(f2ReqIdx).toBeGreaterThan(f1ExecIdx);

    // The lease is released at the end — no in-flight merge remains.
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

// ─── Test 2: concurrent claims resolve to a single holder (real-SQLite, x-proc)─

describe('serialize_merge — cross-process OCC', () => {
  it('SerializeMerge_ConcurrentClaims_OccResolvesSingleHolderCrossProcess', async () => {
    // TWO EventStores over the SAME db file = two appenders / two SQLite handles
    // = a genuine cross-process race resolved by the in-txn stream-version gate.
    const armA = await createArm();
    const armB = await createArm(armA.stateDir);
    const integrationRef = 'integration/shared';

    // The composed merge asserts non-overlap: if serialization broke and both
    // claims won, two merges would run concurrently and maxActive would reach 2.
    let active = 0;
    let maxActive = 0;
    const merged: string[] = [];
    const mergeOrchestrate = async (input: { featureId: string }): Promise<ToolResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Hold the lease across the loser's OCC-conflict retry window (its
      // withStateRetry backoff is ~50ms): a winner that releases too fast would
      // let the loser re-claim a FREE slot, masking a broken in-closure guard.
      // Holding makes the loser's retry fold the LIVE holder, so a removed guard
      // commits a second claim (active-claim counter → 2) and the log invariant
      // below goes red.
      await new Promise((r) => setTimeout(r, 120));
      active -= 1;
      merged.push(input.featureId);
      return { success: true, data: { phase: 'completed' } };
    };

    // The loser polls a MACROTASK so it never starves the winner's setImmediate.
    const sleep: SleepFn = () => new Promise((r) => setImmediate(r));
    // Both claimants' pids read alive, so neither reclaims the other's live lease.
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
    expect(maxActive).toBe(1); // never two in-flight merges at once (wall-clock).
    expect([...merged].sort()).toEqual(['F-A', 'F-B']);

    // Exactly one CLAIM + one RELEASE per featureId, slot ends clear.
    const events = await armA.eventStore.query(WORKTREES_STREAM);
    const claims = events.filter((e) => e.type === 'worktree.merge_requested');
    const releases = events.filter((e) => e.type === 'worktree.merge_executed');
    expect(claims).toHaveLength(2);
    expect(releases).toHaveLength(2);
    expect((await foldWorktrees(armA)).inFlightMerges[integrationRef]).toBeUndefined();

    // DETERMINISTIC single-writer invariant on the COMMITTED log order: walk the
    // worktrees stream maintaining an active-claim counter (+1 on a claim, -1 on
    // a release). It must NEVER exceed 1 — two adjacent claims with no intervening
    // release for the same ref is exactly the double-claim a broken in-closure OCC
    // guard would produce (and is independent of wall-clock interleaving).
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

// ─── Test 3: merge_orchestrate composed UNCHANGED (real git, modulo SHAs) ─────

describe('serialize_merge — composition', () => {
  it('SerializeMerge_MergeOrchestrateComposedUnchanged_FeatureStreamEventsMatchModuloVolatileAndShas', async () => {
    const featureId = 'feat-compose';

    // (1) Serialized path — through handleOrchestrate, production defaults.
    const repoSerial = setupMergeableRepo();
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
      },
      armSerial.ctx,
    );
    expect(serialResult.success).toBe(true);

    // (2) Direct path — handleMergeOrchestrate on an EQUIVALENT independent repo.
    const repoDirect = setupMergeableRepo();
    const armDirect = await createArm();
    await seedFeatureState(armDirect.stateDir, featureId);
    const directResult = await handleMergeOrchestrate(
      { featureId, sourceBranch: 'feat', targetBranch: 'main', strategy: 'merge', repoRoot: repoDirect },
      armDirect.ctx,
    );
    expect(directResult.success).toBe(true);

    // The per-featureId `merge.*` timeline matches modulo id/timestamp/sequence
    // AND the commit-derived SHAs (independent repos → different SHAs/paths).
    const serialMerge = (await armSerial.eventStore.query(featureId))
      .filter((e) => e.type.startsWith('merge.'))
      .map(normalizeMergeEvent);
    const directMerge = (await armDirect.eventStore.query(featureId))
      .filter((e) => e.type.startsWith('merge.'))
      .map(normalizeMergeEvent);

    expect(serialMerge.length).toBeGreaterThan(0);
    expect(serialMerge).toEqual(directMerge);
    // The serializer adds NO events to the feature stream (only worktrees stream).
    expect(serialMerge.map((e) => e.type)).toContain('merge.executed');
  });
});

// ─── Test 4: release is a plain keyed append, NOT CAS-pinned to the claim seq ─

describe('serialize_merge — release semantics', () => {
  it('SerializeMerge_ReleaseIsPlainKeyedAppend_NotCasPinnedToClaimSeq', async () => {
    const arm = await createArm();
    const integrationRef = 'integration/release';
    const appender = arm.eventStore.getAppender();
    const appendSpy = vi.spyOn(appender, 'append');

    // The composed merge ADVANCES the worktrees stream with an unrelated event,
    // so the tail moves PAST the claim seq before the release append runs. A
    // CAS-pin to the claim seq would conflict here; a plain keyed append does not.
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

    // The RELEASE append carried NO AppendOptions (no expectedSequence pin).
    const releaseCall = appendSpy.mock.calls.find((c) => {
      const events = c[1] as Array<{ type: string }>;
      return events[0]?.type === 'worktree.merge_executed';
    });
    expect(releaseCall).toBeDefined();
    expect(releaseCall![3]).toBeUndefined(); // 4th arg = AppendOptions → absent.

    // Behavioral proof: the release CLEARED the slot despite the advanced tail.
    const fold = await foldWorktrees(arm);
    expect(fold.inFlightMerges[integrationRef]).toBeUndefined();
    // The unrelated event really did advance the stream between claim and release.
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const adoptIdx = events.findIndex((e) => e.type === 'worktree.adopted');
    const releaseIdx = events.findIndex((e) => e.type === 'worktree.merge_executed');
    expect(adoptIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(adoptIdx);
  });
});

// ─── Test 5: no lock file written, no flock library imported ──────────────────

describe('serialize_merge — the lease IS the serialization', () => {
  it('SerializeMerge_WritesNoLockFile_ImportsNoFlockLib', async () => {
    // (a) Static: the serializer imports NO advisory-lock library and uses NO
    // flock / .lock filesystem API. Strip comments first so the module's own
    // prose ("no flock / .lock") cannot false-positive.
    const sourcePath = fileURLToPath(new URL('./merge-serializer.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf-8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keep "://" in URLs)
    const importSpecifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of importSpecifiers) {
      expect(spec.toLowerCase()).not.toContain('lock');
    }
    expect(code).not.toMatch(/flockSync|O_EXLOCK|proper-lockfile|lockfile|\.lock\b/i);

    // (b) Behavioral: a full lease cycle writes NO `*.lock` file under stateDir.
    const arm = await createArm();
    const merged: string[] = [];
    const result = await serializeMerge(
      { featureId: 'F', integrationRef: 'integration/nolock', sourceBranch: 'feat/x', strategy: 'merge', timeoutMs: 10_000 },
      arm.ctx,
      { mergeOrchestrate: recordingMerge(merged), readIntegrationHead: () => null, selfPid: 444, selfStartedAt: 'self-444' },
    );
    expect(result.success).toBe(true);

    const lockFiles = execFileSync('find', [arm.stateDir, '-name', '*.lock'], { encoding: 'utf-8' }).trim();
    expect(lockFiles).toBe('');
  });
});

// ─── Test 6: handleOrchestrate routes serialize_merge to the handler ──────────

describe('serialize_merge — dispatch wiring', () => {
  it('HandleOrchestrate_SerializeMerge_RoutesToHandler_NotUnknownAction', async () => {
    const arm = await createArm();
    // Dispatch with a MISSING required field: routing to the handler surfaces a
    // structured INVALID_INPUT (the handler's own validation), NOT UNKNOWN_ACTION
    // (which would mean the action fell through the dispatch table — the DOA class).
    const result = await handleOrchestrate(
      { action: 'serialize_merge', featureId: 'F' }, // integrationRef/sourceBranch/strategy missing
      arm.ctx,
    );
    expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});

// ─── Bonus: bounded-wait timeout + dead-holder inline reclamation ─────────────

describe('serialize_merge — bounded wait + reclamation', () => {
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

    // A fake clock advanced by the injected sleep makes the deadline deterministic.
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
        processTableSource: liveTable([{ pid: 777, startTime: 'alive-777' }]), // holder stays alive.
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
    // The live holder still holds the slot (we never reclaimed it).
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]?.operationId).toBe('live-holder-op');
  });

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
        processTableSource: EMPTY_TABLE, // pid 4242 absent → provably dead.
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

    // The dead holder was reclaimed inline — its terminal release rode its OWN
    // operationId (the documented correlation, even for recovery releases).
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    const deadRelease = events.find(
      (e) => e.type === 'worktree.merge_executed' && e.data?.operationId === 'dead-holder-op',
    );
    expect(deadRelease).toBeDefined();
    // Slot ends clear (our own claim released too).
    expect((await foldWorktrees(arm)).inFlightMerges[integrationRef]).toBeUndefined();
  });
});

// ─── Handler-level input validation ───────────────────────────────────────────

describe('handleSerializeMerge — input guards', () => {
  it('HandleSerializeMerge_MissingStrategy_RejectsInvalidInput', async () => {
    const arm = await createArm();
    const result = await handleSerializeMerge(
      { featureId: 'F', integrationRef: 'main', sourceBranch: 'feat/x' }, // strategy missing
      arm.ctx,
      { mergeOrchestrate: recordingMerge([]), readIntegrationHead: () => null, selfPid: 1, selfStartedAt: 's' },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/strategy/i);
  });
});
