/**
 * Handler-level tests for the worktree read views: `worktrees`, the worktree scope of `ps`, and the
 * `until` scope of `wait`. Each test seeds rows of old logs on the singleton `worktrees` stream, because
 * no code writes that stream now. The tests run over a real EventStore with fake clock seams.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import { WORKTREES_STREAM, handleViewWorktrees } from '../../../../src/verbs/worktree/handlers.js';
import type { InFlightMerge, InFlightPrune, WorktreeEntry } from '../../../../src/verbs/worktree/projections/worktrees.js';
import { callCli, callMcp } from '../../parity-harness.js';
import { extractSchemaFields } from '../../../../src/adapters/cli/schema-to-flags.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

const arms: Arm[] = [];

async function createArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-handlers-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  const arm = { stateDir, ctx };
  arms.push(arm);
  return arm;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (arms.length > 0) {
    const arm = arms.pop();
    if (arm) await rmrfAsync(arm.stateDir);
  }
});

/** Seed a CLAIM (`worktree.merge_requested`) directly on the singleton stream. */
async function seedMergeRequested(
  arm: Arm,
  holder: {
    integrationRef: string;
    operationId: string;
    sourceBranch: string;
    holderPid: number;
    holderStartedAt: string;
  },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'worktree.merge_requested', data: { ...holder } },
    { idempotencyKey: `worktree.merge_requested:${holder.operationId}` },
  );
}

/** Seed a RELEASE (`worktree.merge_executed`) clearing the slot for `op`. */
async function seedMergeExecuted(
  arm: Arm,
  ref: { integrationRef: string; operationId: string; sourceBranch: string },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'worktree.merge_executed', data: { ...ref } },
    { idempotencyKey: `worktree.merge_executed:${ref.operationId}` },
  );
}

/** Seed a CLAIM (`prune.executing_started`) of a pass of the retired prune GC. */
async function seedPruneStarted(
  arm: Arm,
  p: { operationId: string; repoRoot: string; holderPid: number; holderStartedAt: string },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'prune.executing_started', data: { ...p } },
    { idempotencyKey: `prune.executing_started:${p.operationId}` },
  );
}

/** Seed the paired TERMINAL (`prune.executed`) clearing the prune for `op`. */
async function seedPruneExecuted(
  arm: Arm,
  p: { operationId: string; deletedCount: number },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'prune.executed', data: { ...p } },
    { idempotencyKey: `prune.executed:${p.operationId}` },
  );
}

/** Seed a reservation (`worktree.reserved`) of an old log for a worktree owned by a PID. */
async function seedReserved(
  arm: Arm,
  r: {
    worktreeId: string;
    path: string;
    ownerPid: number;
    ownerStartedAt: string | null;
    operationId: string;
  },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    {
      type: 'worktree.reserved',
      data: {
        worktreeId: r.worktreeId,
        path: r.path,
        featureId: null,
        ownerPid: r.ownerPid,
        ownerStartedAt: r.ownerStartedAt,
        operationId: r.operationId,
      },
    },
    { idempotencyKey: `worktree.reserved:${r.operationId}` },
  );
}

/** Seed the launch claim (`launch.executing_started`) that the retired launcher wrote. */
async function seedLaunchStarted(
  arm: Arm,
  l: { worktreeId: string; holderPid: number; holderStartedAt: string },
): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'launch.executing_started', data: { ...l, instanceId: l.worktreeId } },
    { idempotencyKey: `launch.executing_started:${l.worktreeId}` },
  );
}

/** Seed the launch terminal (`launch.executed`) that the retired launcher wrote. */
async function seedLaunchExecuted(arm: Arm, l: { worktreeId: string; exitCode: number }): Promise<void> {
  await arm.ctx.eventStore.append(
    WORKTREES_STREAM,
    { type: 'launch.executed', data: { ...l, instanceId: l.worktreeId } },
    { idempotencyKey: `launch.executed:${l.worktreeId}` },
  );
}

/**
 * Each `ps` call passes `scope: 'worktree'`, the scope that returns the worktree liveness fold.
 * The `ps` calls go through `handleView`, so a missing routing arm fails them.
 */
