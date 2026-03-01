// ─── Prepare Delegation Action Tests ─────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import { WORKFLOW_STATE_VIEW } from '../views/workflow-state-projection.js';
import { CODE_QUALITY_VIEW } from '../views/code-quality-view.js';

// ─── Mock Dependencies ──────────────────────────────────────────────────────

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: vi.fn(),
  getOrCreateEventStore: vi.fn(),
  queryDeltaEvents: vi.fn(),
}));

vi.mock('../quality/hints.js', () => ({
  generateQualityHints: vi.fn(),
}));

import {
  getOrCreateMaterializer,
  getOrCreateEventStore,
  queryDeltaEvents,
} from '../views/tools.js';
import { generateQualityHints } from '../quality/hints.js';
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

function setupMaterializer(
  workflowState: Record<string, unknown>,
  qualityState?: Record<string, unknown>,
) {
  const cqState = qualityState ?? emptyQualityState();
  const mockMaterializer = {
    register: vi.fn(),
    materialize: vi.fn().mockImplementation(
      (_streamId: string, viewName: string) => {
        if (viewName === WORKFLOW_STATE_VIEW) return workflowState;
        if (viewName === CODE_QUALITY_VIEW) return cqState;
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
});
