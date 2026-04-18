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
import { handlePrepareDelegation, classifyTask } from './prepare-delegation.js';
import type { TaskClassification } from './prepare-delegation.js';
import { DEFAULTS } from '../config/resolve.js';

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
    blockers: ['plan not approved', 'no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation'],
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

  // ─── DR-5: nativeIsolation readiness.blockers consistency ─────────────────

  it('handlePrepareDelegation_NativeIsolation_ExcludesWorktreeBlockers', async () => {
    // Arrange: ONLY worktree-related blockers present
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['worktrees pending', 'no worktrees expected'],
      plan: { approved: true, taskCount: 2 },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
      plan: { approved: false, taskCount: 0 },
      quality: { queried: false, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
      plan: { approved: false, taskCount: 0 },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 2, ready: 0, failed: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
    // Plan artifact missing is added as supplementary check
    expect(data.readiness.blockers).toContain('Plan artifact is missing');
  });

  // ─── T-15: nativeIsolation parameter ──────────────────────────────────────

  it('PrepareDelegation_NativeIsolationTrue_SkipsWorktreeBlockers', async () => {
    // Arrange: worktrees not ready, but nativeIsolation skips those blockers
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['no worktrees expected'],
      plan: { approved: true, taskCount: 2 },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 0, ready: 0, failed: [] },
    };
    setupMaterializer(state, undefined, drState);
    vi.mocked(generateQualityHints).mockReturnValue([]);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

    // Assert — should be ready despite worktree blockers
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; isolation: string; blockers?: string[] };
    expect(data.ready).toBe(true);
    expect(data.isolation).toBe('native');
  });

  it('PrepareDelegation_NativeIsolationFalse_PreservesWorktreeBlockers', async () => {
    // Arrange: worktrees not ready, nativeIsolation false (default)
    const state = readyWorkflowState();
    const drState: DelegationReadinessState = {
      ready: false,
      blockers: ['no worktrees expected'],
      plan: { approved: true, taskCount: 2 },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 0, ready: 0, failed: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature' };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
      plan: { approved: false, taskCount: 0 },
      quality: { queried: true, gatePassRate: null, regressions: [] },
      worktrees: { expected: 0, ready: 0, failed: [] },
    };
    setupMaterializer(state, undefined, drState);
    const args = { featureId: 'test-feature', nativeIsolation: true };

    // Act
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
    const result = await handlePrepareDelegation(args, STATE_DIR);

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
      const result = await handlePrepareDelegation(args, STATE_DIR);

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
      const result = await handlePrepareDelegation(args, STATE_DIR);

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

  describe('handler config threading', () => {
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
      const result = await handlePrepareDelegation(args, STATE_DIR);

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
      const result = await handlePrepareDelegation(args, STATE_DIR);

      // Assert -- uses DEFAULTS.agents
      expect(result.success).toBe(true);
      const data = result.data as { taskClassifications: TaskClassification[] };
      const scaffolderTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'scaffolder');
      const implementerTask = data.taskClassifications.find(tc => tc.recommendedAgent === 'implementer');
      expect(scaffolderTask?.recommendedModel).toBe('haiku');   // DEFAULTS.agents.models.scaffolder
      expect(implementerTask?.recommendedModel).toBe('opus');   // DEFAULTS.agents.defaultModel
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
