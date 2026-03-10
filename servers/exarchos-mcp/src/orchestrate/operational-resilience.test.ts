// ─── Operational Resilience Action Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock child_process (for git diff call) ─────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// ─── Mock pure TS operational-resilience module ─────────────────────────────

vi.mock('./pure/operational-resilience.js', () => ({
  checkOperationalResilience: vi.fn(),
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
import { checkOperationalResilience } from './pure/operational-resilience.js';
import { handleOperationalResilience } from './operational-resilience.js';

const STATE_DIR = '/tmp/test-operational-resilience';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleOperationalResilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleOperationalResilience_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleOperationalResilience(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── Clean Code ────────────────────────────────────────────────────────

  describe('clean code', () => {
    it('handleOperationalResilience_CleanCode_ReturnsPassed', async () => {
      // Arrange — git diff returns some diff content
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.ts b/foo.ts\n');

      // Mock the pure TS checker to return a pass result
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: true,
        findingCount: 0,
        findings: [],
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleOperationalResilience(args, STATE_DIR);

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
    it('handleOperationalResilience_Findings_ReturnsFailWithCount', async () => {
      // Arrange — git diff returns some diff content
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.ts b/foo.ts\n');

      // Mock the pure TS checker to return findings
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: false,
        findingCount: 3,
        findings: [
          { severity: 'HIGH', message: '`src/handler.ts` — Empty catch block detected' },
          { severity: 'MEDIUM', message: '`src/service.ts` — console.log in source file' },
          { severity: 'MEDIUM', message: '`src/retry.ts` — Unbounded retry loop' },
        ],
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleOperationalResilience(args, STATE_DIR);

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
    it('handleOperationalResilience_EmitsGateEvent_WithD4Dimension', async () => {
      // Arrange
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: true,
        findingCount: 0,
        findings: [],
      });

      const args = { featureId: 'feat-1' };

      // Act
      await handleOperationalResilience(args, STATE_DIR);

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
      expect(event.data.gateName).toBe('operational-resilience');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D4',
        phase: 'review',
        findingCount: 0,
      });
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleOperationalResilience_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      // Arrange
      vi.mocked(execFileSync).mockReturnValue('diff --git a/foo.ts b/foo.ts\n');
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: true,
        findingCount: 0,
        findings: [],
      });

      const args = { featureId: 'feat-1' };

      // Act
      await handleOperationalResilience(args, STATE_DIR);

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
    it('handleOperationalResilience_GitDiffFails_PassesEmptyStringToChecker', async () => {
      // Arrange — git diff throws (simulating missing repo, etc.)
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('git not found');
      });

      // The empty diff will be passed to the checker
      vi.mocked(checkOperationalResilience).mockReturnValue({
        pass: true,
        findingCount: 0,
        findings: [],
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleOperationalResilience(args, STATE_DIR);

      // Assert — handler still succeeds with pass result
      expect(result.success).toBe(true);
      expect(checkOperationalResilience).toHaveBeenCalledWith('');
    });
  });
});
