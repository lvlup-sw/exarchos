// The `computeNextActions` round-trip.
//
// For each built-in workflow type, the test calls `computeNextActions` for each phase of the HSM
// definition. Each result must parse as a `NextAction[]` with the schema that
// `src/contract/schemas/envelope.ts` exports. An envelope carries these hints, and agents match on
// `verb` and `validTargets`.
//
// `BUILT_IN_WORKFLOW_TYPES` is a copy of the five built-in types of the HSM registry, so a new
// built-in type needs a new entry. `hotfix` is a track of `debug`, not a top-level type.

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

    expect(totalCalls).toBeGreaterThanOrEqual(BUILT_IN_WORKFLOW_TYPES.length);
  });

  /**
   * The harness lands the task branch, so `merge-pending` adds no `merge_orchestrate` verb. Its only
   * action is the HSM return to `delegate`, and it must parse with the `NextAction` schema.
   */
  it('ComputeNextActions_MergePending_WithOrchestratorPending_EmitsOnlyTheDelegateReturn', () => {
    const hsm = getHSMDefinition('feature');
    const result = computeNextActions(
      {
        phase: 'merge-pending',
        workflowType: 'feature',
        mergeOrchestrator: { phase: 'pending', taskId: 'T1' },
      },
      hsm,
    );
    const parsed = z.array(NextActionSchema).safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.map((a) => a.verb)).toEqual(['delegate']);
  });
});
