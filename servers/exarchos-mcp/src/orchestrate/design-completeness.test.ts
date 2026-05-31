// ─── Design Completeness Composite Action Tests ─────────────────────────────
//
// Tests for the design-completeness gate handler that wraps the pure TS
// handleDesignCompleteness function and emits gate.executed events.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';

// ─── Mock pure TS design-completeness module ────────────────────────────────

vi.mock('./pure/design-completeness.js', () => ({
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
  getOrCreateMaterializer: () => ({}),
}));

import { handleDesignCompleteness as runDesignCompleteness } from './pure/design-completeness.js';
import { handleDesignCompleteness } from './design-completeness.js';
import { EventStore } from '../event-store/store.js';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

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
      const result = await handleDesignCompleteness(args, STATE_DIR, mockStore as unknown as EventStore);

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
      mockStore as unknown as EventStore,
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
      mockStore as unknown as EventStore,
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
      mockStore as unknown as EventStore,
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
      mockStore as unknown as EventStore,
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
      mockStore as unknown as EventStore,
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
      mockStore as unknown as EventStore,
      );

      // Assert — the pure TS function was called with stateDir-derived path
      expect(mockRunDesignCompleteness).toHaveBeenCalledWith(
        expect.objectContaining({
          stateFile: expect.stringContaining(STATE_DIR),
        }),
      );
    });

    it('handleDesignCompleteness_NoStatePath_UsesCanonicalDotStateJsonSuffix', async () => {
      // The canonical workflow-state filename convention used by the workflow
      // store (storage/lifecycle.ts) and other gates (assemble-context,
      // subagent-context, gates) is `${featureId}.state.json`. This gate must
      // construct the same path so it actually finds the file the workflow
      // store wrote.
      //
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
        mockStore as unknown as EventStore,
      );

      // Assert — exact path matches the canonical convention
      expect(mockRunDesignCompleteness).toHaveBeenCalledWith(
        expect.objectContaining({
          stateFile: `${STATE_DIR}/test-feature.state.json`,
        }),
      );
    });

    // ─── Fileless resolution: MCP-only workflow (no .state.json) ─────────
    //
    // INV-1: the event store is the sole source of truth. An MCP-only
    // workflow has no `.state.json` stamp; `artifacts.design` must resolve
    // from the event-store projection and be fed to the pure checker as
    // `designPathFromState` so the gate works without a state file.
    it('FilelessMcpOnly_ResolvesDesignPathFromEventStore', async () => {
      mockRunDesignCompleteness.mockReturnValue({
        passed: true,
        advisory: true,
        findings: [],
        checkCount: 4,
        passCount: 4,
        failCount: 0,
      });

      const eventStoreDir = await fsPromises.mkdtemp(
        nodePath.join(tmpdir(), 'design-fileless-'),
      );
      const eventStore = new EventStore(eventStoreDir);
      await eventStore.initialize();

      const featureId = 'fileless-design';
      await eventStore.append(featureId, {
        type: 'workflow.started',
        data: { featureId, workflowType: 'feature' },
      });
      await eventStore.append(featureId, {
        type: 'state.patched',
        data: { patch: { artifacts: { design: 'docs/designs/2026-05-30-x.md' } } },
      });

      await handleDesignCompleteness({ featureId }, STATE_DIR, eventStore);

      await fsPromises.rm(eventStoreDir, { recursive: true, force: true });

      // The pure checker received the event-store-resolved design path,
      // proving fileless resolution worked (no `.state.json` on disk).
      expect(mockRunDesignCompleteness).toHaveBeenCalledWith(
        expect.objectContaining({
          designPathFromState: 'docs/designs/2026-05-30-x.md',
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
      mockStore as unknown as EventStore,
      );

      // Assert — the pure TS function was called with the design file path
      expect(mockRunDesignCompleteness).toHaveBeenCalledWith(
        expect.objectContaining({
          designFile: '/tmp/my-design.md',
        }),
      );
    });
  });

  // ─── State-resolution failure ─────────────────────────────────────────────
  //
  // When neither source yields state — the `.state.json` is absent AND the
  // event store query throws — resolveWorkflowState returns EVENT_STORE_ERROR.
  // The handler must propagate that cause, not flatten it to
  // designPathFromState=null (which the pure checker would mislabel as
  // "artifacts.design is empty or missing", masking the infra failure).

  describe('state resolution error', () => {
    it('EventStoreError_DuringStateResolution_PropagatesUnderlyingError', async () => {
      mockQuery.mockRejectedValue(new Error('database is locked'));

      const result = await handleDesignCompleteness(
        { featureId: 'evt-store-fail' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_STORE_ERROR');
      expect(result.error?.message).toContain('database is locked');
      // We could not evaluate the gate, so the pure checker never runs and no
      // gate.executed event is emitted — we report the cause, not a bogus finding.
      expect(mockRunDesignCompleteness).not.toHaveBeenCalled();
      expect(mockAppend).not.toHaveBeenCalled();
    });
  });
});
