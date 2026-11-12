/**
 * These tests check the comparator of the two guard inputs of one transition.
 * `compareGuardInputs` compares the phase, the facts, the config keys and two keys of each task.
 * It also gives the decide verdict of each edge out of the document phase on both inputs, and it gives each difference a class.
 * Each case writes its two inputs and its expected differences, verdicts and classes as literals.
 * The first case counts the transitions out of the phase in the built-in definition of the type.
 *
 * @oracle-sources: ../../../../src/workflow/definitions/feature.workflow.json, the inputs and expected classes written in this file
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkflowDefinition } from '../../../../src/config/define.js';
import {
  compareGuardInputs,
  type DisagreementClass,
  type GuardInputComparison,
} from '../../../../src/projections/guard-input/compare.js';
import { projectStateToFacts } from '../../../../src/workflow/admission/legacy-state-translation.js';
import { builtInDefinition } from '../../../../src/workflow/definitions/built-in.js';
import {
  getHSMDefinition,
  isBuiltInWorkflowType,
  registerWorkflowType,
  unregisterWorkflowType,
} from '../../../../src/workflow/state-machine.js';

/** The feature id of the inputs of this file. */
const FEATURE_ID = 'guard-compare';

/** The name of the custom type that one case registers and the teardown removes. */
const CUSTOM_TYPE = 'guard-input-compare-custom';

/** A custom type with two phases and one transition. */
const CUSTOM_DEFINITION: WorkflowDefinition = {
  phases: ['start', 'end'],
  initialPhase: 'start',
  transitions: [{ from: 'start', to: 'end', event: 'go' }],
};

/** Returns a feature input at `phase` with no task and no event. The fields replace the defaults. */
function featureInput(phase: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { featureId: FEATURE_ID, workflowType: 'feature', phase, tasks: [], _events: [], ...fields };
}

/** Returns one task with the fields that the task schema requires. */
function task(id: string, status: string): Record<string, unknown> {
  return { id, title: `the task ${id}`, status };
}

/** Defines a getter on `input` that throws when a reader reads `key`. */
function throwOnRead(input: Record<string, unknown>, key: string): void {
  Object.defineProperty(input, key, {
    enumerable: true,
    configurable: true,
    get: (): never => {
      throw new Error(`the ${key} getter throws`);
    },
  });
}

/** Returns the comparison of the two inputs, and fails the case when the comparator gives none. */
function compared(
  document: Record<string, unknown>,
  fold: Record<string, unknown>,
  options?: { readonly skipPhases?: readonly string[] },
): GuardInputComparison {
  const comparison = compareGuardInputs(document, fold, options);
  if (comparison === undefined) throw new Error('the comparator gave no comparison');
  return comparison;
}

/** Returns the key of each difference, in order. */
function keysOf(comparison: GuardInputComparison): readonly string[] {
  return comparison.differences.map((difference) => difference.key);
}

/** Returns the transition id and the target of each edge of a comparison, in order. */
function edgeTargets(comparison: GuardInputComparison): readonly (readonly [string, string])[] {
  return comparison.edges.map((edge) => [edge.transitionId, edge.to]);
}

