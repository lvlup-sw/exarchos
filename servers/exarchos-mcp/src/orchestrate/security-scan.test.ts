// ─── Security Scan Action Tests ─────────────────────────────────────────────

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
import { handleSecurityScan } from './security-scan.js';

const STATE_DIR = '/tmp/test-security-scan';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeCleanReport(): string {
  return [
    '## Security Scan Report',
    '',
    'Scanning for security patterns...',
    '',
    'No issues found.',
    '',
    '---',
    '',
    'Result: CLEAN',
  ].join('\n');
}

function makeFindingsReport(count: number): string {
  return [
    '## Security Scan Report',
    '',
    'Scanning for security patterns...',
    '',
    '### Findings',
    '',
    '- Hardcoded secret detected in config.ts:12',
    '- Insecure random usage in auth.ts:45',
    '',
    '---',
    '',
    `Result: FINDINGS (${count} security patterns detected)`,
  ].join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleSecurityScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleSecurityScan_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleSecurityScan(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── No Findings ────────────────────────────────────────────────────────

  describe('no findings', () => {
    it('handleSecurityScan_NoFindings_ReturnsPassed', async () => {
      // Arrange
      const stdout = makeCleanReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleSecurityScan(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.report).toContain('Result: CLEAN');
    });
  });

  // ─── Findings Detected ─────────────────────────────────────────────────

  describe('findings detected', () => {
    it('handleSecurityScan_FindingsDetected_ReturnsFailWithCount', async () => {
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
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleSecurityScan(args, STATE_DIR);

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
    it('handleSecurityScan_EmitsGateExecutedEvent', async () => {
      // Arrange
      const stdout = makeCleanReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = { featureId: 'feat-1' };

      // Act
      await handleSecurityScan(args, STATE_DIR);

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
      expect(event.data.gateName).toBe('security-scan');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D1',
        findingCount: 0,
      });
    });
  });

  // ─── Usage Error ──────────────────────────────────────────────────────────

  describe('usage error from script', () => {
    it('handleSecurityScan_UsageError_ReturnsScriptError', async () => {
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
      const result = await handleSecurityScan(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('--repo-root is required');
    });
  });
});
