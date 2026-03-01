// ─── Workflow Determinism Action Tests ──────────────────────────────────────

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
import { handleWorkflowDeterminism } from './workflow-determinism.js';

const STATE_DIR = '/tmp/test-workflow-determinism';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePassReport(): string {
  return [
    '## Workflow Determinism Report',
    '',
    'No determinism issues detected.',
    '',
    '---',
    '',
    '**Result: PASS** (5/5 checks passed)',
  ].join('\n');
}

function makeFindingsReport(count: number): string {
  return [
    '## Workflow Determinism Report',
    '',
    `**Findings (${count}):**`,
    '',
    '- **HIGH** `src/handler.test.ts:3` — Test focus/skip modifier: `describe.only(...)`',
    '- **LOW** `src/handler.test.ts:5` — Debug artifact in test file: `console.log(...)`',
    '',
    '---',
    '',
    `**Result: FINDINGS** (${count} findings detected)`,
  ].join('\n');
}

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
      // Arrange
      const stdout = makePassReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

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
      const stdout = makePassReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

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
        findingCount: 0,
      });
    });
  });

  // ─── Usage Error ──────────────────────────────────────────────────────────

  describe('usage error from script', () => {
    it('handleWorkflowDeterminism_UsageError_ReturnsScriptError', async () => {
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
      const result = await handleWorkflowDeterminism(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('--repo-root is required');
    });
  });
});
