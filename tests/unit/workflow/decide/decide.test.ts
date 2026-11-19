/**
 * These tests compare the pure decide over a definition with the legacy executor.
 * The legacy verdict of a corpus fixture is the result of `executeTransition` over the derived machine of its type.
 * The decide differs from it only on the six known legacy defects, and only toward deny.
 *
 * @oracle-sources: ../../../../src/workflow/state-machine.ts, ../__fixtures__/transition-admission-corpus.ts
 */
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
  kernelOf,
  type BuiltInWorkflowType,
} from '../../../../src/workflow/definitions/built-in.js';
import type { ExarchosDefinition } from '../../../../src/workflow/definitions/extension.js';
import { compileDecideDefinition, type DecideDefinition } from '../../../../src/workflow/decide/edges.js';
import { decide, validTargetsOf, type DecideOutcome } from '../../../../src/workflow/decide/decide.js';
import { pinnedExtensionOf } from '../../../../src/workflow/decide/pinned.js';
import { applyPhaseSkips } from '../../../../src/workflow/phase-skip.js';
import {
  executeTransition,
  getHSMDefinition,
  getValidTransitions,
} from '../../../../src/workflow/state-machine.js';
import {
  transitionAdmissionCorpus,
  type LegacyTransitionFixture,
} from '../__fixtures__/transition-admission-corpus.js';

/** The six fixtures where the legacy path admits a fail-shaped state and the edge conditions deny it. */
const THE_SIX: readonly string[] = [
  'bypass-always-pass-implementation-ignores-fail-shaped-state',
  'bypass-empty-task-collection-is-complete',
  'debug-debug-implement-to-debug-validate-fail',
  'debug-hotfix-implement-to-hotfix-validate-fail',
  'debug-investigate-to-cancelled-fail',
  'refactor-polish-implement-to-polish-validate-fail',
];

/** The three fixtures that the admission engine denies on evidence, and that the legacy guard allows. */
const THE_EVIDENCE_FIXTURES: readonly string[] = [
  'bypass-patched-plan-approval-is-authoritative',
  'bypass-patched-review-status-is-authoritative',
  'bypass-stale-gate-event-is-not-consulted',
];

/** Returns the compiled definition of a built-in type, with no skip. */
function defOf(type: BuiltInWorkflowType): DecideDefinition {
  return compileDecideDefinition(type, builtInDefinition(type));
}

/** Returns the guard input of a corpus fixture: its state at its source phase. */
function inputOf(fixture: LegacyTransitionFixture): Record<string, unknown> {
  return { ...fixture.state, phase: fixture.from };
}

/** True when the legacy executor admits the fixture. The gate resolver gives no gate, as the golden renderer does. */
function legacyAllows(fixture: LegacyTransitionFixture): boolean {
  return executeTransition(getHSMDefinition(fixture.workflowType), inputOf(fixture), fixture.to, () => []).success;
}

/** True when the decide admits the transition request of the fixture. */
function decideAllows(fixture: LegacyTransitionFixture): boolean {
  return decide(defOf(fixture.workflowType), inputOf(fixture), { kind: 'transition', target: fixture.to }).kind === 'admit';
}

/** Returns the transition id of an admitted move, or the edge kind of a universal move. Another outcome gives its kind. */
function moveOf(outcome: DecideOutcome): string {
  if (outcome.kind !== 'admit') return outcome.kind;
  return outcome.move.edgeKind === 'explicit' ? outcome.move.transitionId : outcome.move.edgeKind;
}

/** Returns the non-final steps of a built-in type, in kernel order. */
function nonFinalSteps(type: BuiltInWorkflowType): readonly string[] {
  return builtInDefinition(type)
    .steps.filter((step) => !step.isTerminal)
    .map((step) => step.stepId);
}

