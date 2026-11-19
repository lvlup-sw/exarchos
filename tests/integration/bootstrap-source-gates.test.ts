/**
 * Authored definitions and captured bytes supply the bootstrap route and gate inputs.
 * @oracle-sources: ../../src/workflow/definitions/feature.workflow.json, ../../src/workflow/definitions/refactor.workflow.json, literal planned row trails in this file
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { foldWorkflowState } from '../../src/projections/guard-input/fold.js';
import { builtInDefinition } from '../../src/workflow/definitions/built-in.js';
import { planBootstrapPrefix, type BootstrapPlanInput, type BootstrapPlanResult } from '../../src/workflow/design-record/bootstrap-plan.js';
import * as checks from '../../src/workflow/design-record/plan-checks.js';
import { INITIAL_ATTEMPT, prefixInput, snapshot } from '../helpers/capsule/bootstrap-prefix.js';
import { nodeTestProfile, pinnedUnresolvedGlobProfile, UNRESOLVED_GLOBS_REASON } from '../helpers/verification-profile.js';

const PLAN_GATES = ['check_task_decomposition', 'check_plan_coverage', 'spec_coverage_check',
  'check_provenance_chain', 'generate_traceability'];
const EXPLORATION = '### Exploration\n[Report](docs/research/prefix.md) correlationId: prefix-research\n\n';

type Prefix = Extract<BootstrapPlanResult, { ok: true }>;

/** Return the planned rows and show a refusal in test output. */
function accepted(input: BootstrapPlanInput): Prefix {
  const result = planBootstrapPrefix(input);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}

/** Pin the exact trail and bind each gate discharge to its source attempt. */
function expectTrail(result: Prefix, trail: string[], phases: string[]): void {
  expect(result.rows.map((row) => row.type)).toEqual(trail);
  expect(result.rows.map((row) => row.sequence)).toEqual(trail.map((_, index) => index + 1));
  const transitions = result.rows.filter((row) => row.type === 'workflow.transition');
  const entries = result.rows.filter((row) => row.type === 'phase.entered');
  const exits = result.rows.filter((row) => row.type === 'phase.exited');
  const attempts = [INITIAL_ATTEMPT, ...transitions.map((row) => row.data?.phaseAttemptId)];
  expect(attempts).toHaveLength(phases.length);
  expect(new Set(attempts).size).toBe(phases.length);
  expect(entries.map((row) => row.data?.phase)).toEqual(phases);
  expect(exits.map((row) => row.data)).toEqual(phases.slice(0, -1).map((phase) => ({ phase, allRequiredGatesPassed: true })));
  expect(transitions.map((row) => [row.data?.from, row.data?.to])).toEqual(
    phases.slice(0, -1).map((phase, index) => [phase, phases[index + 1]]),
  );
  expect(result.discharges.map(({ phase, phaseAttemptId }) => [phase, phaseAttemptId])).toEqual(
    phases.slice(0, -1).map((phase, index) => [phase, attempts[index]]),
  );
  expect(result.phaseAttemptId).toBe(attempts.at(-1));
  expect(result.effects).toEqual(['log']);
  expect(foldWorkflowState(result.rows)).toMatchObject({
    phase: phases.at(-1), phaseAttemptId: attempts.at(-1), designDepth: 'standard',
    phaseObligation: { kind: 'IMPLEMENT', resolver: 'verification-ladder', posture: 'task-isolated',
      exited: false, resolvedGates: [], riskTier: 'unknown', boundaryTouching: true },
  });
  expect(entries[0]?.data).toMatchObject({ riskTier: 'unknown', boundaryTouching: true, posture: 'read-only' });
}

/** Observe the real evaluators without replacing their results. */
function observePlanChecks() {
  return [
    vi.spyOn(checks, 'evaluatePlanDecomposition'), vi.spyOn(checks, 'evaluatePlanCoverage'),
    vi.spyOn(checks, 'evaluatePlanTestPaths'), vi.spyOn(checks, 'evaluatePlanProvenance'),
    vi.spyOn(checks, 'evaluatePlanTraceability'),
  ];
}

