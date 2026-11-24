/**
 * Outcome tests for the `merge-orchestration` runbook, read through `handleRunbook`.
 *
 * A list call with `phase: 'merge-pending'` returns the runbook summary (`id`, `phase`,
 * `description`, `stepCount`). A detail call returns four steps. The harness checks the ancestry and
 * lands the head. Then one `merge.executed` row is appended, and the workflow moves back to `delegate`.
 * Only the transition auto-emits, with `workflow.transition`.
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
   * The coordinator records the harness landing through an `exarchos_event` append, so `autoEmits`
   * holds only `workflow.transition`, and no step names the retired `merge_orchestrate`.
   */
  it('Runbook_MergePendingPhase_ReturnsHarnessLandingSequence', async () => {
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
    expect(mergeOrch!.stepCount).toBe(4);

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

    expect(detail.autoEmits).toEqual(['workflow.transition']);

    expect(detail.steps.map((step) => `${step.tool}.${step.action}`)).toEqual([
      'native:bash.git_is_ancestor',
      'native:bash.git_merge',
      'exarchos_event.append',
      'exarchos_workflow.transition',
    ]);
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
