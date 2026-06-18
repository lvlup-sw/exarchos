// ─── Prepare Delegation Action Tests ─────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import { WORKFLOW_STATE_VIEW } from '../views/workflow-state-projection.js';
import { CODE_QUALITY_VIEW } from '../views/code-quality-view.js';
import { DELEGATION_READINESS_VIEW } from '../views/delegation-readiness-view.js';
import type { DelegationReadinessState } from '../views/delegation-readiness-view.js';

// ─── Mock Dependencies ──────────────────────────────────────────────────────

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: vi.fn(),
  queryDeltaEvents: vi.fn(),
}));

vi.mock('../quality/hints.js', () => ({
  generateQualityHints: vi.fn(),
}));

vi.mock('./gate-utils.js', () => ({
  emitGateEvent: vi.fn(),
}));

vi.mock('../telemetry/telemetry-queries.js', () => ({
  queryTelemetryState: vi.fn().mockResolvedValue(null),
}));

vi.mock('./dispatch-guard.js', () => ({
  validateBranchAncestry: vi.fn().mockResolvedValue({ passed: true, checks: ['ancestry'] }),
  assertMainWorktree: vi.fn().mockReturnValue({ isMain: true, actual: '/repo', expected: 'main worktree (no .claude/worktrees/ in path)' }),
  getCurrentBranch: vi.fn().mockReturnValue('feature/test-branch'),
  assertCurrentBranchNotProtected: vi.fn().mockReturnValue({ blocked: false }),
  // #1261 — stash probe is fire-and-forget; default to a no-op so existing
  // tests don't need to manage shared-stash semantics.
  probeStashAndEmit: vi.fn().mockResolvedValue(undefined),
}));

// #1509/#1501 — default the native-isolation base-pin guard to "pinned" so
// existing nativeIsolation tests reach the readiness logic. Tests that exercise
// the block override the return value per-case.
vi.mock('./worktree-baseref.js', () => ({
  assertWorktreeBaseRefPinned: vi
    .fn()
    .mockReturnValue({ pinned: true, effective: 'head', checked: [] }),
}));

vi.mock('../workflow/checkpoint.js', () => ({
  shouldEnforceCheckpoint: vi.fn().mockReturnValue({ gated: false }),
  CHECKPOINT_OPERATION_THRESHOLD: 20,
}));

// DR-7: partially mock the phase-kind boundary so a single test can force the
// IMPLEMENT-kind gate-set resolver to throw (simulating a deferred-kind
// 'not-yet-wired' fault or any resolver error). The default implementation
// delegates to the real resolver so every other test exercises the genuine
// ladder; only the fail-closed test overrides it via `mockImplementationOnce`.
vi.mock('../workflow/phase-kind.js', async (importActual) => {
  const actual = await importActual<typeof import('../workflow/phase-kind.js')>();
  return { ...actual, resolveGateSet: vi.fn(actual.resolveGateSet) };
});

import {
  getOrCreateMaterializer,
  queryDeltaEvents,
} from '../views/tools.js';
import { generateQualityHints } from '../quality/hints.js';
import { emitGateEvent } from './gate-utils.js';
import {
  handlePrepareDelegation,
  classifyTask,
  computeScopedWorktrees,
  deriveRiskTier,
  deriveBoundaryTouching,
  HIGH_RISK_GLOBS,
  LOW_RISK_GLOBS,
  BOUNDARY_GLOBS,
} from './prepare-delegation.js';
import type { TaskClassification, TaskInput } from './prepare-delegation.js';
import * as fc from 'fast-check';
import { delegationReadinessProjection } from '../views/delegation-readiness-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import {
  validateBranchAncestry,
  assertMainWorktree,
  getCurrentBranch,
  assertCurrentBranchNotProtected,
} from './dispatch-guard.js';
import { shouldEnforceCheckpoint } from '../workflow/checkpoint.js';
import { assertWorktreeBaseRefPinned } from './worktree-baseref.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { resolveVerificationSequence } from '../workflow/verification-policy.js';
import type { GateName, RiskTier } from '../workflow/verification-policy.js';
import { resolveVerificationPolicy } from '../workflow/verification-policy-resolver.js';
import { resolveGateSet } from '../workflow/phase-kind.js';

const STATE_DIR = '/tmp/test-state';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function readyWorkflowState() {
  return {
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'delegate',
    tasks: [
      { id: 'task-1', title: 'Implement widget', status: 'pending' },
      { id: 'task-2', title: 'Add tests', status: 'pending' },
    ],
    artifacts: { design: 'design.md', plan: 'plan.md', pr: null },
    planReview: { approved: true },
  };
}

function notReadyWorkflowState() {
  return {
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'plan-review',
    tasks: [],
    artifacts: { design: null, plan: null, pr: null },
    planReview: { approved: false },
  };
}

function emptyQualityState() {
  return {
    skills: {},
    models: {},
    gates: {},
    regressions: [],
    benchmarks: [],
  };
}

function mockQualityHints() {
  return [
    {
      skill: 'implement',
      category: 'gate',
      severity: 'warning',
      hint: 'Gate pass rate is 75%. Common failures: typecheck. Pay extra attention to these areas.',
    },
    {
      skill: 'implement',
      category: 'review',
      severity: 'info',
      hint: 'High self-correction rate (40%). Consider strengthening upfront validation.',
    },
  ];
}

function readyDelegationReadiness(): DelegationReadinessState {
  return {
    ready: true,
    blockers: [],
    plan: { approved: true, taskCount: 2, artifactPresent: true },
    quality: { queried: true, gatePassRate: null, regressions: [] },
    worktrees: {
      expected: 2,
      ready: 2,
      failed: [],
      assignedTaskIds: ['task-1', 'task-2'],
      readyTaskIds: ['task-1', 'task-2'],
    },
  };
}

function notReadyDelegationReadiness(): DelegationReadinessState {
  return {
    ready: false,
    blockers: ['plan not approved', 'no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation'],
    plan: { approved: false, taskCount: 0, artifactPresent: false },
    quality: { queried: false, gatePassRate: null, regressions: [] },
    worktrees: {
      expected: 0,
      ready: 0,
      failed: [],
      assignedTaskIds: [],
      readyTaskIds: [],
    },
  };
}

function setupMaterializer(
  workflowState: Record<string, unknown>,
  qualityState?: Record<string, unknown>,
  delegationReadiness?: DelegationReadinessState,
) {
  const cqState = qualityState ?? emptyQualityState();
  const drState = delegationReadiness ?? (
    // Auto-derive from workflow state: if plan is approved and has tasks, use ready
    (workflowState as { planReview?: { approved?: boolean }; tasks?: unknown[] }).planReview?.approved
      ? readyDelegationReadiness()
      : notReadyDelegationReadiness()
  );
  const mockMaterializer = {
    register: vi.fn(),
    materialize: vi.fn().mockImplementation(
      (_streamId: string, viewName: string) => {
        if (viewName === WORKFLOW_STATE_VIEW) return workflowState;
        if (viewName === CODE_QUALITY_VIEW) return cqState;
        if (viewName === DELEGATION_READINESS_VIEW) return drState;
        return {};
      },
    ),
    loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue(null),
  };
  vi.mocked(getOrCreateMaterializer).mockReturnValue(
    mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
  );

  const mockStore = {
    query: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue(undefined),
    listStreams: vi.fn().mockReturnValue(null),
  };
  vi.mocked(queryDeltaEvents).mockResolvedValue([]);

  return { mockMaterializer, mockStore };
}

// Default mock store + ctx for tests that don't need a custom one. Tests
// that need a captured store from setupMaterializer can build their own
// ctx via makeCtx(localStore, STATE_DIR).
const mockStore = {
  query: vi.fn().mockResolvedValue([]),
  append: vi.fn().mockResolvedValue(undefined),
  listStreams: vi.fn().mockReturnValue(null),
};

