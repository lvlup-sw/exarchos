// ─── serialize_merge dry-run default + acquire mutable-hard-gate (WLM-6 T002) ─
//
// DR-1 default-flip: serialize_merge now DEFAULTS to dry-run (claims NO lease,
// runs NO merge). This suite pins:
//   1. the dispatch default claims no lease and returns the planned effect;
//   2. the composed integration-merge caller (LauncherWlm) STILL executes a real
//      merge — the default flip must not silently no-op it;
//   3. acquire_worktree REFUSES the reserve when the adopt-gate verified the
//      target worktree is not mutable (a structured error, not a report).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from './manager.js';
import { handleSerializeMerge, handleAcquireWorktree } from './handlers.js';
import { createLauncherWlm } from '../../launcher/wlm-compose.js';
import type { GitWorktreeProbe } from './manager.js';
import type { ProcessSource } from './pure/process-identity.js';
import type { ProcessTableSource } from './pure/probe.js';
import type { HandleMergeOrchestrateInput } from '../merge-orchestrate.js';

// ─── Deterministic injected deps ─────────────────────────────────────────────

const FIXED_SOURCE: ProcessSource = {
  getStartTime: () => ({ status: 'present', startedAt: 'fixed-start' }),
};

/** Supported process table where the claiming self-PID is alive (no reclaim). */
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

    // No dryRun in args → the handler applies the dry-run DEFAULT.
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
    // The composed merge was NOT run…
    expect(calls).toHaveLength(0);
    // …and NO lease event (claim/release) was appended.
    expect(await leaseEvents(arm.eventStore)).toEqual([]);
  });

  it('SerializeMerge_ExplicitDryRunFalse_ClaimsLeaseAndMerges', async () => {
    // The apply path (dryRun:false) must still claim + release the lease.
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

  it('SerializeMerge_ComposedCaller_StillExecutesMerge', async () => {
    // The WLM-5 rerouted merge surface: LauncherWlm.serializeIntegrationMerge
    // must EXECUTE a real merge despite the new dry-run default — the caller
    // audit pins dryRun:false so the flip cannot silently no-op an integration
    // merge. The caller passes NO dryRun; the composition forces the apply path.
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
    // The real merge ran…
    expect(calls).toHaveLength(1);
    expect(calls[0]!.featureId).toBe('F');
    // …and the lease was claimed + released (NOT a dry-run no-op).
    expect(await leaseEvents(arm.eventStore)).toEqual([
      'worktree.merge_requested',
      'worktree.merge_executed',
    ]);
  });
});

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

  /** A probe that lists exactly `wtPath` with the given mutability verdict. */
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

  it('AcquireWorktree_NotMutable_RefusesReserve', async () => {
    const arm = await nextArm();
    const wtPath = '/wlm6/stale-wt';

    const result = await handleAcquireWorktree(
      { repoRoot: '/wlm6/repo', worktreeId: wtPath },
      arm.ctx,
      // Identity realpath so the adopt report's canonical worktreeId === wtPath.
      { gitProbe: probeWith(wtPath, false), processSource: FIXED_SOURCE, realpath: (p) => p },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WORKTREE_NOT_MUTABLE');
    expect(result.error?.message).toMatch(/stale-after-push/);
    // Refusal is a HARD gate — no reservation was written.
    const events = await arm.eventStore.query(WORKTREES_STREAM);
    expect(events.map((e) => e.type)).not.toContain('worktree.reserved');
  });

  it('AcquireWorktree_Mutable_ReservesAsBefore', async () => {
    // Positive control: a mutable worktree still reserves (the gate is specific).
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
