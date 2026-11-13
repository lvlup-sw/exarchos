/**
 * The bootstrap planner reads only entries owned by the active attempt.
 * @oracle-sources: ../../../../src/workflow/definitions/feature.workflow.json, ../../../helpers/definitions/user-definition.ts, generated acyclic routes and corrupt row cases in this file
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as emission from '../../../../src/workflow/decide/emit.js';
import * as adapter from '../../../../src/workflow/decide/rows.js';
import { builtInDefinition } from '../../../../src/workflow/definitions/built-in.js';
import type { ExarchosDefinition } from '../../../../src/workflow/definitions/extension.js';
import { checkUserDefinition } from '../../../../src/workflow/definitions/user.js';
import { planBootstrapPrefix, type BootstrapPlanInput } from '../../../../src/workflow/design-record/bootstrap-plan.js';
import { INITIAL_ATTEMPT, prefixInput, seed } from '../../../helpers/capsule/bootstrap-prefix.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';

const BASE_TRANSITION = { fromStepId: 'scope', toStepId: 'build', transitionId: 'scope->build', isDefault: false };
const EMPTY_EDGE = { category: 'route-condition', obligation: { kind: 'none' } } as const;
const PLAN_GATES = ['check_task_decomposition', 'check_plan_coverage', 'spec_coverage_check',
  'check_provenance_chain', 'generate_traceability'];
type EntryKind = 'PLAN' | 'GATHER' | 'REVIEW' | 'SYNTHESIZE' | 'MERGE';

/** The authored user fixture passes the real registration rules before planning. */
function checked(raw: unknown): ExarchosDefinition {
  const result = checkUserDefinition(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.findings));
  return result.definition;
}

/** Add ordered source steps before the task batch. */
function userPrefix(kinds: readonly EntryKind[]): ExarchosDefinition {
  const base = checked(releaseCheckDefinition());
  const phases = kinds.map((_, index) => `source-${index}`);
  const sources = kinds.map((stepType, index) => ({
    kind: 'skill', stepId: phases[index]!, stepName: phases[index]!,
    isTerminal: false, runtime: 'exarchos', stepType,
  }));
  const hops = phases.map((fromStepId, index) => {
    const toStepId = phases[index + 1] ?? 'build';
    return { ...BASE_TRANSITION, fromStepId, toStepId, transitionId: `${fromStepId}->${toStepId}` };
  });
  const edges = { ...base.exarchos.edges };
  delete edges['scope->build'];
  return checked({
    ...base,
    entryStepId: phases[0] ?? 'build',
    steps: [...sources, ...base.steps.slice(1)],
    transitions: [...hops, ...base.transitions.slice(1)],
    exarchos: { ...base.exarchos, edges: {
      ...edges, ...Object.fromEntries(hops.map(({ transitionId }) => [transitionId, EMPTY_EDGE])),
    } },
  });
}

/** A registered user prefix with a second branch. */
function withAlternative(definition: ExarchosDefinition, edge: ExarchosDefinition['exarchos']['edges'][string]): ExarchosDefinition {
  return checked({
    ...definition,
    transitions: [...definition.transitions, { ...BASE_TRANSITION, fromStepId: 'source-0', toStepId: 'verify', transitionId: 'source-0->verify' }],
    exarchos: { ...definition.exarchos, edges: { ...definition.exarchos.edges, 'source-0->verify': edge } },
  });
}

/** Assert that a refusal exposes no appendable rows. */
function expectRefusal(input: BootstrapPlanInput, code = 'BOOTSTRAP_UNSUPPORTED', gate?: string): void {
  const result = planBootstrapPrefix(input);
  expect(result).toMatchObject({ ok: false, code, ...(gate === undefined ? {} : { gate }) });
  expect(result).not.toHaveProperty('rows');
}

/** Modify only one planned payload batch, after the shared adapter validates it. */
function corruptRows(
  phase: string,
  corrupt: (rows: readonly adapter.PhaseRow[]) => readonly adapter.PhaseRow[],
): void {
  const adapt = adapter.phaseRowsOf;
  vi.spyOn(adapter, 'phaseRowsOf').mockImplementation((...args) => {
    const rows = adapt(...args);
    return rows.some((row) => row.type === 'phase.entered' && row.data.phase === phase) ? corrupt(rows) : rows;
  });
}

/** Return the same rows with the entry data changed. */
function changeEntry(
  rows: readonly adapter.PhaseRow[],
  change: (data: adapter.PhaseRow['data']) => adapter.PhaseRow['data'],
): readonly adapter.PhaseRow[] {
  return rows.map((row) => row.type === 'phase.entered' ? { ...row, data: change(row.data) } : row);
}

