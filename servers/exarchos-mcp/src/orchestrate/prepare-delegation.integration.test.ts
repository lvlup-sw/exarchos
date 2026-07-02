// Regression harness for #1145: verifies preflight.* events actually
// persist to a real EventStore, not just that a mock's .append was called.
//
// The v2.8.1 fix for #1129 added store.append() call sites for preflight
// events. The existing unit tests assert on mockStore.append.mock.calls,
// which only proves the handler *invoked* the append. Live MCP testing
// revealed events are being silently dropped — this harness exercises the
// real store through the production code path and queries it after the
// handler returns.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { toPosix } from '../utils/paths.js';
import * as os from 'node:os';
import { handlePrepareDelegation, persistWorkflowRiskTier } from './prepare-delegation.js';
import { handleSetupWorktree } from './setup-worktree.js';
import { handleOrchestrate } from './composite.js';
import {
  resetMaterializerCache,
  getOrCreateMaterializer,
  queryDeltaEvents,
} from '../views/tools.js';
import { WORKFLOW_STATE_VIEW } from '../views/workflow-state-projection.js';
import { getRequiredReviews } from '../workflow/review-contract.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

vi.mock('./dispatch-guard.js', () => ({
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
  // #1261 — stash probe is fire-and-forget; default to a no-op for this
  // integration test, which exercises the blocked-protected-branch
  // short-circuit only.
  probeStashAndEmit: vi.fn().mockResolvedValue(undefined),
}));

// vls1-b1 (task 002): the verification-ladder acceptance test exercises the
// nativeIsolation ready path, which runs `assertWorktreeBaseRefPinned`. Default
// it to "pinned" so the dispatch proceeds; the existing blocked-protected-branch
// tests short-circuit before this guard, so the mock is inert for them.
vi.mock('./worktree-baseref.js', () => ({
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

  // The constructor-injection refactor (#1182) requires every reader to
  // share the same EventStore instance the handler used. A "freshReader"
  // EventStore at the same stateDir must still see events on disk, but
  // sequence-counter coherence is only guaranteed when the same instance
  // is used for both writes and reads — that is enforced by single-
  // composition-root wiring at the MCP server level. This test verifies
  // the on-disk events are present (write-side persistence).
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

  // Reproduces the EXACT production MCP call path: handleOrchestrate
  // dispatched with a DispatchContext whose ctx.eventStore is a distinct
  // instance from the factory-cached store the handler uses internally.
  // This is the drift that caused #1129's partial regression to escape.
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

  // Race reproduction: a caller that queries IMMEDIATELY after the dispatch
  // response returns (no flush, no sleep) — exactly what a downstream MCP
  // client does. The event must be visible the moment the dispatch returns,
  // not "eventually." This is the failure mode that surfaced in the v2.8.1
  // dogfood re-verify: the handler returned blocked, the caller queried,
  // the stream was empty. Fire-and-forget appends are not synchronous with
  // the dispatch response, so any "read your writes" MCP caller races.
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

    // Intentionally no flush — mirrors a subsequent MCP call from the
    // same client reading its own writes.
    const events = await ctxStore.query('test-race-stream', {
      type: 'preflight.blocked',
    });
    expect(events).toHaveLength(1);
  });
});

