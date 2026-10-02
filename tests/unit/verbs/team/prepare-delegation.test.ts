// Tests for `handlePrepareDelegation` and the helpers that classify tasks, derive risk tiers and scope worktree readiness.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';
import { WORKFLOW_STATE_VIEW } from '../../../../src/projections/views/workflow-state-projection.js';
import { CODE_QUALITY_VIEW } from '../../../../src/projections/views/code-quality-view.js';
import { DELEGATION_READINESS_VIEW } from '../../../../src/projections/views/delegation-readiness-view.js';
import type { DelegationReadinessState } from '../../../../src/projections/views/delegation-readiness-view.js';
import { SequenceConflictError } from '../../../../src/events/store.js';

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: vi.fn(),
  queryDeltaEvents: vi.fn(),
}));

vi.mock('../../../../src/projections/fold-at-tail.js', () => ({
  foldToTail: vi.fn(),
}));

vi.mock('../../../../src/projections/quality/hints.js', () => ({
  generateQualityHints: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  emitGateEvent: vi.fn(),
}));

vi.mock('../../../../src/projections/telemetry/telemetry-queries.js', () => ({
  queryTelemetryState: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../src/verbs/team/dispatch-guard.js', () => ({
  validateBranchAncestry: vi.fn().mockResolvedValue({ passed: true, checks: ['ancestry'] }),
  assertMainWorktree: vi.fn().mockReturnValue({ isMain: true, actual: '/repo', expected: 'main worktree (no .claude/worktrees/ in path)' }),
  getCurrentBranch: vi.fn().mockReturnValue('feature/test-branch'),
  assertCurrentBranchNotProtected: vi.fn().mockReturnValue({ blocked: false }),
  probeStashAndEmit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/verbs/team/worktree-baseref.js', () => ({
  assertWorktreeBaseRefPinned: vi
    .fn()
    .mockReturnValue({ pinned: true, effective: 'head', checked: [] }),
}));

vi.mock('../../../../src/workflow/checkpoint.js', () => ({
  shouldEnforceCheckpoint: vi.fn().mockReturnValue({ gated: false }),
  CHECKPOINT_OPERATION_THRESHOLD: 20,
}));

vi.mock('../../../../src/workflow/phase-kind.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/workflow/phase-kind.js')>();
  return { ...actual, resolveGateSet: vi.fn(actual.resolveGateSet) };
});