/** Returns a copy of the discovery definition whose first edge routes on a string fact that can be absent. */
function discoveryWithAbsentRoute(): ExarchosDefinition {
  const definition = builtInDefinition('discovery');
  const edge = definition.exarchos.edges['gathering->synthesizing'];
  if (edge === undefined) throw new Error('the discovery definition has no gathering edge');
  return {
    ...definition,
    exarchos: {
      ...definition.exarchos,
      edges: {
        ...definition.exarchos.edges,
        'gathering->synthesizing': {
          ...edge,
          route: { kind: 'factEquals', field: 'triage.symptom', value: 'seen' },
        },
      },
    },
  };
}

/** The comparable form of one edge after a skip. */
interface SkippedEdge {
  readonly from: string;
  readonly to: string;
  readonly guardId: string | undefined;
  readonly isFixCycle: boolean;
  readonly isRevision: boolean;
  readonly effects: readonly string[];
}

/** The result of one side of a skip: the edges, or the fact that the side threw. */
type SkipSide = { readonly threw: true } | { readonly threw: false; readonly edges: readonly SkippedEdge[] };

/** Runs one side of a skip, and records a throw as a result. */
function skipSide(run: () => readonly SkippedEdge[]): SkipSide {
  try {
    return { threw: false, edges: run() };
  } catch {
    return { threw: true };
  }
}

