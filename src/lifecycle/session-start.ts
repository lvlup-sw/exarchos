/**
 * Observe-only `session-start` hook. Both of its jobs fail open:
 *   1. Telemetry: it writes a start entry to the session manifest. The transcript capture of
 *      `session-end` closes the loop.
 *   2. Binding: it returns the orientation directive as `additionalContext`, so an
 *      injection-capable host routes SDLC work through the `exarchos_*` tools.
 *
 * CAUTION: Do not write `sessions/<id>.events.jsonl` here. `session-end` uses that file as its
 * idempotency sentinel. If the file exists at start, `session-end` skips transcript parsing and
 * provenance breaks.
 *
 * The hook never returns a policy `error` and never drives a state transition or rehydration.
 */

import type { CommandResult } from './types.js';
import { readManifestEntries, writeManifestEntry } from '../projections/session/manifest.js';
import type { SessionManifestEntry } from '../projections/session/types.js';

/**
 * Inputs that do not come from stdin. The hook adapter reads the directive from the rendered
 * hook command.
 */
export interface SessionStartOptions {
  /** Orientation directive to emit as additionalContext (injection-capable hosts). */
  readonly directive?: string | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Handles the `session-start` hook command. The stdin payload has this shape:
 * ```json
 * { "session_id": "...", "cwd": "...", "transcript_path": "...",
 *   "source": "startup|resume", "workflow_id": "...", "branch": "..." }
 * ```
 * When a directive is set, every result carries it, so a resumed or malformed session gets it.
 * A missing `session_id`, or an entry that exists for the session, skips the manifest write. An
 * empty `transcriptPath` is a valid start marker, because `findUnextractedSessions` skips it.
 */
export async function handleSessionStart(
  input: Record<string, unknown>,
  stateDir: string,
  opts: SessionStartOptions = {},
): Promise<CommandResult> {
  const additionalContext = opts.directive;
  const ok: CommandResult = additionalContext
    ? { continue: true, additionalContext }
    : { continue: true };

  const sessionId = asString(input.session_id);
  if (!sessionId) {
    return ok;
  }

  const existing = await readManifestEntries(stateDir);
  if (existing.some((e) => e.sessionId === sessionId)) {
    return ok;
  }

  const entry: SessionManifestEntry = {
    sessionId,
    workflowId: asString(input.workflow_id),
    transcriptPath: asString(input.transcript_path) ?? '',
    startedAt: new Date().toISOString(),
    cwd: asString(input.cwd) ?? '',
    branch: asString(input.branch),
  };

  await writeManifestEntry(stateDir, entry);

  return ok;
}
