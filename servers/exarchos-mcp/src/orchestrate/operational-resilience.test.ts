// ─── Operational Resilience Action Tests ────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock child_process ──────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
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
import { handleOperationalResilience } from './operational-resilience.js';

const STATE_DIR = '/tmp/test-operational-resilience';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePassReport(): string {
  return [
    '## Operational Resilience Report',
    '',
    '**Source:** `/tmp/repo` (diff against `main`)',
    '',
    'No operational resilience issues detected.',
    '',
    '---',
    '',
    '**Result: PASS** (0 findings)',
  ].join('\n');
}

function makeFindingsReport(count: number): string {
  return [
    '## Operational Resilience Report',
    '',
    '**Source:** `/tmp/repo` (diff against `main`)',
    '',
    '### Findings',
    '',
    '- **HIGH** `src/handler.ts` — Empty catch block detected',
    '- **MEDIUM** `src/service.ts` — console.log in source file',
    '',
    '---',
    '',
    `**Result: FINDINGS** (${count} findings detected)`,
  ].join('\n');
}

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
      // Arrange
      const stdout = makePassReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      // Arrange
      const stdout = makeFindingsReport(3);
      const error = new Error('script failed') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 1;
      error.stdout = Buffer.from(stdout);
      error.stderr = Buffer.from('');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw error;
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
      const stdout = makePassReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      const stdout = makePassReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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

  // ─── Usage Error ──────────────────────────────────────────────────────────

  describe('usage error from script', () => {
    it('handleOperationalResilience_UsageError_ReturnsScriptError', async () => {
      // Arrange — exit code 2 = usage error
      const error = new Error('script usage error') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 2;
      error.stdout = Buffer.from('');
      error.stderr = Buffer.from('Error: --repo-root is required');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw error;
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleOperationalResilience(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('--repo-root is required');
    });
  });
});
