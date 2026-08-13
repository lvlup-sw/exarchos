// ─── T3.2 — MERGE_ORCHESTRATION runbook outcome (GREEN) ───────────────────
//
// Encodes the #1363 fix shipped in commit c0a59a7e (PR #1391). The contract
// being locked: `exarchos_orchestrate.runbook({phase: 'merge-pending'})`
// returns the populated `merge-orchestration` runbook summary, where
// previously the registry had no entry for the `merge-pending` phase and
// the call returned `[]`.
//
// The runbook's canonical step sequence is (1) preflight dryRun → (2) real
// merge → (3) HSM transition back to delegate. It auto-emits four events
// covering the merge lifecycle: `merge.preflight`, `merge.executed`,
// `merge.rollback`, and `workflow.transition`. List mode (no `id`)
// returns the summary view shape `{id, phase, description, stepCount}`.
//
// Backfill — fix is already on head. A future regression that removes the
// runbook or drops its auto-emits fails CI.

import { describe, it, expect } from 'vitest';

import { handleRunbook } from '../../src/runbooks/handler.js';

interface RunbookSummary {
  readonly id: string;
  readonly phase: string;
  readonly description: string;
  readonly stepCount: number;
}

describe('MERGE_ORCHESTRATION runbook outcome (#1363)', () => {
  it('Runbook_MergePendingPhase_ReturnsCanonicalFourEventSequence', async () => {
    // ─── List mode summary ──────────────────────────────────────────────
    const listResult = await handleRunbook({ phase: 'merge-pending' });
    expect(listResult.success).toBe(true);

    const summaries = listResult.data as readonly RunbookSummary[];
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBeGreaterThan(0);

    const mergeOrch = summaries.find((r) => r.id === 'merge-orchestration');
    expect(mergeOrch).toBeDefined();
    expect(mergeOrch!.phase).toBe('merge-pending');
    expect(typeof mergeOrch!.description).toBe('string');
    expect(mergeOrch!.description.length).toBeGreaterThan(0);
    expect(mergeOrch!.stepCount).toBe(3);

    // ─── Detail mode — canonical step + auto-emit sequence ──────────────
    //
    // The four-event canonical sequence covers the full merge lifecycle.
    // Order on `autoEmits` is the declared emission order: preflight
    // fires first (dryRun), then `merge.executed` after the real merge
    // succeeds OR `merge.rollback` after it fails, then
    // `workflow.transition` regardless of outcome.
    const detailResult = await handleRunbook({ id: 'merge-orchestration' });
    expect(detailResult.success).toBe(true);

    const detail = detailResult.data as {
      readonly id: string;
      readonly phase: string;
      readonly autoEmits: readonly string[];
      readonly steps: ReadonlyArray<{
        readonly seq: number;
        readonly tool: string;
        readonly action: string;
      }>;
    };
    expect(detail.id).toBe('merge-orchestration');
    expect(detail.phase).toBe('merge-pending');

    // Auto-emits must cover EXACTLY the four lifecycle events — no extras.
    // The runbook registry at `runbooks/definitions.ts` is the canonical
    // source. arrayContaining alone would permit silent growth of the list
    // (a real risk if a future change wires in additional emit events without
    // updating this matrix); pin the count explicitly to catch that drift.
    expect(detail.autoEmits).toHaveLength(4);
    expect(detail.autoEmits).toEqual(
      expect.arrayContaining([
        'merge.preflight',
        'merge.executed',
        'merge.recovered',
        'workflow.transition',
      ]),
    );

    // Step shape: preflight (orchestrate) → real merge (orchestrate) →
    // HSM transition (workflow). Each step carries `seq` for operator
    // traceability.
    expect(detail.steps).toHaveLength(3);
    expect(detail.steps[0].tool).toBe('exarchos_orchestrate');
    expect(detail.steps[0].action).toBe('merge_orchestrate');
    expect(detail.steps[1].tool).toBe('exarchos_orchestrate');
    expect(detail.steps[1].action).toBe('merge_orchestrate');
    expect(detail.steps[2].tool).toBe('exarchos_workflow');
    expect(detail.steps[2].action).toBe('transition');
  });

  it('Runbook_OtherPhases_StillPopulated', async () => {
    // Quick regression guard: other phases the registry serves must remain
    // populated. If a refactor accidentally narrows the runbook registry
    // to merge-pending only (or drops a phase), this catches it.
    const phasesToCheck = ['delegate', 'review', 'synthesize'] as const;
    for (const phase of phasesToCheck) {
      const result = await handleRunbook({ phase });
      expect(result.success).toBe(true);
      const summaries = result.data as readonly RunbookSummary[];
      expect(Array.isArray(summaries)).toBe(true);
      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) {
        expect(summary.phase).toBe(phase);
      }
    }
  });
});
