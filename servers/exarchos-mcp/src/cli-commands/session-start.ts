// ─── SessionStart Observer + Binding (#1485) ─────────────────────────────────
//
// Observe-only SessionStart hook (ADR docs/adrs/2026-05-24-hook-layer-observe-only.md).
// Two jobs, both fail-open:
//   1. Telemetry — record a `session.started` manifest entry (the first writer
//      of writeManifestEntry; the provenance projection already reads it). This
//      is the start half of the closed observe-loop whose end half is
//      session-end's transcript/provenance capture.
//   2. Binding — for injection-capable hosts (Claude/Codex), return the
//      orientation directive as `additionalContext` so the harness is soft-bound
//      to route SDLC through the exarchos_* tools.
//
// CRITICAL (G2): never write `sessions/<id>.events.jsonl` here — that file is
// session-end's idempotency sentinel; creating it at start would make session-end
// skip transcript parsing and silently break provenance. The start record goes
// to the separate `.manifest.jsonl` via writeManifestEntry.
//
// Observe-only: never returns a policy `error` and never drives a state
// transition / rehydration (the T-40 auto-resume trap).

import type { CommandResult } from './types.js';
import { readManifestEntries, writeManifestEntry } from '../session/manifest.js';
import type { SessionManifestEntry } from '../session/types.js';

/** Optional, non-stdin inputs (the binding directive is baked into the rendered
 * per-runtime hook command and threaded through by the hook adapter). */
export interface SessionStartOptions {
  /** Orientation directive to emit as additionalContext (injection-capable hosts). */
  readonly directive?: string | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Handle the `session-start` hook command.
 *
 * Expected stdin shape (best-effort — only `session_id` is required):
 * ```json
 * { "session_id": "...", "cwd": "...", "transcript_path": "...",
 *   "source": "startup|resume", "workflow_id": "...", "branch": "..." }
 * ```
 */
export async function handleSessionStart(
  input: Record<string, unknown>,
  stateDir: string,
  opts: SessionStartOptions = {},
): Promise<CommandResult> {
  // additionalContext is produced regardless of session_id / idempotency so a
  // resumed (or malformed) session is still oriented; only the manifest write is
  // gated. The non-error `ok` result is the single fail-open return shape.
  const additionalContext = opts.directive;
  const ok: CommandResult = additionalContext
    ? { continue: true, additionalContext }
    : { continue: true };

  // Fail-open (observe-only): a missing/blank session_id is unexpected, but an
  // observer must NEVER return a blocking error (the adapter would surface it as
  // a non-zero exit). Skip the telemetry write and continue — never block the
  // session start. This is what the header contract promises.
  const sessionId = asString(input.session_id);
  if (!sessionId) {
    return ok;
  }

  // ── Idempotency: one start record per session ───────────────────────────────
  const existing = await readManifestEntries(stateDir);
  if (existing.some((e) => e.sessionId === sessionId)) {
    return ok;
  }

  const entry: SessionManifestEntry = {
    sessionId,
    workflowId: asString(input.workflow_id),
    // Best-effort: the start payload may not carry a transcript path. Empty is a
    // valid start-marker — findUnextractedSessions skips entries without one, so
    // this never falsely flags a session as needing transcript extraction.
    transcriptPath: asString(input.transcript_path) ?? '',
    startedAt: new Date().toISOString(),
    cwd: asString(input.cwd) ?? '',
    branch: asString(input.branch),
  };

  await writeManifestEntry(stateDir, entry);

  return ok;
}
