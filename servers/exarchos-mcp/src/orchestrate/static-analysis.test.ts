// ─── Static Analysis Action Tests ────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock the pure TS static analysis module ────────────────────────────────

const mockRunStaticAnalysis = vi.fn();

vi.mock('../../../../src/orchestrate/static-analysis.js', () => ({
  runStaticAnalysis: (...args: unknown[]) => mockRunStaticAnalysis(...args),
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

import { handleStaticAnalysis } from './static-analysis.js';

const STATE_DIR = '/tmp/test-static-analysis';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePassingResult() {
  return {
    status: 'pass' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/project`',
      '',
      '- **PASS**: Lint',
      '- **PASS**: Typecheck',
      '',
      '---',
      '',
      '**Result: PASS** (2/2 checks passed)',
    ].join('\n'),
    passCount: 2,
    failCount: 0,
  };
}

function makeFailingResult() {
  return {
    status: 'fail' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/project`',
      '',
      '- **PASS**: Lint',
      '- **FAIL**: Typecheck — npm run typecheck failed',
      '',
      '---',
      '',
      '**Result: FAIL** (1/2 checks failed)',
    ].join('\n'),
    passCount: 1,
    failCount: 1,
  };
}

function makeErrorResult() {
  return {
    status: 'error' as const,
    output: '',
    error: 'No package.json found at /nonexistent',
    passCount: 0,
    failCount: 0,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleStaticAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleStaticAnalysis_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── All Checks Passing ────────────────────────────────────────────────

  describe('all checks passing', () => {
    it('handleStaticAnalysis_AllChecksPassing_ReturnsPassed', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.passCount).toBe(2);
      expect(data.failCount).toBe(0);
      expect(data.report).toContain('Static Analysis Report');
    });
  });

  // ─── Errors Found ─────────────────────────────────────────────────────

  describe('errors found', () => {
    it('handleStaticAnalysis_ErrorsFound_ReturnsFailWithFindings', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makeFailingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.passCount).toBe(1);
      expect(data.failCount).toBe(1);
      expect(data.report).toContain('FAIL');
      expect(data.report).toContain('Typecheck');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleStaticAnalysis_EmitsGateExecutedEvent', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR);

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
      expect(event.data.gateName).toBe('static-analysis');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D2',
        phase: 'delegate',
        passCount: 2,
        failCount: 0,
      });
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleStaticAnalysis_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: {
          details: Record<string, unknown>;
        };
      };
      expect(event.data.details.phase).toBe('delegate');
    });
  });

  // ─── Error Status (e.g., no package.json) ──────────────────────────────

  describe('error status from analysis', () => {
    it('handleStaticAnalysis_ErrorStatus_ReturnsScriptError', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makeErrorResult());

      const args = { featureId: 'feat-1', repoRoot: '/nonexistent' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('No package.json found');
    });
  });

  // ─── Skip Flags ───────────────────────────────────────────────────────

  describe('skip flags', () => {
    it('handleStaticAnalysis_SkipFlags_PassedToFunction', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = {
        featureId: 'feat-1',
        repoRoot: '/home/user/project',
        skipLint: true,
        skipTypecheck: true,
      };

      // Act
      await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as {
        repoRoot: string;
        skipLint: boolean;
        skipTypecheck: boolean;
        runCommand: unknown;
      };
      expect(callArgs.repoRoot).toBe('/home/user/project');
      expect(callArgs.skipLint).toBe(true);
      expect(callArgs.skipTypecheck).toBe(true);
      expect(callArgs.runCommand).toBeDefined();
    });
  });

  // ─── runCommand adapter is passed ──────────────────────────────────────

  describe('runCommand adapter', () => {
    it('handleStaticAnalysis_PassesRunCommandAdapter', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as {
        runCommand: unknown;
      };
      expect(typeof callArgs.runCommand).toBe('function');
    });
  });
});
