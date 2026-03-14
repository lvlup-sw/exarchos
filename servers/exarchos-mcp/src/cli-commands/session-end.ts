import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandResult } from '../cli.js';
import { parseTranscript } from '../session/transcript-parser.js';
import { writeManifestCompletion } from '../session/manifest.js';
import type { SessionEvent, SessionSummaryEvent, SessionManifestCompletion } from '../session/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Write an array of events as newline-delimited JSON to the given path. */
async function writeEventsFile(eventsPath: string, events: SessionEvent[]): Promise<void> {
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(eventsPath, content, 'utf-8');
}

/** Check whether a file exists at the given path. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Find the summary event from a list of session events. */
function findSummary(events: SessionEvent[]): SessionSummaryEvent | undefined {
  return events.find((e): e is SessionSummaryEvent => e.t === 'summary');
}

/** Build completion metadata from parsed session events. */
function buildCompletion(
  sessionId: string,
  endReason: string,
  summary: SessionSummaryEvent | undefined,
): SessionManifestCompletion {
  return {
    sessionId,
    extractedAt: new Date().toISOString(),
    endReason,
    toolCalls: summary?.tools
      ? Object.values(summary.tools).reduce((a, b) => a + b, 0)
      : 0,
    turns: summary?.turns ?? 0,
    totalTokens: summary?.tokTotal
      ? summary.tokTotal.in + summary.tokTotal.out
      : 0,
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Handle the `session-end` CLI command.
 *
 * Validates inputs, parses the transcript, writes structured events to a JSONL
 * file, and appends completion metadata to the manifest.
 */
export async function handleSessionEnd(
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<CommandResult> {
  // ── Input validation ──────────────────────────────────────────────────────
  const sessionId = stdinData.session_id;
  const transcriptPath = stdinData.transcript_path;

  if (!sessionId || typeof sessionId !== 'string') {
    return { error: { code: 'MISSING_SESSION_ID', message: 'session_id is required' } };
  }

  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { error: { code: 'MISSING_TRANSCRIPT_PATH', message: 'transcript_path is required' } };
  }

  // ── Idempotency check ─────────────────────────────────────────────────────
  const sessionsDir = path.join(stateDir, 'sessions');
  const eventsPath = path.join(sessionsDir, `${sessionId}.events.jsonl`);

  if (await fileExists(eventsPath)) {
    return { continue: true };
  }

  // ── Transcript existence check ────────────────────────────────────────────
  if (!(await fileExists(transcriptPath))) {
    return {
      error: {
        code: 'TRANSCRIPT_NOT_FOUND',
        message: `Transcript file not found: ${transcriptPath}`,
      },
    };
  }

  // ── Extract and write ─────────────────────────────────────────────────────
  try {
    const events = await parseTranscript(transcriptPath, { sessionId });

    await fs.mkdir(sessionsDir, { recursive: true });
    await writeEventsFile(eventsPath, events);

    const summary = findSummary(events);
    const endReason = typeof stdinData.end_reason === 'string'
      ? stdinData.end_reason
      : 'unknown';
    const completion = buildCompletion(sessionId, endReason, summary);

    await writeManifestCompletion(stateDir, completion);

    return { continue: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: {
        code: 'EXTRACTION_FAILED',
        message,
      },
    };
  }
}
