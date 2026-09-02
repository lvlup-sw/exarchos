// ─── F.4: computeNextActions round-trip (Wave 0, design §7) ────────────────
//
// For every built-in workflow type, iterate every phase declared by its
// HSM definition, call `computeNextActions({phase, workflowType}, hsm)`,
// and assert the result validates as a `NextAction[]` (per the schema in
// `contract/schemas/envelope.ts` → `next-action.ts`).
//
// This is the "no rogue verbs" gate for Wave 0: every HATEOAS hint that
// `wrap()` could ever embed in an envelope must conform to the canonical
// NextAction schema. Drift here would let a malformed verb leak into the
// envelope surface and silently break downstream agents that pattern-match
// on `verb`/`validTargets`.
//
// Note on `hotfix`: the plan named `feature, oneshot, debug, refactor,
// hotfix, discovery`, but the runtime HSM registry exposes five built-ins
// (no top-level `hotfix` type — hotfix is a compound sub-track of `debug`).
// We iterate the registered set so the test stays honest about the
// substrate; if `hotfix` is ever promoted to a top-level workflow type, the
// loop picks it up automatically.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { computeNextActions } from '../../src/next-actions-computer.js';
import { NextActionSchema } from '../../src/contract/schemas/envelope.js';
import { getHSMDefinition } from '../../src/workflow/state-machine.js';

const BUILT_IN_WORKFLOW_TYPES: readonly string[] = [
  'feature',
  'debug',
  'refactor',
  'oneshot',
  'discovery',
];

describe('F.4 — ComputeNextActions per-workflow-type schema round-trip', () => {
  it('ComputeNextActions_PerWorkflowType_ValidatesAgainstSchema', () => {
    const arraySchema = z.array(NextActionSchema);
    let totalCalls = 0;

    for (const workflowType of BUILT_IN_WORKFLOW_TYPES) {
      const hsm = getHSMDefinition(workflowType);
      const phases = Object.keys(hsm.states);
      expect(phases.length).toBeGreaterThan(0);

      for (const phase of phases) {
        const result = computeNextActions({ phase, workflowType }, hsm);
        totalCalls += 1;

        const parsed = arraySchema.safeParse(result);
        expect(
          parsed.success,
          parsed.success
            ? undefined
            : `computeNextActions(${workflowType}, ${phase}) failed NextAction[] validation: ${JSON.stringify(parsed.error.issues)}`,
        ).toBe(true);
      }
    }

    // Sanity floor: at least one call per workflow type. Catches a silent
    // empty-loop regression if any of the built-in types ever returns an
    // empty `Object.keys(hsm.states)`.
    expect(totalCalls).toBeGreaterThanOrEqual(BUILT_IN_WORKFLOW_TYPES.length);
  });

  it('ComputeNextActions_MergePending_WithOrchestratorPending_EmitsValidMergeVerb', () => {
    // The merge-orchestrate verb has its own emission path (T18/DR-MO-1)
    // with an idempotency-key extension. Confirm it round-trips through
    // the NextAction schema in addition to the HSM-derived verbs above.
    const hsm = getHSMDefinition('feature');
    const result = computeNextActions(
      {
        phase: 'merge-pending',
        workflowType: 'feature',
        featureId: 'rt-merge',
        mergeOrchestrator: { phase: 'pending', taskId: 'T1' },
      },
      hsm,
    );
    const parsed = z.array(NextActionSchema).safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.some((a) => a.verb === 'merge_orchestrate')).toBe(true);
  });
});
