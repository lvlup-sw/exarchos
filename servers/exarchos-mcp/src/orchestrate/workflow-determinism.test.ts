// ─── Workflow Determinism Action Tests ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock child_process (for git diff call) ─────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// ─── Mock pure TS workflow-determinism module ───────────────────────────────

vi.mock('./pure/workflow-determinism.js', () => ({
  checkWorkflowDeterminism: vi.fn(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => ({}),
}));

import { execFileSync } from 'node:child_process';
import { checkWorkflowDeterminism } from './pure/workflow-determinism.js';
import { handleWorkflowDeterminism } from './workflow-determinism.js';

const STATE_DIR = '/tmp/test-workflow-determinism';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleWorkflowDeterminism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleWorkflowDeterminism_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleWorkflowDeterminism(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── Clean Code ────────────────────────────────────────────────────────

  describe('clean code', () => {
    it('handleWorkflowDeterminism_CleanCode_ReturnsPassed', async () => {
      // Arrange — git diff returns some diff content
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.ts b/foo.ts\n');

      // Mock the pure TS checker to return a pass result
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '## Workflow Determinism Report\n\nNo determinism issues detected.\n\n---\n\n**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleWorkflowDeterminism(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.report).toContain('Result: PASS');
    });
  });

  // ─── Findings Detected ─────────────────────────────────────────────────

  describe('findings detected', () => {
    it('handleWorkflowDeterminism_Findings_ReturnsFailWithCount', async () => {
      // Arrange — git diff returns some diff content
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.test.ts b/foo.test.ts\n');

      // Mock the pure TS checker to return findings
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'findings',
        findingCount: 3,
        findings: [
          '- **HIGH** `src/handler.test.ts:3` — Test focus/skip modifier: `describe.only(...)`',
          '- **LOW** `src/handler.test.ts:5` — Debug artifact in test file: `console.log(...)`',
          '- **MEDIUM** `src/util.test.ts:10` — Non-deterministic time without fake timers: `Date.now()`',
        ],
        passedChecks: 1,
        totalChecks: 4,
        report: '## Workflow Determinism Report\n\n**Findings (3):**\n\n---\n\n**Result: FINDINGS** (3 findings detected)',
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleWorkflowDeterminism(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(3);
      expect(data.report).toContain('FINDINGS');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleWorkflowDeterminism_EmitsGateEvent_WithD5Dimension', async () => {
      // Arrange
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1' };

      // Act
      await handleWorkflowDeterminism(args, STATE_DIR);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      expect(appendCall[0]).toBe('feat-1');
      const event = appendCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.gateName).toBe('workflow-determinism');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D5',
        phase: 'review',
        findingCount: 0,
      });
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleWorkflowDeterminism_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      // Arrange
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1' };

      // Act
      await handleWorkflowDeterminism(args, STATE_DIR);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: {
          details: Record<string, unknown>;
        };
      };
      expect(event.data.details.phase).toBe('review');
    });
  });

  // ─── Git Diff Failure (empty diff) ───────────────────────────────────────

  describe('git diff failure', () => {
    it('handleWorkflowDeterminism_GitDiffFails_PassesEmptyStringToChecker', async () => {
      // Arrange — git diff throws (simulating missing repo, etc.)
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('git not found');
      });

      // The empty diff will be passed to the checker
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleWorkflowDeterminism(args, STATE_DIR);

      // Assert — handler still succeeds with pass result
      expect(result.success).toBe(true);
      expect(checkWorkflowDeterminism).toHaveBeenCalledWith({ diffContent: '' });
    });
  });
});
