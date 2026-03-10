// ─── Design Completeness Composite Action Tests ─────────────────────────────
//
// Tests for the design-completeness gate handler that wraps the pure TS
// handleDesignCompleteness function and emits gate.executed events.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock pure TS design-completeness module ────────────────────────────────

vi.mock('../../../../src/orchestrate/design-completeness.js', () => ({
  handleDesignCompleteness: vi.fn(),
}));

// ─── Mock event store ───────────────────────────────────────────────────────

const mockAppend = vi.fn();
const mockQuery = vi.fn();

const mockStore = {
  append: mockAppend,
  query: mockQuery,
};

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: () => mockStore,
  getOrCreateMaterializer: () => ({}),
}));

import { handleDesignCompleteness as runDesignCompleteness } from '../../../../src/orchestrate/design-completeness.js';
import { handleDesignCompleteness } from './design-completeness.js';

const mockRunDesignCompleteness = vi.mocked(runDesignCompleteness);

const STATE_DIR = '/tmp/test-design-completeness';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleDesignCompleteness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppend.mockResolvedValue({
      streamId: 'test-feature',
      sequence: 1,
      type: 'gate.executed',
      timestamp: new Date().toISOString(),
    });
    mockQuery.mockResolvedValue([]);
  });

  // ─── Validation ─────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleDesignCompleteness_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleDesignCompleteness(args, STATE_DIR);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── All Checks Pass ─────────────────────────────────────────────────────

  describe('all checks pass', () => {
    it('handleDesignCompleteness_AllChecksPass_ReturnsPassedWithAdvisory', async () => {
      // Arrange — mock pure TS function to return all-pass result
      mockRunDesignCompleteness.mockReturnValue({
        passed: true,
        advisory: true,
        findings: [],
        checkCount: 4,
        passCount: 4,
        failCount: 0,
      });

      // Act
      const result = await handleDesignCompleteness(
        { featureId: 'test-feature' },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        advisory: boolean;
        findings: string[];
        checkCount: number;
        passCount: number;
        failCount: number;
      };
      expect(data.passed).toBe(true);
      expect(data.advisory).toBe(true);
      expect(data.findings).toEqual([]);
      expect(data.passCount).toBe(4);
      expect(data.failCount).toBe(0);
      expect(data.checkCount).toBe(4);
    });
  });

  // ─── Findings Detected ─────────────────────────────────────────────────

  describe('findings detected', () => {
    it('handleDesignCompleteness_FindingsDetected_ReturnsAdvisoryFindings', async () => {
      // Arrange — mock pure TS function to return findings
      mockRunDesignCompleteness.mockReturnValue({
        passed: false,
        advisory: true,
        findings: [
          'Required sections missing: Testing Strategy, Open Questions',
          'Found 1 option(s), expected at least 2',
        ],
        checkCount: 4,
        passCount: 2,
        failCount: 2,
      });

      // Act
      const result = await handleDesignCompleteness(
        { featureId: 'test-feature' },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        advisory: boolean;
        findings: string[];
        checkCount: number;
        passCount: number;
        failCount: number;
      };
      expect(data.passed).toBe(false);
      expect(data.advisory).toBe(true);
      expect(data.findings.length).toBe(2);
      expect(data.findings[0]).toContain('Required sections');
      expect(data.findings[1]).toContain('option');
      expect(data.passCount).toBe(2);
      expect(data.failCount).toBe(2);
      expect(data.checkCount).toBe(4);
    });
  });

  // ─── Event Emission ─────────────────────────────────────────────────────

  describe('event emission', () => {
    it('handleDesignCompleteness_EmitsGateExecutedEvent', async () => {
      // Arrange
      mockRunDesignCompleteness.mockReturnValue({
        passed: true,
        advisory: true,
        findings: [],
        checkCount: 4,
        passCount: 4,
        failCount: 0,
      });

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature' },
        STATE_DIR,
      );

      // Assert — gate.executed event emitted with correct payload
      const gateExecutedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'gate.executed',
      );
      expect(gateExecutedCalls.length).toBe(1);
      expect(gateExecutedCalls[0][0]).toBe('test-feature');

      const event = gateExecutedCalls[0][1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: {
            dimension: string;
            advisory: boolean;
            findings: string[];
            checkCount: number;
            passCount: number;
            failCount: number;
          };
        };
      };
      expect(event.data.gateName).toBe('design-completeness');
      expect(event.data.layer).toBe('design');
      expect(event.data.passed).toBe(true);
      expect(event.data.details.dimension).toBe('D1');
      expect(event.data.details.advisory).toBe(true);
      expect(event.data.details.checkCount).toBe(4);
      expect(event.data.details.passCount).toBe(4);
      expect(event.data.details.failCount).toBe(0);
    });
  });

  // ─── Phase in Details ───────────────────────────────────────────────────

  describe('phase in event details', () => {
    it('handleDesignCompleteness_EmitsGateEvent_IncludesPhaseIdeateInDetails', async () => {
      // Arrange
      mockRunDesignCompleteness.mockReturnValue({
        passed: true,
        advisory: true,
        findings: [],
        checkCount: 4,
        passCount: 4,
        failCount: 0,
      });

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature' },
        STATE_DIR,
      );

      // Assert — gate.executed event includes phase: 'ideate' in details
      const gateExecutedCalls = mockAppend.mock.calls.filter(
        (call: unknown[]) => (call[1] as { type: string }).type === 'gate.executed',
      );
      expect(gateExecutedCalls.length).toBe(1);
      const event = gateExecutedCalls[0][1] as {
        type: string;
        data: {
          details: Record<string, unknown>;
        };
      };
      expect(event.data.details.phase).toBe('ideate');
    });
  });

  // ─── State File Path Construction ───────────────────────────────────────

  describe('state file path', () => {
    it('handleDesignCompleteness_UsesProvidedStatePath_PassesToChecker', async () => {
      // Arrange
      mockRunDesignCompleteness.mockReturnValue({
        passed: true,
        advisory: true,
        findings: [],
        checkCount: 4,
        passCount: 4,
        failCount: 0,
      });

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature', stateFile: '/custom/state.json' },
        STATE_DIR,
      );

      // Assert — the pure TS function was called with the custom state file
      expect(mockRunDesignCompleteness).toHaveBeenCalledWith(
        expect.objectContaining({
          stateFile: '/custom/state.json',
        }),
      );
    });

    it('handleDesignCompleteness_NoStatePath_ConstructsFromStateDir', async () => {
      // Arrange
      mockRunDesignCompleteness.mockReturnValue({
        passed: true,
        advisory: true,
        findings: [],
        checkCount: 4,
        passCount: 4,
        failCount: 0,
      });

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature' },
        STATE_DIR,
      );

      // Assert — the pure TS function was called with stateDir-derived path
      expect(mockRunDesignCompleteness).toHaveBeenCalledWith(
        expect.objectContaining({
          stateFile: expect.stringContaining(STATE_DIR),
        }),
      );
    });

    it('handleDesignCompleteness_DesignPathProvided_PassesToChecker', async () => {
      // Arrange
      mockRunDesignCompleteness.mockReturnValue({
        passed: true,
        advisory: true,
        findings: [],
        checkCount: 4,
        passCount: 4,
        failCount: 0,
      });

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature', designPath: '/tmp/my-design.md' },
        STATE_DIR,
      );

      // Assert — the pure TS function was called with the design file path
      expect(mockRunDesignCompleteness).toHaveBeenCalledWith(
        expect.objectContaining({
          designFile: '/tmp/my-design.md',
        }),
      );
    });
  });
});