afterEach(() => vi.restoreAllMocks());

describe('bootstrap source checks', () => {
  it('Bootstrap_Feature_EvaluatesBothPlanSources', () => {
    const observers = observePlanChecks();
    const input = prefixInput();
    const result = accepted(input);
    expectTrail(result, [
      'workflow.started', 'state.patched', 'phase.entered',
      'workflow.transition', 'phase.exited', 'phase.entered',
      'workflow.transition', 'workflow.compound-entry', 'phase.exited', 'phase.entered',
    ], ['plan', 'plan-review', 'delegate']);
    expect(result.discharges.map(({ gates }) => gates)).toEqual([PLAN_GATES, PLAN_GATES]);
    expect(result.rows.find((row) => row.type === 'workflow.compound-entry')?.data?.compoundStateId).toBe('implementation');
    for (const observer of observers) {
      expect(observer).toHaveBeenCalledTimes(2);
      expect(observer.mock.calls.map(([record]) => record)).toEqual([input.snapshot, input.snapshot]);
    }
    expect(observers.flatMap((observer) => observer.mock.invocationCallOrder).slice().sort((a, b) => a - b))
      .toEqual([0, 1].flatMap((run) => observers.map((observer) => observer.mock.invocationCallOrder[run])));
    expect(result.rows.filter((row) => row.data?.kind === 'PLAN').map((row) => row.data?.designDepth))
      .toEqual(['standard', 'standard']);
  });

  it('Bootstrap_Overhaul_EvaluatesThreePlanSources', () => {
    const observers = observePlanChecks();
    const result = accepted(prefixInput('refactor', builtInDefinition('refactor')));
    expectTrail(result, [
      'workflow.started', 'state.patched', 'phase.entered',
      'workflow.transition', 'phase.exited', 'phase.entered',
      'workflow.transition', 'workflow.compound-entry', 'phase.exited', 'phase.entered',
      'workflow.transition', 'phase.exited', 'phase.entered',
      'workflow.transition', 'phase.exited', 'phase.entered',
    ], ['explore', 'brief', 'overhaul-plan', 'overhaul-plan-review', 'overhaul-delegate']);
    expect(result.discharges.map(({ gates }) => gates)).toEqual([[], PLAN_GATES, PLAN_GATES, PLAN_GATES]);
    expect(result.rows.find((row) => row.type === 'workflow.compound-entry')?.data?.compoundStateId).toBe('overhaul-track');
    for (const observer of observers) expect(observer).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['evaluatePlanDecomposition', 'check_task_decomposition'],
    ['evaluatePlanCoverage', 'check_plan_coverage'],
    ['evaluatePlanTestPaths', 'spec_coverage_check'],
    ['evaluatePlanProvenance', 'check_provenance_chain'],
    ['evaluatePlanTraceability', 'generate_traceability'],
    ['evaluatePlanExploration', 'check_exploration_depth'],
  ] as const)('Bootstrap_SecondSourceFailsAt_%s', (evaluator, gate) => {
    const evaluate = checks[evaluator];
    vi.spyOn(checks, evaluator).mockImplementationOnce(evaluate).mockImplementationOnce(() => {
      throw new Error('Required evaluation failed');
    });
    const result = planBootstrapPrefix({
      ...prefixInput('feature', builtInDefinition('feature'), snapshot(undefined, EXPLORATION)),
      designDepth: 'deep',
    });
    expect(result).toMatchObject({ ok: false, code: 'PLAN_UNSOUND', source: { phase: 'plan-review' }, gate });
    expect(result).not.toHaveProperty('rows');
  });

  it('Bootstrap_RequiredSkipIsARefusal', () => {
    const coverage = checks.evaluatePlanCoverage;
    vi.spyOn(checks, 'evaluatePlanCoverage').mockImplementationOnce((record) => ({
      ...coverage(record), passed: false, reason: 'skipped',
    }));
    expect(planBootstrapPrefix(prefixInput())).toMatchObject({
      ok: false, source: { phase: 'plan', phaseAttemptId: INITIAL_ATTEMPT }, gate: 'check_plan_coverage',
    });
  });

  it.each([
    ['', 'missing the required'],
    ['### Exploration\ncorrelationId: r\n', 'a /exarchos:discover report path'],
    ['### Exploration\ndocs/research/prefix.md\n', 'a correlationId'],
  ])('Bootstrap_DeepRequiresExplorationCitations_%s', (preamble, reason) => {
    const result = planBootstrapPrefix({
      ...prefixInput('feature', builtInDefinition('feature'), snapshot(undefined, preamble)),
      designDepth: 'deep',
    });
    expect(result).toMatchObject({ ok: false, gate: 'check_exploration_depth' });
    if (!result.ok) expect(result.message).toContain(reason);
  });

  it('Bootstrap_DeepChecksExplorationOnBothSources', () => {
    const observer = vi.spyOn(checks, 'evaluatePlanExploration');
    const result = accepted({
      ...prefixInput('feature', builtInDefinition('feature'), snapshot(undefined, EXPLORATION)),
      designDepth: 'deep',
    });
    expect(result.discharges.map(({ gates }) => gates)).toEqual(Array.from({ length: 2 }, () => [...PLAN_GATES, 'check_exploration_depth']));
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('Bootstrap_ThinChecksTheThinSequenceOnly', () => {
    const observer = vi.spyOn(checks, 'evaluatePlanExploration');
    const input = prefixInput('feature', builtInDefinition('feature'), snapshot([]));
    const result = accepted({ ...input, designDepth: 'thin', profile: pinnedUnresolvedGlobProfile(1).profile });
    expect(result.discharges.map(({ gates }) => gates)).toEqual([PLAN_GATES.slice(0, 2), PLAN_GATES.slice(0, 2)]);
    expect(observer).not.toHaveBeenCalled();
  });

  it('Bootstrap_StandardUsesResolvedCustomGlobs', () => {
    const observer = vi.spyOn(checks, 'evaluatePlanExploration');
    const input = prefixInput('feature', builtInDefinition('feature'), snapshot(['checks/cases/compile.fixture']));
    const profile = nodeTestProfile();
    expect(planBootstrapPrefix(input)).toMatchObject({ ok: false, gate: 'spec_coverage_check' });
    expect(accepted({ ...input, profile: { ...profile, tests: {
      ...profile.tests, globs: { state: 'resolved', globs: ['checks/**/*.fixture'], source: 'config' },
    } } }).phase).toBe('delegate');
    expect(observer).not.toHaveBeenCalled();
  });

  it('Bootstrap_UnresolvedGlobsAndEmptyDeclarationsRefuse', () => {
    const unresolved = planBootstrapPrefix({ ...prefixInput(), profile: pinnedUnresolvedGlobProfile(1).profile });
    expect(unresolved).toMatchObject({ ok: false, gate: 'spec_coverage_check' });
    if (!unresolved.ok) expect(unresolved.message).toContain(UNRESOLVED_GLOBS_REASON);
    expect(planBootstrapPrefix(prefixInput('feature', builtInDefinition('feature'), snapshot([]))))
      .toMatchObject({ ok: false, gate: 'spec_coverage_check' });
  });

  it('Bootstrap_WholePlanRefusesBeforeRouting', () => {
    const input = prefixInput();
    const invalid = { ...input.snapshot, definitions: [] };
    expect(planBootstrapPrefix({ ...input, snapshot: invalid })).toMatchObject({ ok: false, code: 'PLAN_UNSOUND' });
  });
});