describe('the comparator of the two guard inputs', () => {
  afterEach(() => {
    unregisterWorkflowType(CUSTOM_TYPE);
  });

  /** Equal inputs agree. At feature `delegate`, the list holds each transition out of the phase and the universal cleanup move. */
  it('CompareGuardInputs_EqualInputs_AgreeAndListEachGuardOutOfThePhase', () => {
    const build = (): Record<string, unknown> =>
      featureInput('delegate', { tasks: [task('t1', 'complete')], riskTier: 'medium', _requiredReviews: ['review'] });
    const outEdges = builtInDefinition('feature').transitions.filter((transition) => transition.fromStepId === 'delegate');

    const comparison = compared(build(), build());

    expect(outEdges).toHaveLength(2);
    expect(comparison.edges).toHaveLength(outEdges.length + 1);
    expect(comparison.edges).toEqual([
      { transitionId: 'delegate->review', to: 'review', document: 'allow', fold: 'allow' },
      { transitionId: 'delegate->merge-pending', to: 'merge-pending', document: 'deny', fold: 'deny' },
      { transitionId: 'cleanup', to: 'completed', document: 'deny', fold: 'deny' },
    ]);
    expect(comparison.workflowType).toBe('feature');
    expect(comparison.phase).toEqual({ document: 'delegate', fold: 'delegate' });
    expect(comparison.differences).toEqual([]);
    expect(comparison.classes).toEqual([]);
    expect(comparison.agrees).toBe(true);
  });

  /** A task that is complete in the document and pending in the fold gives `task-status`. */
  it('CompareGuardInputs_AForgedTaskStatus_IsTaskStatus', () => {
    const document = featureInput('delegate', { tasks: [task('t1', 'complete')] });
    const fold = featureInput('delegate', { tasks: [task('t1', 'pending')] });

    const comparison = compared(document, fold);

    expect(comparison.differences).toEqual([
      { key: 'tasks.allComplete', document: true, fold: false },
      { key: 'tasks[t1].complete', document: true, fold: false },
    ]);
    expect(comparison.edges[0]).toEqual({
      transitionId: 'delegate->review',
      to: 'review',
      document: 'allow',
      fold: 'deny',
    });
    expect(comparison.classes).toEqual(['task-status']);
    expect(comparison.agrees).toBe(false);
  });

  /** One task of two is complete in the document only. The summary facts are equal, and the task key still shows the difference. */
  it('CompareGuardInputs_OneForgedTaskWithEqualSummaries_IsTaskStatus', () => {
    const document = featureInput('delegate', { tasks: [task('t1', 'complete'), task('t2', 'pending')] });
    const fold = featureInput('delegate', { tasks: [task('t1', 'pending'), task('t2', 'pending')] });
    const expectedClasses: readonly DisagreementClass[] = ['task-status'];

    const comparison = compared(document, fold);

    for (const side of [document, fold]) {
      expect(projectStateToFacts(side).fields['tasks.allComplete']).toBe(false);
      expect(projectStateToFacts(side).fields['tasks.count']).toBe(2);
    }
    expect(comparison.differences).toEqual([{ key: 'tasks[t1].complete', document: true, fold: false }]);
    expect(comparison.classes).toEqual(expectedClasses);
    expect(comparison.agrees).toBe(false);
  });

  /** Two different lists of task ids give `task-list`, with no summary difference and with a difference in `tasks.count`. */
  it('CompareGuardInputs_DifferentTaskIds_IsTaskList', () => {
    const document = featureInput('delegate', { tasks: [task('t1', 'pending'), task('t2', 'pending')] });
    const fold = featureInput('delegate', { tasks: [task('t1', 'pending'), task('t3', 'pending')] });
    const shorterFold = featureInput('delegate', { tasks: [task('t1', 'pending')] });

    const comparison = compared(document, fold);
    const withACountDifference = compared(document, shorterFold);

    expect(comparison.differences).toEqual([
      { key: 'tasks[t2].complete', document: false, fold: undefined },
      { key: 'tasks[t2].failed', document: false, fold: undefined },
      { key: 'tasks[t3].complete', document: undefined, fold: false },
      { key: 'tasks[t3].failed', document: undefined, fold: false },
    ]);
    expect(comparison.classes).toEqual(['task-list']);
    expect(comparison.agrees).toBe(false);
    expect(keysOf(withACountDifference)).toEqual(['tasks.count', 'tasks[t2].complete', 'tasks[t2].failed']);
    expect(withACountDifference.classes).toEqual(['task-list']);
  });

  /** A ledger phase ahead of the document gives `phase`. The edges come from the document phase. */
  it('CompareGuardInputs_ALedgerPhaseAheadOfTheDocument_IsPhase', () => {
    const document = featureInput('plan-review');
    const fold = featureInput('delegate');

    const comparison = compared(document, fold);

    expect(comparison.phase).toEqual({ document: 'plan-review', fold: 'delegate' });
    expect(comparison.differences).toEqual([{ key: 'phase', document: 'plan-review', fold: 'delegate' }]);
    expect(edgeTargets(comparison)).toEqual([
      ['plan-review->delegate', 'delegate'],
      ['plan-review->blocked', 'blocked'],
      ['plan-review->plan', 'plan'],
      ['cleanup', 'completed'],
    ]);
    expect(comparison.classes).toEqual(['phase']);
    expect(comparison.agrees).toBe(false);
  });

  /** A risk tier only in the document and the review gates of that tier give `risk-tier`. */
  it('CompareGuardInputs_ARiskTierOnlyInTheDocument_IsRiskTier', () => {
    const document = featureInput('review', { riskTier: 'high', _requiredReviews: ['review', 'mutation-adequacy'] });
    const fold = featureInput('review', { _requiredReviews: ['review'] });

    const comparison = compared(document, fold);

    expect(comparison.differences).toEqual([
      { key: 'riskTier', document: 'high', fold: undefined },
      { key: '_requiredReviews', document: ['review', 'mutation-adequacy'], fold: ['review'] },
    ]);
    expect(comparison.classes).toEqual(['risk-tier']);
    expect(comparison.agrees).toBe(false);
  });

  /** A terminal merge phase on the fold side gives `merge-orchestrator`, on the exit fact and on the exit verdict. */
  it('CompareGuardInputs_ATerminalMergePhaseOnOneSide_IsMergeOrchestrator', () => {
    const document = featureInput('merge-pending', { mergeOrchestrator: { phase: 'executing' } });
    const fold = featureInput('merge-pending', { mergeOrchestrator: { phase: 'completed' } });

    const comparison = compared(document, fold);

    expect(comparison.differences).toEqual([{ key: 'mergePending.exitReady', document: false, fold: true }]);
    expect(comparison.edges).toEqual([
      { transitionId: 'merge-pending->delegate', to: 'delegate', document: 'deny', fold: 'allow' },
      { transitionId: 'cleanup', to: 'completed', document: 'deny', fold: 'deny' },
    ]);
    expect(comparison.classes).toEqual(['merge-orchestrator']);
    expect(comparison.agrees).toBe(false);
  });

  /** A plan artifact in the document only gives `unexplained`. A drift of the workflow type gives `unexplained` too. */
  it('CompareGuardInputs_AnotherFieldDrift_IsUnexplained', () => {
    const document = featureInput('plan', { artifacts: { plan: 'plans/plan.md' } });
    const fold = featureInput('plan');

    const comparison = compared(document, fold);
    const typeDrift = compared(featureInput('plan'), featureInput('plan', { workflowType: 'debug' }));

    expect(comparison.differences).toEqual([
      { key: 'artifacts.plan', document: 'plans/plan.md', fold: undefined },
      { key: 'artifacts.planNonEmpty', document: true, fold: false },
    ]);
    expect(comparison.edges[0]).toEqual({ transitionId: 'plan->plan-review', to: 'plan-review', document: 'allow', fold: 'deny' });
    expect(comparison.classes).toEqual(['unexplained']);
    expect(comparison.agrees).toBe(false);
    expect(typeDrift.workflowType).toBe('feature');
    expect(typeDrift.differences).toEqual([{ key: 'workflowType', document: 'feature', fold: 'debug' }]);
    expect(typeDrift.classes).toEqual(['unexplained']);
  });

  /**
   * The `featureId` getter of the document side throws, and the `artifacts` getter of the fold side throws.
   * The decide reads only the facts, so `featureId` gives no throw. Each edge on the fold side gives `throw`.
   */
  it('CompareGuardInputs_AGuardThatThrows_GivesTheVerdictThrow', () => {
    const document = featureInput('plan');
    throwOnRead(document, 'featureId');
    const fold = featureInput('plan');
    throwOnRead(fold, 'artifacts');

    expect(() => projectStateToFacts(document)).not.toThrow();
    expect(() => compareGuardInputs(document, fold)).not.toThrow();
    const comparison = compared(document, fold);

    expect(comparison.edges).toEqual([
      { transitionId: 'plan->plan-review', to: 'plan-review', document: 'deny', fold: 'throw' },
      { transitionId: 'cleanup', to: 'completed', document: 'deny', fold: 'throw' },
    ]);
    expect(comparison.differences).toEqual([{ key: 'facts', document: 'ok', fold: 'throw' }]);
    expect(comparison.classes).toEqual(['unexplained']);
    expect(comparison.agrees).toBe(false);
  });

  /**
   * The `reviews` getter of the document side throws. The facts step reads `reviews`, and the decide reads only the facts.
   * So the key `facts` differs, and each edge gives `throw` on the document side and a verdict on the fold side.
   */
  it('CompareGuardInputs_AFactsStepThatThrows_GivesTheKeyFactsAsUnexplained', () => {
    const document = featureInput('plan');
    throwOnRead(document, 'reviews');
    const fold = featureInput('plan');

    expect(() => compareGuardInputs(document, fold)).not.toThrow();
    const comparison = compared(document, fold);

    expect(() => projectStateToFacts(document)).toThrow('the reviews getter throws');
    expect(comparison.differences).toEqual([{ key: 'facts', document: 'throw', fold: 'ok' }]);
    expect(comparison.edges).toEqual([
      { transitionId: 'plan->plan-review', to: 'plan-review', document: 'throw', fold: 'deny' },
      { transitionId: 'cleanup', to: 'completed', document: 'throw', fold: 'deny' },
    ]);
    expect(comparison.classes).toEqual(['unexplained']);
    expect(comparison.agrees).toBe(false);
  });

  /** Only the fold side holds a `synthesize.requested` entry and a `workflow.started` entry. Only the declared event type gives a key. */
  it('CompareGuardInputs_ASynthesizeRequestOnOneSide_DiffersOnItsEventKey', () => {
    const document = featureInput('plan');
    const fold = featureInput('plan', {
      _events: [
        { type: 'workflow.started', timestamp: '2026-11-11T10:00:00.000Z' },
        { type: 'synthesize.requested', timestamp: '2026-11-11T10:01:00.000Z' },
      ],
    });

    const comparison = compared(document, fold);

    expect(keysOf(comparison)).not.toContain('events[workflow.started]');
    expect(comparison.differences).toEqual([{ key: 'events[synthesize.requested]', document: false, fold: true }]);
    expect(comparison.classes).toEqual(['unexplained']);
    expect(comparison.agrees).toBe(false);
  });

  /** A registered custom type has a machine, and the comparator still gives no comparison. A document with no type gives none either. */
  it('CompareGuardInputs_ACustomType_GivesNoComparison', () => {
    registerWorkflowType(CUSTOM_TYPE, CUSTOM_DEFINITION);
    const document = { featureId: FEATURE_ID, workflowType: CUSTOM_TYPE, phase: 'start' };
    const fold = { featureId: FEATURE_ID, workflowType: CUSTOM_TYPE, phase: 'end' };

    expect(getHSMDefinition(CUSTOM_TYPE).states['start']).toBeDefined();
    expect(isBuiltInWorkflowType(CUSTOM_TYPE)).toBe(false);
    expect(compareGuardInputs(document, fold)).toBeUndefined();
    expect(compareGuardInputs({ featureId: FEATURE_ID, phase: 'plan' }, featureInput('plan'))).toBeUndefined();
  });

  /** A `_cleanup` in the document only differs on `cleanup.mergeVerified` and on the verdict of the cleanup move. A final phase gives no edge. */
  it('CompareGuardInputs_ACleanupInputOnOneSide_DiffersOnMergeVerified', () => {
    const document = featureInput('synthesize', { _cleanup: { mergeVerified: true } });
    const fold = featureInput('synthesize');

    const comparison = compared(document, fold);
    const atAFinalPhase = compared(featureInput('completed'), featureInput('completed'));

    expect(comparison.differences).toEqual([{ key: 'cleanup.mergeVerified', document: true, fold: false }]);
    expect(edgeTargets(comparison)).toEqual([
      ['synthesize->delegate', 'delegate'],
      ['synthesize->completed', 'completed'],
      ['cleanup', 'completed'],
    ]);
    expect(comparison.edges[2]).toEqual({ transitionId: 'cleanup', to: 'completed', document: 'allow', fold: 'deny' });
    expect(comparison.classes).toEqual(['unexplained']);
    expect(comparison.agrees).toBe(false);
    expect(atAFinalPhase.edges).toEqual([]);
    expect(atAFinalPhase.agrees).toBe(true);
  });

  /** With `skipPhases`, the edges come from the definition with the skipped phase, as the transition handler compiles it. */
  it('CompareGuardInputs_SkipPhases_TakeTheGuardsOfTheSkippedMachine', () => {
    const document = featureInput('plan');
    const fold = featureInput('plan');

    const unskipped = compared(document, fold);
    const skipped = compared(document, fold, { skipPhases: ['plan-review'] });

    expect(edgeTargets(unskipped)).toEqual([
      ['plan->plan-review', 'plan-review'],
      ['cleanup', 'completed'],
    ]);
    expect(edgeTargets(skipped)).toEqual([
      ['plan->delegate', 'delegate'],
      ['plan->blocked', 'blocked'],
      ['plan->plan', 'plan'],
      ['cleanup', 'completed'],
    ]);
    expect(skipped.agrees).toBe(true);
  });
});