afterEach(() => vi.restoreAllMocks());

describe('bootstrap prefix routing', () => {
  it('Bootstrap_ZeroHopEntry_FreezesWithoutTransition', () => {
    const definition = userPrefix([]);
    const result = planBootstrapPrefix(prefixInput('release-check', definition));
    expect(result).toMatchObject({ ok: true, phase: 'build', phaseAttemptId: INITIAL_ATTEMPT, discharges: [], effects: [] });
    if (!result.ok) throw new Error(result.message);
    expect(result.rows.map((row) => row.type)).toEqual(['workflow.started', 'state.patched', 'phase.entered']);
    expect(result.rows[2]?.data).toEqual({
      phase: 'build', kind: 'IMPLEMENT', resolver: 'verification-ladder', resolvedGates: [],
      policySource: 'builtin', mode: 'enforce', posture: 'task-isolated', riskTier: 'unknown', boundaryTouching: true,
    });
  });

  it('Bootstrap_ReviewPrefix_Refuses', () => {
    expectRefusal(prefixInput('release-check', userPrefix(['PLAN', 'REVIEW'])), 'PHASE_NOT_PREPARABLE');
  });

  it.each(['SYNTHESIZE', 'MERGE'] as const)('Bootstrap_UnsupportedPrefix_%s_Refuses', (kind) => {
    expectRefusal(prefixInput('release-check', userPrefix([kind])), 'PHASE_NOT_PREPARABLE');
  });

  it('Bootstrap_SingleAgentImplement_Refuses', () => {
    expectRefusal(prefixInput('oneshot', builtInDefinition('oneshot')), 'PHASE_NOT_PREPARABLE');
  });

  it('Bootstrap_SkipRemovesApproval_Refuses', () => {
    expectRefusal({ ...prefixInput(), skipPhases: ['plan-review'] });
  });

  it('Bootstrap_SkipCannotRemoveInitialOrBatchEntry', () => {
    for (const skip of ['plan', 'delegate', 'completed', 'implementation']) {
      expectRefusal({ ...prefixInput(), skipPhases: [skip] });
    }
  });

  it('Bootstrap_UnrelatedOrderedSkipsPreservePrefix', () => {
    const input = prefixInput();
    expect(planBootstrapPrefix({ ...input, skipPhases: ['unknown', 'review', 'review'] }))
      .toEqual(planBootstrapPrefix(input));
  });

  it('Bootstrap_OneAdmittedBranchPasses', () => {
    const definition = withAlternative(userPrefix(['PLAN']), {
      ...EMPTY_EDGE, route: { kind: 'factEquals', field: 'planReview.approved', value: false },
    });
    expect(planBootstrapPrefix(prefixInput('release-check', definition))).toMatchObject({ ok: true, phase: 'build' });
  });

  it('Bootstrap_NegatedUnsupportedUserPredicateRefuses', () => {
    const original = userPrefix(['PLAN']);
    const definition = checked({
      ...original, exarchos: { ...original.exarchos, edges: {
        ...original.exarchos.edges, 'source-0->build': {
          ...EMPTY_EDGE, route: { kind: 'not', operand: { kind: 'factEquals', field: 'reviews.allPassed', value: true } },
        },
      } },
    });
    expectRefusal(prefixInput('release-check', definition));
  });

  it('Bootstrap_UnsupportedDeniedAlternativeRefuses', () => {
    const definition = withAlternative(userPrefix(['PLAN']), {
      ...EMPTY_EDGE, route: { kind: 'factEquals', field: 'reviews.allPassed', value: true },
    });
    expectRefusal(prefixInput('release-check', definition));
  });

  it('Bootstrap_NoAdmittedEdgeRefuses', () => {
    const original = userPrefix(['PLAN']);
    const definition = checked({
      ...original, exarchos: { ...original.exarchos, edges: {
        ...original.exarchos.edges, 'source-0->build': { ...EMPTY_EDGE, route: { kind: 'any', operands: [] } },
      } },
    });
    expectRefusal(prefixInput('release-check', definition));
  });

  it('Bootstrap_LoopRefuses', () => {
    const original = userPrefix(['PLAN', 'GATHER']);
    const edges = { ...original.exarchos.edges };
    delete edges['source-1->build'];
    const definition = checked({
      ...original,
      transitions: original.transitions.map((transition) => transition.fromStepId === 'source-1'
        ? { ...transition, toStepId: 'source-0', transitionId: 'source-1->source-0' }
        : transition),
      exarchos: { ...original.exarchos, edges: { ...edges, 'source-1->source-0': EMPTY_EDGE } },
    });
    expectRefusal(prefixInput('release-check', definition));
  });

  it.each(['cancelled', 'completed', 'implementation'] as const)('Bootstrap_UniversalOrHistoryTarget_%s_Refuses', (toStepId) => {
    const original = builtInDefinition('feature');
    const definition = { ...original, transitions: original.transitions.map((transition) =>
      transition.fromStepId === 'plan' ? { ...transition, toStepId } : transition) };
    expectRefusal(prefixInput('feature', definition));
  });

  it.each(['isFixCycle', 'isRevision'] as const)('Bootstrap_NonPlainEdge_%s_Refuses', (flag) => {
    const original = builtInDefinition('feature');
    const definition = { ...original, exarchos: { ...original.exarchos, edges: {
      ...original.exarchos.edges, 'plan->plan-review': { ...EMPTY_EDGE, [flag]: true },
    } } };
    expectRefusal(prefixInput('feature', definition));
  });

  it.each(['checkpoint', 'increment-fix-cycle'] as const)('Bootstrap_UnsupportedGroupEffect_%s_Refuses', (effect) => {
    const original = builtInDefinition('feature');
    const definition: ExarchosDefinition = { ...original, exarchos: { ...original.exarchos,
      groups: original.exarchos.groups.map((group) => ({ ...group, onEntry: [effect] })),
    } };
    expectRefusal(prefixInput('feature', definition));
  });

  it('Bootstrap_LogDescriptorsKeepDuplicatesAndOrder', () => {
    const original = builtInDefinition('feature');
    const definition: ExarchosDefinition = { ...original, exarchos: { ...original.exarchos,
      groups: original.exarchos.groups.map((group) => ({ ...group, onEntry: ['log', 'log'] })),
      edges: { ...original.exarchos.edges, 'plan->plan-review': { ...EMPTY_EDGE, effects: ['log'] } },
    } };
    expect(planBootstrapPrefix(prefixInput('feature', definition))).toMatchObject({ ok: true, effects: ['log', 'log', 'log'] });
  });

  it('Bootstrap_GroupExitRefusesWithoutDurableHistory', () => {
    const original = builtInDefinition('feature');
    const definition: ExarchosDefinition = { ...original, exarchos: { ...original.exarchos,
      groups: [{ groupId: 'plan-group', initial: 'plan', members: ['plan'], history: 'shallow', onExit: ['log'] },
        ...original.exarchos.groups],
    } };
    const result = planBootstrapPrefix(prefixInput('feature', definition));
    expect(result).toMatchObject({ ok: false, code: 'BOOTSTRAP_UNSUPPORTED', message: expect.stringContaining('history') });
    expect(result).not.toHaveProperty('rows');
  });

  it('Bootstrap_AcyclicPrefixesDischargeEverySourceAndRefuseAmbiguity', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom('PLAN', 'GATHER'), { minLength: 1, maxLength: 7 }),
      fc.nat(), (kinds, insertion) => {
        const definition = userPrefix(kinds);
        const input = prefixInput('release-check', definition);
        const result = planBootstrapPrefix(input);
        if (!result.ok) throw new Error(result.message);
        expect(result.phase).toBe('build');
        expect(result.discharges.map(({ phase, gates }) => [phase, gates]))
          .toEqual(kinds.map((kind, index) => [`source-${index}`, kind === 'PLAN' ? PLAN_GATES : []]));
        expect(result.rows.filter(({ type }) => type === 'workflow.transition').map(({ data }) => [data?.from, data?.to]))
          .toEqual(kinds.map((_, index) => [`source-${index}`, index + 1 < kinds.length ? `source-${index + 1}` : 'build']));
        expect(result.rows.at(-1)).toMatchObject({ type: 'phase.entered', data: { phase: 'build', resolvedGates: [] } });

        const first = definition.transitions[0]!;
        const ambiguous = checked({
          ...definition,
          transitions: [...definition.transitions, { ...first, toStepId: 'verify', transitionId: 'source-0->verify' }],
          exarchos: { ...definition.exarchos, edges: { ...definition.exarchos.edges, 'source-0->verify': EMPTY_EDGE } },
        });
        expectRefusal({ ...input, definition: ambiguous });
        const sameTarget: ExarchosDefinition = {
          ...definition,
          transitions: [...definition.transitions, { ...first, transitionId: 'alternative' }],
          exarchos: { ...definition.exarchos, edges: { ...definition.exarchos.edges, alternative: EMPTY_EDGE } },
        };
        expectRefusal({ ...input, definition: sameTarget });

        const altered = [...kinds];
        altered[insertion % kinds.length] = 'REVIEW';
        expectRefusal(prefixInput('release-check', userPrefix(altered)), 'PHASE_NOT_PREPARABLE');

        const badSource = `source-${insertion % kinds.length}`;
        const adapt = adapter.phaseRowsOf;
        corruptRows(badSource, (rows) => changeEntry(rows, (data) => ({
          ...data, resolvedGates: [{ family: 'plan', gate: 'unknown' }],
        })));
        try {
          expectRefusal(input);
        } finally {
          vi.mocked(adapter.phaseRowsOf).mockRestore();
          expect(adapter.phaseRowsOf).toBe(adapt);
        }
      }), { seed: 192710, numRuns: 30 });
  });
});

