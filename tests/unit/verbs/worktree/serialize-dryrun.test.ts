// `serialize_merge` defaults to a dry run, which claims no lease and runs no merge.
// The suite checks three facts:
// - The dispatch default claims no lease and returns the planned effect.
// - The composed integration-merge caller `LauncherWlm` still runs a real merge.
// - `acquire_worktree` refuses the reserve with a structured error when the
//   adopt gate finds that the target worktree is not mutable.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import { handleSerializeMerge, handleAcquireWorktree } from '../../../../src/verbs/worktree/handlers.js';
import { createLauncherWlm } from '../../../../src/runtime/launcher/wlm-compose.js';
import type { GitWorktreeProbe } from '../../../../src/verbs/worktree/manager.js';
import type { ProcessSource } from '../../../../src/verbs/worktree/pure/process-identity.js';
import type { ProcessTableSource } from '../../../../src/verbs/worktree/pure/probe.js';
import type { HandleMergeOrchestrateInput } from '../../../../src/verbs/merge/merge-orchestrate.js';

const FIXED_SOURCE: ProcessSource = {
  getStartTime: () => ({ status: 'present', startedAt: 'fixed-start' }),
};

/** A supported process table in which the claiming self PID is alive, so nothing is reclaimed. */
const SELF_ALIVE_TABLE: ProcessTableSource = {
  list: () => [{ pid: 4242, ppid: 1, cwd: '/', startTime: 'fixed-start' }],
  isSupported: () => true,
};

/** A merge-orchestrate dep that records each call and returns a fixed success. */
function recordingMerge(calls: HandleMergeOrchestrateInput[]) {
  return async (input: HandleMergeOrchestrateInput): Promise<ToolResult> => {
    calls.push(input);
    return { success: true, data: { phase: 'completed', mergeSha: 'cafef00d' } };
  };
}

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

async function createArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm6-t002-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, eventStore, ctx: { stateDir, eventStore, enableTelemetry: false } };
}

async function leaseEvents(store: EventStore): Promise<string[]> {
  const events = await store.query(WORKTREES_STREAM);
  return events.map((e) => e.type).filter((t) => t.startsWith('worktree.merge_'));
}

describe('serialize_merge — DR-1 dry-run default', () => {
  let arms: Arm[] = [];
  afterEach(async () => {
    for (const arm of arms) await rmrfAsync(arm.stateDir);
    arms = [];
  });
  async function nextArm(): Promise<Arm> {
    const arm = await createArm();
    arms.push(arm);
    return arm;
  }

  it('SerializeMerge_DefaultDryRun_ClaimsNoLease', async () => {
    const arm = await nextArm();
    const calls: HandleMergeOrchestrateInput[] = [];

    const result = await handleSerializeMerge(
      { featureId: 'F', integrationRef: 'main', sourceBranch: 'feat/x', strategy: 'squash' },
      arm.ctx,
      {
        mergeOrchestrate: recordingMerge(calls),
        readIntegrationHead: () => 'deadbeef',
        processSource: FIXED_SOURCE,
        processTableSource: SELF_ALIVE_TABLE,
      },
    );

    expect(result.success).toBe(true);
    const data = result.data as { dryRun?: boolean; integrationHead?: string | null };
    expect(data.dryRun).toBe(true);
    expect(data.integrationHead).toBe('deadbeef');
    expect(calls).toHaveLength(0);
    expect(await leaseEvents(arm.eventStore)).toEqual([]);
  });

  it('SerializeMerge_ExplicitDryRunFalse_ClaimsLeaseAndMerges', async () => {
    const arm = await nextArm();
    const calls: HandleMergeOrchestrateInput[] = [];

    const result = await handleSerializeMerge(
      { featureId: 'F', integrationRef: 'main', sourceBranch: 'feat/x', strategy: 'squash', dryRun: false },
      arm.ctx,
      {
        mergeOrchestrate: recordingMerge(calls),
        readIntegrationHead: () => 'deadbeef',
        processSource: FIXED_SOURCE,
        processTableSource: SELF_ALIVE_TABLE,
        selfPid: 4242,
        selfStartedAt: 'fixed-start',
      },
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await leaseEvents(arm.eventStore)).toEqual([
      'worktree.merge_requested',
      'worktree.merge_executed',
    ]);
  });

  /**
   * `LauncherWlm.serializeIntegrationMerge` must run a real merge. The caller
   * passes no `dryRun`, and the composition sets `dryRun: false`.
   */
  it('SerializeMerge_ComposedCaller_StillExecutesMerge', async () => {
    const arm = await nextArm();
    const calls: HandleMergeOrchestrateInput[] = [];
    const wlm = createLauncherWlm({ ctx: arm.ctx });

    const result = await wlm.serializeIntegrationMerge(
      { featureId: 'F', integrationRef: 'main', sourceBranch: 'feat/x', strategy: 'squash' },
      {
        mergeOrchestrate: recordingMerge(calls),
        readIntegrationHead: () => 'deadbeef',
        processSource: FIXED_SOURCE,
        processTableSource: SELF_ALIVE_TABLE,
        selfPid: 4242,
        selfStartedAt: 'fixed-start',
      },
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].featureId).toBe('F');
    expect(await leaseEvents(arm.eventStore)).toEqual([
      'worktree.merge_requested',
      'worktree.merge_executed',
    ]);
  });
});

/** The `probeWith` helper returns a git probe that lists only `wtPath`, with the given mutability verdict. */
describe('acquire_worktree — mutable-as-hard-gate (DR-1)', () => {
  let arms: Arm[] = [];
  afterEach(async () => {
    for (const arm of arms) await rmrfAsync(arm.stateDir);
    arms = [];
  });
  async function nextArm(): Promise<Arm> {
    const arm = await createArm();
    arms.push(arm);
    return arm;
  }

  function probeWith(wtPath: string, mutable: boolean): GitWorktreeProbe {
    return {
      listWorktrees: () => [{ path: wtPath, head: 'abc123', branch: 'feat', detached: false, bare: false }],
      verifyHead: () => ({
        head: 'abc123',
        upstream: mutable ? null : 'def456',
        mutable,
        reason: mutable ? 'no-upstream' : 'stale-after-push',
      }),
    };
  }

  /** The identity realpath keeps the canonical `worktreeId` of the adopt report equal to `wtPath`. */
  it('AcquireWorktree_NotMutable_RefusesReserve', async () => {
    const arm = await nextArm();
    const wtPath = '/wlm6/stale-wt';

    const result = await handleAcquireWorktree(
      { repoRoot: '/wlm6/repo', worktreeId: wtPath },
      arm.ctx,
      { gitProbe: probeWith(wtPath, false), processSource: FIXED_SOURCE, realpath: (p) => p },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WORKTREE_NOT_MUTABLE');
    expect(result.error?.message).toMatch(/stale-after-push/);
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(events.map((e) => e.type)).not.toContain('worktree.reserved');
  });

  /** A mutable worktree still reserves, so the gate refuses only the stale case. */
  it('AcquireWorktree_Mutable_ReservesAsBefore', async () => {
    const arm = await nextArm();
    const wtPath = '/wlm6/fresh-wt';

    const result = await handleAcquireWorktree(
      { repoRoot: '/wlm6/repo', worktreeId: wtPath },
      arm.ctx,
      { gitProbe: probeWith(wtPath, true), processSource: FIXED_SOURCE, realpath: (p) => p },
    );

    expect(result.success).toBe(true);
    expect((result.data as { reserved?: boolean }).reserved).toBe(true);
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(events.map((e) => e.type)).toContain('worktree.reserved');
  });
});
