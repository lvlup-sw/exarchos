/**
 * Derives a workflow intent from the diff and an optional transcript, and stores it in workflow
 * state for review and PR-body generation.
 * `deriveIntent` is pure and has no `workflowType` parameter, so each workflow type uses the same derivation.
 * `persistIntent` and `readIntent` are fail-soft, so a state failure cannot break review or PR creation.
 *
 * `changedFilesAgainstBase` mirrors the diff helper in `prepare-synthesis.ts`, but it returns `[]` on a git error.
 * The `prepare-synthesis.ts` helper returns `null` and fails closed, so the two do not share one symbol.
 */

import { execFileSync } from 'node:child_process';
import type { EventStore } from '../../events/store.js';
import { handleUpdate } from '../../workflow/tools.js';
import { WorkflowIntentSchema } from '../../workflow/schemas.js';
import type { WorkflowIntent } from '../../workflow/schemas.js';
import { resolveWorkflowState } from '../resolve-state.js';

export type { WorkflowIntent } from '../../workflow/schemas.js';

/** The default base branch from `origin/HEAD`. A git error, or a ref name outside a safe character set, gives `main`. */
function detectDefaultBranch(cwd?: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    }).trim();
    const branch = ref.replace('refs/remotes/origin/', '');
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

/** Upper bound on the transcript-summary length (chars). */
const TRANSCRIPT_SUMMARY_MAX = 280;

/**
 * The sorted, distinct top-level surfaces of the changed files. A surface is the first path segment,
 * so `servers/a/b.ts` gives `servers` and `README.md` gives `README.md`.
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
 * Derives the `WorkflowIntent` floor from the changed-file list. It is pure and has no `workflowType`
 * parameter, so each workflow type gets the same derivation. A non-empty `transcript` adds
 * `transcriptSummary` and sets `source: 'diff+transcript'`. Otherwise `source` is `'diff'`.
 */
export function deriveIntent(
  changedFiles: readonly string[],
  opts?: { transcript?: string | undefined },
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

/**
 * Stores the intent at `artifacts.intent` through `handleUpdate`, which emits one `state.patched` event.
 * It never throws. A failure returns `{ persisted: false, warning }`, so a state-write failure cannot
 * break review provisioning.
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

/**
 * Reads `artifacts.intent` back from workflow state through {@link resolveWorkflowState}, and parses
 * it with {@link WorkflowIntentSchema}. It never throws. It returns `undefined` when `featureId` or
 * the event store is absent, the state is not readable, or the intent is absent or not valid.
 * PR-body grounding then keeps its default behavior, so a state failure cannot break PR creation.
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

/**
 * The idempotency marker of the `## Intent` section in a PR body. It is an HTML comment, so GitHub
 * does not show it. `create_pr` and `validate_pr_body` use it as a presence check.
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
 * An intent is meaningful only when it names at least one changed file. The empty-diff floor does
 * not ground a PR body. `buildIntentGrounding` in `prepare-review.ts` uses the same rule.
 */
export function isMeaningfulIntent(intent: WorkflowIntent): boolean {
  return intent.changedFiles.length > 0;
}

/**
 * Builds the `## Intent` section for a PR body: the surfaces, the summary, the optional transcript
 * line, and the idempotency marker. It has no `workflowType` branch.
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
