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
  getOrCreateEventStore: vi.fn(),
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

import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  queryDeltaEvents,
} from '../views/tools.js';
import { generateQualityHints } from '../quality/hints.js';
import { emitGateEvent } from './gate-utils.js';
import { handlePrepareDelegation } from './prepare-delegation.js';

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
    plan: { approved: true, taskCount: 2 },
    quality: { queried: true, gatePassRate: null, regressions: [] },
    worktrees: { expected: 2, ready: 2, failed: [] },
  };
}

function notReadyDelegationReadiness(): DelegationReadinessState {
  return {
    ready: false,
    blockers: ['plan not approved', 'no tasks found in workflow state — emit task.assigned events via exarchos_event before calling prepare_delegation', 'quality signals not queried'],
    plan: { approved: false, taskCount: 0 },
    quality: { queried: false, gatePassRate: null, regressions: [] },
    worktrees: { expected: 0, ready: 0, failed: [] },
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
    append: vi.fn(),
    listStreams: vi.fn().mockReturnValue(null),
  };
  vi.mocked(getOrCreateEventStore).mockReturnValue(
    mockStore as unknown as ReturnType<typeof getOrCreateEventStore>,
  );
  vi.mocked(queryDeltaEvents).mockResolvedValue([]);

  return { mockMaterializer, mockStore };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handlePrepareDelegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PrepareDelegation_MissingFeatureId_ReturnsInvalidInput', async () => {
    // Arrange
    const args = {} as { featureId: string };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('PrepareDelegation_NotReady_ReturnsBlockers', async () => {
    // Arrange
    const state = notReadyWorkflowState();
    setupMaterializer(state);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
    await handlePrepareDelegation(args, STATE_DIR);

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
    await handlePrepareDelegation(args, STATE_DIR);

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
    await handlePrepareDelegation(args, STATE_DIR);

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
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
    const result = await handlePrepareDelegation(args, STATE_DIR);

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

  it('HandlePrepareDelegation_ViewReadyButPlanArtifactMissing_ReturnsBlocker', async () => {
    // Arrange: view says ready, but workflow state has no plan artifact
    const state = {
      ...readyWorkflowState(),
      artifacts: { design: 'design.md', plan: null, pr: null },
    };
    const drState = readyDelegationReadiness();
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      blockers: string[];
    };
    expect(data.ready).toBe(false);
    expect(data.blockers).toContain('Plan artifact is missing');
  });

  it('HandlePrepareDelegation_ReadinessIncludesWorktreeData', async () => {
    // Arrange: ready state with worktree data
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ...readyDelegationReadiness(),
      worktrees: { expected: 3, ready: 3, failed: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      readiness: DelegationReadinessState;
    };
    expect(data.readiness.worktrees.expected).toBe(3);
    expect(data.readiness.worktrees.ready).toBe(3);
    expect(data.readiness.worktrees.failed).toHaveLength(0);
  });
});
