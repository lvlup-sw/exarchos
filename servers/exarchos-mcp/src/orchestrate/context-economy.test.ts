// ─── Context Economy Action Tests ───────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock child_process ──────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// ─── Mock event store and materializer ───────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

const mockTelemetryState = {
  tools: {},
  sessionStart: '2026-01-01T00:00:00.000Z',
  totalInvocations: 0,
  totalTokens: 0,
  windowSize: 1000,
};

const mockMaterializer = {
  materialize: vi.fn(() => mockTelemetryState),
  getState: vi.fn(() => null),
  loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

import { execFileSync } from 'node:child_process';
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
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      vi.mocked(execFileSync).mockImplementation(() => {
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
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      vi.mocked(execFileSync).mockImplementation(() => {
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

  // ─── Telemetry Integration ────────────────────────────────────────────────

  describe('telemetry integration', () => {
    it('handleContextEconomy_WithTelemetryData_IncludesRuntimeMetricsInResult', async () => {
      // Arrange
      const stdout = makeCleanReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

      // Setup telemetry state with data
      mockTelemetryState.tools = {
        'exarchos_workflow': {
          invocations: 5,
          errors: 0,
          totalDurationMs: 1000,
          totalBytes: 2000,
          totalTokens: 3000,
          p50DurationMs: 200,
          p95DurationMs: 400,
          p50Bytes: 400,
          p95Bytes: 800,
          p50Tokens: 600,
          p95Tokens: 1200,
          durations: [],
          sizes: [],
          tokenEstimates: [],
        },
        'exarchos_view': {
          invocations: 5,
          errors: 0,
          totalDurationMs: 500,
          totalBytes: 1000,
          totalTokens: 2000,
          p50DurationMs: 100,
          p95DurationMs: 200,
          p50Bytes: 200,
          p95Bytes: 400,
          p50Tokens: 400,
          p95Tokens: 800,
          durations: [],
          sizes: [],
          tokenEstimates: [],
        },
      };
      mockTelemetryState.totalTokens = 5000;
      mockTelemetryState.totalInvocations = 10;

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleContextEconomy(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
        runtimeMetrics: {
          sessionTokens: number;
          toolCount: number;
          totalInvocations: number;
        };
      };
      expect(data.runtimeMetrics).toBeDefined();
      expect(data.runtimeMetrics.sessionTokens).toBe(5000);
      expect(data.runtimeMetrics.toolCount).toBe(2);
      expect(data.runtimeMetrics.totalInvocations).toBe(10);
    });

    it('handleContextEconomy_WithoutTelemetryData_ReturnsScriptOnlyResult', async () => {
      // Arrange
      const stdout = makeCleanReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

      // Setup empty telemetry state
      mockTelemetryState.tools = {};
      mockTelemetryState.totalTokens = 0;
      mockTelemetryState.totalInvocations = 0;

      const args = { featureId: 'feat-1' };

      // Act
      const result = await handleContextEconomy(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
        runtimeMetrics: {
          sessionTokens: number;
          toolCount: number;
          totalInvocations: number;
        };
      };
      expect(data.runtimeMetrics).toBeDefined();
      expect(data.runtimeMetrics.sessionTokens).toBe(0);
      expect(data.runtimeMetrics.toolCount).toBe(0);
      expect(data.runtimeMetrics.totalInvocations).toBe(0);
    });
  });
});
