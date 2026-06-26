// ─── Worktree-lifecycle handler contract tests ───────────────────────────────
//
// Focused on the handler-level invariants the dispatch/parity suite does not
// pin: the all-or-nothing owner override (fix 6) and the exclusive-ownership
// rejections wired from the manager (fix 4). Every handler is driven directly
// over a real EventStore with deterministic injected deps (no git spawn, no OS
// process probe), so the assertions are platform-free.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
} from './handlers.js';
import type { GitWorktreeProbe } from './manager.js';
import type { ProcessSource, StartTimeProbe } from './pure/process-identity.js';

// ─── Deterministic injected deps ─────────────────────────────────────────────

/** Empty probe — adopt observes zero on-disk worktrees, no git spawn. */
const EMPTY_PROBE: GitWorktreeProbe = {
  listWorktrees: () => [],
  verifyHead: () => ({
    head: null,
    upstream: null,
    mutable: false,
    reason: 'head-unresolved',
  }),
};

/** Fixed, present create-time so reserve is byte-stable and OS-free. */
const FIXED_SOURCE: ProcessSource = {
  getStartTime: (): StartTimeProbe => ({ status: 'present', startedAt: 'fixed-start' }),
};

const DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };

// ─── Arm ─────────────────────────────────────────────────────────────────────

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
  while (arms.length > 0) {
    const arm = arms.pop();
    if (arm) await rmrfAsync(arm.stateDir);
  }
});

// ─── fix 6: all-or-nothing owner override ────────────────────────────────────

describe('resolveOwner all-or-nothing (acquire_worktree)', () => {
  const baseArgs = { repoRoot: '/tmp/wlm-h-repo', worktreeId: '/tmp/wlm-h-wt' };

  it('AcquireWorktree_PartialOwnerOverride_OnlyPid_Rejected', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(
      { ...baseArgs, ownerPid: 4242 }, // ownerStartedAt omitted → partial
      arm.ctx,
      DEPS,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/together/i);
  });

  it('AcquireWorktree_PartialOwnerOverride_OnlyStartedAt_Rejected', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(
      { ...baseArgs, ownerStartedAt: 'boot-4242' }, // ownerPid omitted → partial
      arm.ctx,
      DEPS,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/together/i);
  });

  it('AcquireWorktree_BothOwnerFields_Accepted', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(
      { ...baseArgs, ownerPid: 4242, ownerStartedAt: 'boot-4242' },
      arm.ctx,
      DEPS,
    );
    expect(result.success).toBe(true);
    expect((result.data as { reserved?: boolean }).reserved).toBe(true);
  });

  it('AcquireWorktree_NeitherOwnerField_DerivesBoth_Accepted', async () => {
    const arm = await createArm();
    const result = await handleAcquireWorktree(baseArgs, arm.ctx, DEPS);
    expect(result.success).toBe(true);
    expect((result.data as { reserved?: boolean }).reserved).toBe(true);
  });
});

// ─── fix 4: exclusive-ownership rejections surfaced by the handlers ───────────

describe('exclusive ownership (acquire/release handlers)', () => {
  it('AcquireWorktree_AlreadyReservedByLiveOwner_ReturnsReservedError', async () => {
    const arm = await createArm();
    const args = {
      repoRoot: '/tmp/wlm-h-repo',
      worktreeId: '/tmp/wlm-h-held',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    };
    // Owner 100 claims it under a source where 100 is live.
    const liveSource: ProcessSource = {
      getStartTime: (pid): StartTimeProbe =>
        pid === 100 ? { status: 'present', startedAt: 'boot-100' } : { status: 'absent' },
    };
    const first = await handleAcquireWorktree(args, arm.ctx, {
      gitProbe: EMPTY_PROBE,
      processSource: liveSource,
    });
    expect(first.success).toBe(true);

    // A different owner cannot claim the live-held worktree.
    const second = await handleAcquireWorktree(
      { ...args, ownerPid: 200, ownerStartedAt: 'boot-200' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('WORKTREE_RESERVED');
  });

  it('ReleaseWorktree_ForeignLiveOwner_ReturnsOwnedByOtherError', async () => {
    const arm = await createArm();
    const liveSource: ProcessSource = {
      getStartTime: (pid): StartTimeProbe =>
        pid === 100 ? { status: 'present', startedAt: 'boot-100' } : { status: 'absent' },
    };
    await handleAcquireWorktree(
      {
        repoRoot: '/tmp/wlm-h-repo',
        worktreeId: '/tmp/wlm-h-owned',
        ownerPid: 100,
        ownerStartedAt: 'boot-100',
      },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );

    // A foreign caller (owner 200) cannot release owner 100's live reservation.
    const release = await handleReleaseWorktree(
      { worktreeId: '/tmp/wlm-h-owned', ownerPid: 200, ownerStartedAt: 'boot-200' },
      arm.ctx,
      { gitProbe: EMPTY_PROBE, processSource: liveSource },
    );
    expect(release.success).toBe(false);
    expect(release.error?.code).toBe('WORKTREE_OWNED_BY_OTHER');
  });
});
