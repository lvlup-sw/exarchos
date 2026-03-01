// ─── Context Economy Action Tests ───────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock child_process ──────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
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

import { execSync } from 'node:child_process';
import { handleContextEconomy } from './context-economy.js';

const STATE_DIR = '/tmp/test-context-economy';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeCleanReport(): string {
  return [
    '## Context Economy Report',
    '',
    'No context-economy concerns detected.',
    '',
    '---',
    '',
    '**Result: PASS** (4/4 checks passed)',
  ].join('\n');
}

function makeFindingsReport(count: number): string {
  return [
    '## Context Economy Report',
    '',
    `**Findings (${count}):**`,
    '',
    '- **MEDIUM** `src/big-file.ts` — Source file exceeds 400 lines (520 lines)',
    '- **MEDIUM** Diff breadth: 35 files changed (threshold: 30)',
    '',
    '---',
    '',
    `**Result: FINDINGS** (${count} findings detected)`,
  ].join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleContextEconomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleContextEconomy_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleContextEconomy(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── Clean Code ────────────────────────────────────────────────────────

  describe('clean code', () => {
    it('handleContextEconomy_CleanCode_ReturnsPassed', async () => {
      // Arrange
      const stdout = makeCleanReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleContextEconomy(args, STATE_DIR);

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
    it('handleContextEconomy_Findings_ReturnsFailWithCount', async () => {
      // Arrange
      const stdout = makeFindingsReport(2);
      const error = new Error('script failed') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 1;
      error.stdout = Buffer.from(stdout);
      error.stderr = Buffer.from('');
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleContextEconomy(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(2);
      expect(data.report).toContain('FINDINGS');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleContextEconomy_EmitsGateEvent_WithD3Dimension', async () => {
      // Arrange
      const stdout = makeCleanReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1' };

      // Act
      await handleContextEconomy(args, STATE_DIR);

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
      expect(event.data.gateName).toBe('context-economy');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D3',
        phase: 'review',
        findingCount: 0,
      });
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleContextEconomy_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      // Arrange
      const stdout = makeCleanReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1' };

      // Act
      await handleContextEconomy(args, STATE_DIR);

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

  // ─── Usage Error ──────────────────────────────────────────────────────────

  describe('usage error from script', () => {
    it('handleContextEconomy_UsageError_ReturnsScriptError', async () => {
      // Arrange — exit code 2 = usage error
      const error = new Error('script usage error') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 2;
      error.stdout = Buffer.from('');
      error.stderr = Buffer.from('Error: --repo-root is required');
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleContextEconomy(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('--repo-root is required');
    });
  });
});
