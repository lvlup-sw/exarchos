// ─── Post-Merge Gate Handler Tests ──────────────────────────────────────────

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';

// ─── Mock the pure TS post-merge module ──────────────────────────────────────

const mockCheckPostMerge = vi.fn();

vi.mock('./pure/post-merge.js', () => ({
  checkPostMerge: (...args: unknown[]) => mockCheckPostMerge(...args),
}));

// ─── Mock event store ──────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

// ─── Import after mocks ───────────────────────────────────────────────────

import { handlePostMerge } from './post-merge.js';

const STATE_DIR = '/tmp/test-post-merge';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePassingResult() {
  return {
    status: 'pass' as const,
    prUrl: 'https://github.com/org/repo/pull/42',
    mergeSha: 'abc1234',
    passCount: 2,
    failCount: 0,
    results: [
      '- **PASS**: CI green (all checks SUCCESS or NEUTRAL)',
      '- **PASS**: Test suite (npm run test:run passed)',
    ],
    findings: [],
    report: '## Post-Merge Regression Report\n\n**Result: PASS** (2/2 checks passed)',
  };
}

function makeFailingResult() {
  return {
    status: 'fail' as const,
    prUrl: 'https://github.com/org/repo/pull/42',
    mergeSha: 'abc1234',
    passCount: 0,
    failCount: 2,
    results: [
      '- **FAIL**: CI green -- Failed checks: ci/build (FAILURE)',
      '- **FAIL**: Test suite -- npm run test:run failed',
    ],
    findings: [
      'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: ci/build (FAILURE)"',
      'FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed (merge-sha: abc1234)"',
    ],
    report: '## Post-Merge Regression Report\n\n**Result: FAIL** (2/2 checks failed)',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('handlePostMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Test 1: CI passing returns passed ──────────────────────────────────

  it('handlePostMerge_CIPassing_ReturnsPassed', async () => {
    // Arrange
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    // Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prUrl: string; mergeSha: string; findings: string[]; report: string };
    expect(data.passed).toBe(true);
    expect(data.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(data.mergeSha).toBe('abc1234');
    expect(data.findings).toEqual([]);
    expect(data.report).toContain('PASS');
  });

  // ─── Test 2: Regression returns fail with findings ─────────────────────

  it('handlePostMerge_Regression_ReturnsFailWithFindings', async () => {
    // Arrange
    mockCheckPostMerge.mockReturnValue(makeFailingResult());

    // Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; findings: string[]; report: string };
    expect(data.passed).toBe(false);
    expect(data.findings).toHaveLength(2);
    expect(data.findings[0]).toContain('ci-green');
    expect(data.findings[1]).toContain('test-suite');
    expect(data.report).toContain('FAIL');
  });

  // ─── Test 3: Emits gate.executed event ─────────────────────────────────

  it('handlePostMerge_EmitsGateExecutedEvent', async () => {
    // Arrange
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    // Act
    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(mockStore.append).toHaveBeenCalledTimes(1);
    const [streamId, event] = mockStore.append.mock.calls[0] as [string, { type: string; data: Record<string, unknown> }];
    expect(streamId).toBe('feat-123');
    expect(event.type).toBe('gate.executed');
    expect(event.data.gateName).toBe('post-merge');
    expect(event.data.layer).toBe('post-merge');
    expect(event.data.passed).toBe(true);
    const details = event.data.details as { dimension: string; prUrl: string; mergeSha: string; findings: string[] };
    expect(details.dimension).toBe('D4');
    expect(details.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(details.mergeSha).toBe('abc1234');
    expect(details.findings).toEqual([]);
  });

  // ─── Test 3b: Phase in gate event details ───────────────────────────────

  it('handlePostMerge_EmitsGateEvent_IncludesPhaseInDetails', async () => {
    // Arrange
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    // Act
    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(mockStore.append).toHaveBeenCalledTimes(1);
    const [, event] = mockStore.append.mock.calls[0] as [string, { type: string; data: Record<string, unknown> }];
    const details = event.data.details as Record<string, unknown>;
    expect(details.phase).toBe('synthesize');
  });

  // ─── Test 4: Missing args returns error ────────────────────────────────

  it('handlePostMerge_MissingPrUrl_ReturnsError', async () => {
    // Arrange & Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: '', mergeSha: 'abc1234' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('prUrl');
  });

  it('handlePostMerge_MissingMergeSha_ReturnsError', async () => {
    // Arrange & Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: '' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('mergeSha');
  });

  it('handlePostMerge_MissingFeatureId_ReturnsError', async () => {
    // Arrange & Act
    const result = await handlePostMerge(
      { featureId: '', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  // ─── Test 5: runCommand adapter is passed ──────────────────────────────

  it('handlePostMerge_PassesRunCommandAdapter', async () => {
    // Arrange
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    // Act
    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    // Assert
    expect(mockCheckPostMerge).toHaveBeenCalledTimes(1);
    const callArgs = mockCheckPostMerge.mock.calls[0][0] as {
      prUrl: string;
      mergeSha: string;
      runCommand: unknown;
    };
    expect(callArgs.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(callArgs.mergeSha).toBe('abc1234');
    expect(typeof callArgs.runCommand).toBe('function');
  });
});