describe('ps — in-flight liveness read (DR-4)', () => {
  /** `ps` lists an in-flight merge from the rows of an old log and appends nothing. */
  it('HandleView_Ps_ListsInFlightFromInFlightMerges_AppendsNothing', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-ps',
      sourceBranch: 'feat/x',
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });
    const before = (await arm.ctx.eventStore.query(WORKTREES_STREAM)).length;

    const result = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);

    expect(result.success).toBe(true);
    const data = result.data as { inFlight: InFlightMerge[]; count: number };
    expect(data.count).toBe(1);
    expect(data.inFlight[0].integrationRef).toBe('main');
    expect(data.inFlight[0].sourceBranch).toBe('feat/x');
    expect((await arm.ctx.eventStore.query(WORKTREES_STREAM)).length).toBe(before);
  });

  /**
   * The retired launcher reserved its worktree, and then a child started.
   * `ps` shows the launch from the old rows, and clears it after `launch.executed` folds.
   */
  it('HandleView_Ps_SurfacesInFlightLaunches_ClearedByTerminal', async () => {
    const arm = await createArm();
    await seedReserved(arm, {
      worktreeId: '/wlm/launch-wt',
      path: '/wlm/launch-wt',
      ownerPid: 4242,
      ownerStartedAt: 'boot-4242',
      operationId: 'op-launch',
    });
    await seedLaunchStarted(arm, {
      worktreeId: '/wlm/launch-wt',
      holderPid: 7777,
      holderStartedAt: 'boot-7777',
    });

    const inFlightResult = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);
    expect(inFlightResult.success).toBe(true);
    const inFlightData = inFlightResult.data as {
      launches: WorktreeEntry[];
      launchCount: number;
    };
    expect(inFlightData.launchCount).toBe(1);
    expect(inFlightData.launches[0].worktreeId).toBe('/wlm/launch-wt');
    expect(inFlightData.launches[0].launch).toEqual({
      holderPid: 7777,
      holderStartedAt: 'boot-7777',
    });

    await seedLaunchExecuted(arm, { worktreeId: '/wlm/launch-wt', exitCode: 0 });
    const clearedResult = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);
    const clearedData = clearedResult.data as {
      launches: WorktreeEntry[];
      launchCount: number;
    };
    expect(clearedData.launchCount).toBe(0);
    expect(clearedData.launches).toEqual([]);
  });

  /**
   * The supervisor died with no teardown, so no `launch.executed` exists. `ps` is a read. No action
   * heals the entry, so the launch reads as in flight on every call and the stream gains no row.
   */
  it('HandleView_Ps_PhantomLaunch_StaysInFlightAndHealsNothing', async () => {
    const arm = await createArm();
    await seedReserved(arm, {
      worktreeId: '/wlm/phantom-launch-wt',
      path: '/wlm/phantom-launch-wt',
      ownerPid: 8881,
      ownerStartedAt: 'boot-8881',
      operationId: 'op-phantom',
    });
    await seedLaunchStarted(arm, {
      worktreeId: '/wlm/phantom-launch-wt',
      holderPid: 8882,
      holderStartedAt: 'boot-8882',
    });
    const before = (await arm.ctx.eventStore.query(WORKTREES_STREAM)).length;

    const first = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);
    const second = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);

    expect((first.data as { launchCount: number }).launchCount).toBe(1);
    expect((second.data as { launchCount: number }).launchCount).toBe(1);
    expect((await arm.ctx.eventStore.query(WORKTREES_STREAM)).length).toBe(before);
  });
});

/** The `worktrees` view folds old reservation rows and keeps a null create time as `null`. */
describe('worktrees — governed set read of old logs', () => {
  it('HandleViewWorktrees_ReservedRowWithNullStartTime_FoldsNullNeverEmptyString', async () => {
    const arm = await createArm();
    await seedReserved(arm, {
      worktreeId: '/tmp/wlm-h-nullstart',
      path: '/tmp/wlm-h-nullstart',
      ownerPid: 4242,
      ownerStartedAt: null,
      operationId: 'op-null',
    });

    const view = await handleViewWorktrees({}, arm.ctx);

    expect(view.success).toBe(true);
    const worktrees = (view.data as { worktrees: WorktreeEntry[] }).worktrees;
    const entry = worktrees.find((w) => w.worktreeId === '/tmp/wlm-h-nullstart');
    expect(entry?.state).toBe('reserved');
    expect(entry?.ownerStartedAt).toBeNull();
  });
});

