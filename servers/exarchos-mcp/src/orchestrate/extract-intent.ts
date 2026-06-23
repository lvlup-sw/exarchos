// ─── Extract Intent (DR-1 #1593) ─────────────────────────────────────────────
//
// A transcript/diff-derived **intent** captured as workflow state so that
// REVIEW (task 005) and PR-body generation (task 006) can later read it back.
// This module WRITES the intent; downstream tasks READ it.
//
// Two pieces:
//   1. `deriveIntent` — PURE: changed-file list (+ optional transcript) → the
//      `WorkflowIntent` floor. No I/O, no `workflowType` parameter. The absence
//      of a `workflowType` parameter is the structural guarantee of INV-6
//      (workflow-agnosticism): the SAME derivation runs for feature / debug /
//      refactor / oneshot with no type switch anywhere on the path.
//   2. `persistIntent` — fail-soft persist via the CANONICAL state-patch surface
//      (`handleUpdate` → exactly one `state.patched` event). Never throws; on
//      any failure it returns `{ persisted: false, warning }` so review
//      provisioning is never broken by a state-write hiccup.
//
// `changedFilesAgainstBase` mirrors the proven diff helper in
// `prepare-synthesis.ts` (kept self-contained here — Bundle A's file is left
// untouched to keep blast radius off it).
// ────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import type { EventStore } from '../event-store/store.js';
import { handleUpdate } from '../workflow/tools.js';
import type { WorkflowIntent } from '../workflow/schemas.js';

export type { WorkflowIntent } from '../workflow/schemas.js';

// ─── Diff Helper (self-contained — mirrors prepare-synthesis.ts) ─────────────

/** The default base branch, via origin/HEAD with a sanitizing fallback to `main`. */
function detectDefaultBranch(cwd?: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    }).trim();
    const branch = ref.replace('refs/remotes/origin/', '');
    // Sanitize to prevent command injection via crafted ref names.
    return /^[a-zA-Z0-9/_.-]+$/.test(branch) ? branch : 'main';
  } catch {
    return 'main';
  }
}

/** Changed files between the default base branch and HEAD (name-only). `[]` on any error. */
export function changedFilesAgainstBase(cwd?: string): string[] {
  try {
    const baseBranch = detectDefaultBranch(cwd);
    const output = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
      encoding: 'buffer',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    return output
      .toString('utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Pure Derivation ─────────────────────────────────────────────────────────

/** Upper bound on the transcript-summary length (chars). */
const TRANSCRIPT_SUMMARY_MAX = 280;

/**
 * De-duped, sorted top-level surface prefixes of the changed files. The surface
 * is the first path segment (e.g. `servers/a/b.ts` → `servers`); a top-level
 * file with no slash (e.g. `README.md`) is its own surface.
 */
function surfacesOf(changedFiles: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const f of changedFiles) {
    const trimmed = f.trim();
    if (!trimmed) continue;
    const slash = trimmed.indexOf('/');
    seen.add(slash === -1 ? trimmed : trimmed.slice(0, slash));
  }
  return [...seen].sort();
}

/**
 * Bound a transcript to a single human-readable summary line: the first
 * non-empty line, length-capped. Pure — never throws on odd input.
 */
function summarizeTranscript(transcript: string): string {
  const firstLine =
    transcript
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? transcript.trim();
  return firstLine.length > TRANSCRIPT_SUMMARY_MAX
    ? `${firstLine.slice(0, TRANSCRIPT_SUMMARY_MAX - 1)}…`
    : firstLine;
}

/**
 * Derive the `WorkflowIntent` floor from the cumulative changed-file list, with
 * optional transcript enrichment. PURE — no I/O, and (deliberately) NO
 * `workflowType` parameter: the same derivation holds for every workflow type
 * (INV-6). When a non-empty `transcript` is supplied the intent is enriched
 * (`source: 'diff+transcript'`, `transcriptSummary` set); otherwise it is the
 * diff-only floor (`source: 'diff'`, no `transcriptSummary`).
 */
export function deriveIntent(
  changedFiles: readonly string[],
  opts?: { transcript?: string },
): WorkflowIntent {
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);
  const surfaces = surfacesOf(files);
  const summary =
    `${files.length} file${files.length === 1 ? '' : 's'} changed across ` +
    `${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}` +
    (surfaces.length > 0 ? `: ${surfaces.join(', ')}` : '');

  const transcript = opts?.transcript;
  if (typeof transcript === 'string' && transcript.trim().length > 0) {
    return {
      source: 'diff+transcript',
      changedFiles: files,
      surfaces,
      summary,
      transcriptSummary: summarizeTranscript(transcript),
    };
  }

  return {
    source: 'diff',
    changedFiles: files,
    surfaces,
    summary,
  };
}

// ─── Fail-Soft Persist ───────────────────────────────────────────────────────

/**
 * Persist the derived intent to `artifacts.intent` via the canonical state-patch
 * surface (`handleUpdate`), which emits exactly ONE `state.patched` event — no
 * custom event type. Fail-soft: on a non-success result or a thrown error this
 * returns `{ persisted: false, warning }` and NEVER throws, so a state-write
 * failure cannot break review provisioning.
 */
export async function persistIntent(
  featureId: string,
  intent: WorkflowIntent,
  stateDir: string,
  eventStore: EventStore,
): Promise<{ persisted: boolean; warning?: string }> {
  try {
    const result = await handleUpdate(
      { featureId, updates: { 'artifacts.intent': intent } },
      stateDir,
      eventStore,
    );
    if (result.success) {
      return { persisted: true };
    }
    const message = result.error?.message ?? 'state-patch returned a non-success result';
    return { persisted: false, warning: `intent persistence skipped: ${message}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { persisted: false, warning: `intent persistence failed: ${message}` };
  }
}