function makeCtx(store: { append: unknown; query: unknown }, stateDir: string) {
  return {
    stateDir,
    eventStore: store as unknown as import('../event-store/store.js').EventStore,
    enableTelemetry: false,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handlePrepareDelegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set dispatch guard defaults after clearAllMocks
    vi.mocked(validateBranchAncestry).mockResolvedValue({ passed: true, checks: ['ancestry'] });
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: true,
      actual: '/repo',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    vi.mocked(shouldEnforceCheckpoint).mockReturnValue({ gated: false });
    // #1509/#1501 — default the native-isolation base-pin guard to "pinned".
    vi.mocked(assertWorktreeBaseRefPinned).mockReturnValue({
      pinned: true,
      effective: 'head',
      checked: [],
    });
  });

  it('PrepareDelegation_MissingFeatureId_ReturnsInvalidInput', async () => {
    // Arrange
    const args = {} as { featureId: string };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('PrepareDelegation_MalformedTaskShape_ReturnsInvalidInputNotPhaseBlocked', async () => {
    // A non-MCP caller can hand `tasks` through an unchecked cast. Any malformed
    // planner field that the heuristics / resolver consume would otherwise crash
    // downstream — e.g. `files.some(...)` on a non-array, or a bad `riskTier`
    // reaching resolveVerificationSequence — and, caught by the fail-closed
    // wrapper, masquerade as a `phase.blocked` RESOLVER fault. The shape guard
    // must reject every such field as INVALID_INPUT first.
    const malformed: Array<Record<string, unknown>> = [
      { id: 't1', title: 'ok', files: 'src/not-an-array.ts' }, // files: non-array (crash path)
      { id: 't2', title: 'ok', blockedBy: [1, 2] }, // blockedBy: non-string elements
      { id: 't3', title: 'ok', riskTier: 'critical' }, // riskTier: not a RiskTier (resolver throw)
      { id: 't4', title: 'ok', boundaryTouching: 'yes' }, // boundaryTouching: non-boolean
      { id: 't5', title: 'ok', testLayer: 'e2e' }, // testLayer: not in the enum
      { id: 7, title: 'ok' }, // id: non-string
    ];

    for (const bad of malformed) {
      const args = {
        featureId: 'feat-malformed',
        tasks: [bad],
      } as unknown as { featureId: string; tasks?: TaskInput[] };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success, `expected INVALID_INPUT for ${JSON.stringify(bad)}`).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.code).not.toBe('PHASE_BLOCKED');
    }
  });

  it('PrepareDelegation_NotReady_ReturnsBlockers', async () => {
    // Arrange
    const state = notReadyWorkflowState();
    setupMaterializer(state);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: Record<string, unknown>;
      blockers: string[];
    };
    expect(data.ready).toBe(false);
    expect(data.blockers).toBeDefined();
    expect(data.blockers.length).toBeGreaterThan(0);
    expect(data.readiness).toBeDefined();
  });

  it('PrepareDelegation_Ready_ReturnsTrue', async () => {
    // Arrange
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: Record<string, unknown>;
    };
    expect(data.ready).toBe(true);
    expect(data.readiness).toBeDefined();
    expect(data.readiness.plan).toBeDefined();
  });

  it('PrepareDelegation_ValidInput_ReturnsReadiness', async () => {
    // Arrange
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = {
      featureId: 'test-feature',
      tasks: [
        { id: 'task-1', title: 'Implement widget' },
        { id: 'task-2', title: 'Add tests' },
      ],
    };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: {
        plan: { approved: boolean; taskCount: number };
        quality: { queried: boolean };
      };
    };
    expect(data.readiness.plan.approved).toBe(true);
    expect(data.readiness.plan.taskCount).toBe(2);
    expect(data.readiness.quality.queried).toBe(true);
  });

  it('PrepareDelegation_QualityHints_IncludedInResult', async () => {
    // Arrange
    const state = readyWorkflowState();
    setupMaterializer(state);
    const hints = mockQualityHints();
    vi.mocked(generateQualityHints).mockReturnValue(
      hints as ReturnType<typeof generateQualityHints>,
    );
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      qualityHints: Array<{ category: string; severity: string; hint: string }>;
    };
    expect(data.ready).toBe(true);
    expect(data.qualityHints).toBeDefined();
    expect(data.qualityHints).toHaveLength(2);
    expect(data.qualityHints[0].category).toBe('gate');
    expect(data.qualityHints[0].severity).toBe('warning');
    expect(data.qualityHints[1].category).toBe('review');
  });

  it('PrepareDelegation_Ready_EmitsPlanCoverageGateEvent', async () => {
    // Arrange
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(emitGateEvent).toHaveBeenCalledOnce();
    expect(emitGateEvent).toHaveBeenCalledWith(
      expect.anything(), // store
      'test-feature',    // streamId
      'plan-coverage',   // gateName
      'planning',        // layer
      true,              // passed
      {
        dimension: 'D1',
        phase: 'delegate',
        taskCount: 2,
        gatePassRate: null,
      },
    );
  });

  it('PrepareDelegation_Ready_EmitsGateEvent_IncludesPhaseInDetails', async () => {
    // Arrange
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(emitGateEvent).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(emitGateEvent).mock.calls[0];
    const details = callArgs[5] as Record<string, unknown>;
    expect(details.phase).toBe('delegate');
  });

  it('PrepareDelegation_NotReady_DoesNotEmitGateEvent', async () => {
    // Arrange
    const state = notReadyWorkflowState();
    setupMaterializer(state);
    const args = { featureId: 'test-feature' };

    // Act
    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(emitGateEvent).not.toHaveBeenCalled();
  });

  // ─── T-08: DelegationReadinessView Consolidation ─────────────────────────

  it('HandlePrepareDelegation_ViewReady_ReturnsReadyWithHints', async () => {
    // Arrange: seed a ready delegation readiness view
    const state = readyWorkflowState();
    const drState = readyDelegationReadiness();
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      qualityHints: Array<{ category: string; severity: string; hint: string }>;
    };
    expect(data.ready).toBe(true);
    expect(data.readiness.ready).toBe(true);
    expect(data.readiness.blockers).toHaveLength(0);
    expect(data.readiness.worktrees).toBeDefined();
    expect(data.qualityHints).toBeDefined();
  });

  it('HandlePrepareDelegation_ViewNotReady_ReturnsBlockers', async () => {
    // Arrange: seed a not-ready delegation readiness view
    const state = notReadyWorkflowState();
    const drState = notReadyDelegationReadiness();
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      blockers: string[];
    };
    expect(data.ready).toBe(false);
    expect(data.blockers.length).toBeGreaterThan(0);
    expect(data.readiness.ready).toBe(false);
  });

  // DR-T-1 (T-03): plan-artifact blocker comes ONLY from the projection.
  // This replaces a previous test that asserted a handler-side supplementary
  // check fired when artifacts.plan was missing in workflow state. After T-03
  // the handler trusts the projection — single source of truth (#1205).
  it('HandlePrepareDelegation_BlockerList_MatchesDelegationReadinessView', async () => {
    // fix-003 (review #1213, T-03): true parity test — replay the SAME
    // event stream through both the handler (via the mocked materializer)
    // and `delegationReadinessProjection.apply` directly, then deep-equal
    // the resulting blockers arrays. Earlier revisions of this test only
    // asserted the handler did not append a supplementary blocker; they
    // never invoked the projection itself, so a divergence in the
    // projection's blocker generation could pass undetected.

    // ── Step 1: build a minimal event stream that exercises the
    // plan-artifact branch.
    // - workflow.transition → plan-review flips planReview.approved to true.
    // - state.patched without artifacts.plan keeps artifactPresent at false.
    // - task.assigned x2 + worktree.created x2 satisfy the worktree gate.
    const events: WorkflowEvent[] = [
      { type: 'workflow.transition', data: { to: 'plan-review' } } as unknown as WorkflowEvent,
      { type: 'task.assigned', data: { taskId: 'task-1' } } as unknown as WorkflowEvent,
      { type: 'task.assigned', data: { taskId: 'task-2' } } as unknown as WorkflowEvent,
      { type: 'worktree.created', data: { taskId: 'task-1', path: '/w/1' } } as unknown as WorkflowEvent,
      { type: 'worktree.created', data: { taskId: 'task-2', path: '/w/2' } } as unknown as WorkflowEvent,
    ];

    // ── Step 2: replay events through the projection — this is the
    // delegation_readiness view as a caller would observe it.
    let projectedView = delegationReadinessProjection.init();
    for (const ev of events) {
      projectedView = delegationReadinessProjection.apply(projectedView, ev);
    }

    // Sanity-check the projection: plan-artifact blocker must be present
    // (because no state.patched flipped artifactPresent), AND no worktree
    // pending (both created). If this ever stops being true the test
    // fixture needs updating.
    expect(projectedView.blockers).toContain('Plan artifact is missing');
    expect(projectedView.blockers.find(b => /worktrees pending/.test(b))).toBeUndefined();

    // ── Step 3: feed the SAME projection result into the handler. Workflow
    // state's `artifacts.plan` is irrelevant — the projection is authoritative.
    const state = {
      ...readyWorkflowState(),
      // Match projection's view of tasks: 2 entries, no plan artifact.
      artifacts: { design: 'design.md', plan: null, pr: null },
    };
    setupMaterializer(state, undefined, projectedView);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // ── Step 4: deep-equal the blocker arrays. The handler must not
    // mutate or supplement what the projection produced (no `tasks` arg
    // here, so the wave-scoping helper is a passthrough).
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      blockers: string[];
    };
    expect(data.readiness.blockers).toEqual(projectedView.blockers);
    expect(data.blockers).toEqual([...projectedView.blockers]);
  });

  it('HandlePrepareDelegation_ViewReady_NoSupplementaryPlanArtifactCheck', async () => {
    // Arrange: projection says ready (artifactPresent: true) but workflow
    // state lacks artifacts.plan. Handler must NOT add a side blocker.
    const state = {
      ...readyWorkflowState(),
      artifacts: { design: 'design.md', plan: null, pr: null },
    };
    const drState: DelegationReadinessState = {
      ready: true,
      blockers: [],
      plan: { approved: true, taskCount: 2, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 2, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; readiness: DelegationReadinessState };
    expect(data.ready).toBe(true);
    expect(data.readiness.blockers).toEqual([]);
  });

  // ─── DR-T-3 (T-06): state-vs-plan desync diagnostic ────────────────────

  it('PrepareDelegation_TaskCountExceedsStateTasks_AddsDesyncBlocker', async () => {
    // Projection has 33 task.assigned events (plan.taskCount = 33), but
    // workflow state has only 31 entries in tasks[]. Plan revision likely
    // added two without re-syncing state — surface the drift.
    const state = {
      ...readyWorkflowState(),
      tasks: Array.from({ length: 31 }, (_, i) => ({
        id: `T-${String(i + 1).padStart(3, '0')}`,
        title: `Task ${i + 1}`,
        status: 'pending',
      })),
    };
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: [],
      plan: { approved: true, taskCount: 33, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: {
        expected: 33, ready: 0, failed: [],
        assignedTaskIds: Array.from({ length: 33 }, (_, i) => `T-${String(i + 1).padStart(3, '0')}`),
        readyTaskIds: [],
      },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { readiness: DelegationReadinessState };
    const desync = data.readiness.blockers.find(b => /state-vs-plan desync/.test(b));
    expect(desync).toBeDefined();
    expect(desync).toContain('31');
    expect(desync).toContain('33');
  });

  it('PrepareDelegation_StateTasksExceedPlanCount_AddsDesyncBlocker', async () => {
    // Reverse: state has more entries than plan.taskCount. Either drift
    // direction triggers the diagnostic.
    const state = {
      ...readyWorkflowState(),
      tasks: Array.from({ length: 5 }, (_, i) => ({
        id: `t-${i}`,
        title: `T ${i}`,
        status: 'pending',
      })),
    };
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: [],
      plan: { approved: true, taskCount: 3, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: {
        expected: 3, ready: 0, failed: [],
        assignedTaskIds: ['t-0', 't-1', 't-2'],
        readyTaskIds: [],
      },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { readiness: DelegationReadinessState };
    expect(data.readiness.blockers.find(b => /state-vs-plan desync/.test(b))).toBeDefined();
  });

  it('PrepareDelegation_TaskCountMatchesStateTasks_NoDesyncBlocker', async () => {
    // Counts match — no drift, no diagnostic.
    const state = readyWorkflowState();
    setupMaterializer(state); // uses readyDelegationReadiness()
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { readiness: DelegationReadinessState };
    expect(data.readiness.blockers.find(b => /state-vs-plan desync/.test(b))).toBeUndefined();
  });

  it('PrepareDelegation_PlanTaskCountZero_NoDesyncBlockerEvenIfStateEmpty', async () => {
    // Initial state — no tasks anywhere yet. Diagnostic should not fire
    // at the empty-state baseline (blocker would be noise).
    const state = notReadyWorkflowState();
    setupMaterializer(state); // uses notReadyDelegationReadiness()
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { readiness: DelegationReadinessState };
    expect(data.readiness.blockers.find(b => /state-vs-plan desync/.test(b))).toBeUndefined();
  });

  // ─── DR-T-2 (T-05): wave-scoped worktree readiness ─────────────────────

  it('PrepareDelegation_TasksArgSubsetReady_NoBlocker', async () => {
    // Projection has 5 assigned, 3 ready (subset). tasks arg names the
    // 3 ready ones — wave is complete, no worktree blocker should fire.
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['2 worktrees pending'], // global view: 2 of 5 still pending
      plan: { approved: true, taskCount: 5, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: {
        expected: 5, ready: 3, failed: [],
        assignedTaskIds: ['t1', 't2', 't3', 't4', 't5'],
        readyTaskIds: ['t1', 't2', 't3'],
      },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = {
      featureId: 'test-feature',
      tasks: [
        { id: 't1', title: 'A' },
        { id: 't2', title: 'B' },
        { id: 't3', title: 'C' },
      ],
    };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; readiness: DelegationReadinessState };
    expect(data.ready).toBe(true);
    // fix-006 (review #1213): explicit predicate avoids the
    // `not.toContain(expect.stringContaining(...))` asymmetric-matcher
    // construction whose semantics vary across vitest versions.
    expect(data.readiness.blockers.find(b => /worktrees pending/.test(b))).toBeUndefined();
  });

  it('PrepareDelegation_TasksArgSubsetPending_ExactPendingCountInBlocker', async () => {
    // Projection has 33 assigned, 0 ready. tasks arg names 3 pending.
    // Blocker should report 3 worktrees pending, not 33.
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['33 worktrees pending'],
      plan: { approved: true, taskCount: 33, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: {
        expected: 33, ready: 0, failed: [],
        assignedTaskIds: Array.from({ length: 33 }, (_, i) => `T-${String(i + 1).padStart(3, '0')}`),
        readyTaskIds: [],
      },
    };
    setupMaterializer(state, undefined, drState);
    const args = {
      featureId: 'test-feature',
      tasks: [
        { id: 'T-001', title: 'A' },
        { id: 'T-002', title: 'B' },
        { id: 'T-003', title: 'C' },
      ],
    };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; readiness: DelegationReadinessState; blockers: string[] };
    expect(data.ready).toBe(false);
    expect(data.readiness.blockers).toContain('3 worktrees pending');
    expect(data.readiness.blockers).not.toContain('33 worktrees pending');
  });

  it('PrepareDelegation_NoTasksArg_AllAssignedConsidered', async () => {
    // Without tasks arg, the global blocker passes through unchanged.
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['10 worktrees pending'],
      plan: { approved: true, taskCount: 10, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: {
        expected: 10, ready: 0, failed: [],
        assignedTaskIds: Array.from({ length: 10 }, (_, i) => `t-${i}`),
        readyTaskIds: [],
      },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' }; // no tasks arg

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; readiness: DelegationReadinessState };
    expect(data.readiness.blockers).toContain('10 worktrees pending');
  });

  // fix-005 (review #1213): wave-scoping must update both blockers AND the
  // numeric worktrees.expected/ready surfaces, not just the blocker strings.
  // Plan T-05 specified a pure helper computeScopedWorktrees(readiness,
  // tasksFilter) returning { expected, ready, pending } so all three counts
  // stay in lockstep. This test asserts effectiveReadiness.worktrees mirrors
  // the wave subset rather than the global stream-wide count.
  it('PrepareDelegation_TasksArgSubset_EffectiveReadinessReportsScopedWorktreeCounts', async () => {
    // Projection has 5 assigned, 2 ready (global). The wave names 3 of those
    // 5 — 2 ready, 1 pending. Effective readiness must report
    // worktrees.expected === 3 and worktrees.ready === 2 (NOT 5/2).
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['3 worktrees pending'], // global view: 3 of 5 still pending
      plan: { approved: true, taskCount: 5, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: {
        expected: 5, ready: 2, failed: [],
        assignedTaskIds: ['t1', 't2', 't3', 't4', 't5'],
        readyTaskIds: ['t1', 't2'],
      },
    };
    setupMaterializer(state, undefined, drState);
    const args = {
      featureId: 'test-feature',
      tasks: [
        { id: 't1', title: 'A' }, // ready
        { id: 't2', title: 'B' }, // ready
        { id: 't3', title: 'C' }, // pending
      ],
    };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; readiness: DelegationReadinessState };
    // Wave size is 3 (not 5). One pending in the wave (t3).
    expect(data.readiness.worktrees.expected).toBe(args.tasks.length);
    expect(data.readiness.worktrees.expected).toBe(3);
    expect(data.readiness.worktrees.ready).toBe(2);
    // Blocker reports the wave-scoped pending count.
    expect(data.readiness.blockers).toContain('1 worktrees pending');
    expect(data.readiness.blockers).not.toContain('3 worktrees pending');
  });

  // ─── DR-5: nativeIsolation readiness.blockers consistency ─────────────────

  it('handlePrepareDelegation_NativeIsolation_ExcludesWorktreeBlockers', async () => {
    // Arrange: ONLY worktree-related blockers present
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['worktrees pending', 'no worktrees expected'],
      plan: { approved: true, taskCount: 2, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: ready=true AND readiness.blockers is empty (consistent)
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
    };
    expect(data.ready).toBe(true);
    expect(data.readiness.ready).toBe(true);
    expect(data.readiness.blockers).toEqual([]);
  });

  it('handlePrepareDelegation_NativeIsolation_PreservesNonWorktreeBlockers', async () => {
    // Arrange: BOTH worktree AND non-worktree blockers
    const state = notReadyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['plan not approved', 'worktrees pending'],
      plan: { approved: false, taskCount: 0, artifactPresent: false },
      quality: { queried: false, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: readiness.blockers contains ONLY non-worktree items
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      blockers: string[];
    };
    expect(data.ready).toBe(false);
    expect(data.readiness.ready).toBe(false);
    expect(data.readiness.blockers).not.toContainEqual(
      expect.stringContaining('worktrees'),
    );
    expect(data.readiness.blockers).toContain('plan not approved');
  });

  it('handlePrepareDelegation_WithoutNativeIsolation_IncludesAllBlockers', async () => {
    // Arrange: both worktree AND non-worktree blockers, no nativeIsolation
    const state = notReadyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['plan not approved', 'worktrees pending'],
      plan: { approved: false, taskCount: 0, artifactPresent: false },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: ALL blockers present including worktree ones
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      blockers: string[];
    };
    expect(data.ready).toBe(false);
    expect(data.readiness.blockers).toContain('plan not approved');
    expect(data.readiness.blockers).toContain('worktrees pending');
    // Plan artifact missing now comes from the projection itself (T-02);
    // the handler does not emit a supplementary copy (T-03).
    // (This fixture's drState.blockers does not include it, so it should NOT appear here.)
  });

  // ─── T-15: nativeIsolation parameter ──────────────────────────────────────

  it('PrepareDelegation_NativeIsolationTrue_SkipsWorktreeBlockers', async () => {
    // Arrange: worktrees not ready, but nativeIsolation skips those blockers
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['no worktrees expected'],
      plan: { approved: true, taskCount: 2, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 0, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — should be ready despite worktree blockers
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; isolation: string; blockers?: string[] };
    expect(data.ready).toBe(true);
    expect(data.isolation).toBe('native');
  });

  // ─── #1509/#1501: native-isolation worktree base-pin guard ────────────────

  it('PrepareDelegation_NativeIsolation_BaseRefUnset_BlocksWithRemediation', async () => {
    // Arrange: nativeIsolation requested, but worktree.baseRef is NOT pinned to
    // "head" — Claude Code would branch the subagent worktree from main.
    const state = readyWorkflowState();
    setupMaterializer(state, undefined, readyDelegationReadiness());
    vi.mocked(assertWorktreeBaseRefPinned).mockReturnValue({
      pinned: false,
      effective: null,
      checked: ['/repo/.claude/settings.local.json', '/repo/.claude/settings.json'],
      reason: 'worktree-baseref-unset',
      remediation: { file: '.claude/settings.json', patch: { worktree: { baseRef: 'head' } } },
      hint: 'set worktree.baseRef:"head"',
    });
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — dispatch is blocked loud, with the exact remediation
    expect(result.success).toBe(true);
    const data = result.data as {
      blocked: boolean;
      reason: string;
      effective: string | null;
      remediation: { file: string; patch: unknown };
    };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('worktree-baseref-unset');
    expect(data.effective).toBeNull();
    expect(data.remediation).toEqual({
      file: '.claude/settings.json',
      patch: { worktree: { baseRef: 'head' } },
    });
  });

  it('PrepareDelegation_NativeIsolation_BaseRefPinned_RunsGuardAndProceeds', async () => {
    // Arrange: nativeIsolation with baseRef pinned (default mock) → proceeds.
    const state = readyWorkflowState();
    setupMaterializer(state, undefined, readyDelegationReadiness());
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — guard ran on the native path, dispatch proceeds
    expect(assertWorktreeBaseRefPinned).toHaveBeenCalled();
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; isolation?: string; blocked?: boolean };
    expect(data.blocked).toBeUndefined();
    expect(data.ready).toBe(true);
    expect(data.isolation).toBe('native');
  });

  it('PrepareDelegation_NonNativeIsolation_DoesNotRunBaseRefGuard', async () => {
    // Arrange: default (non-native) path — the baseRef guard is irrelevant
    // (exarchos manages the worktree base explicitly via setup_worktree).
    const state = readyWorkflowState();
    setupMaterializer(state, undefined, readyDelegationReadiness());
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — guard never consulted on the non-native path
    expect(assertWorktreeBaseRefPinned).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('PrepareDelegation_NativeIsolationFalse_PreservesWorktreeBlockers', async () => {
    // Arrange: worktrees not ready, nativeIsolation false (default)
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['no worktrees expected'],
      plan: { approved: true, taskCount: 2, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 0, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — should NOT be ready because of worktree blockers
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; blockers?: string[]; isolation?: string };
    expect(data.ready).toBe(false);
    expect(data.blockers).toContain('no worktrees expected');
    expect(data.isolation).toBeUndefined();
  });

  it('PrepareDelegation_NativeIsolationTrue_StillTracksState', async () => {
    // Arrange: nativeIsolation but plan not approved — non-worktree blockers still apply
    const state = notReadyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['plan not approved', 'no worktrees expected'],
      plan: { approved: false, taskCount: 0, artifactPresent: false },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 0, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — still not ready because plan not approved (non-worktree blocker persists)
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; blockers?: string[]; readiness: DelegationReadinessState };
    expect(data.ready).toBe(false);
    expect(data.blockers).toContain('plan not approved');
    expect(data.readiness).toBeDefined();
  });

  it('PrepareDelegation_NativeIsolationTrue_StillRunsPreChecks', async () => {
    // Arrange: nativeIsolation with ready state — quality hints still assembled
    const state = readyWorkflowState();
    const drState = readyDelegationReadiness();
    setupMaterializer(state, undefined, drState);
    const hints = mockQualityHints();
    vi.mocked(generateQualityHints).mockReturnValue(
      hints as ReturnType<typeof generateQualityHints>,
    );
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — quality hints still present
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      isolation: string;
      qualityHints: Array<{ category: string; severity: string; hint: string }>;
    };
    expect(data.ready).toBe(true);
    expect(data.isolation).toBe('native');
    expect(data.qualityHints).toHaveLength(2);
    expect(generateQualityHints).toHaveBeenCalled();
  });

  it('HandlePrepareDelegation_ReadinessIncludesWorktreeData', async () => {
    // Arrange: ready state with worktree data
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ...readyDelegationReadiness(),
      worktrees: { expected: 3, ready: 3, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      readiness: DelegationReadinessState;
    };
    expect(data.readiness.worktrees.expected).toBe(3);
    expect(data.readiness.worktrees.ready).toBe(3);
    expect(data.readiness.worktrees.failed).toHaveLength(0);
  });

  // ─── DR-1: Ancestry Check Integration ───────────────────────────────────

  it('handlePrepareDelegation_AncestryCheckFails_ReturnsBlocked', async () => {
    // Arrange: ancestry check returns blocked
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: false,
      blocked: true,
      reason: 'ancestry',
      missing: ['main'],
    });
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      blocked: boolean;
      reason: string;
      missing: string[];
    };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('ancestry');
    expect(data.missing).toContain('main');
  });

  it('handlePrepareDelegation_AncestryCheckPasses_ProceedsToClassification', async () => {
    // Arrange: ancestry check passes
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: true,
      checks: ['ancestry'],
    });
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = {
      featureId: 'test-feature',
      tasks: [
        { id: 'task-1', title: 'Implement widget' },
      ],
    };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — proceeds past ancestry check, returns readiness data
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      taskClassifications: TaskClassification[];
    };
    expect(data.ready).toBe(true);
    expect(data.readiness).toBeDefined();
    expect(data.taskClassifications).toBeDefined();
  });

  // ─── DR-2: Worktree Assertion Integration ─────────────────────────────────

  it('handlePrepareDelegation_InSubagentWorktree_ReturnsBlocked', async () => {
    // Arrange: assertMainWorktree returns isMain=false (subagent worktree)
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: false,
      actual: '/repo/.claude/worktrees/agent-abc123',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      blocked: boolean;
      reason: string;
      actual: string;
      expected: string;
    };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('worktree-location');
    expect(data.actual).toBe('/repo/.claude/worktrees/agent-abc123');
    expect(data.expected).toBeDefined();
  });

  // ─── #1129 C: Current-Branch Protection ────────────────────────────────
  it('handlePrepareDelegation_OnProtectedBranch_ReturnsBlockedAndEmitsPreflightBlocked', async () => {
    // Arrange: current branch is main (protected)
    const state = readyWorkflowState();
    const { mockStore } = setupMaterializer(state);
    vi.mocked(getCurrentBranch).mockReturnValueOnce('main');
    vi.mocked(assertCurrentBranchNotProtected).mockReturnValueOnce({
      blocked: true,
      reason: 'current-branch-protected',
      currentBranch: 'main',
    });
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: blocked with the dedicated reason — ancestry never even runs
    expect(result.success).toBe(true);
    const data = result.data as {
      blocked: boolean;
      reason: string;
      currentBranch: string;
    };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');
    expect(data.currentBranch).toBe('main');
    expect(vi.mocked(validateBranchAncestry)).not.toHaveBeenCalled();

    const preflightEvent = mockStore.append.mock.calls.find(
      (call: unknown[]) => (call[1] as { type: string }).type === 'preflight.blocked',
    );
    expect(preflightEvent).toBeDefined();
    const eventData = (preflightEvent![1] as { type: string; data: Record<string, unknown> }).data;
    expect(eventData.reason).toBe('current-branch-protected');
  });

  // ─── #1129 D: integrationBranch fallback safety ─────────────────────────
  it('handlePrepareDelegation_IntegrationBranchUnset_UsesCurrentBranchNotFeatureId', async () => {
    // Arrange: synthesis.integrationBranch unset; current branch known
    const state = readyWorkflowState() as ReturnType<typeof readyWorkflowState> & {
      synthesis?: { integrationBranch?: string };
    };
    delete state.synthesis;
    setupMaterializer(state);
    vi.mocked(getCurrentBranch).mockReturnValueOnce('feature/real-branch');
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: true,
      checks: ['ancestry'],
    });
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = {
      featureId: 'dogfood-v280',  // not a real branch name
      tasks: [{ id: 'task-1', title: 'x' }],
    };

    // Act
    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: ancestry ran against current branch, never against featureId
    const call = vi.mocked(validateBranchAncestry).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![0]).toBe('feature/real-branch');
    expect(call![0]).not.toBe('dogfood-v280');
  });

  it('handlePrepareDelegation_InMainWorktree_ProceedsNormally', async () => {
    // Arrange: assertMainWorktree returns isMain=true
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: true,
      actual: '/home/user/repo',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert — proceeds normally, returns readiness
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
    };
    expect(data.ready).toBe(true);
    expect(data.readiness).toBeDefined();
  });

  // ─── DR-1/DR-2: Preflight Event Emissions ────────────────────────────────

  it('handlePrepareDelegation_AncestryPasses_EmitsPreflightExecutedEvent', async () => {
    // Arrange: ancestry and worktree checks pass, ready state
    const state = readyWorkflowState();
    const { mockStore } = setupMaterializer(state);
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: true,
      checks: ['ancestry'],
    });
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: true,
      actual: '/home/user/repo',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: preflight.executed event emitted
    const appendCalls = mockStore.append.mock.calls;
    const preflightEvent = appendCalls.find(
      (call: unknown[]) => (call[1] as { type: string }).type === 'preflight.executed',
    );
    expect(preflightEvent).toBeDefined();
    const eventData = (preflightEvent![1] as { type: string; data: Record<string, unknown> }).data;
    expect(eventData.checks).toContain('ancestry');
    expect(eventData.checks).toContain('worktree');
    expect(eventData.passed).toBe(true);
    expect(eventData.integrationBranch).toBeDefined();
  });

  it('handlePrepareDelegation_AncestryBlocked_EmitsPreflightBlockedEvent', async () => {
    // Arrange: ancestry check fails
    const state = readyWorkflowState();
    const { mockStore } = setupMaterializer(state);
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: false,
      blocked: true,
      reason: 'ancestry',
      missing: ['main'],
    });
    const args = { featureId: 'test-feature' };

    // Act
    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: preflight.blocked event emitted
    const appendCalls = mockStore.append.mock.calls;
    const preflightEvent = appendCalls.find(
      (call: unknown[]) => (call[1] as { type: string }).type === 'preflight.blocked',
    );
    expect(preflightEvent).toBeDefined();
    const eventData = (preflightEvent![1] as { type: string; data: Record<string, unknown> }).data;
    expect(eventData.reason).toBe('ancestry');
    expect((eventData.details as { missing: string[] }).missing).toContain('main');
  });

  it('handlePrepareDelegation_WorktreeBlocked_EmitsPreflightBlockedEvent', async () => {
    // Arrange: ancestry passes but worktree check fails
    const state = readyWorkflowState();
    const { mockStore } = setupMaterializer(state);
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: true,
      checks: ['ancestry'],
    });
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: false,
      actual: '/repo/.claude/worktrees/agent-xyz',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    const args = { featureId: 'test-feature' };

    // Act
    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: preflight.blocked event emitted
    const appendCalls = mockStore.append.mock.calls;
    const preflightEvent = appendCalls.find(
      (call: unknown[]) => (call[1] as { type: string }).type === 'preflight.blocked',
    );
    expect(preflightEvent).toBeDefined();
    const eventData = (preflightEvent![1] as { type: string; data: Record<string, unknown> }).data;
    expect(eventData.reason).toBe('worktree-location');
    const details = eventData.details as { actual: string; expected: string };
    expect(details.actual).toBe('/repo/.claude/worktrees/agent-xyz');
    expect(details.expected).toBeDefined();
  });

  // ─── DR-5: Checkpoint Gate Integration ──────────────────────────────────

  it('handlePrepareDelegation_AboveThreshold_ReturnsCheckpointRequired', async () => {
    // Arrange: operationsSince above threshold — gate should block
    const state = readyWorkflowState();
    const { mockStore } = setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    vi.mocked(shouldEnforceCheckpoint).mockReturnValue({
      gated: true,
      gate: 'checkpoint_required',
      operationsSince: 25,
      threshold: 20,
    });
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: gated response
    expect(result.success).toBe(true);
    const data = result.data as {
      gated: boolean;
      gate: string;
      operationsSince: number;
      threshold: number;
    };
    expect(data.gated).toBe(true);
    expect(data.gate).toBe('checkpoint_required');
    expect(data.operationsSince).toBe(25);
    expect(data.threshold).toBe(20);

    // Assert: checkpoint.enforced event emitted
    const appendCalls = mockStore.append.mock.calls;
    const enforcedEvent = appendCalls.find(
      (call: unknown[]) => (call[1] as { type: string }).type === 'checkpoint.enforced',
    );
    expect(enforcedEvent).toBeDefined();
    const eventData = (enforcedEvent![1] as { type: string; data: Record<string, unknown> }).data;
    expect(eventData.operationsSince).toBe(25);
    expect(eventData.threshold).toBe(20);
    expect(eventData.blockedAction).toBe('wave-dispatch');
  });

  it('handlePrepareDelegation_BelowThreshold_ProceedsNormally', async () => {
    // Arrange: operationsSince below threshold — gate should not block
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    vi.mocked(shouldEnforceCheckpoint).mockReturnValue({
      gated: false,
    });
    const args = {
      featureId: 'test-feature',
      tasks: [
        { id: 'task-1', title: 'Implement widget' },
      ],
    };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    // Assert: proceeds to task classification — not gated
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      taskClassifications: TaskClassification[];
    };
    expect(data.ready).toBe(true);
    expect(data.readiness).toBeDefined();
    expect(data.taskClassifications).toBeDefined();
    expect(data.taskClassifications).toHaveLength(1);
  });

  // ─── Task Classification ─────────────────────────────────────────────────

  describe('Task classification', () => {
    it('PrepareDelegation_WithTasks_ReturnsTaskClassifications', async () => {
      // Arrange: ready state with tasks
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        tasks: [
          { id: 'task-1', title: 'Implement widget' },
          { id: 'task-2', title: 'Add tests' },
        ],
      };

      // Act
      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        ready: boolean;
        taskClassifications: TaskClassification[];
      };
      expect(data.ready).toBe(true);
      expect(data.taskClassifications).toBeDefined();
      expect(data.taskClassifications).toHaveLength(2);
      expect(data.taskClassifications[0].taskId).toBe('task-1');
      expect(data.taskClassifications[1].taskId).toBe('task-2');
    });

    it('TaskClassification_ScaffoldingTitle_ReturnsLowScaffolder', () => {
      // Arrange
      const task = { id: 'task-1', title: 'Stub out the API interface' };

      // Act
      const classification = classifyTask(task);

      // Assert
      expect(classification.taskId).toBe('task-1');
      expect(classification.complexity).toBe('low');
      expect(classification.recommendedAgent).toBe('scaffolder');
      expect(classification.effort).toBe('low');
      expect(classification.reason).toBeDefined();
    });

    it('TaskClassification_BoilerplateTitle_ReturnsLowScaffolder', () => {
      // Arrange: test multiple scaffolding keywords
      const tasks = [
        { id: 't-1', title: 'Generate boilerplate for the service' },
        { id: 't-2', title: 'Create type def for the API' },
        { id: 't-3', title: 'Define the interface for the data layer' },
        { id: 't-4', title: 'Scaffold the test harness' },
      ];

      // Act & Assert
      for (const task of tasks) {
        const classification = classifyTask(task);
        expect(classification.complexity).toBe('low');
        expect(classification.recommendedAgent).toBe('scaffolder');
        expect(classification.effort).toBe('low');
      }
    });

    it('TaskClassification_MultiDependencyTask_ReturnsHighImplementer', () => {
      // Arrange: task with >= 2 blockedBy entries
      const task = {
        id: 'task-1',
        title: 'Integrate payment system',
        blockedBy: ['task-a', 'task-b'],
      };

      // Act
      const classification = classifyTask(task);

      // Assert
      expect(classification.complexity).toBe('high');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.effort).toBe('high');
      expect(classification.reason).toBeDefined();
    });

    it('TaskClassification_ManyFiles_ReturnsHighImplementer', () => {
      // Arrange: task with >= 3 files
      const task = {
        id: 'task-1',
        title: 'Refactor data access layer',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      };

      // Act
      const classification = classifyTask(task);

      // Assert
      expect(classification.complexity).toBe('high');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.effort).toBe('high');
    });

    it('TaskClassification_StandardTask_ReturnsMediumImplementer', () => {
      // Arrange: task with no special markers
      const task = { id: 'task-1', title: 'Add validation logic' };

      // Act
      const classification = classifyTask(task);

      // Assert
      expect(classification.complexity).toBe('medium');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.effort).toBe('medium');
    });

    it('PrepareDelegation_NoTasks_OmitsClassifications', async () => {
      // Arrange: ready state, no tasks arg
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = { featureId: 'test-feature' };

      // Act
      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.ready).toBe(true);
      expect(data.taskClassifications).toBeUndefined();
    });

    // ─── T-003: testLayer effort mapping ──────────────────────────────────────

    it('classifyTask_AcceptanceTestLayer_ReturnsHighEffort', () => {
      // Arrange
      const task = { id: 'T-001', title: 'Write acceptance test', testLayer: 'acceptance' as const };

      // Act
      const classification = classifyTask(task);

      // Assert
      expect(classification.effort).toBe('high');
      expect(classification.complexity).toBe('high');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.reason.toLowerCase()).toContain('acceptance');
    });

    it('classifyTask_IntegrationTestLayer_ReturnsMediumImplementer', () => {
      // Arrange — integration tasks short-circuit to medium/implementer regardless of deps
      const task = {
        id: 'T-002',
        title: 'Integration test',
        testLayer: 'integration' as const,
        blockedBy: ['T-001', 'T-003'],
      };

      // Act
      const classification = classifyTask(task);

      // Assert
      expect(classification.effort).toBe('medium');
      expect(classification.recommendedAgent).toBe('implementer');
    });

    it('classifyTask_IntegrationTestLayerLowDeps_ReturnsMediumEffort', () => {
      // Arrange
      const task = {
        id: 'T-002',
        title: 'Integration test',
        testLayer: 'integration' as const,
      };

      // Act
      const classification = classifyTask(task);

      // Assert
      expect(classification.effort).toBe('medium');
    });

    it('classifyTask_UnitTestLayer_FallsBackToExistingHeuristics', () => {
      // Arrange
      const task = { id: 'T-003', title: 'Unit test for parser', testLayer: 'unit' as const };

      // Act
      const classification = classifyTask(task);

      // Assert — falls through to default heuristic (no scaffolding keywords, no deps, no files)
      expect(classification.effort).toBe('medium');
    });

    it('classifyTask_NoTestLayer_UnchangedBehavior', () => {
      // Arrange — no testLayer, title has scaffolding keyword
      const task = { id: 'T-004', title: 'stub boilerplate' };

      // Act
      const classification = classifyTask(task, DEFAULTS.agents);

      // Assert — existing scaffolding behavior preserved
      expect(classification.effort).toBe('low');
      expect(classification.recommendedAgent).toBe('scaffolder');
    });
  });

  // ─── Verification-policy stamp (vls1-b2 / task 003) ───────────────────────
  //
  // classifyTask must stamp the CONFIG-RESOLVED verification sequence
  // (resolveVerificationPolicy) rather than the frozen built-in table
  // (resolveVerificationSequence). When no config is supplied the stamp must
  // be byte-identical to the built-in path.
  describe('classifyTask — verification-policy stamp', () => {
    /** A deep-mutable config seeded from DEFAULTS with a custom medium cell. */
    function configWithMediumPolicy(sequence: readonly GateName[]): ResolvedProjectConfig {
      const config = structuredClone(DEFAULTS) as ResolvedProjectConfig;
      // structuredClone drops nothing here; override only the medium cell so
      // the boundary axis + other cells still fall through to the base table.
      (config.verification.policy as { medium?: readonly GateName[] }).medium = [...sequence];
      return config;
    }

    it('ClassifyTask_NoVerificationConfig_StampsBuiltinSequence', () => {
      // Arrange — a medium-risk, non-boundary task (default heuristic), no config.
      const task: TaskInput = { id: 'T-100', title: 'Implement feature X' };

      // Act
      const classification = classifyTask(task);

      // Assert — characterization: byte-identical to the built-in table.
      const expected = resolveVerificationSequence(
        classification.riskTier,
        classification.boundaryTouching,
      );
      expect(classification.verificationSequence).toEqual(expected);
    });

    it('ClassifyTask_ConfiguredPolicyCell_StampsConfigResolvedSequence', () => {
      // Arrange — task derives to medium/non-boundary; config overrides medium.
      const customSequence: readonly GateName[] = [
        'check_static_analysis',
        'check_mock_boundary',
      ];
      const task: TaskInput = { id: 'T-101', title: 'Implement feature Y' };
      const config = configWithMediumPolicy(customSequence);

      // Pre-assert the task lands in the medium cell so the override applies.
      const baseline = classifyTask(task);
      expect(baseline.riskTier).toBe('medium');
      expect(baseline.boundaryTouching).toBe(false);

      // Act
      const classification = classifyTask(task, DEFAULTS.agents, config);

      // Assert — the configured cell is stamped verbatim (full replacement).
      expect(classification.verificationSequence).toEqual(customSequence);
      // And it diverges from the built-in table the no-config path would stamp.
      expect(classification.verificationSequence).not.toEqual(baseline.verificationSequence);
    });
  });

  // task-004 (DR-4): classifyTask now resolves its verification sequence by
  // routing through resolveGateSet('IMPLEMENT', …) instead of calling
  // resolveVerificationPolicy directly. Because the IMPLEMENT kind's resolver is
  // wired to delegate verbatim to resolveVerificationPolicy, the stamped
  // sequence must remain byte-identical across representative task profiles —
  // i.e. the routing is purely behavior-neutral plumbing.
  describe('classifyTask — resolver-routing behavior-neutrality (task-004)', () => {
    const profiles: ReadonlyArray<{
      readonly label: string;
      readonly riskTier: RiskTier;
      readonly boundaryTouching: boolean;
    }> = [
      { label: 'low / no-boundary', riskTier: 'low', boundaryTouching: false },
      { label: 'medium / no-boundary', riskTier: 'medium', boundaryTouching: false },
      { label: 'high / boundary', riskTier: 'high', boundaryTouching: true },
    ];

    it('ClassifyTask_VerificationSequence_UnchangedByResolverRouting', () => {
      for (const { label, riskTier, boundaryTouching } of profiles) {
        // Arrange — explicit risk/boundary overrides pin the profile so the
        // derivation heuristic does not influence the comparison.
        const task: TaskInput = {
          id: `T-NEUTRAL-${label}`,
          title: 'Implement feature under neutrality check',
          riskTier,
          boundaryTouching,
        };

        // Act
        const classification = classifyTask(task);

        // Assert — byte-identical to the pre-routing builtin behavior.
        const expected = resolveVerificationPolicy(riskTier, boundaryTouching).sequence;
        expect(classification.verificationSequence, label).toEqual(expected);
      }
    });
  });

  describe('handler config threading', () => {
    it('PrepareDelegation_ConfiguredPolicy_StampsConfigSequenceOnClassifications', async () => {
      // R7-inheritance proof: the config-resolved sequence flows onto the
      // taskClassifications records the handler returns (prompt assembly
      // downstream reads exactly this stamp).
      // Arrange
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const customSequence: readonly GateName[] = [
        'check_static_analysis',
        'check_contract_drift',
      ];
      const config = structuredClone(DEFAULTS) as ResolvedProjectConfig;
      (config.verification.policy as { medium?: readonly GateName[] }).medium = [...customSequence];

      const args = {
        featureId: 'test-feature',
        // A title with no scaffolding keywords / deps / files derives to medium.
        tasks: [{ id: 'task-1', title: 'Implement widget' }],
      };
      const ctx = {
        stateDir: STATE_DIR,
        eventStore: mockStore as never,
        enableTelemetry: false,
        projectConfig: config,
      };

      // Act
      const result = await handlePrepareDelegation(args, STATE_DIR, ctx as never);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      const stamped = data.taskClassifications[0];
      expect(stamped.riskTier).toBe('medium');
      expect(stamped.verificationSequence).toEqual(customSequence);
    });

    it('PrepareDelegation_WithTasks_ClassificationsIncludeRecommendedModel', async () => {
      // Arrange
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        tasks: [
          { id: 'task-1', title: 'Implement widget' },
          { id: 'task-2', title: 'Stub boilerplate' },
        ],
      };

      // Act
      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      expect(data.taskClassifications).toBeDefined();
      for (const tc of data.taskClassifications) {
        expect(tc.recommendedModel).toBeDefined();
        expect(['opus', 'sonnet', 'haiku']).toContain(tc.recommendedModel);
      }
    });

    it('PrepareDelegation_WithCtx_UsesProjectConfigForModelResolution', async () => {
      // Arrange
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        tasks: [
          { id: 'task-1', title: 'Scaffold the interface' },
          { id: 'task-2', title: 'Implement handler' },
        ],
      };
      const ctx = {
        stateDir: STATE_DIR,
        eventStore: {} as never,
        enableTelemetry: false,
        projectConfig: {
          agents: {
            defaultModel: 'sonnet' as const,
            models: { scaffolder: 'haiku' as const },
          },
        } as never,
      };

      // Act
      const result = await handlePrepareDelegation(args, STATE_DIR, ctx as never);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      const scaffolderTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'scaffolder');
      const implementerTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'implementer');
      expect(scaffolderTask?.recommendedModel).toBe('haiku');
      expect(implementerTask?.recommendedModel).toBe('sonnet');
    });

    it('PrepareDelegation_WithoutCtx_UsesDefaults', async () => {
      // Arrange
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        tasks: [
          { id: 'task-1', title: 'Scaffold boilerplate' },
          { id: 'task-2', title: 'Implement handler' },
        ],
      };

      // Act -- no ctx passed
      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      // Assert -- uses DEFAULTS.agents
      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      const scaffolderTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'scaffolder');
      const implementerTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'implementer');
      expect(scaffolderTask?.recommendedModel).toBe('haiku');   // DEFAULTS.agents.models.scaffolder
      expect(implementerTask?.recommendedModel).toBe('opus');   // DEFAULTS.agents.defaultModel
    });
  });

  // ─── DR-7: Fail-Closed at the Gate-Set Boundary ──────────────────────────
  //
  // The wave-dispatch boundary stamps each task's verification sequence by
  // routing through `resolveGateSet('IMPLEMENT', …)`. That call was previously
  // UNGUARDED: a resolver throw (e.g. a deferred-kind 'not-yet-wired' fault, or
  // any resolver error) propagated out of the handler and the dispatch failed
  // OPEN / silently. DR-7 makes the boundary FAIL CLOSED: append a
  // `phase.blocked` event carrying a visible skip reason, and refuse to proceed
  // (structured error envelope, NO task classifications stamped).
  describe('fail-closed gate-set boundary (DR-7)', () => {
    it('ResolveGateSet_ResolverThrows_AppendsPhaseBlocked', async () => {
      // Arrange: a ready workflow with a single implement task. Force the
      // IMPLEMENT-kind resolver to throw at the dispatch boundary.
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const localStore = {
        query: vi.fn().mockResolvedValue([]),
        append: vi.fn().mockResolvedValue(undefined),
        listStreams: vi.fn().mockReturnValue(null),
      };
      const boom = new Error(
        "resolveGateSet: resolver 'plan-structure' is not wired yet (deferred to S3)",
      );
      vi.mocked(resolveGateSet).mockImplementationOnce(() => {
        throw boom;
      });
      const args = {
        featureId: 'test-feature',
        tasks: [{ id: 'task-1', title: 'Implement widget' }],
      };

      // Act
      const result = await handlePrepareDelegation(
        args,
        STATE_DIR,
        makeCtx(localStore, STATE_DIR),
      );

      // Assert: dispatch did NOT proceed — structured error envelope, and
      // CRUCIALLY no taskClassifications were stamped (fail closed).
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PHASE_BLOCKED');
      // Visible skip reason surfaced to the operator.
      expect(result.error?.message).toMatch(/gate|resolve|blocked|verification/i);
      const data = (result.data ?? {}) as { taskClassifications?: unknown };
      expect(data.taskClassifications).toBeUndefined();

      // A `phase.blocked` event was appended carrying a visible skip reason.
      const blockedCall = localStore.append.mock.calls.find(
        (c) => (c[1] as { type?: string }).type === 'phase.blocked',
      );
      expect(blockedCall, 'expected a phase.blocked event to be appended').toBeDefined();
      const blockedEvent = blockedCall![1] as {
        type: string;
        data: { phase: string; kind: string; reason: string; error: { code: string; message: string } };
      };
      expect(blockedEvent.data.kind).toBe('IMPLEMENT');
      expect(blockedEvent.data.reason.length).toBeGreaterThan(0);
      expect(blockedEvent.data.error.message).toContain('not wired');
    });
  });

  describe('classifyTask model resolution', () => {
    it('classifyTask_WithAgentConfig_ScaffolderGetsConfiguredModel', () => {
      const config = { defaultModel: 'opus' as const, models: { scaffolder: 'haiku' as const } };
      const result = classifyTask({ id: '001', title: 'Stub out the API interface' }, config);
      expect(result.recommendedModel).toBe('haiku');
    });

    it('classifyTask_WithAgentConfig_ImplementerGetsConfiguredModel', () => {
      const config = { defaultModel: 'opus' as const, models: { implementer: 'opus' as const } };
      const result = classifyTask({ id: '002', title: 'Implement auth handler' }, config);
      expect(result.recommendedModel).toBe('opus');
    });

    it('classifyTask_WithAgentConfig_FallsBackToDefaultModel', () => {
      const config = { defaultModel: 'sonnet' as const, models: {} };
      const result = classifyTask({ id: '003', title: 'Implement feature X' }, config);
      expect(result.recommendedModel).toBe('sonnet');
    });

    it('classifyTask_WithAgentConfig_PerAgentOverridesDefault', () => {
      const config = { defaultModel: 'opus' as const, models: { scaffolder: 'haiku' as const } };
      // scaffolder task -> 'haiku'
      const scaffolderResult = classifyTask({ id: '004a', title: 'Scaffold the test harness' }, config);
      expect(scaffolderResult.recommendedModel).toBe('haiku');
      // implementer task -> 'opus' (from defaultModel)
      const implementerResult = classifyTask({ id: '004b', title: 'Implement handler' }, config);
      expect(implementerResult.recommendedModel).toBe('opus');
    });

    it('classifyTask_WithDefaultConfig_ScaffolderGetsHaiku', () => {
      const result = classifyTask({ id: '005', title: 'Scaffold boilerplate' }, DEFAULTS.agents);
      expect(result.recommendedModel).toBe('haiku');
    });

    it('classifyTask_WithDefaultConfig_ImplementerGetsOpus', () => {
      const result = classifyTask({ id: '006', title: 'Implement handler' }, DEFAULTS.agents);
      expect(result.recommendedModel).toBe('opus');
    });
  });
});

