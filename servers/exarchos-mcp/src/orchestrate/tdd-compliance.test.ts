// ─── TDD Compliance Orchestrate Action Tests ─────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';

// ─── Mock pure TS tdd-compliance module ─────────────────────────────────────

vi.mock('./pure/tdd-compliance.js', () => ({
  checkTddCompliance: vi.fn(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { checkTddCompliance } from './pure/tdd-compliance.js';
import { handleTddCompliance } from './tdd-compliance.js';

const STATE_DIR = '/tmp/test-tdd-compliance';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleTddCompliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Test 1: Compliant branch returns passed ────────────────────────────

  it('handleTddCompliance_CompliantBranch_ReturnsPassed', async () => {
    // Arrange — mock the pure TS checker
    vi.mocked(checkTddCompliance).mockReturnValue({
      status: 'pass',
      branch: 'feature/widget',
      baseBranch: 'main',
      commitsAnalyzed: 3,
      passCount: 3,
      failCount: 0,
      violations: [],
      results: [
        '- **PASS**: `abc1234` — feat: add tests (test-only)',
        '- **PASS**: `def5678` — feat: implement widget (test+impl)',
        '- **PASS**: `ghi9012` — feat: add more tests (test-only)',
      ],
      report: '## TDD Compliance Report\n\n**Result: PASS** (3/3 commits compliant)',
    });

    const args = {
      featureId: 'feat-widget',
      taskId: 'T-01',
      branch: 'feature/widget',
    };

    // Act
    const result = await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      taskId: string;
      branch: string;
      compliance: { passCount: number; failCount: number; total: number };
      report: string;
    };
    expect(data.passed).toBe(true);
    expect(data.taskId).toBe('T-01');
    expect(data.branch).toBe('feature/widget');
    expect(data.compliance.passCount).toBe(3);
    expect(data.compliance.failCount).toBe(0);
    expect(data.compliance.total).toBe(3);
    expect(data.report).toContain('Result: PASS');
  });

  // ─── Test 2: Violations returns fail with findings ──────────────────────

  it('handleTddCompliance_Violations_ReturnsFailWithFindings', async () => {
    // Arrange — mock the pure TS checker with violations
    vi.mocked(checkTddCompliance).mockReturnValue({
      status: 'fail',
      branch: 'feature/widget',
      baseBranch: 'main',
      commitsAnalyzed: 3,
      passCount: 1,
      failCount: 2,
      violations: [
        'def5678: feat: implement without test',
        'xyz3456: feat: another impl without test',
      ],
      results: [
        '- **PASS**: `abc1234` — feat: add tests (test-only)',
        '- **FAIL**: `def5678` — feat: implement without test (implementation without test)',
        '- **FAIL**: `xyz3456` — feat: another impl without test (implementation without test)',
      ],
      report: '## TDD Compliance Report\n\n**Result: FAIL** (2/3 commits have violations)',
    });

    const args = {
      featureId: 'feat-widget',
      taskId: 'T-02',
      branch: 'feature/widget',
    };

    // Act
    const result = await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      taskId: string;
      compliance: { passCount: number; failCount: number; total: number };
      report: string;
    };
    expect(data.passed).toBe(false);
    expect(data.taskId).toBe('T-02');
    expect(data.compliance.failCount).toBe(2);
    expect(data.compliance.total).toBe(3);
    expect(data.report).toContain('Result: FAIL');
  });

  // ─── Test 3: Emits gate.executed event with taskId ──────────────────────

  it('handleTddCompliance_EmitsGateExecutedEvent_WithTaskId', async () => {
    // Arrange
    vi.mocked(checkTddCompliance).mockReturnValue({
      status: 'pass',
      branch: 'feature/widget',
      baseBranch: 'main',
      commitsAnalyzed: 2,
      passCount: 2,
      failCount: 0,
      violations: [],
      results: [],
      report: '## TDD Compliance Report\n\n**Result: PASS** (2/2 commits compliant)',
    });

    const args = {
      featureId: 'feat-widget',
      taskId: 'T-03',
      branch: 'feature/widget',
    };

    // Act
    await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert
    expect(mockStore.append).toHaveBeenCalledOnce();
    const [streamId, event] = mockStore.append.mock.calls[0] as [
      string,
      { type: string; data: Record<string, unknown> },
    ];
    expect(streamId).toBe('feat-widget');
    expect(event.type).toBe('gate.executed');
    expect(event.data.gateName).toBe('tdd-compliance');
    expect(event.data.layer).toBe('testing');
    expect(event.data.passed).toBe(true);
    const details = event.data.details as Record<string, unknown>;
    expect(details.dimension).toBe('D1');
    expect(details.taskId).toBe('T-03');
    expect(details.branch).toBe('feature/widget');
    expect(details.passCount).toBe(2);
    expect(details.failCount).toBe(0);
    expect(details.totalCommits).toBe(2);
  });

  // ─── Test: Phase in event details ──────────────────────────────────────

  it('handleTddCompliance_EmitsGateEvent_IncludesPhaseDelegateInDetails', async () => {
    // Arrange
    vi.mocked(checkTddCompliance).mockReturnValue({
      status: 'pass',
      branch: 'feature/widget',
      baseBranch: 'main',
      commitsAnalyzed: 2,
      passCount: 2,
      failCount: 0,
      violations: [],
      results: [],
      report: '## TDD Compliance Report\n\n**Result: PASS** (2/2 commits compliant)',
    });

    const args = {
      featureId: 'feat-widget',
      taskId: 'T-phase',
      branch: 'feature/widget',
    };

    // Act
    await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert
    expect(mockStore.append).toHaveBeenCalledOnce();
    const [, event] = mockStore.append.mock.calls[0] as [
      string,
      { type: string; data: Record<string, unknown> },
    ];
    expect(event.type).toBe('gate.executed');
    const details = event.data.details as Record<string, unknown>;
    expect(details.phase).toBe('delegate');
  });

  // ─── Test 4: Missing args returns error ─────────────────────────────────

  it('handleTddCompliance_MissingFeatureId_ReturnsError', async () => {
    // Arrange
    const args = { featureId: '', taskId: 'T-04', branch: 'feature/widget' };

    // Act
    const result = await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('handleTddCompliance_MissingTaskId_ReturnsError', async () => {
    // Arrange
    const args = { featureId: 'feat-widget', taskId: '', branch: 'feature/widget' };

    // Act
    const result = await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('taskId');
  });

  it('handleTddCompliance_MissingBranch_ReturnsError', async () => {
    // Arrange
    const args = { featureId: 'feat-widget', taskId: 'T-04', branch: '' };

    // Act
    const result = await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('branch');
  });

  // ─── Test 5: Uses baseBranch argument when provided ─────────────────────

  it('handleTddCompliance_CustomBaseBranch_PassedToChecker', async () => {
    // Arrange
    vi.mocked(checkTddCompliance).mockReturnValue({
      status: 'pass',
      branch: 'feature/widget',
      baseBranch: 'develop',
      commitsAnalyzed: 1,
      passCount: 1,
      failCount: 0,
      violations: [],
      results: [],
      report: '## TDD Compliance Report\n\n**Result: PASS** (1/1 commits compliant)',
    });

    const args = {
      featureId: 'feat-widget',
      taskId: 'T-05',
      branch: 'feature/widget',
      baseBranch: 'develop',
    };

    // Act
    await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert — verify the checker was called with correct baseBranch
    expect(checkTddCompliance).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/widget',
        baseBranch: 'develop',
      }),
    );
  });

  // ─── Test 6: Defaults baseBranch to main ────────────────────────────────

  it('handleTddCompliance_NoBaseBranch_DefaultsToMain', async () => {
    // Arrange
    vi.mocked(checkTddCompliance).mockReturnValue({
      status: 'pass',
      branch: 'feature/widget',
      baseBranch: 'main',
      commitsAnalyzed: 1,
      passCount: 1,
      failCount: 0,
      violations: [],
      results: [],
      report: '## TDD Compliance Report\n\n**Result: PASS** (1/1 commits compliant)',
    });

    const args = {
      featureId: 'feat-widget',
      taskId: 'T-06',
      branch: 'feature/widget',
    };

    // Act
    await handleTddCompliance(args, STATE_DIR, mockStore as unknown as EventStore);

    // Assert — verify the checker was called with default baseBranch 'main'
    expect(checkTddCompliance).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'main',
      }),
    );
  });
});
