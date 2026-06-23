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
// untouched to keep blast radius off it). The two now deliberately DIVERGE on
// failure: intent is fail-SOFT (`[]` floor on git error — a degraded intent is
// fine), whereas prepare-synthesis fails CLOSED (`null` → a blocking document
// leg cannot be silently waived). Same shape, intentionally different failure
// semantics — which is why the helper is not hoisted into one shared symbol.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { EventStore } from '../event-store/store.js';
import { handleUpdate } from '../workflow/tools.js';
import { WorkflowIntentSchema } from '../workflow/schemas.js';
import type { WorkflowIntent } from '../workflow/schemas.js';
import { resolveWorkflowState } from './resolve-state.js';

export type { WorkflowIntent } from '../workflow/schemas.js';

// ─── Diff Helper (self-contained — mirrors prepare-synthesis.ts) ─────────────

/** The default base branch, via origin/HEAD with a sanitizing fallback to `main`. */
function detectDefaultBranch(cwd?: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
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
    const output = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
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

// ─── Fail-Soft Read (DR-1 task 006) ──────────────────────────────────────────

/**
 * Read the persisted `artifacts.intent` back from workflow state — the READ
 * counterpart of {@link persistIntent}. Resolves state via the canonical
 * {@link resolveWorkflowState} (SQLite event store is the source of truth) and
 * safe-parses `artifacts.intent` through {@link WorkflowIntentSchema}.
 *
 * FAIL-SOFT by design (DR-1 acceptance): returns `undefined` — never throws and
 * never surfaces an error envelope — when `featureId` is absent, no event store
 * is supplied, state is unreadable, the intent is absent, or it fails schema
 * validation. PR-body grounding (create_pr / validate_pr_body) consumes this and
 * degrades to its unchanged legacy behavior when the result is `undefined`, so a
 * state hiccup can never break PR creation or validation. No `workflowType`
 * branch (INV-6): the same read holds for every workflow type.
 */
export async function readIntent(
  featureId: string | undefined,
  eventStore: EventStore | undefined,
): Promise<WorkflowIntent | undefined> {
  if (!featureId || !eventStore) return undefined;
  try {
    const resolved = await resolveWorkflowState({ featureId, eventStore });
    if ('error' in resolved) return undefined;
    const artifacts = resolved.state['artifacts'];
    if (typeof artifacts !== 'object' || artifacts === null) return undefined;
    const rawIntent = (artifacts as Record<string, unknown>)['intent'];
    if (rawIntent === undefined) return undefined;
    const parsed = WorkflowIntentSchema.safeParse(rawIntent);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ─── Intent Grounding Marker (DR-1 task 006) ─────────────────────────────────

/**
 * Idempotency marker for the `## Intent` grounding section injected into a PR
 * body. An HTML comment so it renders invisibly on GitHub while remaining a
 * deterministic presence check for both the create_pr enrichment (don't
 * double-inject) and the validate_pr_body advisory (is the body grounded?).
 */
export const INTENT_GROUNDING_MARKER = '<!-- intent-grounded -->';

/**
 * Whether a body already carries the intent-grounding marker. Used by both the
 * create_pr enrichment (idempotency guard) and the validate_pr_body advisory.
 */
export function bodyHasIntentMarker(body: string): boolean {
  return body.includes(INTENT_GROUNDING_MARKER);
}

/**
 * An intent is "meaningful" — worth grounding a PR body in — only when it
 * references at least one changed file. The empty/un-resolvable-diff floor
 * (`changedFiles.length === 0`) is NOT grounded; the body is left untouched.
 * Mirrors the `buildIntentGrounding` meaningfulness gate in prepare-review.ts
 * (task 005) so the grounded-PR and grounded-review paths agree on the floor.
 */
export function isMeaningfulIntent(intent: WorkflowIntent): boolean {
  return intent.changedFiles.length > 0;
}

/**
 * Build the deterministic `## Intent` grounding section appended to a PR body.
 * Pure — no `workflowType` branch. Carries surfaces, the human-floor summary,
 * the optional transcript line, and the idempotency marker so the section is
 * both human-readable and machine-detectable on a later validate pass.
 */
export function buildIntentSection(intent: WorkflowIntent): string {
  const lines: string[] = ['## Intent', '', INTENT_GROUNDING_MARKER, ''];
  lines.push(`**Surfaces:** ${intent.surfaces.length > 0 ? intent.surfaces.join(', ') : '(none)'}`);
  lines.push('');
  lines.push(intent.summary);
  if (intent.transcriptSummary) {
    lines.push('');
    lines.push(`**Context:** ${intent.transcriptSummary}`);
  }
  return lines.join('\n');
}

/**
 * Append the `## Intent` grounding section to a PR body when the intent is
 * meaningful AND the body is not already grounded (idempotent). Returns the body
 * UNCHANGED when the intent is not meaningful or the marker is already present.
 * Pure / total — never throws.
 */
export function groundBodyInIntent(body: string, intent: WorkflowIntent): string {
  if (!isMeaningfulIntent(intent)) return body;
  if (bodyHasIntentMarker(body)) return body;
  const section = buildIntentSection(intent);
  return body.trimEnd().length === 0 ? section : `${body.trimEnd()}\n\n${section}`;
}
