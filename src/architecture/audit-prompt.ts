/**
 * Catalog-driven audit-prompt renderer (DR-4).
 *
 * Judgment invariants — those whose `enforcement.mode === 'audit'` — cannot be
 * decided by a declarative check tree; they require an LLM reviewer's
 * judgment. This module compiles every such invariant in a catalog slice into
 * a single prompt block suitable for handing to a review subagent. The block
 * is wired into the review gate's prompt by a later task (T-17); this renderer
 * is concerned only with producing the text.
 *
 * ## Design constraints
 *
 * - **Workflow-agnostic (INV-6).** The renderer treats every audit invariant
 *   uniformly. There is NO per-id (`INV-*`) branching or special-casing: the
 *   vocabulary lives in the catalog `summary` / `audit-prompt` fields, not in
 *   this code. A brand-new invariant id renders identically in shape to a
 *   familiar one.
 * - **No MCP-local execution presumption (INV-3).** The output is plain prompt
 *   text. Nothing here executes the check or assumes it runs in-process; the
 *   audit is performed by whatever reviewer the gate hands the prompt to.
 * - **Deterministic.** Audit invariants are emitted in ascending `id` order so
 *   the rendered prompt is stable regardless of catalog iteration order.
 * - **Non-empty denominator (task 069).** A projection that resolved ZERO
 *   applicable entries is not a clean audit — it is an audit that lost its
 *   subject (the catalog moved, the registration gate closed, the projection
 *   filter over-narrowed). Rendering `''` for that case makes the loudest
 *   possible failure indistinguishable from the quietest possible success, so
 *   {@link projectAuditPrompt} THROWS on an empty entry list instead. The tooth
 *   lives in the pure function, not in a caller, so a future consumer wired
 *   straight to the renderer inherits it rather than bypassing it (the exact
 *   half-installed-tooth defect task 022 recorded against the CLI guard).
 */
import type { InvariantEntry } from './invariants-loader.js';

/**
 * Thrown when an audit projection is asked to render over ZERO applicable
 * entries. Its own type (not a bare `Error`) so a caller can distinguish "the
 * audit had no subject" from "the renderer blew up", and treat only the former
 * as a reportable gate condition.
 */
export class EmptyAuditProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyAuditProjectionError';
  }
}

/** Why {@link AuditProjection.prompt} has the content it has. */
export type AuditProjectionStatus =
  /** At least one audit-mode entry applied; `prompt` carries their blocks. */
  | 'rendered'
  /** Entries applied, but none were audit-mode. `prompt` is `''`, legitimately. */
  | 'no-audit-entries';

/** The result of projecting a catalog slice into a reviewer prompt. */
export interface AuditProjection {
  readonly status: AuditProjectionStatus;
  /** The concatenated prompt blocks, or `''` when `status` is `no-audit-entries`. */
  readonly prompt: string;
  /**
   * Every invariant id rendered into {@link prompt}, ascending. This is the
   * reader's enumerable checklist: an instructed consumer must return a
   * judgment for each id, and a consumer that returns none is visibly not a
   * consumer. Empty exactly when `status` is `no-audit-entries`.
   */
  readonly invariantIds: readonly string[];
}

/**
 * Project a catalog slice into the review subagent's audit prompt.
 *
 * Entries without an `enforcement` directive, or whose enforcement mode is not
 * `audit`, are skipped. The surviving entries are sorted by `id` and each
 * emitted as a block carrying the invariant id, its `summary`, and its
 * `audit-prompt` text verbatim.
 *
 * @throws {EmptyAuditProjectionError} when `invariants` is empty — see the
 * non-empty-denominator note in the module header. Note the distinction the
 * caller must preserve: an empty INPUT is a lost subject and fails, while a
 * non-empty input holding no audit-mode entry is an ordinary
 * `no-audit-entries` result.
 */
export function projectAuditPrompt(
  invariants: readonly InvariantEntry[],
): AuditProjection {
  if (invariants.length === 0) {
    throw new EmptyAuditProjectionError(
      'Audit projection resolved ZERO applicable invariants. An empty denominator ' +
        'renders an empty prompt, which reads exactly like a clean audit while ' +
        'proving nothing was audited at all. Check that the effective catalog ' +
        'still resolves (registration gate, projection filters, touched-files ' +
        'scope) before treating this as a pass.',
    );
  }

  const auditEntries = invariants
    .filter(
      (entry): entry is InvariantEntry & {
        enforcement: { mode: 'audit'; 'audit-prompt': string };
      } => entry.enforcement?.mode === 'audit',
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  if (auditEntries.length === 0) {
    return Object.freeze({
      status: 'no-audit-entries',
      prompt: '',
      invariantIds: Object.freeze([]),
    });
  }

  return Object.freeze({
    status: 'rendered',
    prompt: auditEntries.map(renderBlock).join('\n\n'),
    invariantIds: Object.freeze(auditEntries.map((entry) => entry.id)),
  });
}

/**
 * Render the audit-mode invariants in `invariants` into a single prompt block.
 *
 * Thin projection of {@link projectAuditPrompt} — it carries the SAME
 * non-empty-denominator tooth, because it delegates rather than re-deriving.
 *
 * @returns the concatenated prompt, or `''` when no audit invariants apply.
 * @throws {EmptyAuditProjectionError} when `invariants` is empty.
 */
export function renderAuditPrompt(invariants: readonly InvariantEntry[]): string {
  return projectAuditPrompt(invariants).prompt;
}

/**
 * Render a single audit invariant into its prompt block. Uniform for every
 * invariant — no id-specific formatting (INV-6).
 */
function renderBlock(entry: InvariantEntry & {
  enforcement: { mode: 'audit'; 'audit-prompt': string };
}): string {
  return [
    `### ${entry.id}: ${entry.summary}`,
    entry.enforcement['audit-prompt'],
  ].join('\n');
}