// ─── T-09 (#1301): Working-tree mirroring-leak root-cause characterization ────
//
// characterizationRequired: true
//
// #1301 symptom: an implementer agent's worktree edits surface as
// byte-identical UNCOMMITTED modifications in the orchestrator's MAIN
// worktree. The issue's leading hypothesis (#1) is a "file-tool path
// resolution leak" — an agent file-write resolving to BOTH the worktree path
// AND the equivalent main-worktree path.
//
// This block characterizes whether that leak can originate in
// MCP-SERVER-OWNED code. The server's entire surface area for "where an agent
// will write" is the worktree it provisions via `handleSetupWorktree`
// (`git worktree add <repoRoot>/.worktrees/<task>`). The server never spawns
// the agent and never resolves the agent's individual file-write targets —
// that is the Claude Code harness / file-tool layer, outside this repo.
//
// INV-11 (by-construction worktree isolation) on the server side reduces to a
// single provable invariant: every path the server hands off as an agent
// write root MUST live strictly inside `<repoRoot>/.worktrees/`, NEVER the
// main worktree root. These tests assert exactly that. If the server resolved
// a write target to the main worktree, the leak would reproduce here; if it
// cannot, the root fix is a harness-layer concern (escalated to RC2), with
// T-08's `verify-worktree-baseline` backstop as the shipping mitigation.
describe('ImplementerDispatch_WorktreeEdit_DoesNotAppearInMainWorktree (characterization, #1301)', () => {
  let repoRoot: string;

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rootcause-1301-'));
    git(repoRoot, ['init', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    // Seed a committed file so the agent worktree has a real main-worktree
    // counterpart to (not) leak into.
    await fs.writeFile(path.join(repoRoot, 'src.txt'), 'baseline\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'baseline']);
  });

  afterEach(async () => {
    await rmrfAsync(repoRoot);
  });

  it('resolves the agent write-root strictly inside <repoRoot>/.worktrees/, never the main worktree', () => {
    const result = handleSetupWorktree({
      repoRoot,
      taskId: 'T-99',
      taskName: 'leak-probe',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { worktreePath: string; passed: boolean };

    // handleSetupWorktree returns a POSIX-normalized worktreePath (#1620), so
    // build the containment prefix the same way rather than with native sep.
    const worktreesRoot = toPosix(path.join(repoRoot, '.worktrees')) + '/';
    // The write root must be UNDER .worktrees/ — not the repoRoot itself and
    // not a sibling escaping the isolation boundary.
    expect(data.worktreePath.startsWith(worktreesRoot)).toBe(true);
    expect(path.resolve(data.worktreePath)).not.toBe(path.resolve(repoRoot));
    // A real, distinct worktree was provisioned (git sees a separate gitdir).
    expect(existsSyncSafe(data.worktreePath)).toBe(true);
  });

  it('an agent-side write into its worktree does NOT mirror into the main worktree', () => {
    const setup = handleSetupWorktree({
      repoRoot,
      taskId: 'T-99',
      taskName: 'leak-probe',
      skipTests: true,
    });
    const { worktreePath } = setup.data as { worktreePath: string };

    // Simulate the agent's file-tool write happening at the path the SERVER
    // handed it. If server path-resolution leaked, the byte-identical content
    // would also appear at the main worktree's copy of the same file.
    const agentFile = path.join(worktreePath, 'src.txt');
    execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(agentFile)}, 'agent-edit\\n')`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // The agent's edited path (src.txt) must NOT surface as a modification in
    // the main worktree. (`handleSetupWorktree` step 1 writes `.gitignore`
    // into the main worktree by design — that is provisioning, not a leak, so
    // we assert specifically on the agent-edited path, not whole-tree
    // cleanliness.)
    const mainStatus = git(repoRoot, ['status', '--porcelain']);
    const leakedPaths = mainStatus
      .split('\n')
      .map(l => l.slice(2).trim())
      .filter(p => p === 'src.txt');
    expect(leakedPaths).toEqual([]);
    // And the main worktree's file is untouched.
    const mainContent = execFileSync('cat', [path.join(repoRoot, 'src.txt')], {
      encoding: 'utf-8',
    });
    expect(mainContent).toBe('baseline\n');
  });
});

function existsSyncSafe(p: string): boolean {
  try {
    execFileSync('git', ['-C', p, 'rev-parse', '--git-dir'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── vls1-b1 (task 002 / 007): verification-ladder ACCEPTANCE ────────────────
//
// Dispatches `prepare_delegation` THROUGH `handleOrchestrate` (the production
// dispatch entry — a registered action without a dispatch branch returns
// UNKNOWN_ACTION, which per-handler tests cannot catch) on a real EventStore
// seeded to a ready state. Asserts every returned task classification carries
// the verification-ladder fields — `riskTier`, `boundaryTouching`, and an
// ordered `verificationSequence` — consistent with the policy table
// (`workflow/verification-policy.ts`, task 006).
//
// Written FIRST and RED until the wire-in (task 007). Each case exercises a
// distinct tier/boundary combination so a partial implementation is caught.
describe('HandleOrchestrate_PrepareDelegation_StampsRiskTierBoundaryAndVerificationSequence', () => {
  // Seed a real EventStore so the delegation-readiness projection reports
  // ready=true (plan approved + artifact present + every task's worktree
  // created). The handler classifies tasks only on the ready path.
  async function seedReadyStream(
    store: EventStore,
    streamId: string,
    taskIds: readonly string[],
  ): Promise<void> {
    // plan.approved = true
    await store.append(streamId, {
      type: 'workflow.transition',
      data: { to: 'plan-review' },
    });
    // artifacts.plan present → plan.artifactPresent = true
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

    // Override the module-level dispatch-guard mock so this dispatch is NOT
    // blocked on the protected-branch short-circuit (the file default blocks).
    const guard = await import('./dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/verification-ladder');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        tasks: [
          // (a) high tier via a high-risk schema glob — NOT a boundary glob and
          // NOT a boundary testLayer, so this cleanly exercises the pure-high
          // base sequence (riskTier and boundaryTouching are orthogonal axes).
          { id: 't-high', title: 'edit schema', files: ['src/event-store/schemas.ts'] },
          // (a2) high tier via testLayer 'acceptance'. Per the boundary policy,
          // the acceptance layer ALSO marks the task boundary-touching, so its
          // sequence is base-high + contract_drift + mock_boundary.
          { id: 't-high-accept', title: 'Write acceptance test', testLayer: 'acceptance' },
          // (b) medium default — single module behavior, no high/low signals.
          { id: 't-medium', title: 'Add validation logic', files: ['src/validate.ts'] },
          // (c) low — doc-only files.
          { id: 't-low', title: 'Update changelog', files: ['docs/CHANGELOG.md'] },
          // (d) boundary-tagged — testLayer 'integration'.
          { id: 't-boundary', title: 'Integration test', testLayer: 'integration' },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = (result.data as { ready?: boolean }) ?? {};
    expect(data.ready).toBe(true);

    // (a) high tier, NOT boundary-touching → base high sequence only.
    const high = findClassification(data, 't-high');
    expect(high.riskTier).toBe('high');
    expect(high.boundaryTouching).toBe(false);
    expect(high.verificationSequence).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_integration_suite',
    ]);

    // (a2) high tier AND boundary-touching (acceptance layer) → base high
    // sequence + contract_drift + mock_boundary, appended in that order.
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

    // (b) medium default, not boundary-touching → base medium sequence.
    const medium = findClassification(data, 't-medium');
    expect(medium.riskTier).toBe('medium');
    expect(medium.boundaryTouching).toBe(false);
    expect(medium.verificationSequence).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
    ]);

    // (c) low (doc-only), not boundary-touching → base low sequence.
    const low = findClassification(data, 't-low');
    expect(low.riskTier).toBe('low');
    expect(low.boundaryTouching).toBe(false);
    expect(low.verificationSequence).toEqual(['check_static_analysis']);

    // (d) boundary-tagged (integration testLayer). riskTier is medium
    // (integration → medium), boundaryTouching true → base medium sequence
    // PLUS check_contract_drift (every tier) then check_mock_boundary
    // (medium/high only), appended in that order.
    const boundary = findClassification(data, 't-boundary');
    expect(boundary.boundaryTouching).toBe(true);
    expect(boundary.riskTier).toBe('medium');
    expect(boundary.verificationSequence).toEqual([
      'check_static_analysis',
      'check_test_adequacy',
      'check_contract_drift',
      'check_mock_boundary',
    ]);

    // Every sequence is duplicate-free.
    for (const c of [high, highAccept, medium, low, boundary]) {
      expect(new Set(c.verificationSequence).size).toBe(c.verificationSequence.length);
    }
  });

  // vls1-b1 (task 007): the wired classifier must populate the
  // verificationSequence from the policy table — assert the exact sequence the
  // policy produces appears on the returned classification (the "delegation
  // record"), proving the wire-in is sourced from resolveVerificationSequence
  // rather than hand-rolled in the handler.
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

    const guard = await import('./dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/verification-ladder');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const { resolveVerificationSequence } = await import('../workflow/verification-policy.js');

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        // medium tier (single source file), boundary-touching (adapter glob).
        tasks: [{ id: 't-only', title: 'tweak adapter', files: ['src/adapters/cli.ts'] }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const c = findClassification(result.data, 't-only');
    expect(c.riskTier).toBe('medium');
    expect(c.boundaryTouching).toBe(true);
    // The record's sequence is EXACTLY what the policy table resolves.
    expect(c.verificationSequence).toEqual([
      ...resolveVerificationSequence('medium', true),
    ]);
  });
});

// ─── DR-2: workflow-level riskTier persistence + review-contract wiring ──────
//
// Drives prepare_delegation through the production handleOrchestrate path on a
// real EventStore, then proves the END-TO-END wiring task 004 delivers:
//   1. the derived workflow tier persists to state.riskTier (event-sourced
//      state.patched, materialized through the real workflow-state projection);
//   2. that persisted tier feeds the /review required-reviews contract so the
//      high-tier mutation-adequacy backstop is armed.
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

    const guard = await import('./dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/risk-closeout');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        tasks: [
          // high via the **/*schema* glob; medium default — max-of-tiers ⇒ high.
          { id: 't-high', title: 'edit schema', files: ['src/event-store/schemas.ts'] },
          { id: 't-medium', title: 'Add validation logic', files: ['src/validate.ts'] },
        ],
      },
      ctx,
    );
    expect(result.success).toBe(true);

    // (1) the state.patched riskTier event actually persisted to the real store.
    const patchEvents = await ctxStore.query(streamId, { type: 'state.patched' });
    const riskTierPatch = patchEvents.find(
      (e) => !!(e.data as { patch?: Record<string, unknown> }).patch
        && 'riskTier' in (e.data as { patch: Record<string, unknown> }).patch,
    );
    expect(riskTierPatch).toBeDefined();
    expect((riskTierPatch!.data as { patch: { riskTier: string } }).patch.riskTier).toBe('high');

    // (2) folded through the real workflow-state projection → state.riskTier=high.
    const riskTier = await materializeRiskTier(ctxStore, tmpDir, streamId);
    expect(riskTier).toBe('high');

    // (3) that persisted tier arms the /review mutation-adequacy backstop.
    expect(getRequiredReviews('feature', riskTier as string)).toContain('mutation-adequacy');
  });

  it('re-raised tier survives high → medium → high (no value-keyed dedup — RVC-R9)', async () => {
    // Regression: persistWorkflowRiskTier keyed the state.patched by tier value,
    // so a workflow that went high → medium → high cache-hit the second `high` at
    // the store and materialized to `medium` — silently under-arming the
    // mutation-adequacy backstop. With the value-based key removed, every
    // derivation appends and the projection folds last-write-wins.
    const ctxStore = new EventStore(tmpDir);
    const streamId = 'dr2-risktier-reraise';

    await persistWorkflowRiskTier(ctxStore, streamId, 'high');
    await persistWorkflowRiskTier(ctxStore, streamId, 'medium');
    await persistWorkflowRiskTier(ctxStore, streamId, 'high');

    // All three patches must persist (the value-based key would have dropped the
    // third as a cache-hit, leaving `medium` as the last applied value).
    const patches = await ctxStore.query(streamId, { type: 'state.patched' });
    const tierPatches = patches.filter(
      (e) =>
        !!(e.data as { patch?: Record<string, unknown> }).patch &&
        'riskTier' in (e.data as { patch: Record<string, unknown> }).patch,
    );
    expect(tierPatches.length).toBe(3);

    // Materialized through the real projection → last-write-wins yields `high`.
    const riskTier = await materializeRiskTier(ctxStore, tmpDir, streamId);
    expect(riskTier).toBe('high');
    expect(getRequiredReviews('feature', riskTier as string)).toContain('mutation-adequacy');
  });

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

    const guard = await import('./dispatch-guard.js');
    vi.mocked(guard.getCurrentBranch).mockReturnValue('feature/risk-closeout');
    vi.mocked(guard.assertCurrentBranchNotProtected).mockReturnValue({ blocked: false });

    const result = await handleOrchestrate(
      {
        action: 'prepare_delegation',
        featureId: streamId,
        nativeIsolation: true,
        // The task derives to medium, but the caller forces high — override wins.
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
