/**
 * Lints the prose of a checkpoint handoff with `lintProse` from `projections/rehydration/prose-lint.ts`.
 * The pattern catalog lives only in that module. This file imports it and keeps no copy.
 * The lint checks `context` and each `nextSteps` and `suggestions` string alone.
 * Each finding names the handoff field that produced it.
 */

import { lintProse, type Violation } from '../projections/rehydration/prose-lint.js';

/** A `lintProse` violation with the handoff field that produced it. */
export interface HandoffLintFinding extends Violation {
  /** Which handoff field produced this finding. */
  readonly source: 'context' | 'nextSteps' | 'suggestions';
}

/**
 * The handoff fields that the lint reads.
 * The type matches `CheckpointHandoffSchema` by structure, so this file does not import the dispatch schema.
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
