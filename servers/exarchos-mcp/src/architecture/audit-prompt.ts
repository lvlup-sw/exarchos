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
 */
import type { InvariantEntry } from './invariants-loader.js';

/**
 * Render the audit-mode invariants in `invariants` into a single prompt block.
 *
 * Entries without an `enforcement` directive, or whose enforcement mode is not
 * `audit`, are skipped. The surviving entries are sorted by `id` and each
 * emitted as a block carrying the invariant id, its `summary`, and its
 * `audit-prompt` text verbatim.
 *
 * @returns the concatenated prompt, or `''` when no audit invariants apply.
 */
export function renderAuditPrompt(invariants: InvariantEntry[]): string {
  const auditEntries = invariants
    .filter(
      (entry): entry is InvariantEntry & {
        enforcement: { mode: 'audit'; 'audit-prompt': string };
      } => entry.enforcement?.mode === 'audit',
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  if (auditEntries.length === 0) {
    return '';
  }

  return auditEntries.map(renderBlock).join('\n\n');
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