// ─── F19 (#1213): computeScopedWorktrees task-ID canonicalisation ──────────
//
// Callers may pass `T-001`/`T001`/`001` interchangeably; the projection's
// `readyTaskIds` preserves the form recorded by upstream emitters. Strict
// string-equality comparisons mis-fire on this drift and produce false
// "<N> worktrees pending" blockers. The helper now canonicalises both
// sides via `canonicaliseTaskId` (collapses `T-NNN`/`TNNN`/`NNN` to a
// shared `<digits>` form) before comparing.

describe('computeScopedWorktrees', () => {
  function readiness(
    readyTaskIds: readonly string[],
    expected: number,
    blockers: readonly string[] = [],
  ): DelegationReadinessState {
    return {
      ready: readyTaskIds.length === expected,
      blockers,
      plan: { approved: true, taskCount: expected, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: {
        expected,
        ready: readyTaskIds.length,
        failed: [],
        assignedTaskIds: [],
        readyTaskIds: [...readyTaskIds],
      },
    };
  }

  it('ComputeScopedWorktrees_HyphenedVsUnhyphenedIds_TreatedEqual', () => {
    // Wave addresses tasks with the hyphenated form `T-001`/`T-002`; the
    // projection holds the unhyphenated form `T001`/`T002` (e.g. because
    // an upstream task.assigned event normalised them differently). Both
    // tasks ARE worktree-ready, so the wave-scoped count must report
    // 2/2 ready and zero pending — not "2 worktrees pending".
    const state = readiness(['T001', 'T002'], 2, ['2 worktrees pending']);
    const result = computeScopedWorktrees(state, [
      { id: 'T-001' },
      { id: 'T-002' },
    ]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(2);
    expect(result.pending).toBe(0);
    // The "2 worktrees pending" blocker must drop because the wave is
    // fully ready under canonical comparison.
    expect(result.blockers).not.toContain('2 worktrees pending');
  });

  it('ComputeScopedWorktrees_PlainNumericInArgs_MatchesTPrefixedReady', () => {
    // Wave passes plain-numeric IDs (`001`, `002`); projection records
    // the `T-`-prefixed form. Canonical comparison still matches.
    const state = readiness(['T-001', 'T-002'], 2);
    const result = computeScopedWorktrees(state, [{ id: '001' }, { id: '002' }]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(2);
    expect(result.pending).toBe(0);
  });

  it('ComputeScopedWorktrees_MismatchedIds_StillReportsPending', () => {
    // Sanity: when a wave member is genuinely missing from
    // readyTaskIds (regardless of form), pending is non-zero.
    const state = readiness(['T-001'], 2, ['1 worktrees pending']);
    const result = computeScopedWorktrees(state, [
      { id: 'T-001' }, // ready
      { id: 'T-099' }, // not ready
    ]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(1);
    expect(result.pending).toBe(1);
    // Blocker rewritten to wave-scoped count (matches existing scoping
    // contract; canonical comparison only changes the match logic).
    expect(result.blockers).toContain('1 worktrees pending');
  });

  // F-iter3 (#1213, sentry HIGH r3186305844): the global readiness can be
  // empty of "N worktrees pending" blockers (because globally everything is
  // ready) while a wave subset still has unready members. Without an
  // explicit synthesise step the caller saw `blockers === []` and dispatched
  // prematurely. The next three tests pin the synthesise / no-synthesise /
  // existing-rewrite behaviours.
  it('ComputeScopedWorktrees_GlobalReadyButWavePending_SynthesisesBlocker', () => {
    // Globally only T-001 is ready and the projection has no
    // "N worktrees pending" blocker (e.g. global expected==1 / ready==1
    // because the global expected count was scoped to the ready set, OR a
    // mix of legacy/modern worktree.created events). The wave addresses
    // T-002 — which is not ready. Without synthesis the caller would see
    // blockers===[] and dispatch.
    const state = readiness(['T-001'], 1, []);
    const result = computeScopedWorktrees(state, [{ id: 'T-002' }]);
    expect(result.expected).toBe(1);
    expect(result.ready).toBe(0);
    expect(result.pending).toBe(1);
    expect(result.blockers).toContain('1 worktrees pending');
  });

  it('ComputeScopedWorktrees_GlobalAndWaveReady_NoBlockerSynthesised', () => {
    // Globally and wave-locally the only task is ready. No blocker should
    // be synthesised; result.blockers must remain empty.
    const state = readiness(['T-001'], 1, []);
    const result = computeScopedWorktrees(state, [{ id: 'T-001' }]);
    expect(result.expected).toBe(1);
    expect(result.ready).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.blockers).toEqual([]);
  });

  it('ComputeScopedWorktrees_GlobalHasPendingBlocker_RewrittenToWaveCount', () => {
    // Existing transformation contract: the global "5 worktrees pending"
    // blocker must be rewritten to the wave-scoped count, not duplicated
    // or left at the global value.
    const state = readiness(['T-001'], 5, ['5 worktrees pending']);
    const result = computeScopedWorktrees(state, [
      { id: 'T-001' }, // ready
      { id: 'T-002' }, // not ready
    ]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.blockers).toContain('1 worktrees pending');
    expect(result.blockers).not.toContain('5 worktrees pending');
    // Synthesise step must not produce a duplicate "1 worktrees pending".
    const matches = result.blockers.filter(b =>
      /^\d+ worktrees pending$/.test(b),
    );
    expect(matches).toHaveLength(1);
  });
});

// ─── vls1-b1 (task 003): deriveRiskTier — high rules ────────────────────────
//
// Pure derivation of a task's risk tier. High when ANY of: a file matches a
// HIGH_RISK_GLOB (schema/type/API/shared-contract surfaces), testLayer is
// 'acceptance', blockedBy has >= 2 entries, or files has >= 3 entries.

describe('deriveRiskTier — high rules', () => {
  it('DeriveRiskTier_AcceptanceTestLayer_ReturnsHigh', () => {
    const task: TaskInput = { id: 't-1', title: 'Acceptance test', testLayer: 'acceptance' };
    expect(deriveRiskTier(task)).toBe('high');
  });

  it('DeriveRiskTier_BlockedByAtLeastTwo_ReturnsHigh', () => {
    const task: TaskInput = {
      id: 't-2',
      title: 'Integrate dependent modules',
      blockedBy: ['t-a', 't-b'],
    };
    expect(deriveRiskTier(task)).toBe('high');
  });

  it('DeriveRiskTier_ThreeOrMoreFiles_ReturnsHigh', () => {
    const task: TaskInput = {
      id: 't-3',
      title: 'Refactor across modules',
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    };
    expect(deriveRiskTier(task)).toBe('high');
  });

  it('DeriveRiskTier_SchemaContractGlobHit_ReturnsHigh', () => {
    // A single file that matches a high-risk glob is enough — even when no
    // other high signal (deps/file-count/acceptance) is present.
    const cases: TaskInput[] = [
      { id: 's-1', title: 'edit schema', files: ['src/event-store/schemas.ts'] },
      { id: 's-2', title: 'edit types', files: ['src/types/foo.ts'] },
      { id: 's-3', title: 'edit dts', files: ['dist/index.d.ts'] },
      { id: 's-4', title: 'edit api', files: ['src/api/handler.ts'] },
      { id: 's-5', title: 'edit contracts', files: ['src/contracts/order.ts'] },
    ];
    for (const task of cases) {
      expect(deriveRiskTier(task), task.id).toBe('high');
    }
  });

  it('DeriveRiskTier_HighRiskGlobsExported_NonEmpty', () => {
    // The glob list is the SoT for high-risk surfaces — assert it is
    // exported and non-empty so consumers can reference it.
    expect(Array.isArray(HIGH_RISK_GLOBS)).toBe(true);
    expect(HIGH_RISK_GLOBS.length).toBeGreaterThan(0);
  });
});

// ─── vls1-b1 (task 004): deriveRiskTier — low / medium / override ───────────
//
// Precedence: explicit planner value > high-rules > low-rules > medium.
// Low requires ALL files to match LOW_RISK_GLOBS (docs/config/rename-only).
// A single-module behavioural change with no high/low signal defaults to
// medium. Mixed low+unknown files resolve to medium (ambiguous).

describe('deriveRiskTier — low / medium / override', () => {
  // PR #1535 CodeRabbit (CR-4): schema/contract ARTIFACTS are shared-contract
  // surfaces (the documented blast-radius gap) and must reach the HIGH lane.
  // Before the fix, `openapi.yaml` fell through to LOW via the `**/*.yaml`
  // low-glob, and `*.proto` / `*.graphql` defaulted to MEDIUM.
  it('DeriveRiskTier_SchemaArtifacts_ReturnHigh', () => {
    const cases: TaskInput[] = [
      { id: 'sa-1', title: 'proto reshape', files: ['proto/workflow.proto'] },
      { id: 'sa-2', title: 'openapi reshape', files: ['openapi.yaml'] },
      { id: 'sa-3', title: 'openapi json', files: ['spec/openapi.json'] },
      { id: 'sa-4', title: 'graphql reshape', files: ['src/gateway/queries.graphql'] },
    ];
    for (const task of cases) {
      expect(deriveRiskTier(task), task.id).toBe('high');
    }
  });

  it('DeriveRiskTier_DocConfigRenameOnlyFiles_ReturnsLow', () => {
    const cases: TaskInput[] = [
      { id: 'l-1', title: 'docs', files: ['docs/CHANGELOG.md', 'README.md'] },
      { id: 'l-2', title: 'config', files: ['package.json', 'tsconfig.json'] },
      { id: 'l-3', title: 'yaml', files: ['.github/ci.yml', 'config.yaml'] },
    ];
    for (const task of cases) {
      expect(deriveRiskTier(task), task.id).toBe('low');
    }
  });

  it('DeriveRiskTier_SingleModuleBehavior_DefaultsMedium', () => {
    // One source file, no high-risk glob, not all-low → medium.
    const task: TaskInput = {
      id: 'm-1',
      title: 'Add validation logic',
      files: ['src/validate.ts'],
    };
    expect(deriveRiskTier(task)).toBe('medium');
  });

  it('DeriveRiskTier_NoFilesNoSignals_DefaultsMedium', () => {
    const task: TaskInput = { id: 'm-2', title: 'Tidy a helper' };
    expect(deriveRiskTier(task)).toBe('medium');
  });

  it('DeriveRiskTier_MixedLowAndUnknownFiles_ResolvesMedium', () => {
    // Not ALL files match low globs → ambiguous → medium, not low.
    const task: TaskInput = {
      id: 'm-3',
      title: 'Docs plus code',
      files: ['docs/README.md', 'src/handler.ts'],
    };
    expect(deriveRiskTier(task)).toBe('medium');
  });

  it('DeriveRiskTier_ExplicitPlannerValue_WinsOverDerivation', () => {
    // Explicit override beats every derived rule, in BOTH directions:
    // a planner can downgrade a would-be-high task, or upgrade a doc task.
    const wouldBeHigh: TaskInput = {
      id: 'o-1',
      title: 'edit schema',
      files: ['src/event-store/schemas.ts'],
      riskTier: 'low',
    };
    expect(deriveRiskTier(wouldBeHigh)).toBe('low');

    const wouldBeLow: TaskInput = {
      id: 'o-2',
      title: 'docs',
      files: ['docs/CHANGELOG.md'],
      riskTier: 'high',
    };
    expect(deriveRiskTier(wouldBeLow)).toBe('high');
  });

  it('DeriveRiskTier_LowRiskGlobsExported_NonEmpty', () => {
    expect(Array.isArray(LOW_RISK_GLOBS)).toBe(true);
    expect(LOW_RISK_GLOBS.length).toBeGreaterThan(0);
  });

  // Property: the derived tier is always one of low|medium|high for arbitrary
  // TaskInput, and an explicit override always wins.
  it('DeriveRiskTier_Property_AlwaysValidTierAndOverrideWins', () => {
    const tierArb = fc.constantFrom('low', 'medium', 'high') as fc.Arbitrary<
      'low' | 'medium' | 'high'
    >;
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 12 }),
          title: fc.string({ maxLength: 40 }),
          files: fc.option(
            fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 6 }),
            { nil: undefined },
          ),
          blockedBy: fc.option(
            fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 5 }),
            { nil: undefined },
          ),
          testLayer: fc.option(
            fc.constantFrom('acceptance', 'integration', 'unit', 'property'),
            { nil: undefined },
          ) as fc.Arbitrary<'acceptance' | 'integration' | 'unit' | 'property' | undefined>,
          override: fc.option(tierArb, { nil: undefined }),
        }),
        (raw) => {
          const base: TaskInput = {
            id: raw.id,
            title: raw.title,
            ...(raw.files !== undefined ? { files: raw.files } : {}),
            ...(raw.blockedBy !== undefined ? { blockedBy: raw.blockedBy } : {}),
            ...(raw.testLayer !== undefined ? { testLayer: raw.testLayer } : {}),
          };
          const derived = deriveRiskTier(base);
          expect(['low', 'medium', 'high']).toContain(derived);

          if (raw.override !== undefined) {
            const overridden: TaskInput = { ...base, riskTier: raw.override };
            expect(deriveRiskTier(overridden)).toBe(raw.override);
          }
        },
      ),
    );
  });
});