describe('wait — caller-bounded merge-terminal poll (DR-4)', () => {
  /** With no holder, the slot is already terminal, so the wait resolves on the first fold with no sleep. */
  it('HandleView_Wait_AlreadyTerminal_ResolvesImmediately', async () => {
    const arm = await createArm();
    const sleep = vi.fn(async () => {});

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 5_000 },
      arm.ctx,
      { sleep },
    );

    expect(result.success).toBe(true);
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  /** The injected sleep clears the slot on its first call, so the next fold resolves with no real timer. */
  it('HandleView_Wait_InFlightThenTerminal_ResolvesWithinTimeout', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-wait',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await seedMergeExecuted(arm, {
          integrationRef: 'main',
          operationId: 'op-wait',
          sourceBranch: 'feat/x',
        });
      }
    });

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 10_000 },
      arm.ctx,
      { sleep },
    );

    expect(result.success).toBe(true);
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  /** Each instant sleep moves the clock past the deadline, so the poll ends with a structured timeout. */
  it('HandleView_Wait_Timeout_ReturnsStructuredTimeoutNotHang', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-stuck',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let t = 0;
    const now = (): number => t;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 100 },
      arm.ctx,
      { now, sleep, pollIntervalMs: 200 },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_TIMEOUT');
    const data = result.data as {
      reason: string;
      integrationRef: string;
      timeoutMs: number;
    };
    expect(data.reason).toBe('wait-timeout');
    expect(data.integrationRef).toBe('main');
    expect(data.timeoutMs).toBe(100);
  });

  /** The injected sleep clears the slot on the first poll, so the wait creates no real `setTimeout` or `setInterval`. */
  it('Wait_NoBackgroundTimer_SetIntervalSpyZeroCalls', async () => {
    const arm = await createArm();
    await seedMergeRequested(arm, {
      integrationRef: 'main',
      operationId: 'op-timer',
      sourceBranch: 'feat/x',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const beforeInterval = setIntervalSpy.mock.calls.length;
    const beforeTimeout = setTimeoutSpy.mock.calls.length;

    const sleep = vi.fn(async () => {
      await seedMergeExecuted(arm, {
        integrationRef: 'main',
        operationId: 'op-timer',
        sourceBranch: 'feat/x',
      });
    });

    const result = await handleView(
      { action: 'wait', integrationRef: 'main', timeoutMs: 10_000 },
      arm.ctx,
      { sleep },
    );
    expect(result.success).toBe(true);

    expect(setIntervalSpy.mock.calls.length - beforeInterval).toBe(0);
    expect(setTimeoutSpy.mock.calls.length - beforeTimeout).toBe(0);
  });
});

/** The merge wait reads only own claims, so a ref named like an `Object.prototype` member is not blocked by an inherited value. */
describe('wait — prototype-named integration refs', () => {
  /** With no claim, a ref such as `constructor` or `__proto__` resolves on the first fold with no sleep. */
  it.each(['constructor', '__proto__', 'toString'])(
    'HandleView_Wait_PrototypeNamedRef_%s_ResolvesImmediately',
    async (integrationRef) => {
      const arm = await createArm();
      const sleep = vi.fn(async () => {});

      const result = await handleView(
        { action: 'wait', integrationRef, timeoutMs: 5_000 },
        arm.ctx,
        { sleep },
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ integrationRef, resolved: true });
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  /** A real claim on a prototype-named ref still blocks the wait, and the timeout names its holder. */
  it.each(['constructor', '__proto__'])(
    'HandleView_Wait_PrototypeNamedRef_%s_OwnClaimStillBlocks',
    async (integrationRef) => {
      const arm = await createArm();
      await seedMergeRequested(arm, {
        integrationRef,
        operationId: `op-${integrationRef}`,
        sourceBranch: 'feat/x',
        holderPid: 100,
        holderStartedAt: 'boot-100',
      });
      let t = 0;
      const sleep = vi.fn(async (ms: number) => {
        t += ms;
      });

      const result = await handleView(
        { action: 'wait', integrationRef, timeoutMs: 100 },
        arm.ctx,
        { now: () => t, sleep, pollIntervalMs: 200 },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('WAIT_TIMEOUT');
      expect(result.data).toMatchObject({
        integrationRef,
        holder: { operationId: `op-${integrationRef}`, holderPid: 100 },
      });

      const ps = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);
      expect((ps.data as { count: number }).count).toBe(1);
    },
  );
});

/** The `worktrees@v1` projection folds the `prune.executing_started` and `prune.executed` pair into `inFlightPrunes`. */
describe('ps — in-flight prune surface (DR-3)', () => {
  /** `ps` lists the in-flight prune from the fold, and clears it after the terminal folds. */
  it('PruneWorktrees_InFlight_VisibleViaPs', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-prune',
      repoRoot: '/wlm/repo',
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    const result = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);

    expect(result.success).toBe(true);
    const data = result.data as { prunes: InFlightPrune[]; pruneCount: number };
    expect(data.pruneCount).toBe(1);
    expect(data.prunes[0].operationId).toBe('op-prune');
    expect(data.prunes[0].repoRoot).toBe('/wlm/repo');
    expect(data.prunes[0].holderPid).toBe(4242);

    await seedPruneExecuted(arm, { operationId: 'op-prune', deletedCount: 0 });
    const cleared = await handleView({ action: 'ps', scope: 'worktree' }, arm.ctx);
    const clearedData = cleared.data as { prunes: InFlightPrune[]; pruneCount: number };
    expect(clearedData.pruneCount).toBe(0);
    expect(clearedData.prunes).toEqual([]);
  });
});

