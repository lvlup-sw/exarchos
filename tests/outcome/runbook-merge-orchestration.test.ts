/**
 * Outcome tests for the `merge-orchestration` runbook, read through `handleRunbook`.
 *
 * A list call with `phase: 'merge-pending'` returns the runbook summary (`id`, `phase`,
 * `description`, `stepCount`). A detail call returns three steps: a dry-run preflight, the real
 * merge, and the transition back to `delegate`. The runbook auto-emits four events:
 * `merge.preflight`, `merge.executed`, `merge.recovered` and `workflow.transition`.
 */

import { describe, it, expect } from 'vitest';

import { handleRunbook } from '../../src/runbooks/handler.js';

interface RunbookSummary {
  readonly id: string;
  readonly phase: string;
  readonly description: string;
  readonly stepCount: number;
}

describe('MERGE_ORCHESTRATION runbook outcome (#1363)', () => {
  /**
   * `autoEmits` must hold exactly the four lifecycle events. `arrayContaining` alone accepts a
   * longer list, so the test also asserts the length.
   */
  it('Runbook_MergePendingPhase_ReturnsCanonicalFourEventSequence', async () => {
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

    expect(detail.autoEmits).toHaveLength(4);
    expect(detail.autoEmits).toEqual(
      expect.arrayContaining([
        'merge.preflight',
        'merge.executed',
        'merge.recovered',
        'workflow.transition',
      ]),
    );

    expect(detail.steps).toHaveLength(3);
    const [preflight, realMerge, transition] = detail.steps;
    expect(preflight?.tool).toBe('exarchos_orchestrate');
    expect(preflight?.action).toBe('merge_orchestrate');
    expect(realMerge?.tool).toBe('exarchos_orchestrate');
    expect(realMerge?.action).toBe('merge_orchestrate');
    expect(transition?.tool).toBe('exarchos_workflow');
    expect(transition?.action).toBe('transition');
  });

  /**
   * A registry change must not leave the `delegate`, `review` or `synthesize` phase with no
   * runbook.
   */
  it('Runbook_OtherPhases_StillPopulated', async () => {
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
