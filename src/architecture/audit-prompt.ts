/**
 * Renders the audit-mode invariants (`enforcement.mode === 'audit'`) of a catalog slice into one
 * prompt for a review subagent. No declarative check tree can decide these invariants, so they
 * need the judgment of an LLM reviewer.
 *
 * - The renderer treats every audit invariant the same and has no branch on an invariant id.
 *   The vocabulary lives in the catalog `summary` and `audit-prompt` fields.
 * - The output is plain prompt text. Nothing here runs the check.
 * - Blocks appear in ascending `id` order, so the prompt does not depend on catalog order.
 * - An empty input throws, because an empty prompt reads like a clean audit. The throw is in the
 *   pure function, so every consumer inherits it.
 */
import type { InvariantEntry } from './invariants-loader.js';

/**
 * Thrown when an audit projection gets zero entries. The separate type lets a caller tell "the
 * audit had no subject" from a renderer fault, and report only the first as a gate condition.
 */
export class EmptyAuditProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyAuditProjectionError';
  }
}

/**
 * Why {@link AuditProjection.prompt} has its content. With `rendered`, at least one audit-mode
 * entry applied and `prompt` holds their blocks. With `no-audit-entries`, no applied entry was
 * audit-mode, so `prompt` is `''`.
 */
export type AuditProjectionStatus =
  | 'rendered'
  | 'no-audit-entries';

/** The result of projecting a catalog slice into a reviewer prompt. */
export interface AuditProjection {
  readonly status: AuditProjectionStatus;
  /** The concatenated prompt blocks, or `''` when `status` is `no-audit-entries`. */
  readonly prompt: string;
  /**
   * Every invariant id in {@link prompt}, ascending. An instructed consumer must return a
   * judgment for each id. The list is empty exactly when `status` is `no-audit-entries`.
   */
  readonly invariantIds: readonly string[];
}

/**
 * Projects a catalog slice into the audit prompt for the review subagent. It skips each entry
 * that has no `audit` enforcement mode. It sorts the rest by `id` and emits a block for each with
 * the id, the `summary` and the verbatim `audit-prompt` text.
 *
 * @throws {EmptyAuditProjectionError} when `invariants` is empty. A non-empty input with no
 * audit-mode entry gives an ordinary `no-audit-entries` result.
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
 * Renders the audit-mode invariants in `invariants` into one prompt. It delegates to
 * {@link projectAuditPrompt}, so an empty input throws here too.
 *
 * @returns the concatenated prompt, or `''` when no audit invariants apply.
 * @throws {EmptyAuditProjectionError} when `invariants` is empty.
 */
export function renderAuditPrompt(invariants: readonly InvariantEntry[]): string {
  return projectAuditPrompt(invariants).prompt;
}

/** Renders one audit invariant into its prompt block, with the same format for every id. */
function renderBlock(entry: InvariantEntry & {
  enforcement: { mode: 'audit'; 'audit-prompt': string };
}): string {
  return [
    `### ${entry.id}: ${entry.summary}`,
    entry.enforcement['audit-prompt'],
  ].join('\n');
}
