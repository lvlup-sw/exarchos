/**
 * #1244 — markdown-aware handoff lint at `handleCheckpoint`.
 *
 * Thin fan-out over `lintProse` (the canonical prose-lint at
 * `projections/rehydration/prose-lint.ts`). Scans each of the three
 * text-bearing fields of a `CheckpointHandoffSchema` payload —
 * `context`, `nextSteps`, `suggestions` — and tags every finding with
 * the field it originated in so the checkpoint handler (and the human
 * reading the warning) can localize the offending text.
 *
 * Design notes:
 *
 *   1. **No duplicate catalog.** The pattern set lives in `prose-lint.ts`
 *      (DR-13 / T048). This wrapper imports `lintProse` directly; any
 *      future drift between "what the rehydration template lints" and
 *      "what the handoff dispatch lints" would be a footgun, so the
 *      single source of truth is enforced by import, not convention.
 *
 *   2. **Per-field fan-out.** `nextSteps` and `suggestions` are arrays
 *      of short strings (DIM-7 caps each at 256 bytes). We lint each
 *      string independently rather than joining them first — joining
 *      would let the em-dash-chain pattern's `minHits: 3` rule mask a
 *      single-line AI-tell that the operator could otherwise see and
 *      fix.
 *
 *   3. **Short-circuit on empty.** Empty `context` / undefined arrays
 *      yield zero findings without entering the lint loop. Pre-#1240
 *      callers that omit `handoff` entirely (it's optional on
 *      `CheckpointInputSchema`) also pass through cleanly.
 */

import { lintProse, type Violation } from '../projections/rehydration/prose-lint.js';

/**
 * A prose-lint violation annotated with the handoff field it came from.
 * Inherits the full `Violation` shape (`pattern`, `line`, `excerpt`) so
 * downstream consumers — the soft-warning event hint, the hard-fail
 * `data` block — see the same fields they would from a direct
 * `lintProse` call.
 */
export interface HandoffLintFinding extends Violation {
  /** Which handoff field produced this finding. */
  readonly source: 'context' | 'nextSteps' | 'suggestions';
}

/**
 * Handoff payload shape accepted by the lint. Mirrors
 * `CheckpointHandoffSchema` structurally but is declared inline so the
 * helper has no cross-module dependency on the dispatch schema — keeps
 * this file unit-testable without dragging in the workflow surface.
 */
export interface HandoffLintInput {
  readonly context?: string | undefined;
  readonly nextSteps?: readonly string[] | undefined;
  readonly suggestions?: readonly string[] | undefined;
}

export function lintHandoff(handoff: HandoffLintInput): HandoffLintFinding[] {
  const findings: HandoffLintFinding[] = [];

  if (handoff.context && handoff.context.length > 0) {
    for (const v of lintProse(handoff.context)) {
      findings.push({ ...v, source: 'context' });
    }
  }

  if (handoff.nextSteps) {
    for (const step of handoff.nextSteps) {
      if (!step || step.length === 0) continue;
      for (const v of lintProse(step)) {
        findings.push({ ...v, source: 'nextSteps' });
      }
    }
  }

  if (handoff.suggestions) {
    for (const s of handoff.suggestions) {
      if (!s || s.length === 0) continue;
      for (const v of lintProse(s)) {
        findings.push({ ...v, source: 'suggestions' });
      }
    }
  }

  return findings;
}
