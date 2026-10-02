// Integration tests for `prepare_delegation` on a real `EventStore`. They query the
// store after dispatch, so they prove that events persist, not only that a mock
// `append` ran.
//
// The dispatch-guard mock blocks on the protected branch by default, and its stash
// probe does nothing. The base-ref mock reports a pinned base ref, so a ready
// dispatch passes `assertWorktreeBaseRefPinned`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toPosix } from '../../../../src/utils/paths.js';
import * as os from 'node:os';
import { handlePrepareDelegation, persistWorkflowRiskTier } from '../../../../src/verbs/team/prepare-delegation.js';
import { handleSetupWorktree } from '../../../../src/verbs/team/setup-worktree.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import {
  resetMaterializerCache,
  getOrCreateMaterializer,
  queryDeltaEvents,
} from '../../../../src/projections/views/tools.js';
import { WORKFLOW_STATE_VIEW } from '../../../../src/projections/views/workflow-state-projection.js';
import { getRequiredReviews } from '../../../../src/workflow/review-contract.js';
import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

vi.mock('../../../../src/verbs/team/dispatch-guard.js', () => ({
  validateBranchAncestry: vi.fn().mockResolvedValue({ passed: true, checks: ['ancestry'] }),
  assertMainWorktree: vi.fn().mockReturnValue({
    isMain: true,
    actual: '/fake/repo',
    expected: 'main worktree (no .claude/worktrees/ in path)',
  }),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  assertCurrentBranchNotProtected: vi.fn().mockReturnValue({
    blocked: true,
    reason: 'current-branch-protected',
    currentBranch: 'main',
  }),
  probeStashAndEmit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/verbs/team/worktree-baseref.js', () => ({
  assertWorktreeBaseRefPinned: vi
    .fn()
    .mockReturnValue({ pinned: true, effective: 'head', checked: [] }),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-deleg-integ-'));
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  await rmrfAsync(tmpDir);
});

async function flushAsyncQueue(ms = 50): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(queueMicrotask);
    await new Promise(resolve => setImmediate(resolve));
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('handlePrepareDelegation — event persistence (integration)', () => {
  it('persists preflight.blocked to the injected EventStore when branch is protected', async () => {
    const args = { featureId: 'test-integration-stream' };
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const result = await handlePrepareDelegation(args, tmpDir, ctx);
    await flushAsyncQueue();

    expect(result.success).toBe(true);
    const data = result.data as {
      blocked: boolean;
      reason: string;
      currentBranch: string;
    };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');
    expect(data.currentBranch).toBe('main');

    const events = await ctxStore.query('test-integration-stream', {
      type: 'preflight.blocked',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('preflight.blocked');
    const eventData = events[0]?.data as {
      reason: string;
      details: { currentBranch: string };
    };
    expect(eventData.reason).toBe('current-branch-protected');
    expect(eventData.details.currentBranch).toBe('main');
  });

  /** A second `EventStore` instance at the same state directory reads the persisted events from disk. */
  it('event persists to disk and is readable by a second EventStore instance', async () => {
    const args = { featureId: 'test-cross-instance' };
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    await handlePrepareDelegation(args, tmpDir, ctx);
    await flushAsyncQueue(200);

    const freshReader = new EventStore(tmpDir);
    const events = await freshReader.query('test-cross-instance', {
      type: 'preflight.blocked',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('preflight.blocked');
  });

  /** This is the production MCP path: `handleOrchestrate` with a `DispatchContext`. */
  it('preflight.blocked persists when dispatched via handleOrchestrate with DispatchContext', async () => {
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const result = await handleOrchestrate(
      { action: 'prepare_delegation', featureId: 'test-composite-stream' },
      ctx,
    );
    await flushAsyncQueue(200);

    expect(result.success).toBe(true);
    const data = result.data as { blocked: boolean; reason: string };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');

    const events = await ctxStore.query('test-composite-stream', {
      type: 'preflight.blocked',
    });
    expect(events).toHaveLength(1);
  });

  /**
   * A caller that queries at once after the dispatch returns must see the event.
   * An append that the handler does not await races such a caller.
   */
  it('preflight.blocked is visible the moment handleOrchestrate returns (no flush)', async () => {
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    await handleOrchestrate(
      { action: 'prepare_delegation', featureId: 'test-race-stream' },
      ctx,
    );

    const events = await ctxStore.query('test-race-stream', {
      type: 'preflight.blocked',
    });
    expect(events).toHaveLength(1);
  });
});

/**
 * Characterizes whether a worktree edit by an implementer agent can leak into the
 * main worktree through server code. The server decides only the worktree path from
 * `handleSetupWorktree`, so each agent write root must be inside `<repoRoot>/.worktrees/`.
 * Agent file writes happen in the harness, outside this repository.
 */
describe('ImplementerDispatch_WorktreeEdit_DoesNotAppearInMainWorktree (characterization, #1301)', () => {
  let repoRoot: string;

  function git(cwd: string, args: readonly string[]): Promise<string> {
    return execFileAsync('git', ['-C', cwd, ...args]);
  }

  /** Commits `src.txt`, so the agent worktree has a counterpart file in the main worktree. */
  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rootcause-1301-'));
    await git(repoRoot, ['init', '-b', 'main']);
    await git(repoRoot, ['config', 'user.email', 'test@example.com']);
    await git(repoRoot, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repoRoot, 'src.txt'), 'baseline\n');
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'baseline']);
  });

  afterEach(async () => {
    await rmrfAsync(repoRoot);
  });

  /** `handleSetupWorktree` returns a POSIX path, so the test builds the `.worktrees/` prefix with `toPosix`. */
  it('resolves the agent write-root strictly inside <repoRoot>/.worktrees/, never the main worktree', async () => {
    const result = await handleSetupWorktree({
      repoRoot,
      taskId: 'T-99',
      taskName: 'leak-probe',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { worktreePath: string; passed: boolean };

    const worktreesRoot = toPosix(path.join(repoRoot, '.worktrees')) + '/';
    expect(data.worktreePath.startsWith(worktreesRoot)).toBe(true);
    expect(path.resolve(data.worktreePath)).not.toBe(path.resolve(repoRoot));
    expect(await existsSafe(data.worktreePath)).toBe(true);
  });

  /**
   * The test writes `src.txt` at the worktree path that the server returns. The main
   * worktree must show no change to `src.txt`. The check ignores other paths, because
   * `handleSetupWorktree` writes `.gitignore` into the main worktree by design.
   */
  it('an agent-side write into its worktree does NOT mirror into the main worktree', async () => {
    const setup = await handleSetupWorktree({
      repoRoot,
      taskId: 'T-99',
      taskName: 'leak-probe',
      skipTests: true,
    });
    const { worktreePath } = setup.data as { worktreePath: string };

    const agentFile = path.join(worktreePath, 'src.txt');
    await execFileAsync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(agentFile)}, 'agent-edit\\n')`]);

    const mainStatus = await git(repoRoot, ['status', '--porcelain']);
    const leakedPaths = mainStatus
      .split('\n')
      .map(l => l.slice(2).trim())
      .filter(p => p === 'src.txt');
    expect(leakedPaths).toEqual([]);
    const mainContent = await execFileAsync('cat', [path.join(repoRoot, 'src.txt')]);
    expect(mainContent).toBe('baseline\n');
  });
});

async function existsSafe(p: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', p, 'rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatches `prepare_delegation` through `handleOrchestrate`, because a registered
 * action without a dispatch branch returns `UNKNOWN_ACTION` and a handler test cannot
 * catch that. The seeded store makes the readiness projection report ready, and the
 * handler classifies tasks only when ready. Each case checks `riskTier`,
 * `boundaryTouching` and the ordered `verificationSequence`.
 */
describe('HandleOrchestrate_PrepareDelegation_StampsRiskTierBoundaryAndVerificationSequence', () => {
  async function seedReadyStream(
    store: EventStore,
    streamId: string,
    taskIds: readonly string[],
  ): Promise<void> {
    await store.append(streamId, {
      type: 'workflow.transition',
      data: { to: 'plan-review' },
    });
    await store.append(streamId, {
      type: 'state.patched',
      data: { patch: { 'artifacts.plan': 'plan.md' } },
    });
    for (const taskId of taskIds) {
      await store.append(streamId, { type: 'task.assigned', data: { taskId } });
    }
    for (const taskId of taskIds) {
      await store.append(streamId, {
        type: 'worktree.created',
        data: { taskId, worktreePath: `/w/${taskId}` },
      });
    }
  }

  function findClassification(
    data: unknown,
    taskId: string,
  ): { riskTier: string; boundaryTouching: boolean; verificationSequence: string[] } {
    const classifications = (data as {
      taskClassifications?: Array<{
        taskId: string;
        riskTier?: string;
        boundaryTouching?: boolean;
        verificationSequence?: string[];
      }>;
    }).taskClassifications;
    expect(classifications).toBeDefined();
    const found = classifications!.find((c) => c.taskId === taskId);
    expect(found, `classification for ${taskId}`).toBeDefined();
    return found as {
      riskTier: string;
      boundaryTouching: boolean;
      verificationSequence: string[];
    };
  }

  /**
   * The test overrides the dispatch-guard mock, so the dispatch is not blocked on the
   * protected branch. `t-high` edits a schema file that is not a boundary glob.
   * The `acceptance` layer gives a high, boundary-touching task. The `integration`
   * layer gives a medium, boundary-touching task. A medium or high boundary task
   * appends `check_contract_drift` and then `check_mock_boundary` to its base sequence.
   */
  it('stamps riskTier, boundaryTouching, and an ordered verificationSequence per task', async () => {
    const ctxStore = new EventStore(tmpDir);
    const streamId = 'vls1-acceptance';
    const taskIds = ['t-high', 't-high-accept', 't-medium', 't-low', 't-boundary'] as const;
    await seedReadyStream(ctxStore, streamId, taskIds);
    await flushAsyncQueue();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const guard = await import('../../../../src/verbs/team/dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/verification-ladder');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        tasks: [
          { id: 't-high', title: 'edit schema', files: ['src/events/schemas.ts'] },
          { id: 't-high-accept', title: 'Write acceptance test', testLayer: 'acceptance' },
          { id: 't-medium', title: 'Add validation logic', files: ['src/validate.ts'] },
          { id: 't-low', title: 'Update changelog', files: ['docs/CHANGELOG.md'] },
          { id: 't-boundary', title: 'Integration test', testLayer: 'integration' },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = (result.data as { ready?: boolean }) ?? {};
    expect(data.ready).toBe(true);

    const high = findClassification(data, 't-high');
    expect(high.riskTier).toBe('high');
    expect(high.boundaryTouching).toBe(false);
    expect(high.verificationSequence).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_integration_suite',
    ]);

    const highAccept = findClassification(data, 't-high-accept');
    expect(highAccept.riskTier).toBe('high');
    expect(highAccept.boundaryTouching).toBe(true);
    expect(highAccept.verificationSequence).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_integration_suite',
      'check_contract_drift',
      'check_mock_boundary',
    ]);

    const medium = findClassification(data, 't-medium');
    expect(medium.riskTier).toBe('medium');
    expect(medium.boundaryTouching).toBe(false);
    expect(medium.verificationSequence).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
    ]);

    const low = findClassification(data, 't-low');
    expect(low.riskTier).toBe('low');
    expect(low.boundaryTouching).toBe(false);
    expect(low.verificationSequence).toEqual(['check_static_analysis']);

    const boundary = findClassification(data, 't-boundary');
    expect(boundary.boundaryTouching).toBe(true);
    expect(boundary.riskTier).toBe('medium');
    expect(boundary.verificationSequence).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_contract_drift',
      'check_mock_boundary',
    ]);

    for (const c of [high, highAccept, medium, low, boundary]) {
      expect(new Set(c.verificationSequence).size).toBe(c.verificationSequence.length);
    }
  });

  /**
   * The adapter file gives a medium, boundary-touching task. Its classification carries
   * the exact sequence from `resolveVerificationSequence`, not one that the handler builds.
   */
  it('PrepareDelegation_ClassifiedTask_CarriesPolicySequenceOnDelegationRecord', async () => {
    const ctxStore = new EventStore(tmpDir);
    const streamId = 'vls1-policy-record';
    const taskIds = ['t-only'] as const;
    await seedReadyStream(ctxStore, streamId, taskIds);
    await flushAsyncQueue();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const guard = await import('../../../../src/verbs/team/dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/verification-ladder');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const { resolveVerificationSequence } = await import('../../../../src/workflow/verification-policy.js');

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        tasks: [{ id: 't-only', title: 'tweak adapter', files: ['src/adapters/cli.ts'] }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const c = findClassification(result.data, 't-only');
    expect(c.riskTier).toBe('medium');
    expect(c.boundaryTouching).toBe(true);
    expect(c.verificationSequence).toEqual([
      ...resolveVerificationSequence('medium', true),
    ]);
  });
});

/**
 * Drives `prepare_delegation` through `handleOrchestrate` on a real `EventStore`. The
 * derived workflow tier persists to `state.riskTier` through `state.patched`, and a
 * high tier adds `mutation-adequacy` to the required reviews.
 */
describe('HandleOrchestrate_PrepareDelegation_PersistsWorkflowRiskTier (DR-2)', () => {
  async function seedReadyStream(
    store: EventStore,
    streamId: string,
    taskIds: readonly string[],
  ): Promise<void> {
    await store.append(streamId, {
      type: 'workflow.transition',
      data: { to: 'plan-review' },
    });
    await store.append(streamId, {
      type: 'state.patched',
      data: { patch: { 'artifacts.plan': 'plan.md' } },
    });
    for (const taskId of taskIds) {
      await store.append(streamId, { type: 'task.assigned', data: { taskId } });
    }
    for (const taskId of taskIds) {
      await store.append(streamId, {
        type: 'worktree.created',
        data: { taskId, worktreePath: `/w/${taskId}` },
      });
    }
  }

  async function materializeRiskTier(
    store: EventStore,
    stateDir: string,
    streamId: string,
  ): Promise<unknown> {
    const materializer = getOrCreateMaterializer(stateDir);
    const events = await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATE_VIEW);
    const view = materializer.materialize<{ riskTier?: unknown }>(
      streamId,
      WORKFLOW_STATE_VIEW,
      events,
    );
    return view.riskTier;
  }

  /** The workflow tier is the highest task tier, so a schema task and a medium task give `high`. */
  it('persists state.riskTier=high for a high-tier wave and arms the mutation-adequacy backstop', async () => {
    const ctxStore = new EventStore(tmpDir);
    const streamId = 'dr2-workflow-risktier';
    const taskIds = ['t-high', 't-medium'] as const;
    await seedReadyStream(ctxStore, streamId, taskIds);
    await flushAsyncQueue();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const guard = await import('../../../../src/verbs/team/dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/risk-closeout');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        tasks: [
          { id: 't-high', title: 'edit schema', files: ['src/events/schemas.ts'] },
          { id: 't-medium', title: 'Add validation logic', files: ['src/validate.ts'] },
        ],
      },
      ctx,
    );
    expect(result.success).toBe(true);

    const patchEvents = await ctxStore.query(streamId, { type: 'state.patched' });
    const riskTierPatch = patchEvents.find(
      (e) => !!(e.data as { patch?: Record<string, unknown> }).patch
        && 'riskTier' in (e.data as { patch: Record<string, unknown> }).patch,
    );
    expect(riskTierPatch).toBeDefined();
    expect((riskTierPatch!.data as { patch: { riskTier: string } }).patch.riskTier).toBe('high');

    const riskTier = await materializeRiskTier(ctxStore, tmpDir, streamId);
    expect(riskTier).toBe('high');

    expect(getRequiredReviews('feature', riskTier as string)).toContain('mutation-adequacy');
  });

  /**
   * Every derivation appends a `state.patched` event, and the projection keeps the last
   * value. An idempotency key on the tier value drops the second `high` and leaves `medium`.
   * The test closes the store before `afterEach` removes `tmpDir`, because an open SQLite
   * handle blocks removal on Windows.
   */
  it('re-raised tier survives high → medium → high (no value-keyed dedup — RVC-R9)', async () => {
    const ctxStore = new EventStore(tmpDir);
    const streamId = 'dr2-risktier-reraise';
    try {
      await persistWorkflowRiskTier(ctxStore, streamId, 'high');
      await persistWorkflowRiskTier(ctxStore, streamId, 'medium');
      await persistWorkflowRiskTier(ctxStore, streamId, 'high');

      const patches = await ctxStore.query(streamId, { type: 'state.patched' });
      const tierPatches = patches.filter(
        (e) =>
          !!(e.data as { patch?: Record<string, unknown> }).patch &&
          'riskTier' in (e.data as { patch: Record<string, unknown> }).patch,
      );
      expect(tierPatches.length).toBe(3);

      const riskTier = await materializeRiskTier(ctxStore, tmpDir, streamId);
      expect(riskTier).toBe('high');
      expect(getRequiredReviews('feature', riskTier as string)).toContain('mutation-adequacy');
    } finally {
      ctxStore.close();
    }
  });

  /** The task derives to `medium`, and the caller sets `riskTier: 'high'`. */
  it('an explicit caller riskTier override wins over the derived value end-to-end', async () => {
    const ctxStore = new EventStore(tmpDir);
    const streamId = 'dr2-override';
    const taskIds = ['t-only'] as const;
    await seedReadyStream(ctxStore, streamId, taskIds);
    await flushAsyncQueue();

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const guard = await import('../../../../src/verbs/team/dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/risk-closeout');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        riskTier: 'high',
        tasks: [{ id: 't-only', title: 'Add validation logic', files: ['src/validate.ts'] }],
      },
      ctx,
    );
    expect(result.success).toBe(true);

    const riskTier = await materializeRiskTier(ctxStore, tmpDir, streamId);
    expect(riskTier).toBe('high');
  });
});
