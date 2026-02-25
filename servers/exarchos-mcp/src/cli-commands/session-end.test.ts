import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEvent, SessionSummaryEvent } from '../session/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../session/transcript-parser.js', () => ({
  parseTranscript: vi.fn(),
}));

vi.mock('../session/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session/manifest.js')>();
  return {
    ...actual,
    writeManifestCompletion: vi.fn(),
  };
});

// ─── Test Data ──────────────────────────────────────────────────────────────

function makeMockEvents(sessionId: string): SessionEvent[] {
  return [
    { t: 'tool', ts: '2026-02-24T10:00:00Z', tool: 'Read', cat: 'native', inB: 100, outB: 200, sid: sessionId },
    { t: 'turn', ts: '2026-02-24T10:00:01Z', model: 'claude-opus-4-6', tokIn: 100, tokOut: 50, tokCacheR: 5000, tokCacheW: 2000, sid: sessionId },
    { t: 'summary', ts: '2026-02-24T10:00:02Z', sid: sessionId, tools: { Read: 1 }, tokTotal: { in: 100, out: 50, cacheR: 5000, cacheW: 2000 }, files: [], dur: 2000, turns: 1 },
  ];
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('session-end command', () => {
  let tmpDir: string;
  let stateDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-end-test-'));
    stateDir = path.join(tmpDir, 'state');
    await fs.mkdir(path.join(stateDir, 'sessions'), { recursive: true });
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');

    // Reset mocks
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  describe('input validation', () => {
    it('handleSessionEnd_MissingSessionId_ReturnsError', async () => {
      const { handleSessionEnd } = await import('./session-end.js');

      // Arrange
      const stdinData = { transcript_path: transcriptPath };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toEqual({
        error: { code: 'MISSING_SESSION_ID', message: 'session_id is required' },
      });
    });

    it('handleSessionEnd_MissingTranscriptPath_ReturnsError', async () => {
      const { handleSessionEnd } = await import('./session-end.js');

      // Arrange
      const stdinData = { session_id: 'abc' };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toEqual({
        error: { code: 'MISSING_TRANSCRIPT_PATH', message: 'transcript_path is required' },
      });
    });

    it('handleSessionEnd_EmptyStdin_ReturnsError', async () => {
      const { handleSessionEnd } = await import('./session-end.js');

      // Act
      const result = await handleSessionEnd({}, stateDir);

      // Assert
      expect(result).toHaveProperty('error');
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('MISSING_SESSION_ID');
    });

    it('handleSessionEnd_NonStringSessionId_ReturnsError', async () => {
      const { handleSessionEnd } = await import('./session-end.js');

      // Arrange
      const stdinData = { session_id: 123, transcript_path: transcriptPath };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toEqual({
        error: { code: 'MISSING_SESSION_ID', message: 'session_id is required' },
      });
    });

    it('handleSessionEnd_NonStringTranscriptPath_ReturnsError', async () => {
      const { handleSessionEnd } = await import('./session-end.js');

      // Arrange
      const stdinData = { session_id: 'abc', transcript_path: 42 };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toEqual({
        error: { code: 'MISSING_TRANSCRIPT_PATH', message: 'transcript_path is required' },
      });
    });
  });

  describe('extraction', () => {
    it('handleSessionEnd_ValidTranscript_WritesSessionEventsFile', async () => {
      const { handleSessionEnd } = await import('./session-end.js');
      const { parseTranscript } = await import('../session/transcript-parser.js');
      const sessionId = 'test-session-001';
      const mockEvents = makeMockEvents(sessionId);

      // Arrange — create transcript file and set up mock
      await fs.writeFile(transcriptPath, '{"type":"assistant"}\n', 'utf-8');
      vi.mocked(parseTranscript).mockResolvedValue(mockEvents);

      const stdinData = { session_id: sessionId, transcript_path: transcriptPath };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toEqual({ continue: true });
      const eventsPath = path.join(stateDir, 'sessions', `${sessionId}.events.jsonl`);
      const content = await fs.readFile(eventsPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
      const parsed = lines.map((l) => JSON.parse(l));
      expect(parsed[0].t).toBe('tool');
      expect(parsed[1].t).toBe('turn');
      expect(parsed[2].t).toBe('summary');
    });

    it('handleSessionEnd_ValidTranscript_UpdatesManifestWithCompletion', async () => {
      const { handleSessionEnd } = await import('./session-end.js');
      const { parseTranscript } = await import('../session/transcript-parser.js');
      const { writeManifestCompletion } = await import('../session/manifest.js');
      const sessionId = 'test-session-002';
      const mockEvents = makeMockEvents(sessionId);

      // Arrange
      await fs.writeFile(transcriptPath, '{"type":"assistant"}\n', 'utf-8');
      vi.mocked(parseTranscript).mockResolvedValue(mockEvents);

      const stdinData = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        end_reason: 'user_exit',
      };

      // Act
      await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(writeManifestCompletion).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(writeManifestCompletion).mock.calls[0];
      expect(callArgs[0]).toBe(stateDir);
      const completion = callArgs[1];
      expect(completion.sessionId).toBe(sessionId);
      expect(completion.endReason).toBe('user_exit');
      expect(completion.toolCalls).toBe(1); // 1 Read tool call
      expect(completion.turns).toBe(1);
      expect(completion.totalTokens).toBe(150); // 100 in + 50 out
      expect(completion.extractedAt).toBeDefined();
    });

    it('handleSessionEnd_ValidTranscript_SessionEventsContainToolAndTurnAndSummary', async () => {
      const { handleSessionEnd } = await import('./session-end.js');
      const { parseTranscript } = await import('../session/transcript-parser.js');
      const sessionId = 'test-session-003';
      const mockEvents = makeMockEvents(sessionId);

      // Arrange
      await fs.writeFile(transcriptPath, '{"type":"assistant"}\n', 'utf-8');
      vi.mocked(parseTranscript).mockResolvedValue(mockEvents);

      const stdinData = { session_id: sessionId, transcript_path: transcriptPath };

      // Act
      await handleSessionEnd(stdinData, stateDir);

      // Assert
      const eventsPath = path.join(stateDir, 'sessions', `${sessionId}.events.jsonl`);
      const content = await fs.readFile(eventsPath, 'utf-8');
      const events = content.trim().split('\n').map((l) => JSON.parse(l));
      const types = events.map((e: { t: string }) => e.t);
      expect(types).toContain('tool');
      expect(types).toContain('turn');
      expect(types).toContain('summary');
    });

    it('handleSessionEnd_TranscriptNotFound_ReturnsErrorGracefully', async () => {
      const { handleSessionEnd } = await import('./session-end.js');

      // Arrange — do NOT create the transcript file
      const stdinData = {
        session_id: 'test-session-004',
        transcript_path: path.join(tmpDir, 'nonexistent-transcript.jsonl'),
      };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toHaveProperty('error');
      expect(result.error!.code).toBe('TRANSCRIPT_NOT_FOUND');
    });

    it('handleSessionEnd_AlreadyExtracted_SkipsReextraction', async () => {
      const { handleSessionEnd } = await import('./session-end.js');
      const { parseTranscript } = await import('../session/transcript-parser.js');
      const sessionId = 'test-session-005';

      // Arrange — create events file to simulate already-extracted session
      const eventsPath = path.join(stateDir, 'sessions', `${sessionId}.events.jsonl`);
      await fs.writeFile(eventsPath, '{"t":"summary"}\n', 'utf-8');
      await fs.writeFile(transcriptPath, '{"type":"assistant"}\n', 'utf-8');

      const stdinData = { session_id: sessionId, transcript_path: transcriptPath };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toEqual({ continue: true });
      expect(parseTranscript).not.toHaveBeenCalled();
    });

    it('handleSessionEnd_ParseTranscriptThrows_ReturnsExtractionError', async () => {
      const { handleSessionEnd } = await import('./session-end.js');
      const { parseTranscript } = await import('../session/transcript-parser.js');
      const sessionId = 'test-session-006';

      // Arrange
      await fs.writeFile(transcriptPath, '{"type":"assistant"}\n', 'utf-8');
      vi.mocked(parseTranscript).mockRejectedValue(new Error('Parse failed'));

      const stdinData = { session_id: sessionId, transcript_path: transcriptPath };

      // Act
      const result = await handleSessionEnd(stdinData, stateDir);

      // Assert
      expect(result).toHaveProperty('error');
      expect(result.error!.code).toBe('EXTRACTION_FAILED');
      expect(result.error!.message).toContain('Parse failed');
    });

    it('handleSessionEnd_NoEndReason_DefaultsToUnknown', async () => {
      const { handleSessionEnd } = await import('./session-end.js');
      const { parseTranscript } = await import('../session/transcript-parser.js');
      const { writeManifestCompletion } = await import('../session/manifest.js');
      const sessionId = 'test-session-007';
      const mockEvents = makeMockEvents(sessionId);

      // Arrange — stdinData without end_reason
      await fs.writeFile(transcriptPath, '{"type":"assistant"}\n', 'utf-8');
      vi.mocked(parseTranscript).mockResolvedValue(mockEvents);

      const stdinData = { session_id: sessionId, transcript_path: transcriptPath };

      // Act
      await handleSessionEnd(stdinData, stateDir);

      // Assert
      const callArgs = vi.mocked(writeManifestCompletion).mock.calls[0];
      expect(callArgs[1].endReason).toBe('unknown');
    });
  });

  describe('routeCommand integration', () => {
    it('routeCommand_SessionEnd_WithMissingData_ReturnsError', async () => {
      const { routeCommand } = await import('../cli.js');

      // Act
      const result = await routeCommand('session-end', {});

      // Assert
      expect(result).toHaveProperty('error');
      expect(result.error?.code).toBe('MISSING_SESSION_ID');
    });
  });
});