describe("wait — until: 'idle' prune-idle poll (DR-3)", () => {
  /** The injected sleep appends the prune terminal on its first call, so the next fold finds no in-flight prune and resolves. */
  it('Wait_UntilIdle_ResolvesOnPruneTerminal', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-idle',
      repoRoot: '/wlm/repo',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await seedPruneExecuted(arm, { operationId: 'op-idle', deletedCount: 3 });
      }
    });

    const result = await handleView(
      { action: 'wait', until: 'idle', timeoutMs: 10_000 },
      arm.ctx,
      { sleep },
    );

    expect(result.success).toBe(true);
    const data = result.data as { until: string; resolved: boolean };
    expect(data.until).toBe('idle');
    expect(data.resolved).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  /** The prune pass never ends, so the poll ends with a structured timeout that names the holder. */
  it('Wait_UntilIdle_Timeout_StructuredNotHang', async () => {
    const arm = await createArm();
    await seedPruneStarted(arm, {
      operationId: 'op-stuck-prune',
      repoRoot: '/wlm/repo',
      holderPid: 100,
      holderStartedAt: 'boot-100',
    });

    let t = 0;
    const now = (): number => t;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });

    const result = await handleView(
      { action: 'wait', until: 'idle', timeoutMs: 100 },
      arm.ctx,
      { now, sleep, pollIntervalMs: 200 },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_TIMEOUT');
    const data = result.data as {
      reason: string;
      timeoutMs: number;
      holders: Array<{ operationId: string; repoRoot: string; holderPid: number | null }>;
    };
    expect(data.reason).toBe('wait-idle-timeout');
    expect(data.timeoutMs).toBe(100);
    expect(data.holders).toHaveLength(1);
    expect(data.holders[0].operationId).toBe('op-stuck-prune');
    expect(data.holders[0].repoRoot).toBe('/wlm/repo');
  });
});

describe("wait — until: 'idle' CLI/MCP flag parity (DR-3, task-021)", () => {
  /**
   * The CLI and MCP facades derive `until` from one registry schema, so this pins its enum values and optionality.
   * It then runs `wait until: 'idle'` through both facades with their real deps.
   * The store has no in-flight prune, so the wait resolves on the first fold with no real timer.
   */
  it('WaitSchema_UntilIdleFlag_ParityCliMcp', async () => {
    const waitAction = TOOL_REGISTRY
      .find((t) => t.name === 'exarchos_view')!
      .actions.find((a) => a.name === 'wait')!;
    const untilField = extractSchemaFields(waitAction.schema).find(
      (f) => f.name === 'until',
    );
    expect(untilField).toBeDefined();
    expect(untilField!.type).toBe('enum');
    expect(untilField!.enumValues).toEqual(['merge', 'idle']);
    expect(untilField!.required).toBe(false);

    const cliArm = await createArm();
    const mcpArm = await createArm();

    const { result: cliResult } = await callCli(cliArm.ctx, 'vw', 'wait', {
      until: 'idle',
      timeoutMs: 1_000,
    });
    const mcpResult = await callMcp(mcpArm.ctx, 'exarchos_view', {
      action: 'wait',
      until: 'idle',
      timeoutMs: 1_000,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    const cliData = cliResult.data as { until: string; resolved: boolean };
    const mcpData = mcpResult.data as { until: string; resolved: boolean };
    expect(cliData.until).toBe('idle');
    expect(mcpData.until).toBe('idle');
    expect(cliData.resolved).toBe(true);
    expect(mcpData.resolved).toBe(true);
  });
});
