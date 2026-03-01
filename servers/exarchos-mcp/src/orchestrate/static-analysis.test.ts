// ─── Static Analysis Action Tests ────────────────────────────────────────────

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
import { handleStaticAnalysis } from './static-analysis.js';

const STATE_DIR = '/tmp/test-static-analysis';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePassingReport(): string {
  return [
    '## Static Analysis Report',
    '**Repository:** `/home/user/project`',
    '- **PASS**: Lint',
    '- **PASS**: Typecheck',
    '---',
    '**Result: PASS** (2/2 checks passed)',
  ].join('\n');
}

function makeFailingReport(): string {
  return [
    '## Static Analysis Report',
    '**Repository:** `/home/user/project`',
    '- **PASS**: Lint',
    '- **FAIL**: Typecheck — npm run typecheck failed',
    '---',
    '**Result: FAIL** (1/2 checks failed)',
  ].join('\n');
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
      const stdout = makePassingReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      const stdout = makeFailingReport();
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
      const stdout = makePassingReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      const stdout = makePassingReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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

  // ─── Usage Error ──────────────────────────────────────────────────────

  describe('usage error from script', () => {
    it('handleStaticAnalysis_UsageError_ReturnsScriptError', async () => {
      // Arrange — exit code 2 = usage error
      const error = new Error('script usage error') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 2;
      error.stdout = Buffer.from('');
      error.stderr = Buffer.from('Error: Repository not found: /nonexistent');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw error;
      });

      const args = { featureId: 'feat-1', repoRoot: '/nonexistent' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('Repository not found');
    });
  });

  // ─── Skip Flags ───────────────────────────────────────────────────────

  describe('skip flags', () => {
    it('handleStaticAnalysis_SkipFlags_PassedToScript', async () => {
      // Arrange
      const stdout = makePassingReport();
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

      const args = {
        featureId: 'feat-1',
        repoRoot: '/home/user/project',
        skipLint: true,
        skipTypecheck: true,
      };

      // Act
      await handleStaticAnalysis(args, STATE_DIR);

      // Assert
      expect(execFileSync).toHaveBeenCalledTimes(1);
      const scriptArgs = vi.mocked(execFileSync).mock.calls[0][1] as string[];
      expect(scriptArgs).toContain('--skip-lint');
      expect(scriptArgs).toContain('--skip-typecheck');
      expect(scriptArgs).toContain('--repo-root');
      expect(scriptArgs).toContain('/home/user/project');
    });
  });
});
