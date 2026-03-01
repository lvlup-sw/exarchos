// ─── Post-Merge Gate Handler Tests ──────────────────────────────────────────

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ─── Mock child_process ────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// ─── Mock event store ──────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => ({}),
}));

// ─── Import after mocks ───────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { handlePostMerge } from './post-merge.js';

const STATE_DIR = '/tmp/test-post-merge';

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
    const stdout = '## Post-Merge Regression Report\n\n**Result: PASS** (2/2 checks passed)';
    vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

    // Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
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
    const error = new Error('Command failed') as Error & {
      stdout: Buffer;
      stderr: Buffer;
      status: number;
    };
    error.stdout = Buffer.from('## Post-Merge Regression Report\n\n**Result: FAIL** (1/2 checks failed)');
    error.stderr = Buffer.from(
      'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: ci/build (FAILURE)"\n'
      + 'FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed"',
    );
    error.status = 1;
    vi.mocked(execSync).mockImplementation(() => { throw error; });

    // Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
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
    const stdout = '## Post-Merge Regression Report\n\n**Result: PASS** (2/2 checks passed)';
    vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

    // Act
    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
    );

    // Assert
    expect(mockStore.append).toHaveBeenCalledTimes(1);
    const [streamId, event] = mockStore.append.mock.calls[0] as [string, { type: string; data: Record<string, unknown> }];
    expect(streamId).toBe('feat-123');
    expect(event.type).toBe('gate.executed');
    expect(event.data.gateName).toBe('post-merge');
    expect(event.data.layer).toBe('post-merge');
    expect(event.data.passed).toBe(true);
    const details = event.data.details as { prUrl: string; mergeSha: string; findings: string[] };
    expect(details.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(details.mergeSha).toBe('abc1234');
    expect(details.findings).toEqual([]);
  });

  // ─── Test 4: Missing args returns error ────────────────────────────────

  it('handlePostMerge_MissingPrUrl_ReturnsError', async () => {
    // Arrange & Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: '', mergeSha: 'abc1234' },
      STATE_DIR,
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
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  // ─── Test 5: Usage error (exit 2) returns error ────────────────────────

  it('handlePostMerge_UsageError_ReturnsScriptError', async () => {
    // Arrange
    const error = new Error('Command failed') as Error & {
      stdout: Buffer;
      stderr: Buffer;
      status: number;
    };
    error.stdout = Buffer.from('');
    error.stderr = Buffer.from('Error: --pr-url and --merge-sha are required');
    error.status = 2;
    vi.mocked(execSync).mockImplementation(() => { throw error; });

    // Act
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234' },
      STATE_DIR,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SCRIPT_ERROR');
  });
});
