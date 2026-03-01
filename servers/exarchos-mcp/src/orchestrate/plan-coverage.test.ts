// ─── Plan Coverage Action Tests ──────────────────────────────────────────────

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
import { handlePlanCoverage } from './plan-coverage.js';

const STATE_DIR = '/tmp/test-plan-coverage';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makePassingReport(): string {
  return [
    '## Plan Coverage Report',
    '',
    '**Design file:** `design.md`',
    '**Plan file:** `plan.md`',
    '',
    '### Coverage Matrix',
    '',
    '| Design Section | Task(s) | Status |',
    '|----------------|---------|--------|',
    '| Event Store | Task 1: Implement event store | Covered |',
    '| Gate Utils | Task 2: Implement gate utils | Covered |',
    '| Composite Router | Task 3: Implement composite | Covered |',
    '| View Projections | Task 4: Implement views | Covered |',
    '| Error Handling | Task 5: Implement error handling | Covered |',
    '',
    '### Summary',
    '',
    '- Design sections: 5',
    '- Covered: 5',
    '- Deferred: 0',
    '- Gaps: 0',
    '',
    '---',
    '',
    '**Result: PASS** (5/5 sections covered)',
  ].join('\n');
}

function makeFailingReport(): string {
  return [
    '## Plan Coverage Report',
    '',
    '**Design file:** `design.md`',
    '**Plan file:** `plan.md`',
    '',
    '### Coverage Matrix',
    '',
    '| Design Section | Task(s) | Status |',
    '|----------------|---------|--------|',
    '| Event Store | Task 1: Implement event store | Covered |',
    '| Gate Utils | Task 2: Implement gate utils | Covered |',
    '| Composite Router | — | **GAP** |',
    '| View Projections | Task 4: Implement views | Covered |',
    '| Error Handling | — | **GAP** |',
    '',
    '### Summary',
    '',
    '- Design sections: 7',
    '- Covered: 3',
    '- Deferred: 2',
    '- Gaps: 2',
    '',
    '### Unmapped Sections',
    '',
    '- **Composite Router** — No task maps to this design section',
    '- **Error Handling** — No task maps to this design section',
    '',
    '---',
    '',
    '**Result: FAIL** (2/7 sections have gaps)',
  ].join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handlePlanCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handlePlanCoverage_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' };

      // Act
      const result = await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });

    it('handlePlanCoverage_MissingDesignPath_ReturnsError', async () => {
      // Arrange
      const args = { featureId: 'feat-1', designPath: '', planPath: '/tmp/plan.md' };

      // Act
      const result = await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('designPath');
    });

    it('handlePlanCoverage_MissingPlanPath_ReturnsError', async () => {
      // Arrange
      const args = { featureId: 'feat-1', designPath: '/tmp/design.md', planPath: '' };

      // Act
      const result = await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('planPath');
    });
  });

  // ─── All Covered ──────────────────────────────────────────────────────────

  describe('all sections covered', () => {
    it('handlePlanCoverage_AllCovered_ReturnsPassed', async () => {
      // Arrange
      const stdout = makePassingReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      // Act
      const result = await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        coverage: { covered: number; gaps: number; deferred: number; total: number };
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.coverage.covered).toBe(5);
      expect(data.coverage.gaps).toBe(0);
      expect(data.coverage.deferred).toBe(0);
      expect(data.coverage.total).toBe(5);
      expect(data.report).toContain('Plan Coverage Report');
    });
  });

  // ─── Gaps Found ───────────────────────────────────────────────────────────

  describe('gaps found', () => {
    it('handlePlanCoverage_GapsFound_ReturnsFailWithFindings', async () => {
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
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      // Act
      const result = await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        coverage: { covered: number; gaps: number; deferred: number; total: number };
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.coverage.covered).toBe(3);
      expect(data.coverage.gaps).toBe(2);
      expect(data.coverage.deferred).toBe(2);
      expect(data.coverage.total).toBe(7);
      expect(data.report).toContain('Unmapped Sections');
    });
  });

  // ─── Gate Event Emission ──────────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handlePlanCoverage_EmitsGateExecutedEvent', async () => {
      // Arrange
      const stdout = makePassingReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      // Act
      await handlePlanCoverage(args, STATE_DIR);

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
      expect(event.data.gateName).toBe('plan-coverage');
      expect(event.data.layer).toBe('planning');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D1',
        phase: 'plan',
        covered: 5,
        gaps: 0,
        deferred: 0,
        totalSections: 5,
      });
    });

    it('handlePlanCoverage_GapsFail_EmitsFailedGateEvent', async () => {
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
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      // Act
      await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
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
      expect(event.data.passed).toBe(false);
      expect(event.data.details).toEqual({
        dimension: 'D1',
        phase: 'plan',
        covered: 3,
        gaps: 2,
        deferred: 2,
        totalSections: 7,
      });
    });
  });

  // ─── Phase in Details ──────────────────────────────────────────────────────

  describe('phase in event details', () => {
    it('handlePlanCoverage_EmitsGateEvent_IncludesPhasePlanInDetails', async () => {
      // Arrange
      const stdout = makePassingReport();
      vi.mocked(execSync).mockReturnValue(Buffer.from(stdout));

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      // Act
      await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: {
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.details.phase).toBe('plan');
    });
  });

  // ─── Usage Error ──────────────────────────────────────────────────────────

  describe('usage error from script', () => {
    it('handlePlanCoverage_UsageError_ReturnsScriptError', async () => {
      // Arrange — exit code 2 = usage error
      const error = new Error('script usage error') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      error.status = 2;
      error.stdout = Buffer.from('');
      error.stderr = Buffer.from('Error: Design file not found: /tmp/design.md');
      vi.mocked(execSync).mockImplementation(() => {
        throw error;
      });

      const args = {
        featureId: 'feat-1',
        designPath: '/tmp/design.md',
        planPath: '/tmp/plan.md',
      };

      // Act
      const result = await handlePlanCoverage(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('Design file not found');
    });
  });
});
