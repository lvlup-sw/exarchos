// ─── Design Completeness Composite Action Tests ─────────────────────────────
//
// Tests for the design-completeness gate handler that wraps
// scripts/verify-ideate-artifacts.sh and emits gate.executed events.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock child_process ─────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// ─── Mock event store ───────────────────────────────────────────────────────

const mockAppend = vi.fn();
const mockQuery = vi.fn();

vi.mock('../event-store/store.js', () => ({
  EventStore: vi.fn().mockImplementation(() => ({
    append: mockAppend,
    query: mockQuery,
  })),
}));

import { execFileSync } from 'node:child_process';
import { handleDesignCompleteness } from './design-completeness.js';

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

  // ─── Script Passes ──────────────────────────────────────────────────────

  describe('script passes', () => {
    it('handleDesignCompleteness_ScriptPasses_ReturnsPassedWithAdvisory', async () => {
      // Arrange — mock execSync to return exit 0 with PASS output
      const stdout = [
        '## Ideation Artifact Verification Report',
        '',
        '**State file:** `/tmp/state.json`',
        '**Design file:** `/tmp/design.md`',
        '',
        '- **PASS**: Design document exists (/tmp/design.md)',
        '- **PASS**: Required sections present (6/6)',
        '- **PASS**: Multiple options evaluated (3 options found)',
        '- **PASS**: State file has design path (/tmp/design.md)',
        '',
        '---',
        '',
        '**Result: PASS** (4/4 checks passed)',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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

  // ─── Script Finds Issues ────────────────────────────────────────────────

  describe('script finds issues', () => {
    it('handleDesignCompleteness_ScriptFindsIssues_ReturnsAdvisoryFindings', async () => {
      // Arrange — mock execSync to throw (exit code 1) with findings in stdout
      const stdout = [
        '## Ideation Artifact Verification Report',
        '',
        '**State file:** `/tmp/state.json`',
        '**Design file:** `/tmp/design.md`',
        '',
        '- **PASS**: Design document exists (/tmp/design.md)',
        '- **FAIL**: Required sections present — Missing: Testing Strategy, Open Questions',
        '- **FAIL**: Multiple options evaluated — Found 1 option(s), expected at least 2',
        '- **PASS**: State file has design path (/tmp/design.md)',
        '',
        '---',
        '',
        '**Result: FAIL** (2/4 checks failed)',
      ].join('\n');

      const error = new Error('Command failed') as Error & {
        stdout: Buffer;
        stderr: Buffer;
        status: number;
      };
      error.stdout = Buffer.from(stdout);
      error.stderr = Buffer.from('');
      error.status = 1;
      vi.mocked(execFileSync).mockImplementation(() => {
        throw error;
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
      expect(data.findings[0]).toContain('Required sections present');
      expect(data.findings[1]).toContain('Multiple options evaluated');
      expect(data.passCount).toBe(2);
      expect(data.failCount).toBe(2);
      expect(data.checkCount).toBe(4);
    });
  });

  // ─── Event Emission ─────────────────────────────────────────────────────

  describe('event emission', () => {
    it('handleDesignCompleteness_EmitsGateExecutedEvent', async () => {
      // Arrange
      const stdout = [
        '## Ideation Artifact Verification Report',
        '',
        '**State file:** `/tmp/state.json`',
        '',
        '- **PASS**: Design document exists (/tmp/design.md)',
        '- **PASS**: Required sections present (6/6)',
        '- **PASS**: Multiple options evaluated (3 options found)',
        '- **PASS**: State file has design path (/tmp/design.md)',
        '',
        '---',
        '',
        '**Result: PASS** (4/4 checks passed)',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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
      const stdout = [
        '## Ideation Artifact Verification Report',
        '',
        '- **PASS**: Design document exists (/tmp/design.md)',
        '- **PASS**: Required sections present (6/6)',
        '- **PASS**: Multiple options evaluated (3 options found)',
        '- **PASS**: State file has design path (/tmp/design.md)',
        '',
        '---',
        '',
        '**Result: PASS** (4/4 checks passed)',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

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

  // ─── Usage Error ────────────────────────────────────────────────────────

  describe('usage error', () => {
    it('handleDesignCompleteness_ScriptUsageError_ReturnsError', async () => {
      // Arrange — exit code 2 (usage error)
      const error = new Error('Command failed') as Error & {
        stdout: Buffer;
        stderr: Buffer;
        status: number;
      };
      error.stdout = Buffer.from('');
      error.stderr = Buffer.from('Error: --state-file is required');
      error.status = 2;
      vi.mocked(execFileSync).mockImplementation(() => {
        throw error;
      });

      // Act
      const result = await handleDesignCompleteness(
        { featureId: 'test-feature' },
        STATE_DIR,
      );

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DESIGN_COMPLETENESS_FAILED');
    });
  });

  // ─── State File Path Construction ───────────────────────────────────────

  describe('state file path', () => {
    it('handleDesignCompleteness_UsesProvidedStatePath_PassesItToScript', async () => {
      // Arrange
      const stdout = '**Result: PASS** (4/4 checks passed)\n';
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature', stateFile: '/custom/state.json' },
        STATE_DIR,
      );

      // Assert — the script args include the custom state file
      const argsCall = vi.mocked(execFileSync).mock.calls[0][1] as string[];
      const stateFileIdx = argsCall.indexOf('--state-file');
      expect(stateFileIdx).toBeGreaterThanOrEqual(0);
      expect(argsCall[stateFileIdx + 1]).toBe('/custom/state.json');
    });

    it('handleDesignCompleteness_NoStatePath_ConstructsFromStateDir', async () => {
      // Arrange
      const stdout = '**Result: PASS** (4/4 checks passed)\n';
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature' },
        STATE_DIR,
      );

      // Assert — the script args use stateDir-derived path
      const argsCall = vi.mocked(execFileSync).mock.calls[0][1] as string[];
      const stateFileIdx = argsCall.indexOf('--state-file');
      expect(stateFileIdx).toBeGreaterThanOrEqual(0);
      expect(argsCall[stateFileIdx + 1]).toContain(STATE_DIR);
    });

    it('handleDesignCompleteness_DesignPathProvided_PassesToScript', async () => {
      // Arrange
      const stdout = '**Result: PASS** (4/4 checks passed)\n';
      vi.mocked(execFileSync).mockReturnValue(Buffer.from(stdout));

      // Act
      await handleDesignCompleteness(
        { featureId: 'test-feature', designPath: '/tmp/my-design.md' },
        STATE_DIR,
      );

      // Assert — the script args include --design-file
      const argsCall = vi.mocked(execFileSync).mock.calls[0][1] as string[];
      const designFileIdx = argsCall.indexOf('--design-file');
      expect(designFileIdx).toBeGreaterThanOrEqual(0);
      expect(argsCall[designFileIdx + 1]).toBe('/tmp/my-design.md');
    });
  });
});