describe('bootstrap frozen entry association', () => {
  it('Bootstrap_UnknownFrozenGate_Refuses', () => {
    corruptRows('plan', (rows) => changeEntry(rows, (data) => ({
      ...data, resolvedGates: PLAN_GATES.map((gate, index) => ({ family: 'plan', gate: index === 0 ? 'unknown' : gate })),
    })));
    expectRefusal(prefixInput(), 'BOOTSTRAP_UNSUPPORTED', 'unknown');
  });

  it.each([
    ['wrong phase', { phase: 'plan-review' }],
    ['wrong kind', { kind: 'GATHER' }],
    ['wrong depth', { designDepth: 'deep' }],
    ['wrong floor', { boundaryTouching: false }],
    ['omitted list', { resolvedGates: undefined }],
    ['empty list', { resolvedGates: [] }],
    ['malformed family', { resolvedGates: PLAN_GATES.map((gate) => ({ family: 'other', gate })) }],
    ['wrong known family', { resolvedGates: PLAN_GATES.map((gate) => ({ family: 'review', gate })) }],
    ['reordered list', { resolvedGates: PLAN_GATES.toReversed().map((gate) => ({ family: 'plan', gate })) }],
  ])('Bootstrap_MalformedInitialEntry_%s_Refuses', (_name, changes) => {
    corruptRows('plan', (rows) => changeEntry(rows, (data) => ({ ...data, ...changes })));
    expectRefusal(prefixInput());
  });

  it('Bootstrap_DuplicateEntryRefuses', () => {
    corruptRows('plan', (rows) => [...rows, ...rows]);
    expectRefusal(prefixInput());
  });

  it('Bootstrap_PrecedingEntryCannotBelongToTheNewAttempt', () => {
    corruptRows('plan-review', (rows) => [rows.at(-1)!, ...rows.slice(0, -1)]);
    expectRefusal(prefixInput());
  });

  it('Bootstrap_StaleSamePhaseEntryCannotProveTheNewAttempt', () => {
    corruptRows('plan-review', (rows) => {
      const entry = rows.at(-1)!;
      const transition = rows[0]!;
      return [...rows.slice(0, -1), entry,
        { ...transition, data: { ...transition.data, phaseAttemptId: 'another-attempt' } }];
    });
    expectRefusal(prefixInput());
  });

  it('Bootstrap_ReducedResolverCannotEraseFrozenRequirements', () => {
    const emit = emission.phaseMoveEvents;
    vi.spyOn(emission, 'phaseMoveEvents').mockImplementation((def, state, move, floor) =>
      emit(def, state, move, floor, () => []));
    expectRefusal(prefixInput());
  });

  it('Bootstrap_FinalEntryIsRequired', () => {
    corruptRows('delegate', (rows) => rows.filter(({ type }) => type !== 'phase.entered'));
    expectRefusal(prefixInput());
  });

  it('Bootstrap_SeedRequiresExactApprovalAndAttempt', () => {
    const input = prefixInput();
    const [start, patch] = seed(input.workflowType, input.definition, input.snapshot);
    expectRefusal({ ...input, approvedDigest: 'f'.repeat(64) }, 'DESIGN_APPROVAL_MISMATCH');
    expectRefusal({ ...input, seed: [{ ...start, schemaVersion: '1.0' }, patch] });
    expectRefusal({ ...input, seed: [{ ...start, data: { ...start.data, phaseAttemptId: undefined } }, patch] });
  });
});