describe('the pure decide over a definition', () => {
  it('Decide_FrozenCorpus_DiffersFromLegacyOnlyOnTheSixAndOnlyToDeny', () => {
    const differing = transitionAdmissionCorpus.filter((fixture) => legacyAllows(fixture) !== decideAllows(fixture));
    expect(transitionAdmissionCorpus).toHaveLength(131);
    expect(differing.map((fixture) => fixture.id).sort()).toEqual(THE_SIX);
    expect(differing.map((fixture) => [legacyAllows(fixture), decideAllows(fixture)])).toEqual(
      THE_SIX.map(() => [true, false]),
    );
  });

  it('Decide_TheThreeEvidenceFixtures_Allow', () => {
    const fixtures = transitionAdmissionCorpus.filter((fixture) => THE_EVIDENCE_FIXTURES.includes(fixture.id));
    expect(fixtures.map((fixture) => fixture.id).sort()).toEqual(THE_EVIDENCE_FIXTURES);
    expect(fixtures.map((fixture) => [decideAllows(fixture), legacyAllows(fixture)])).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ]);
  });

  it('Decide_Settle_OneTwoAndZeroAdmittedEdges', () => {
    const def = defOf('feature');
    const one = decide(def, { phase: 'plan-review', planReview: { approved: true } }, { kind: 'settle' });
    const two = decide(def, { phase: 'plan-review', planReview: { approved: true, gapsFound: true } }, { kind: 'settle' });
    const zero = decide(def, { phase: 'plan-review' }, { kind: 'settle' });
    const verdictsOf = (outcome: DecideOutcome): readonly string[] =>
      outcome.kind === 'admit' || outcome.kind === 'stay'
        ? outcome.verdicts.map((verdict) => `${verdict.transitionId} ${verdict.verdict}`)
        : [outcome.kind];
    expect([moveOf(one), two.kind, zero.kind]).toEqual(['plan-review->delegate', 'stay', 'stay']);
    expect(verdictsOf(two)).toEqual([
      'plan-review->delegate allow',
      'plan-review->blocked deny',
      'plan-review->plan allow',
    ]);
    expect(verdictsOf(zero)).toEqual([
      'plan-review->delegate deny',
      'plan-review->blocked deny',
      'plan-review->plan deny',
    ]);
  });

  it('Decide_Transition_CancelledFromInvestigate_DeniesWithoutEscalation', () => {
    const def = defOf('debug');
    const denied = decide(def, { phase: 'investigate' }, { kind: 'transition', target: 'cancelled' });
    const admitted = decide(
      def,
      { phase: 'investigate', investigation: { escalate: true } },
      { kind: 'transition', target: 'cancelled' },
    );
    expect(denied).toMatchObject({
      kind: 'deny',
      from: 'investigate',
      edge: { transitionId: 'investigate->cancelled' },
      verdict: { verdict: 'deny', falseFacts: ['investigation.escalate'] },
      expectedShape: { investigation: { escalate: true } },
    });
    expect(moveOf(admitted)).toBe('investigate->cancelled');
  });

  it('Decide_Cancel_AdmitsFromEachNonFinalStep', () => {
    const moves = BUILT_IN_WORKFLOW_TYPES.flatMap((type) =>
      nonFinalSteps(type).map((stepId) => {
        const outcome = decide(defOf(type), { phase: stepId }, { kind: 'cancel' });
        return `${type} ${stepId} ${moveOf(outcome)} ${outcome.kind === 'admit' ? outcome.move.to : ''}`;
      }),
    );
    expect(moves).toHaveLength(35);
    expect(moves.filter((move) => !move.endsWith(' cancel cancelled'))).toEqual([]);
  });

  it('Decide_Cleanup_FalseMergeVerified_FallsToTheExplicitEdge', () => {
    const def = defOf('feature');
    const withPr = decide(
      def,
      { phase: 'synthesize', synthesis: { prUrl: 'https://example.test/pr/1' }, _cleanup: { mergeVerified: false } },
      { kind: 'cleanup' },
    );
    const withoutPr = decide(def, { phase: 'synthesize' }, { kind: 'cleanup' });
    const noEdge = decide(def, { phase: 'plan' }, { kind: 'cleanup' });
    expect(moveOf(withPr)).toBe('synthesize->completed');
    expect(withoutPr).toMatchObject({ kind: 'deny', edge: { transitionId: 'synthesize->completed' } });
    expect(noEdge).toEqual({ kind: 'no-edge', from: 'plan', validTargets: ['plan-review', 'cancelled', 'completed'] });
  });

  it('Decide_Transition_ToCompletedWithMergeVerified_AdmitsTheCleanupMove', () => {
    const def = defOf('oneshot');
    const verified = decide(
      def,
      { phase: 'synthesize', _cleanup: { mergeVerified: true } },
      { kind: 'transition', target: 'completed' },
    );
    const unverified = decide(def, { phase: 'synthesize' }, { kind: 'transition', target: 'completed' });
    expect(verified).toMatchObject({ kind: 'admit', from: 'synthesize', move: { edgeKind: 'cleanup', to: 'completed' } });
    expect(unverified).toMatchObject({ kind: 'deny', edge: { transitionId: 'synthesize->completed' } });
  });

  it('Decide_AFinalSourceStep_GivesIdempotentOrNoEdge', () => {
    const def = defOf('feature');
    expect([
      decide(def, { phase: 'cancelled' }, { kind: 'cancel' }),
      decide(def, { phase: 'completed' }, { kind: 'cancel' }),
      decide(def, { phase: 'completed' }, { kind: 'cleanup' }),
      decide(def, { phase: 'cancelled', _cleanup: { mergeVerified: true } }, { kind: 'cleanup' }),
    ]).toEqual([
      { kind: 'idempotent', phase: 'cancelled' },
      { kind: 'no-edge', from: 'completed', validTargets: [] },
      { kind: 'idempotent', phase: 'completed' },
      { kind: 'no-edge', from: 'cancelled', validTargets: [] },
    ]);
  });

  it('Decide_AnIndeterminateCondition_FailsClosed', () => {
    const def = compileDecideDefinition('discovery', discoveryWithAbsentRoute());
    const input = { phase: 'gathering', artifacts: { sources: ['notes.md'] } };
    const transition = decide(def, input, { kind: 'transition', target: 'synthesizing' });
    const settle = decide(def, input, { kind: 'settle' });
    const known = decide(def, { ...input, triage: { symptom: 'seen' } }, { kind: 'transition', target: 'synthesizing' });
    expect(transition).toMatchObject({
      kind: 'deny',
      verdict: { verdict: 'indeterminate', falseFacts: ['triage.symptom'] },
    });
    expect(settle).toMatchObject({
      kind: 'stay',
      verdicts: [{ transitionId: 'gathering->synthesizing', verdict: 'indeterminate' }],
    });
    expect(moveOf(known)).toBe('gathering->synthesizing');
  });

  it('Decide_ADenial_NestsEachFalseFactInTheExpectedShape', () => {
    const implementation = decide(
      defOf('debug'),
      { phase: 'debug-implement', implementation: { complete: false } },
      { kind: 'transition', target: 'debug-validate' },
    );
    const emptyTasks = decide(
      defOf('feature'),
      { phase: 'delegate', tasks: [], _events: [] },
      { kind: 'transition', target: 'review' },
    );
    expect(implementation).toMatchObject({
      kind: 'deny',
      verdict: { falseFacts: ['implementation.complete'] },
      expectedShape: { implementation: { complete: true } },
    });
    expect(emptyTasks).toMatchObject({
      kind: 'deny',
      verdict: { falseFacts: ['tasks.count', 'tasks.allComplete'] },
    });
    expect(emptyTasks.kind === 'deny' ? emptyTasks.expectedShape : undefined).toEqual({});
  });

  it('Decide_AnUnknownSourcePhase_FollowsTheRuleOfEachRequestKind', () => {
    const def = defOf('feature');
    expect([
      moveOf(decide(def, { phase: 'ideate' }, { kind: 'cancel' })),
      moveOf(decide(def, { phase: 'ideate', _cleanup: { mergeVerified: true } }, { kind: 'cleanup' })),
      decide(def, { phase: 'ideate' }, { kind: 'cleanup' }),
      decide(def, { phase: 'ideate', planReview: { approved: true } }, { kind: 'transition', target: 'plan' }),
    ]).toEqual([
      'cancel',
      'cleanup',
      { kind: 'no-edge', from: 'ideate', validTargets: [] },
      { kind: 'no-edge', from: 'ideate', validTargets: [] },
    ]);
  });

  it('Decide_ATargetEqualToTheSource_IsIdempotent', () => {
    expect([
      decide(defOf('feature'), { phase: 'delegate' }, { kind: 'transition', target: 'delegate' }),
      decide(defOf('debug'), { phase: 'completed' }, { kind: 'transition', target: 'completed' }),
    ]).toEqual([
      { kind: 'idempotent', phase: 'delegate' },
      { kind: 'idempotent', phase: 'completed' },
    ]);
  });

  it('ValidTargetsOf_EachStepOfEachBuiltIn_EqualsGetValidTransitions', () => {
    const rows = BUILT_IN_WORKFLOW_TYPES.flatMap((type) =>
      builtInDefinition(type).steps.map((step) => ({
        step: `${type} ${step.stepId}`,
        decide: validTargetsOf(defOf(type), step.stepId),
        legacy: getValidTransitions(getHSMDefinition(type), step.stepId).map((target) => target.phase),
      })),
    );
    expect(rows).toHaveLength(45);
    expect(rows.map((row) => ({ step: row.step, targets: row.decide }))).toEqual(
      rows.map((row) => ({ step: row.step, targets: row.legacy })),
    );
  });

  it('CompileDecideDefinition_SkipPhases_EqualApplyPhaseSkipsOnEachBuiltIn', () => {
    const rows = BUILT_IN_WORKFLOW_TYPES.flatMap((type) => {
      const definition = builtInDefinition(type);
      return nonFinalSteps(type)
        .filter((stepId) => stepId !== definition.entryStepId)
        .map((stepId) => ({
          skip: `${type} ${stepId}`,
          decide: skipSide(() =>
            compileDecideDefinition(type, definition, [stepId]).edges.map((edge) => ({
              from: edge.from,
              to: edge.to,
              guardId: edge.guardId,
              isFixCycle: edge.isFixCycle === true,
              isRevision: edge.isRevision === true,
              effects: edge.effects ?? [],
            })),
          ),
          legacy: skipSide(() =>
            applyPhaseSkips(getHSMDefinition(type), [stepId]).transitions.map((transition) => ({
              from: transition.from,
              to: transition.to,
              guardId: transition.guard?.id,
              isFixCycle: transition.isFixCycle === true,
              isRevision: transition.isRevision === true,
              effects: transition.effects ?? [],
            })),
          ),
        }));
    });
    expect(rows).toHaveLength(30);
    expect(rows.filter((row) => row.legacy.threw).map((row) => row.skip)).toEqual(['debug blocked']);
    expect(rows.map((row) => ({ skip: row.skip, side: row.decide }))).toEqual(
      rows.map((row) => ({ skip: row.skip, side: row.legacy })),
    );
  });

  /**
   * A skip routes each incoming edge of the skipped step to each outgoing target. The new edge takes the route and the
   * presence probe of the outgoing edge with no skip. It does not take those of the incoming edge.
   * A feature at `plan` with a skip of `plan-review` and no exhausted revisions does not reach `blocked`.
   */
  it('CompileDecideDefinition_SkipPhases_ARerouteTakesTheOutgoingRoute', () => {
    const rerouted = BUILT_IN_WORKFLOW_TYPES.flatMap((type) => {
      const definition = builtInDefinition(type);
      const unskipped = defOf(type);
      return nonFinalSteps(type)
        .filter((stepId) => stepId !== definition.entryStepId && !(type === 'debug' && stepId === 'blocked'))
        .flatMap((stepId) =>
          compileDecideDefinition(type, definition, [stepId])
            .edges.filter((edge) => !unskipped.edges.some((kept) => kept.transitionId === edge.transitionId && kept.from === edge.from && kept.to === edge.to))
            .map((edge) => {
              const outgoing = unskipped.edges.filter((candidate) => candidate.from === stepId && candidate.to === edge.to);
              const incoming = unskipped.edges.filter((candidate) => candidate.to === stepId && candidate.from === edge.from);
              return {
                reroute: `${type} skip ${stepId} ${edge.transitionId}`,
                outgoingCount: outgoing.length,
                incomingRouteDiffers: incoming.some((candidate) => JSON.stringify(candidate.route.node) !== JSON.stringify(edge.route.node)),
                decide: { route: edge.route.node, presence: edge.presence?.node },
                outgoing: { route: outgoing[0]?.route.node, presence: outgoing[0]?.presence?.node },
              };
            }),
        );
    });
    const blocked = decide(
      compileDecideDefinition('feature', builtInDefinition('feature'), ['plan-review']),
      { phase: 'plan', artifacts: { plan: 'plans/plan.md' } },
      { kind: 'transition', target: 'blocked' },
    );

    expect(rerouted).toHaveLength(58);
    expect(rerouted.filter((row) => row.outgoingCount !== 1)).toEqual([]);
    expect(rerouted.filter((row) => row.incomingRouteDiffers)).toHaveLength(31);
    expect(rerouted.map((row) => ({ reroute: row.reroute, nodes: row.decide }))).toEqual(
      rerouted.map((row) => ({ reroute: row.reroute, nodes: row.outgoing })),
    );
    expect(blocked).toMatchObject({
      kind: 'deny',
      from: 'plan',
      edge: { transitionId: 'plan->blocked' },
      verdict: { falseFacts: ['planReview.revisionsExhausted'] },
    });
  });

  it('PinnedExtensionOf_AKernelOnlyDefinition_GivesNone', () => {
    expect(pinnedExtensionOf(kernelOf(builtInDefinition('feature')))).toBeUndefined();
  });

  it('PinnedExtensionOf_ABuiltInDefinition_GivesItsExtension', () => {
    const definition = builtInDefinition('feature');
    expect(pinnedExtensionOf(definition)).toEqual(definition.exarchos);
  });
});
