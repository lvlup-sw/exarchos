// ─── Select Debug Track Tests ────────────────────────────────────────────────
//
// Tests for the pure TypeScript debug track selection implementation.
// Deterministic decision tree: urgency + root cause known → hotfix or thorough.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');

import { handleSelectDebugTrack } from './select-debug-track.js';

const STATE_DIR = '/tmp/test-select-debug-track';

describe('handleSelectDebugTrack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Decision Tree ──────────────────────────────────────────────────────

  describe('decision tree', () => {
    it('handleSelectDebugTrack_CriticalKnown_ReturnsHotfix', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'critical', rootCauseKnown: true },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { track: string; reasoning: string };
      expect(data.track).toBe('hotfix');
      expect(data.reasoning).toContain('Critical urgency with known root cause');
    });

    it('handleSelectDebugTrack_CriticalUnknown_ReturnsThorough', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'critical', rootCauseKnown: false },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { track: string; reasoning: string };
      expect(data.track).toBe('thorough');
      expect(data.reasoning).toContain('unknown root cause');
    });

    it('handleSelectDebugTrack_HighKnown_ReturnsHotfix', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'high', rootCauseKnown: true },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { track: string };
      expect(data.track).toBe('hotfix');
    });

    it('handleSelectDebugTrack_HighUnknown_ReturnsThorough', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'high', rootCauseKnown: false },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { track: string; reasoning: string };
      expect(data.track).toBe('thorough');
      expect(data.reasoning).toContain('thorough investigation needed');
    });

    it('handleSelectDebugTrack_MediumAny_ReturnsThorough', async () => {
      const knownResult = await handleSelectDebugTrack(
        { urgency: 'medium', rootCauseKnown: true },
        STATE_DIR,
      );
      const unknownResult = await handleSelectDebugTrack(
        { urgency: 'medium', rootCauseKnown: false },
        STATE_DIR,
      );
      expect((knownResult.data as { track: string }).track).toBe('thorough');
      expect((unknownResult.data as { track: string }).track).toBe('thorough');
    });

    it('handleSelectDebugTrack_LowAny_ReturnsThorough', async () => {
      const knownResult = await handleSelectDebugTrack(
        { urgency: 'low', rootCauseKnown: true },
        STATE_DIR,
      );
      const unknownResult = await handleSelectDebugTrack(
        { urgency: 'low', rootCauseKnown: false },
        STATE_DIR,
      );
      expect((knownResult.data as { track: string }).track).toBe('thorough');
      expect((unknownResult.data as { track: string }).track).toBe('thorough');
    });
  });

  // ─── String-based rootCauseKnown ─────────────────────────────────────────

  describe('string rootCauseKnown normalization', () => {
    it('handleSelectDebugTrack_YesString_TreatedAsTrue', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'critical', rootCauseKnown: 'yes' },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { track: string; rootCauseKnown: boolean };
      expect(data.track).toBe('hotfix');
      expect(data.rootCauseKnown).toBe(true);
    });

    it('handleSelectDebugTrack_NoString_TreatedAsFalse', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'critical', rootCauseKnown: 'no' },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { track: string; rootCauseKnown: boolean };
      expect(data.track).toBe('thorough');
      expect(data.rootCauseKnown).toBe(false);
    });
  });

  // ─── Validation Errors ──────────────────────────────────────────────────

  describe('validation', () => {
    it('handleSelectDebugTrack_InvalidUrgency_ReturnsError', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'extreme', rootCauseKnown: true },
        STATE_DIR,
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('urgency');
    });

    it('handleSelectDebugTrack_MissingArgs_ReturnsError', async () => {
      const result = await handleSelectDebugTrack({}, STATE_DIR);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    });
  });

  // ─── State File ─────────────────────────────────────────────────────────

  describe('state file', () => {
    it('handleSelectDebugTrack_ReadsFromStateFile_ExtractsFields', async () => {
      const stateData = {
        urgency: { level: 'critical' },
        investigation: { rootCauseKnown: true },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stateData));

      const result = await handleSelectDebugTrack(
        { stateFile: '/tmp/state.json' },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { track: string; urgency: string; rootCauseKnown: boolean };
      expect(data.track).toBe('hotfix');
      expect(data.urgency).toBe('critical');
      expect(data.rootCauseKnown).toBe(true);
    });

    it('handleSelectDebugTrack_StateFileNotFound_ReturnsError', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await handleSelectDebugTrack(
        { stateFile: '/tmp/nonexistent.json' },
        STATE_DIR,
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('not found');
    });
  });

  // ─── Report Format ──────────────────────────────────────────────────────

  describe('report format', () => {
    it('handleSelectDebugTrack_ReportContainsMarkdown', async () => {
      const result = await handleSelectDebugTrack(
        { urgency: 'critical', rootCauseKnown: true },
        STATE_DIR,
      );
      expect(result.success).toBe(true);
      const data = result.data as { report: string };
      expect(data.report).toContain('## Debug Track Selection');
      expect(data.report).toContain('**Urgency:**');
      expect(data.report).toContain('**Root cause known:**');
      expect(data.report).toContain('**Selected track:**');
      expect(data.report).toContain('**Reasoning:**');
    });
  });
});