import {
  getOrCreateMaterializer,
  queryDeltaEvents,
} from '../../../../src/projections/views/tools.js';
import { foldToTail } from '../../../../src/projections/fold-at-tail.js';
import { generateQualityHints } from '../../../../src/projections/quality/hints.js';
import { emitGateEvent } from '../../../../src/verbs/gates/gate-utils.js';
import {
  handlePrepareDelegation,
  classifyTask,
  classifyTasksFailClosed,
  assertDispatchMutationCapabilities,
  computeScopedWorktrees,
  deriveRiskTier,
  deriveBoundaryTouching,
  verificationNoteKey,
  HIGH_RISK_GLOBS,
  LOW_RISK_GLOBS,
  BOUNDARY_GLOBS,
} from '../../../../src/verbs/team/prepare-delegation.js';
import type { TaskClassification, TaskInput } from '../../../../src/verbs/team/prepare-delegation.js';
import {
  renderImplementerPrompt,
  reconstructImplementerPrompt,
  buildVerificationNote,
  IMPLEMENTER_PROMPT_TEMPLATE,
  VERIFICATION_NOTE_PLACEHOLDER,
} from '../../../../src/runtime/agents/definitions.js';
import { estimateTokens } from '../../../../tools/conformance/src/description-budget.js';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as fc from 'fast-check';
import { delegationReadinessProjection } from '../../../../src/projections/views/delegation-readiness-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import {
  validateBranchAncestry,
  assertMainWorktree,
  getCurrentBranch,
  assertCurrentBranchNotProtected,
} from '../../../../src/verbs/team/dispatch-guard.js';
import { shouldEnforceCheckpoint } from '../../../../src/workflow/checkpoint.js';
import { assertWorktreeBaseRefPinned } from '../../../../src/verbs/team/worktree-baseref.js';
import { DEFAULTS, resolveConfig } from '../../../../src/config/resolve.js';
import type { ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import { parseTaskStamps } from '../../../../src/verbs/tasks/parse-task-stamps.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVerificationSequence } from '../../../../src/workflow/verification-policy.js';
import type { GateName, RiskTier } from '../../../../src/workflow/verification-policy.js';
import { resolveVerificationPolicy } from '../../../../src/workflow/verification-policy-resolver.js';
import { resolveGateSet } from '../../../../src/workflow/phase-kind.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STATE_DIR = '/tmp/test-state';

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
    blockers: ['plan not approved', 'no task.assigned events found — prepare_delegation announces the plan\'s tasks itself; give the workflow a task list (workflow update with tasks) or pass tasks, so there is something to announce'],
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

/**
 * Stubs the materializer and `foldToTail` to return each view by its name, and returns a new store stub.
 * Without a readiness view, it uses the ready or the not-ready fixture from `planReview.approved`.
 */
function setupMaterializer(
  workflowState: Record<string, unknown>,
  qualityState?: Record<string, unknown>,
  delegationReadiness?: DelegationReadinessState,
) {
  const cqState = qualityState ?? emptyQualityState();
  const drState = delegationReadiness ?? (
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
  vi.mocked(foldToTail).mockImplementation(
    async (_store, _materializer, _streamId, viewName) => {
      if (viewName === WORKFLOW_STATE_VIEW) return { view: workflowState, sequence: 1 };
      if (viewName === CODE_QUALITY_VIEW) return { view: cqState, sequence: 1 };
      if (viewName === DELEGATION_READINESS_VIEW) return { view: drState, sequence: 1 };
      return { view: {}, sequence: 1 };
    },
  );

  const mockStore = {
    query: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue(undefined),
    listStreams: vi.fn().mockReturnValue(null),
  };
  vi.mocked(queryDeltaEvents).mockResolvedValue([]);

  return { mockMaterializer, mockStore };
}

/** The default store stub that most handler tests pass through `makeCtx`. */
const mockStore = {
  query: vi.fn().mockResolvedValue([]),
  append: vi.fn().mockResolvedValue(undefined),
  listStreams: vi.fn().mockReturnValue(null),
};

function makeCtx(store: { append: unknown; query: unknown }, stateDir: string) {
  return {
    stateDir,
    eventStore: store as unknown as import('../../../../src/events/store.js').EventStore,
    enableTelemetry: false,
  };
}

describe('handlePrepareDelegation', () => {
  /**
   * Restores the guard defaults, because some tests override them with `mockReturnValue` and `vi.clearAllMocks` keeps implementations.
   * The base-ref guard defaults to pinned, so native-isolation tests reach the readiness logic.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateBranchAncestry).mockResolvedValue({ passed: true, checks: ['ancestry'] });
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: true,
      actual: '/repo',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    vi.mocked(shouldEnforceCheckpoint).mockReturnValue({ gated: false });
    vi.mocked(assertWorktreeBaseRefPinned).mockReturnValue({
      pinned: true,
      effective: 'head',
      checked: [],
    });
  });

  it('PrepareDelegation_MissingFeatureId_ReturnsInvalidInput', async () => {
    const args = {} as { featureId: string };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  /**
   * A non-MCP caller can pass `tasks` through an unchecked cast. The shape guard must reject each malformed field as `INVALID_INPUT`.
   * Otherwise the field crashes a later step, and the fail-closed wrapper reports it as a false `phase.blocked` fault.
   */
  it('PrepareDelegation_MalformedTaskShape_ReturnsInvalidInputNotPhaseBlocked', async () => {
    const malformed: Array<Record<string, unknown>> = [
      { id: 't1', title: 'ok', files: 'src/not-an-array.ts' },
      { id: 't2', title: 'ok', blockedBy: [1, 2] },
      { id: 't3', title: 'ok', riskTier: 'critical' },
      { id: 't4', title: 'ok', boundaryTouching: 'yes' },
      { id: 't5', title: 'ok', testLayer: 'e2e' },
      { id: 7, title: 'ok' },
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
    const state = notReadyWorkflowState();
    setupMaterializer(state);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
    const state = readyWorkflowState();
    setupMaterializer(state);
    const hints = mockQualityHints();
    vi.mocked(generateQualityHints).mockReturnValue(
      hints as ReturnType<typeof generateQualityHints>,
    );
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(emitGateEvent).toHaveBeenCalledOnce();
    expect(emitGateEvent).toHaveBeenCalledWith(
      expect.anything(),
      'test-feature',
      'plan-coverage',
      'planning',
      true,
      {
        dimension: 'D1',
        phase: 'delegate',
        taskCount: 2,
        gatePassRate: null,
      },
    );
  });

  it('PrepareDelegation_Ready_EmitsGateEvent_IncludesPhaseInDetails', async () => {
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(emitGateEvent).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(emitGateEvent).mock.calls[0];
    const details = callArgs[5] as Record<string, unknown>;
    expect(details.phase).toBe('delegate');
  });

  it('PrepareDelegation_NotReady_DoesNotEmitGateEvent', async () => {
    const state = notReadyWorkflowState();
    setupMaterializer(state);
    const args = { featureId: 'test-feature' };

    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(emitGateEvent).not.toHaveBeenCalled();
  });

  it('HandlePrepareDelegation_ViewReady_ReturnsReadyWithHints', async () => {
    const state = readyWorkflowState();
    const drState = readyDelegationReadiness();
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
    const state = notReadyWorkflowState();
    const drState = notReadyDelegationReadiness();
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

  /**
   * The plan-artifact blocker comes only from the readiness projection. The handler adds no plan-artifact check of its own.
   * The test replays one stream through `delegationReadinessProjection`, which readies both worktrees but records no plan artifact.
   * The handler gets that view, and its blockers must equal the projection blockers.
   * Without `tasks`, the wave scoping passes the blockers through unchanged.
   */
  it('HandlePrepareDelegation_BlockerList_MatchesDelegationReadinessView', async () => {
    const events: WorkflowEvent[] = [
      { type: 'workflow.transition', data: { to: 'plan-review' } } as unknown as WorkflowEvent,
      { type: 'task.assigned', data: { taskId: 'task-1' } } as unknown as WorkflowEvent,
      { type: 'task.assigned', data: { taskId: 'task-2' } } as unknown as WorkflowEvent,
      { type: 'worktree.created', data: { taskId: 'task-1', path: '/w/1' } } as unknown as WorkflowEvent,
      { type: 'worktree.created', data: { taskId: 'task-2', path: '/w/2' } } as unknown as WorkflowEvent,
    ];

    let projectedView = delegationReadinessProjection.init();
    for (const ev of events) {
      projectedView = delegationReadinessProjection.apply(projectedView, ev);
    }

    expect(projectedView.blockers).toContain('Plan artifact is missing');
    expect(projectedView.blockers.find(b => /worktrees pending/.test(b))).toBeUndefined();

    const state = {
      ...readyWorkflowState(),
      artifacts: { design: 'design.md', plan: null, pr: null },
    };
    setupMaterializer(state, undefined, projectedView);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      blockers: string[];
    };
    expect(data.readiness.blockers).toEqual(projectedView.blockers);
    expect(data.blockers).toEqual([...projectedView.blockers]);
  });

  /** The projection reports a plan artifact that the workflow state does not list. The handler must not add a blocker for it. */
  it('HandlePrepareDelegation_ViewReady_NoSupplementaryPlanArtifactCheck', async () => {
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

  /** The projection counts 33 planned tasks and the workflow state lists 31. The handler reports the drift as a desync blocker. */
  it('PrepareDelegation_TaskCountExceedsStateTasks_AddsDesyncBlocker', async () => {
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

  /** The desync blocker also appears when the workflow state lists more tasks than the projection counts. */
  it('PrepareDelegation_StateTasksExceedPlanCount_AddsDesyncBlocker', async () => {
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
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { readiness: DelegationReadinessState };
    expect(data.readiness.blockers.find(b => /state-vs-plan desync/.test(b))).toBeUndefined();
  });

  /** A new workflow has no tasks in the projection or the state, and the desync diagnostic does not fire at that baseline. */
  it('PrepareDelegation_PlanTaskCountZero_NoDesyncBlockerEvenIfStateEmpty', async () => {
    const state = notReadyWorkflowState();
    setupMaterializer(state);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { readiness: DelegationReadinessState };
    expect(data.readiness.blockers.find(b => /state-vs-plan desync/.test(b))).toBeUndefined();
  });

  /** The projection has 5 assigned tasks and 3 ready worktrees. The wave names the 3 ready tasks, so no worktree blocker appears. */
  it('PrepareDelegation_TasksArgSubsetReady_NoBlocker', async () => {
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['2 worktrees pending'],
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
    expect(data.readiness.blockers.find(b => /worktrees pending/.test(b))).toBeUndefined();
  });

  /** The projection has 33 assigned tasks and none ready. A wave of 3 pending tasks reports 3 worktrees pending, not 33. */
  it('PrepareDelegation_TasksArgSubsetPending_ExactPendingCountInBlocker', async () => {
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

  /** Without `tasks`, the global worktree blocker passes through unchanged. */
  it('PrepareDelegation_NoTasksArg_AllAssignedConsidered', async () => {
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
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; readiness: DelegationReadinessState };
    expect(data.readiness.blockers).toContain('10 worktrees pending');
  });

  /**
   * Wave scoping must update `readiness.worktrees.expected` and `ready` as well as the blocker text.
   * The projection has 5 assigned tasks and 2 ready. The wave names 2 ready tasks and 1 pending task, so it reports 3 and 2.
   */
  it('PrepareDelegation_TasksArgSubset_EffectiveReadinessReportsScopedWorktreeCounts', async () => {
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['3 worktrees pending'],
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
        { id: 't1', title: 'A' },
        { id: 't2', title: 'B' },
        { id: 't3', title: 'C' },
      ],
    };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; readiness: DelegationReadinessState };
    expect(data.readiness.worktrees.expected).toBe(args.tasks.length);
    expect(data.readiness.worktrees.expected).toBe(3);
    expect(data.readiness.worktrees.ready).toBe(2);
    expect(data.readiness.blockers).toContain('1 worktrees pending');
    expect(data.readiness.blockers).not.toContain('3 worktrees pending');
  });

  /** Under native isolation, the handler also drops the worktree blockers from `readiness.blockers`, so that list agrees with `ready`. */
  it('handlePrepareDelegation_NativeIsolation_ExcludesWorktreeBlockers', async () => {
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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
    };
    expect(data.ready).toBe(true);
    expect(data.readiness.ready).toBe(true);
    expect(data.readiness.blockers).toEqual([]);
  });

  /** Native isolation drops only the worktree blockers. The other blockers stay. */
  it('handlePrepareDelegation_NativeIsolation_PreservesNonWorktreeBlockers', async () => {
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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
      blockers: string[];
    };
    expect(data.ready).toBe(false);
    expect(data.readiness.blockers).toContain('plan not approved');
    expect(data.readiness.blockers).toContain('worktrees pending');
  });

  it('PrepareDelegation_NativeIsolationTrue_SkipsWorktreeBlockers', async () => {
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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; isolation: string; blockers?: string[] };
    expect(data.ready).toBe(true);
    expect(data.isolation).toBe('native');
  });

  /**
   * Native isolation expects 2 worktrees, but none is ready. `ready` stays true, because the host owns isolation.
   * A warning names the shared-checkout hazard, so the readiness result does not hide it.
   */
  it('PrepareDelegation_NativeIsolationExpectedButNoneReady_WarnsKeepsReadyTrue', async () => {
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['2 worktrees pending'],
      plan: { approved: true, taskCount: 2, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; isolation: string };
    expect(data.ready).toBe(true);
    expect(data.isolation).toBe('native');
    expect(result.warnings).toBeDefined();
    expect(
      (result.warnings ?? []).some(
        (w) => /native isolation/i.test(w) && /shared checkout/i.test(w),
      ),
    ).toBe(true);
  });

  it('PrepareDelegation_NativeIsolationWorktreesReady_NoSharedCheckoutWarning', async () => {
    const state = readyWorkflowState();
    setupMaterializer(state, undefined, readyDelegationReadiness());
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    expect((result.warnings ?? []).some((w) => /shared checkout/i.test(w))).toBe(false);
  });

  /** Without native isolation, pending worktrees block dispatch, and the shared-checkout warning does not appear. */
  it('PrepareDelegation_NonNativeWorktreesPending_NoSharedCheckoutWarning', async () => {
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['2 worktrees pending'],
      plan: { approved: true, taskCount: 2, artifactPresent: true },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    expect((result.warnings ?? []).some((w) => /shared checkout/i.test(w))).toBe(false);
  });

  /**
   * Under native isolation, an unpinned `worktree.baseRef` makes Claude Code branch the subagent worktree from main.
   * The handler blocks dispatch and returns the settings patch that pins it.
   */
  it('PrepareDelegation_NativeIsolation_BaseRefUnset_BlocksWithRemediation', async () => {
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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
    const state = readyWorkflowState();
    setupMaterializer(state, undefined, readyDelegationReadiness());
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(assertWorktreeBaseRefPinned).toHaveBeenCalled();
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; isolation?: string; blocked?: boolean };
    expect(data.blocked).toBeUndefined();
    expect(data.ready).toBe(true);
    expect(data.isolation).toBe('native');
  });

  /** Without native isolation, `setup_worktree` sets the worktree base, so the base-ref guard does not run. */
  it('PrepareDelegation_NonNativeIsolation_DoesNotRunBaseRefGuard', async () => {
    const state = readyWorkflowState();
    setupMaterializer(state, undefined, readyDelegationReadiness());
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(assertWorktreeBaseRefPinned).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('PrepareDelegation_NativeIsolationFalse_PreservesWorktreeBlockers', async () => {
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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; blockers?: string[]; isolation?: string };
    expect(data.ready).toBe(false);
    expect(data.blockers).toContain('no worktrees expected');
    expect(data.isolation).toBeUndefined();
  });

  it('PrepareDelegation_NativeIsolationTrue_StillTracksState', async () => {
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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; blockers?: string[]; readiness: DelegationReadinessState };
    expect(data.ready).toBe(false);
    expect(data.blockers).toContain('plan not approved');
    expect(data.readiness).toBeDefined();
  });

  it('PrepareDelegation_NativeIsolationTrue_StillRunsPreChecks', async () => {
    const state = readyWorkflowState();
    const drState = readyDelegationReadiness();
    setupMaterializer(state, undefined, drState);
    const hints = mockQualityHints();
    vi.mocked(generateQualityHints).mockReturnValue(
      hints as ReturnType<typeof generateQualityHints>,
    );
    const args = { featureId: 'test-feature', nativeIsolation: true };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ...readyDelegationReadiness(),
      worktrees: { expected: 3, ready: 3, failed: [], assignedTaskIds: [], readyTaskIds: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as {
      readiness: DelegationReadinessState;
    };
    expect(data.readiness.worktrees.expected).toBe(3);
    expect(data.readiness.worktrees.ready).toBe(3);
    expect(data.readiness.worktrees.failed).toHaveLength(0);
  });

  it('handlePrepareDelegation_AncestryCheckFails_ReturnsBlocked', async () => {
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: false,
      blocked: true,
      reason: 'ancestry',
      missing: ['main'],
    });
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

  it('handlePrepareDelegation_InSubagentWorktree_ReturnsBlocked', async () => {
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: false,
      actual: '/repo/.claude/worktrees/agent-abc123',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

  /** On a protected branch, the handler blocks before the ancestry check runs and records a `preflight.blocked` event. */
  it('handlePrepareDelegation_OnProtectedBranch_ReturnsBlockedAndEmitsPreflightBlocked', async () => {
    const state = readyWorkflowState();
    const { mockStore } = setupMaterializer(state);
    vi.mocked(getCurrentBranch).mockReturnValueOnce('main');
    vi.mocked(assertCurrentBranchNotProtected).mockReturnValueOnce({
      blocked: true,
      reason: 'current-branch-protected',
      currentBranch: 'main',
    });
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

  /**
   * The server reads HEAD from its own launch checkout, which stays on `main` while the orchestrator works in a worktree.
   * So the protected-branch guard gives a false positive there. Under native isolation, the host owns base safety and the guard does not run.
   * The test sets `getCurrentBranch` with `mockReturnValueOnce`, so the value does not leak into later tests.
   */
  it('handlePrepareDelegation_NativeIsolationOnProtectedBranch_SkipsGuardAndProceeds', async () => {
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    vi.mocked(getCurrentBranch).mockReturnValueOnce('main');
    const args = { featureId: 'test-feature', nativeIsolation: true };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(vi.mocked(assertCurrentBranchNotProtected)).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    const data = result.data as { blocked?: boolean; reason?: string; ready?: boolean };
    expect(data.reason).not.toBe('current-branch-protected');
    expect(data.ready).toBe(true);

    const protectedBlocked = mockStore.append.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as { type: string }).type === 'preflight.blocked' &&
        (call[1] as { data?: { reason?: string } }).data?.reason ===
          'current-branch-protected',
    );
    expect(protectedBlocked).toBeUndefined();
  });

  /** Without `synthesis.integrationBranch`, the ancestry check uses the current branch when it is known, and not the feature id. */
  it('handlePrepareDelegation_IntegrationBranchUnset_UsesCurrentBranchNotFeatureId', async () => {
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
      featureId: 'dogfood-v280',
      tasks: [{ id: 'task-1', title: 'x' }],
    };

    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    const call = vi.mocked(validateBranchAncestry).mock.calls[0];
    expect(call).toBeDefined();
    expect(call![0]).toBe('feature/real-branch');
    expect(call![0]).not.toBe('dogfood-v280');
  });

  it('handlePrepareDelegation_InMainWorktree_ProceedsNormally', async () => {
    const state = readyWorkflowState();
    setupMaterializer(state);
    vi.mocked(assertMainWorktree).mockReturnValue({
      isMain: true,
      actual: '/home/user/repo',
      expected: 'main worktree (no .claude/worktrees/ in path)',
    });
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: DelegationReadinessState;
    };
    expect(data.ready).toBe(true);
    expect(data.readiness).toBeDefined();
  });

  it('handlePrepareDelegation_AncestryPasses_EmitsPreflightExecutedEvent', async () => {
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

    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
    const state = readyWorkflowState();
    const { mockStore } = setupMaterializer(state);
    vi.mocked(validateBranchAncestry).mockResolvedValue({
      passed: false,
      blocked: true,
      reason: 'ancestry',
      missing: ['main'],
    });
    const args = { featureId: 'test-feature' };

    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

    await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

  it('handlePrepareDelegation_AboveThreshold_ReturnsCheckpointRequired', async () => {
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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

    const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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

  /**
   * The handler writes the workflow risk tier, the highest tier of the wave, to `state.riskTier` in one `state.patched` event.
   * An explicit `riskTier` argument wins over the derived tier. `riskTierPatches` collects the patches that the store stub got.
   */
  describe('Workflow riskTier persistence', () => {
    function riskTierPatches(
      store: { append: { mock: { calls: unknown[][] } } },
    ): Array<Record<string, unknown>> {
      return store.append.mock.calls
        .map((c) => c[1] as { type?: string; data?: { patch?: Record<string, unknown> } })
        .filter(
          (e) =>
            e.type === 'state.patched' &&
            !!e.data?.patch &&
            Object.prototype.hasOwnProperty.call(e.data.patch, 'riskTier'),
        )
        .map((e) => e.data!.patch!);
    }

    /** One task matches the high-risk schema glob, and one derives to medium. The handler writes `high` in exactly one event. */
    it('PrepareDelegation_HighRiskTask_PersistsWorkflowRiskTierHigh_ViaStatePatched', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        tasks: [
          { id: 'task-1', title: 'edit schema', files: ['src/events/schemas.ts'] },
          { id: 'task-2', title: 'Add tests' },
        ],
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      const patches = riskTierPatches(mockStore);
      expect(patches).toHaveLength(1);
      expect(patches[0]).toEqual({ riskTier: 'high' });
    });

    /** With no high task, the wave derives to `medium`. This shows that the tier is derived and not fixed at `high`. */
    it('PrepareDelegation_AllMediumTasks_PersistsDerivedMedium', async () => {
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

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      expect(riskTierPatches(mockStore)).toEqual([{ riskTier: 'medium' }]);
    });

    /** The wave derives to `medium`, and the handler writes the explicit `high` argument instead. */
    it('PrepareDelegation_ExplicitRiskTierOverride_WinsOverDerived', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        riskTier: 'high' as const,
        tasks: [
          { id: 'task-1', title: 'Implement widget' },
          { id: 'task-2', title: 'Add tests' },
        ],
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      expect(riskTierPatches(mockStore)).toEqual([{ riskTier: 'high' }]);
    });

    /** The override also wins downward. A wave that derives to `high` and gets `low` writes `low`. */
    it('PrepareDelegation_OverrideWinsDownward_OverHighDerivation', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        riskTier: 'low' as const,
        tasks: [{ id: 'task-1', title: 'edit schema', files: ['src/events/schemas.ts'] }],
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      expect(riskTierPatches(mockStore)).toEqual([{ riskTier: 'low' }]);
    });

    it('PrepareDelegation_NoTasksNoOverride_DoesNotPersistRiskTier', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = { featureId: 'test-feature' };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      expect(riskTierPatches(mockStore)).toEqual([]);
    });

    it('PrepareDelegation_InvalidRiskTierOverride_ReturnsInvalidInput', async () => {
      const args = {
        featureId: 'test-feature',
        riskTier: 'critical',
      } as unknown as { featureId: string; riskTier?: 'low' | 'medium' | 'high' };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('riskTier');
    });
  });

  describe('Task classification', () => {
    it('PrepareDelegation_WithTasks_ReturnsTaskClassifications', async () => {
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

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

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
      const task = { id: 'task-1', title: 'Stub out the API interface' };

      const classification = classifyTask(task);

      expect(classification.taskId).toBe('task-1');
      expect(classification.complexity).toBe('low');
      expect(classification.recommendedAgent).toBe('scaffolder');
      expect(classification.effort).toBe('low');
      expect(classification.reason).toBeDefined();
    });

    it('TaskClassification_BoilerplateTitle_ReturnsLowScaffolder', () => {
      const tasks = [
        { id: 't-1', title: 'Generate boilerplate for the service' },
        { id: 't-2', title: 'Create type def for the API' },
        { id: 't-3', title: 'Define the interface for the data layer' },
        { id: 't-4', title: 'Scaffold the test harness' },
      ];

      for (const task of tasks) {
        const classification = classifyTask(task);
        expect(classification.complexity).toBe('low');
        expect(classification.recommendedAgent).toBe('scaffolder');
        expect(classification.effort).toBe('low');
      }
    });

    it('TaskClassification_MultiDependencyTask_ReturnsHighImplementer', () => {
      const task = {
        id: 'task-1',
        title: 'Integrate payment system',
        blockedBy: ['task-a', 'task-b'],
      };

      const classification = classifyTask(task);

      expect(classification.complexity).toBe('high');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.effort).toBe('high');
      expect(classification.reason).toBeDefined();
    });

    it('TaskClassification_ManyFiles_ReturnsHighImplementer', () => {
      const task = {
        id: 'task-1',
        title: 'Refactor data access layer',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      };

      const classification = classifyTask(task);

      expect(classification.complexity).toBe('high');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.effort).toBe('high');
    });

    it('TaskClassification_StandardTask_ReturnsMediumImplementer', () => {
      const task = { id: 'task-1', title: 'Add validation logic' };

      const classification = classifyTask(task);

      expect(classification.complexity).toBe('medium');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.effort).toBe('medium');
    });

    it('PrepareDelegation_NoTasks_OmitsClassifications', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = { featureId: 'test-feature' };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.ready).toBe(true);
      expect(data.taskClassifications).toBeUndefined();
    });

    it('classifyTask_AcceptanceTestLayer_ReturnsHighEffort', () => {
      const task = { id: 'T-001', title: 'Write acceptance test', testLayer: 'acceptance' as const };

      const classification = classifyTask(task);

      expect(classification.effort).toBe('high');
      expect(classification.complexity).toBe('high');
      expect(classification.recommendedAgent).toBe('implementer');
      expect(classification.reason.toLowerCase()).toContain('acceptance');
    });

    /** An integration task gets medium effort and the implementer agent, even with 2 blockers. */
    it('classifyTask_IntegrationTestLayer_ReturnsMediumImplementer', () => {
      const task = {
        id: 'T-002',
        title: 'Integration test',
        testLayer: 'integration' as const,
        blockedBy: ['T-001', 'T-003'],
      };

      const classification = classifyTask(task);

      expect(classification.effort).toBe('medium');
      expect(classification.recommendedAgent).toBe('implementer');
    });

    it('classifyTask_IntegrationTestLayerLowDeps_ReturnsMediumEffort', () => {
      const task = {
        id: 'T-002',
        title: 'Integration test',
        testLayer: 'integration' as const,
      };

      const classification = classifyTask(task);

      expect(classification.effort).toBe('medium');
    });

    /** The unit test layer does not change the classification. With no other signal, the default heuristic gives medium effort. */
    it('classifyTask_UnitTestLayer_FallsBackToExistingHeuristics', () => {
      const task = { id: 'T-003', title: 'Unit test for parser', testLayer: 'unit' as const };

      const classification = classifyTask(task);

      expect(classification.effort).toBe('medium');
    });

    /** With no test layer, a scaffolding keyword in the title gives the scaffolder agent and low effort. */
    it('classifyTask_NoTestLayer_UnchangedBehavior', () => {
      const task = { id: 'T-004', title: 'stub boilerplate' };

      const classification = classifyTask(task, DEFAULTS.agents);

      expect(classification.effort).toBe('low');
      expect(classification.recommendedAgent).toBe('scaffolder');
    });
  });

  /**
   * `classifyTask` stamps the verification sequence that the project config resolves, not the built-in table.
   * Without a config, the stamp equals the built-in sequence.
   * `configWithMediumPolicy` copies `DEFAULTS` and replaces only the medium cell, so the other cells keep the built-in values.
   */
  describe('classifyTask — verification-policy stamp', () => {
    function configWithMediumPolicy(sequence: readonly GateName[]): ResolvedProjectConfig {
      const config = structuredClone(DEFAULTS) as ResolvedProjectConfig;
      (config.verification.policy as { medium?: readonly GateName[] }).medium = [...sequence];
      return config;
    }

    it('ClassifyTask_NoVerificationConfig_StampsBuiltinSequence', () => {
      const task: TaskInput = { id: 'T-100', title: 'Implement feature X' };

      const classification = classifyTask(task);

      const expected = resolveVerificationSequence(
        classification.riskTier,
        classification.boundaryTouching,
      );
      expect(classification.verificationSequence).toEqual(expected);
    });

    /** The task derives to the medium cell, so the configured medium sequence replaces the built-in sequence. */
    it('ClassifyTask_ConfiguredPolicyCell_StampsConfigResolvedSequence', () => {
      const customSequence: readonly GateName[] = [
        'check_static_analysis',
        'check_mock_boundary',
      ];
      const task: TaskInput = { id: 'T-101', title: 'Implement feature Y' };
      const config = configWithMediumPolicy(customSequence);

      const baseline = classifyTask(task);
      expect(baseline.riskTier).toBe('medium');
      expect(baseline.boundaryTouching).toBe(false);

      const classification = classifyTask(task, DEFAULTS.agents, config);

      expect(classification.verificationSequence).toEqual(customSequence);
      expect(classification.verificationSequence).not.toEqual(baseline.verificationSequence);
    });
  });

  /**
   * `classifyTask` gets its verification sequence through `resolveGateSet('IMPLEMENT', ...)`.
   * That resolver returns the `resolveVerificationPolicy` sequence unchanged, so the stamp equals it for each profile.
   * Each profile sets `riskTier` and `boundaryTouching`, so the derivation heuristic does not affect the comparison.
   */
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
        const task: TaskInput = {
          id: `T-NEUTRAL-${label}`,
          title: 'Implement feature under neutrality check',
          riskTier,
          boundaryTouching,
        };

        const classification = classifyTask(task);

        const expected = resolveVerificationPolicy(riskTier, boundaryTouching).sequence;
        expect(classification.verificationSequence, label).toEqual(expected);
      }
    });
  });

  /**
   * `classifyTask` selects the implementer prompt by tier, and never uses a fixed medium default.
   * The default classification carries `verificationNoteKey` and not the full prompt.
   * The full prompt is inline only when the caller passes `includeImplementerPrompt: true`.
   */
  describe('classifyTask — per-task implementer prompt rendering (#1586 / DR-4)', () => {
    /** A low-tier prompt must not contain the uppercase red-green-refactor tokens. */
    it('ClassifyTask_LowTierTask_RendersStaticAnalysisNote_NotRGR', () => {
      const task: TaskInput = {
        id: 'T-LOW',
        title: 'Update the docs',
        riskTier: 'low',
        boundaryTouching: false,
      };

      const classification = classifyTask(task, undefined, undefined, {
        includeImplementerPrompt: true,
      });

      expect(classification.verificationNoteKey).toBe('low|false');
      expect(classification.implementerPrompt).toContain('static analysis suffices');
      expect(classification.implementerPrompt).not.toContain('RED');
      expect(classification.implementerPrompt).not.toContain('REFACTOR');
    });

    it('ClassifyTask_HighTierTask_RendersTestAfterIntegrationBlock', () => {
      const task: TaskInput = {
        id: 'T-HIGH',
        title: 'Reshape the schema',
        riskTier: 'high',
        boundaryTouching: true,
      };

      const classification = classifyTask(task, undefined, undefined, {
        includeImplementerPrompt: true,
      });

      expect(classification.verificationNoteKey).toBe('high|true');
      expect(classification.implementerPrompt).toContain('check_test_adequacy');
      expect(classification.implementerPrompt).toContain('check_integration_suite');
    });

    it('ClassifyTask_DefaultClassification_OmitsFullPrompt_CarriesNoteKey', () => {
      const task: TaskInput = {
        id: 'T-MED',
        title: 'Implement widget',
        riskTier: 'medium',
        boundaryTouching: false,
      };

      const classification = classifyTask(task);

      expect(classification.verificationNoteKey).toBe('medium|false');
      expect(classification.implementerPrompt).toBeUndefined();
    });

    it('ClassifyTask_ImplementerPrompt_ByteIdenticalToRenderForResolvedTier', () => {
      const task: TaskInput = {
        id: 'T-MED',
        title: 'Implement widget',
        riskTier: 'medium',
        boundaryTouching: false,
      };

      const classification = classifyTask(task, undefined, undefined, {
        includeImplementerPrompt: true,
      });

      expect(classification.implementerPrompt).toBe(
        renderImplementerPrompt({
          riskTier: classification.riskTier,
          boundaryTouching: classification.boundaryTouching,
        }),
      );
    });
  });

  /**
   * The response carries the implementer prompt template once, each distinct tier note once, and a note key for each task.
   * The template and a note rebuild the full prompt of a task without loss. Without the dedupe, each task carries the full prompt.
   * `eightTaskWave` holds 2 low, 4 medium and 2 high tasks.
   * The tests that use it pass `nativeIsolation: true`, so worktree blockers do not stop the wave before classification.
   */
  describe('DR-4 — prompt dedupe (template once + per-task note deltas)', () => {
    function eightTaskWave(): TaskInput[] {
      return [
        { id: 'task-1', title: 'Update the README', files: ['docs/a.md'] },
        { id: 'task-2', title: 'Update the guide', files: ['docs/b.md'] },
        { id: 'task-3', title: 'Implement widget A' },
        { id: 'task-4', title: 'Implement widget B' },
        { id: 'task-5', title: 'Implement widget C' },
        { id: 'task-6', title: 'Implement widget D' },
        { id: 'task-7', title: 'Reshape the schema', riskTier: 'high', boundaryTouching: true },
        { id: 'task-8', title: 'Rework the API contract', riskTier: 'high', boundaryTouching: true },
      ];
    }

    interface DedupeData {
      ready: boolean;
      taskClassifications: TaskClassification[];
      implementerPromptTemplate?: string;
      verificationNotes?: Record<string, string>;
    }

    /**
     * The head sentence of the template appears once in the serialized response, and no task carries the full prompt.
     * The prompt payload of the 8 tasks stays at or under 2,500 tokens. The classification metadata is outside that budget.
     * The whole response is less than a third of its size with a full prompt on each task.
     */
    it('prepareDelegation_EightTaskWave_ReturnsPromptTemplateOnce', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        nativeIsolation: true,
        tasks: eightTaskWave(),
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      const data = result.data as DedupeData;
      expect(data.ready).toBe(true);
      expect(data.taskClassifications).toHaveLength(8);

      expect(typeof data.implementerPromptTemplate).toBe('string');
      expect(data.implementerPromptTemplate).toBe(IMPLEMENTER_PROMPT_TEMPLATE);
      expect(data.implementerPromptTemplate).toContain(VERIFICATION_NOTE_PLACEHOLDER);

      const serialized = JSON.stringify(data);
      const sentinel = 'You are an implementer agent on the verification ladder';
      expect(serialized.split(sentinel).length - 1).toBe(1);

      for (const c of data.taskClassifications) {
        expect(c.implementerPrompt).toBeUndefined();
        expect(typeof c.verificationNoteKey).toBe('string');
      }

      expect(Object.keys(data.verificationNotes ?? {})).toHaveLength(3);

      const promptPayloadTokens = estimateTokens(
        JSON.stringify({
          implementerPromptTemplate: data.implementerPromptTemplate,
          verificationNotes: data.verificationNotes,
          noteKeys: data.taskClassifications.map((c) => c.verificationNoteKey),
        }),
      );
      expect(promptPayloadTokens).toBeLessThanOrEqual(2500);

      const responseTokens = estimateTokens(serialized);
      const preDr4PromptTokens = data.taskClassifications.reduce(
        (sum, c) =>
          sum +
          estimateTokens(
            renderImplementerPrompt({ riskTier: c.riskTier, boundaryTouching: c.boundaryTouching }),
          ),
        0,
      );
      const preDr4ResponseTokens = responseTokens - promptPayloadTokens + preDr4PromptTokens;
      expect(responseTokens).toBeLessThan(preDr4ResponseTokens / 3);
    });

    /**
     * For each task, the template with its note equals `renderImplementerPrompt` for the tier of the task, byte for byte.
     * `reconstructImplementerPrompt` gives the same text.
     */
    it('prepareDelegation_PerTaskDeltas_ReconstructExactPerTaskPrompt', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        nativeIsolation: true,
        tasks: eightTaskWave(),
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      const data = result.data as DedupeData;
      const template = data.implementerPromptTemplate as string;
      const notes = data.verificationNotes as Record<string, string>;

      for (const c of data.taskClassifications) {
        expect(notes[c.verificationNoteKey]).toBeDefined();

        const reconstructed = template.replaceAll(
          VERIFICATION_NOTE_PLACEHOLDER,
          notes[c.verificationNoteKey],
        );
        const preDr4 = renderImplementerPrompt({
          riskTier: c.riskTier,
          boundaryTouching: c.boundaryTouching,
        });
        expect(reconstructed).toBe(preDr4);

        expect(
          reconstructImplementerPrompt({ verificationNote: notes[c.verificationNoteKey] }),
        ).toBe(preDr4);
      }

      for (const c of data.taskClassifications) {
        expect(c.verificationNoteKey).toBe(
          verificationNoteKey(c.riskTier, c.boundaryTouching),
        );
        expect(notes[c.verificationNoteKey]).toBe(
          buildVerificationNote({ riskTier: c.riskTier, boundaryTouching: c.boundaryTouching }),
        );
      }
    });

    /**
     * A high, boundary-touching stamp in the plan file at `planPath` reaches the classification and selects the high-tier note.
     * The plan heading and the task match by their canonical id.
     */
    it('prepareDelegation_TierStamps_ThreadedEndToEnd', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);

      const planDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'dr4-planpath-'));
      const planPath = nodePath.join(planDir, 'plan.md');
      await fsp.writeFile(
        planPath,
        '#### Task 001: Reshape the schema\n**Risk Tier:** high · **Boundary Touching:** true\n',
        'utf-8',
      );

      try {
        const args = {
          featureId: 'test-feature',
          tasks: [{ id: 'task-1', title: 'Reshape the schema' }],
          planPath,
        };

        const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

        expect(result.success).toBe(true);
        const data = result.data as DedupeData;
        expect(data.taskClassifications).toHaveLength(1);
        const c = data.taskClassifications[0];

        expect(c.riskTier).toBe('high');
        expect(c.boundaryTouching).toBe(true);
        expect(c.verificationNoteKey).toBe('high|true');

        const note = (data.verificationNotes as Record<string, string>)[c.verificationNoteKey];
        expect(note).toContain('check_integration_suite');
        const reconstructed = (data.implementerPromptTemplate as string).replaceAll(
          VERIFICATION_NOTE_PLACEHOLDER,
          note,
        );
        expect(reconstructed).toBe(
          renderImplementerPrompt({ riskTier: 'high', boundaryTouching: true }),
        );
      } finally {
        await rmrfAsync(planDir);
      }
    });

    /** With `detail: true`, each classification carries its full prompt inline, equal to `renderImplementerPrompt` for its tier. */
    it('prepareDelegation_DetailFlag_InlinesFullPerTaskPrompt', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      const args = {
        featureId: 'test-feature',
        nativeIsolation: true,
        detail: true,
        tasks: [{ id: 'task-1', title: 'Reshape the schema', riskTier: 'high' as const, boundaryTouching: true }],
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      const data = result.data as DedupeData;
      const c = data.taskClassifications[0];
      expect(c.implementerPrompt).toBe(
        renderImplementerPrompt({ riskTier: 'high', boundaryTouching: true }),
      );
    });

    it('prepareDelegation_InvalidOutputFormat_ReturnsInvalidInput', async () => {
      const args = {
        featureId: 'test-feature',
        outputFormat: 'verbose',
      } as unknown as { featureId: string; outputFormat?: 'prompt-only' };

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('outputFormat');
    });
  });

  describe('handler config threading', () => {
    /**
     * The sequence from `ctx.projectConfig` reaches the classifications that the handler returns, and prompt assembly reads that stamp.
     * The task derives to medium, and the config replaces the medium cell.
     */
    it('PrepareDelegation_ConfiguredPolicy_StampsConfigSequenceOnClassifications', async () => {
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
        tasks: [{ id: 'task-1', title: 'Implement widget' }],
      };
      const ctx = {
        stateDir: STATE_DIR,
        eventStore: mockStore as never,
        enableTelemetry: false,
        projectConfig: config,
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, ctx as never);

      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      const stamped = data.taskClassifications[0];
      expect(stamped.riskTier).toBe('medium');
      expect(stamped.verificationSequence).toEqual(customSequence);
    });

    it('PrepareDelegation_WithTasks_ClassificationsIncludeRecommendedModel', async () => {
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

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      expect(data.taskClassifications).toBeDefined();
      for (const tc of data.taskClassifications) {
        expect(tc.recommendedModel).toBeDefined();
        expect(['opus', 'sonnet', 'haiku']).toContain(tc.recommendedModel);
      }
    });

    /**
     * The model follows the risk tier through `projectConfig.agents.tierModels`, not the scaffolder or implementer agent.
     * Both tasks derive to medium, so both get the configured medium model from a real `resolveConfig` result.
     */
    it('PrepareDelegation_WithCtx_UsesProjectConfigForModelResolution', async () => {
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
        projectConfig: resolveConfig({ agents: { 'tier-models': { medium: 'opus' } } }),
      };

      const result = await handlePrepareDelegation(args, STATE_DIR, ctx as never);

      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      const scaffolderTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'scaffolder');
      const implementerTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'implementer');
      expect(scaffolderTask).toBeDefined();
      expect(implementerTask).toBeDefined();
      expect(scaffolderTask?.riskTier).toBe('medium');
      expect(implementerTask?.riskTier).toBe('medium');
      expect(scaffolderTask?.recommendedModel).toBe('opus');
      expect(implementerTask?.recommendedModel).toBe('opus');
    });

    /**
     * The handler appends one `task.assigned` with a per-task key for each task that the stream has not announced.
     * It skips an announced task, because the projection reads a second `task.assigned` event as a return to `assigned`.
     * The title comes from the workflow state, which is the authority on the plan. The append guard is the tail that the read saw.
     */
    it('PrepareDelegation_AnnouncesEachTaskTheStreamHasNotHeardOf_BeforeReadiness', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      mockStore.query.mockResolvedValue([
        { sequence: 7, type: 'task.assigned', data: { taskId: 'task-1', title: 'by hand' } },
      ]);
      const args = {
        featureId: 'test-feature',
        tasks: [
          { id: 'task-1', title: 'First' },
          { id: 'task-2', title: 'Second' },
        ],
      };
      try {
        const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));
        expect(result.success).toBe(true);
        const announced = mockStore.append.mock.calls
          .filter(([, event]) => (event as { type: string }).type === 'task.assigned')
          .map(([, event, opts]) => ({
            data: (event as { data: unknown }).data,
            key: (opts as { idempotencyKey?: string } | undefined)?.idempotencyKey,
            guard: (opts as { expectedSequence?: number } | undefined)?.expectedSequence,
          }));
        expect(announced).toEqual([
          { data: { taskId: 'task-2', title: 'Add tests' }, key: 'test-feature:task.assigned:task-2', guard: 7 },
        ]);
      } finally {
        mockStore.query.mockReset();
        mockStore.query.mockResolvedValue([]);
      }
    });

    /**
     * Another writer appends between the read and the append, so the tail guard refuses the first append.
     * The handler reads the stream again and announces only the tasks that the new read does not hold.
     * The raced task gets no second announcement, and the next task uses the tail of the new read as its guard.
     */
    it('PrepareDelegation_AnnouncementRacesAnotherWriter_DecidesAgainFromAFreshRead', async () => {
      const state = readyWorkflowState();
      setupMaterializer(state);
      vi.mocked(generateQualityHints).mockReturnValue([]);
      mockStore.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { sequence: 1, type: 'task.assigned', data: { taskId: 'task-1', title: 'by hand' } },
        ]);
      mockStore.append.mockImplementation(
        async (_stream: string, event: { type: string }, opts?: { expectedSequence?: number }) => {
          if (event.type === 'task.assigned' && opts?.expectedSequence === 0) {
            throw new SequenceConflictError(0, 1);
          }
          return undefined;
        },
      );
      const args = { featureId: 'test-feature' };
      try {
        const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));
        expect(result.success).toBe(true);
        const announced = mockStore.append.mock.calls
          .filter(([, event]) => (event as { type: string }).type === 'task.assigned')
          .map(([, event, opts]) => ({
            taskId: (event as { data: { taskId: string } }).data.taskId,
            guard: (opts as { expectedSequence?: number } | undefined)?.expectedSequence,
          }));
        expect(announced).toEqual([
          { taskId: 'task-1', guard: 0 },
          { taskId: 'task-2', guard: 1 },
        ]);
      } finally {
        mockStore.query.mockReset();
        mockStore.query.mockResolvedValue([]);
        mockStore.append.mockReset();
        mockStore.append.mockResolvedValue(undefined);
      }
    });

    /** The context has no `projectConfig`, so both medium tasks get `sonnet` from `DEFAULTS.agents.tierModels`, whatever their agent. */
    it('PrepareDelegation_WithoutCtx_UsesDefaults', async () => {
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

      const result = await handlePrepareDelegation(args, STATE_DIR, makeCtx(mockStore, STATE_DIR));

      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      const scaffolderTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'scaffolder');
      const implementerTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'implementer');
      expect(scaffolderTask).toBeDefined();
      expect(implementerTask).toBeDefined();
      expect(scaffolderTask?.recommendedModel).toBe('sonnet');
      expect(implementerTask?.recommendedModel).toBe('sonnet');
    });
  });

  /**
   * The dispatch boundary stamps each verification sequence through `resolveGateSet('IMPLEMENT', ...)`.
   * When the resolver throws, the boundary fails closed. It appends `phase.blocked` with a visible reason and stamps no classification.
   */
  describe('fail-closed gate-set boundary (DR-7)', () => {
    /** The phase-kind module mock wraps the real `resolveGateSet`, and this test makes it throw once with `mockImplementationOnce`. */
    it('ResolveGateSet_ResolverThrows_AppendsPhaseBlocked', async () => {
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

      const result = await handlePrepareDelegation(
        args,
        STATE_DIR,
        makeCtx(localStore, STATE_DIR),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PHASE_BLOCKED');
      expect(result.error?.message).toMatch(/gate|resolve|blocked|verification/i);
      const data = (result.data ?? {}) as { taskClassifications?: unknown };
      expect(data.taskClassifications).toBeUndefined();

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

  /**
   * The model follows the risk tier through `agents.tierModels`. The scaffolder or implementer split sets the agent, but not the model.
   * The defaults are haiku for low, sonnet for medium, and opus for high.
   */
  describe('classifyTask — tier-keyed model resolution (DR-1 #1672)', () => {
    /** A low-tier task gets the configured low model, here `sonnet`. The control call with the defaults gets `haiku`. */
    it('ClassifyTask_LowTier_ResolvesConfiguredLowModel', () => {
      const agents = resolveConfig({ agents: { 'tier-models': { low: 'sonnet' } } }).agents;
      const result = classifyTask({ id: '001', title: 'Tune settings', files: ['settings.json'] }, agents);
      expect(result.riskTier).toBe('low');
      expect(result.recommendedModel).toBe('sonnet');

      const dflt = classifyTask({ id: '001', title: 'Tune settings', files: ['settings.json'] });
      expect(dflt.riskTier).toBe('low');
      expect(dflt.recommendedModel).toBe('haiku');
    });

    /** A scaffolding title on a high-tier task keeps the scaffolder agent but gets the high-tier model, not haiku. */
    it('ClassifyTask_HighTierScaffoldingTitle_NeverHaiku', () => {
      const result = classifyTask({ id: '002', title: 'Scaffold the API interface', riskTier: 'high' });
      expect(result.recommendedAgent).toBe('scaffolder');
      expect(result.riskTier).toBe('high');
      expect(result.recommendedModel).not.toBe('haiku');
      expect(result.recommendedModel).toBe('opus');
    });

    /**
     * The planner stamp wins over the heuristic. A task that derives to medium gets the high-tier model when the planner stamps it high.
     */
    it('ClassifyTask_PlannerHighStamp_GetsHighTierModel', () => {
      const heuristicOnly = classifyTask({ id: '003', title: 'Implement feature' });
      expect(heuristicOnly.riskTier).toBe('medium');
      expect(heuristicOnly.recommendedModel).toBe('sonnet');

      const stamped = classifyTask({ id: '003', title: 'Implement feature', riskTier: 'high' });
      expect(stamped.riskTier).toBe('high');
      expect(stamped.recommendedModel).toBe('opus');
    });

    /** A configured high-tier model of `sonnet` reaches the classification from a real `resolveConfig` result. */
    it('ClassifyTask_TierModelsOverride_FlowsThrough', () => {
      const agents = resolveConfig({ agents: { 'tier-models': { high: 'sonnet' } } }).agents;
      const result = classifyTask({ id: '004', title: 'Implement feature', riskTier: 'high' }, agents);
      expect(result.riskTier).toBe('high');
      expect(result.recommendedModel).toBe('sonnet');
    });

    /** A task with only an id and a title derives to medium and gets `sonnet`. The model does not follow the agent. */
    it('ClassifyTask_MediumDefault_ResolvesSonnet', () => {
      const result = classifyTask({ id: '005', title: 'Add validation logic' });
      expect(result.riskTier).toBe('medium');
      expect(result.recommendedAgent).toBe('implementer');
      expect(result.recommendedModel).toBe('sonnet');
    });
  });
});

/**
 * Runs the production `classifyTask` over each tier-stamped task in the spec corpus, as `parseTaskStamps` reads it.
 * The model mix must follow the tier mix. The suite skips when the spec directory is absent.
 */
describe.skipIf(!fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/specs')))(
  'classifyTask — stamped-corpus model mix (DR-1 #1672)',
  () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SPECS_DIR = path.join(__dirname, '../../../../docs/specs');

  function loadStampedCorpus(): TaskInput[] {
    const files = fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.md'));
    const tasks: TaskInput[] = [];
    for (const f of files) {
      const parsed = parseTaskStamps(fs.readFileSync(path.join(SPECS_DIR, f), 'utf-8'));
      for (const t of parsed) {
        if (t.riskTier === undefined) continue;
        tasks.push({
          id: t.id,
          title: t.title,
          files: t.files,
          blockedBy: t.blockedBy,
          ...(t.testLayer ? { testLayer: t.testLayer } : {}),
          riskTier: t.riskTier,
          ...(t.boundaryTouching !== undefined ? { boundaryTouching: t.boundaryTouching } : {}),
        });
      }
    }
    return tasks;
  }

  /**
   * Each task gets the default model of its tier. The test requires at least 20 tasks in at least 2 tiers, so the check is not vacuous.
   * The default tier models are distinct, so each model count equals the count of its tier, and no model covers the whole corpus.
   */
  it('PrepareDelegation_StampedCorpus_ModelMixTracksTierDistribution', () => {
    const corpus = loadStampedCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(20);

    const tierCounts: Record<RiskTier, number> = { low: 0, medium: 0, high: 0 };
    const modelCounts: Record<string, number> = {};
    for (const task of corpus) {
      const c = classifyTask(task);
      expect(c.recommendedModel).toBe(DEFAULTS.agents.tierModels[c.riskTier]);
      tierCounts[c.riskTier]++;
      modelCounts[c.recommendedModel] = (modelCounts[c.recommendedModel] ?? 0) + 1;
    }

    const tiersPresent = (['low', 'medium', 'high'] as const).filter((t) => tierCounts[t] > 0);
    expect(tiersPresent.length).toBeGreaterThanOrEqual(2);

    const expectedModelCounts: Record<string, number> = {};
    for (const tier of tiersPresent) {
      const model = DEFAULTS.agents.tierModels[tier];
      expectedModelCounts[model] = (expectedModelCounts[model] ?? 0) + tierCounts[tier];
    }
    expect(modelCounts).toEqual(expectedModelCounts);

    const distinctModels = Object.keys(modelCounts);
    expect(distinctModels.length).toBeGreaterThanOrEqual(2);
    for (const count of Object.values(modelCounts)) {
      expect(count).toBeLessThan(corpus.length);
    }
  });
});

/**
 * `computeScopedWorktrees` compares task ids after `canonicaliseTaskId`, so the hyphenated, unhyphenated and plain-number spellings of one id match.
 * A strict string comparison gives false `<N> worktrees pending` blockers.
 */
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

  /** The wave uses the hyphenated id form and the projection holds the unhyphenated form. Both tasks are ready, so none is pending. */
  it('ComputeScopedWorktrees_HyphenedVsUnhyphenedIds_TreatedEqual', () => {
    const state = readiness(['T001', 'T002'], 2, ['2 worktrees pending']);
    const result = computeScopedWorktrees(state, [
      { id: 'T-001' },
      { id: 'T-002' },
    ]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(2);
    expect(result.pending).toBe(0);
    expect(result.blockers).not.toContain('2 worktrees pending');
  });

  it('ComputeScopedWorktrees_PlainNumericInArgs_MatchesTPrefixedReady', () => {
    const state = readiness(['T-001', 'T-002'], 2);
    const result = computeScopedWorktrees(state, [{ id: '001' }, { id: '002' }]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(2);
    expect(result.pending).toBe(0);
  });

  /** A wave task that is absent from `readyTaskIds` stays pending, and the blocker shows the wave count. */
  it('ComputeScopedWorktrees_MismatchedIds_StillReportsPending', () => {
    const state = readiness(['T-001'], 2, ['1 worktrees pending']);
    const result = computeScopedWorktrees(state, [
      { id: 'T-001' },
      { id: 'T-099' },
    ]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.blockers).toContain('1 worktrees pending');
  });

  /**
   * The global readiness can have no pending blocker while a wave task is not ready.
   * The helper then adds a `<N> worktrees pending` blocker, so the caller does not dispatch too early.
   */
  it('ComputeScopedWorktrees_GlobalReadyButWavePending_SynthesisesBlocker', () => {
    const state = readiness(['T-001'], 1, []);
    const result = computeScopedWorktrees(state, [{ id: 'T-002' }]);
    expect(result.expected).toBe(1);
    expect(result.ready).toBe(0);
    expect(result.pending).toBe(1);
    expect(result.blockers).toContain('1 worktrees pending');
  });

  it('ComputeScopedWorktrees_GlobalAndWaveReady_NoBlockerSynthesised', () => {
    const state = readiness(['T-001'], 1, []);
    const result = computeScopedWorktrees(state, [{ id: 'T-001' }]);
    expect(result.expected).toBe(1);
    expect(result.ready).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.blockers).toEqual([]);
  });

  /** The helper rewrites the global pending blocker to the wave count and adds no second pending blocker. */
  it('ComputeScopedWorktrees_GlobalHasPendingBlocker_RewrittenToWaveCount', () => {
    const state = readiness(['T-001'], 5, ['5 worktrees pending']);
    const result = computeScopedWorktrees(state, [
      { id: 'T-001' },
      { id: 'T-002' },
    ]);
    expect(result.expected).toBe(2);
    expect(result.ready).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.blockers).toContain('1 worktrees pending');
    expect(result.blockers).not.toContain('5 worktrees pending');
    const matches = result.blockers.filter(b =>
      /^\d+ worktrees pending$/.test(b),
    );
    expect(matches).toHaveLength(1);
  });
});