// ─── vls1-b1 (task 005): deriveBoundaryTouching ─────────────────────────────
//
// A task is boundary-touching when it crosses an I/O or schema boundary:
// testLayer is integration/acceptance, a file matches a BOUNDARY_GLOB
// (adapters/clients/io/http), or a file is a schema artifact (*.proto,
// openapi.*, *.graphql). Boundary tagging is INDEPENDENT of risk tier — a
// low-blast task can still be boundary-touching. An explicit override wins.

describe('deriveBoundaryTouching', () => {
  it('DeriveBoundaryTouching_IntegrationOrAcceptanceTestLayer_ReturnsTrue', () => {
    expect(deriveBoundaryTouching({ id: 'b-1', title: 'x', testLayer: 'integration' })).toBe(true);
    expect(deriveBoundaryTouching({ id: 'b-2', title: 'x', testLayer: 'acceptance' })).toBe(true);
  });

  it('DeriveBoundaryTouching_UnitOrPropertyTestLayer_NotBoundaryByLayer', () => {
    // Unit/property layers alone do not mark a boundary.
    expect(deriveBoundaryTouching({ id: 'b-u', title: 'x', testLayer: 'unit', files: ['src/a.ts'] })).toBe(false);
    expect(deriveBoundaryTouching({ id: 'b-p', title: 'x', testLayer: 'property', files: ['src/a.ts'] })).toBe(false);
  });

  it('DeriveBoundaryTouching_IOAdapterGlobHit_ReturnsTrue', () => {
    const cases: TaskInput[] = [
      { id: 'a-1', title: 'x', files: ['src/adapters/cli.ts'] },
      { id: 'a-2', title: 'x', files: ['src/clients/http-client.ts'] },
      { id: 'a-3', title: 'x', files: ['src/io/reader.ts'] },
      { id: 'a-4', title: 'x', files: ['src/http/server.ts'] },
    ];
    for (const task of cases) {
      expect(deriveBoundaryTouching(task), task.id).toBe(true);
    }
  });

  it('DeriveBoundaryTouching_SchemaArtifactInScope_ReturnsTrue', () => {
    const cases: TaskInput[] = [
      { id: 'p-1', title: 'x', files: ['proto/order.proto'] },
      { id: 'p-2', title: 'x', files: ['openapi.yaml'] },
      { id: 'p-3', title: 'x', files: ['schema/user.graphql'] },
    ];
    for (const task of cases) {
      expect(deriveBoundaryTouching(task), task.id).toBe(true);
    }
  });

  it('DeriveBoundaryTouching_LowBlastSchemaAdapterEdit_TagIndependentOfRiskTier', () => {
    // A single adapter file → low risk tier (one source file, not high/low
    // glob for risk) but STILL boundary-touching. Tag is orthogonal to tier.
    const task: TaskInput = { id: 'i-1', title: 'tweak adapter', files: ['src/adapters/cli.ts'] };
    expect(deriveBoundaryTouching(task)).toBe(true);
    // riskTier derivation must not be 'high' from this alone (adapters is not
    // a high-risk glob) — confirms independence.
    expect(deriveRiskTier(task)).not.toBe('high');
  });

  it('DeriveBoundaryTouching_PlainSourceEdit_ReturnsFalse', () => {
    const task: TaskInput = { id: 'n-1', title: 'logic', files: ['src/validate.ts'] };
    expect(deriveBoundaryTouching(task)).toBe(false);
  });

  it('DeriveBoundaryTouching_ExplicitOverride_Wins', () => {
    // Override forces the tag in both directions.
    const forceTrue: TaskInput = { id: 'o-1', title: 'plain', files: ['src/validate.ts'], boundaryTouching: true };
    expect(deriveBoundaryTouching(forceTrue)).toBe(true);
    const forceFalse: TaskInput = { id: 'o-2', title: 'adapter', files: ['src/adapters/cli.ts'], boundaryTouching: false };
    expect(deriveBoundaryTouching(forceFalse)).toBe(false);
  });

  it('DeriveBoundaryTouching_BoundaryGlobsExported_NonEmpty', () => {
    expect(Array.isArray(BOUNDARY_GLOBS)).toBe(true);
    expect(BOUNDARY_GLOBS.length).toBeGreaterThan(0);
  });
});