/**
 * A task is high risk when a file matches `HIGH_RISK_GLOBS` or the test layer is acceptance.
 * It is also high with 2 or more blockers or 3 or more files.
 */
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

  /** One file that matches a high-risk glob gives `high` without another high signal. */
  it('DeriveRiskTier_SchemaContractGlobHit_ReturnsHigh', () => {
    const cases: TaskInput[] = [
      { id: 's-1', title: 'edit schema', files: ['src/events/schemas.ts'] },
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
    expect(Array.isArray(HIGH_RISK_GLOBS)).toBe(true);
    expect(HIGH_RISK_GLOBS.length).toBeGreaterThan(0);
  });
});

/**
 * The planner value wins first, then the high rules, then the low rules. Medium is the default.
 * Low needs each file to match `LOW_RISK_GLOBS`, so a mix of low and other files gives medium.
 */
describe('deriveRiskTier — low / medium / override', () => {
  /** Schema and contract artifacts are shared-contract surfaces. They derive to high, even when a low-risk glob also matches the file. */
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
    const task: TaskInput = {
      id: 'm-3',
      title: 'Docs plus code',
      files: ['docs/README.md', 'src/handler.ts'],
    };
    expect(deriveRiskTier(task)).toBe('medium');
  });

  /** The planner value wins in both directions. It can lower a high task or raise a documentation task. */
  it('DeriveRiskTier_ExplicitPlannerValue_WinsOverDerivation', () => {
    const wouldBeHigh: TaskInput = {
      id: 'o-1',
      title: 'edit schema',
      files: ['src/events/schemas.ts'],
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

  /** For any task input, the derived tier is low, medium or high, and an explicit tier always wins. */
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

/**
 * A task is boundary-touching when its test layer is integration or acceptance, or when a file matches `BOUNDARY_GLOBS`.
 * The tag is independent of the risk tier, and an explicit value wins.
 */
describe('deriveBoundaryTouching', () => {
  it('DeriveBoundaryTouching_IntegrationOrAcceptanceTestLayer_ReturnsTrue', () => {
    expect(deriveBoundaryTouching({ id: 'b-1', title: 'x', testLayer: 'integration' })).toBe(true);
    expect(deriveBoundaryTouching({ id: 'b-2', title: 'x', testLayer: 'acceptance' })).toBe(true);
  });

  it('DeriveBoundaryTouching_UnitOrPropertyTestLayer_NotBoundaryByLayer', () => {
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

  /** One adapter file marks the task boundary-touching, but it does not make the task high risk. */
  it('DeriveBoundaryTouching_LowBlastSchemaAdapterEdit_TagIndependentOfRiskTier', () => {
    const task: TaskInput = { id: 'i-1', title: 'tweak adapter', files: ['src/adapters/cli.ts'] };
    expect(deriveBoundaryTouching(task)).toBe(true);
    expect(deriveRiskTier(task)).not.toBe('high');
  });

  it('DeriveBoundaryTouching_PlainSourceEdit_ReturnsFalse', () => {
    const task: TaskInput = { id: 'n-1', title: 'logic', files: ['src/validate.ts'] };
    expect(deriveBoundaryTouching(task)).toBe(false);
  });

  /** The explicit value sets the tag in both directions. */
  it('DeriveBoundaryTouching_ExplicitOverride_Wins', () => {
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

describe('DR-14 dispatch-boundary capability enforcement (#1546)', () => {
  /** With the default handshake, the bundle that `mintCapabilitiesForKind` mints for the dispatch kind carries `fs:write`. */
  it('AssertDispatchMutationCapabilities_DefaultHandshake_GrantsFsWrite', () => {
    const caps = assertDispatchMutationCapabilities();
    expect(caps.has('fs:write')).toBe(true);
    expect(caps.has('isolation:worktree')).toBe(true);
  });

  /**
   * A handshake that revokes `fs:write`, as a sandboxed client can do, makes the dispatch boundary throw.
   * It does not dispatch an agent that cannot write.
   */
  it('AssertDispatchMutationCapabilities_HandshakeDeniesFsWrite_FailsClosed', () => {
    expect(() =>
      assertDispatchMutationCapabilities({ deny: ['fs:write'] }),
    ).toThrow(/fs:write/);
  });

  /** The capability check does not block the ordinary dispatch path, because the dispatch kind grants mutation. */
  it('ClassifyTasksFailClosed_HappyPath_StillClassifies', () => {
    const result = classifyTasksFailClosed([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.classifications).toEqual([]);
  });
});
