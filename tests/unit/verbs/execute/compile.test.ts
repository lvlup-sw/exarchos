import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { compileIntent, PRODUCTION_COMPILE_DEPS, type CompileDeps } from '../../../../src/verbs/execute/compile.js';
import type { CompiledLeaf } from '../../../../src/verbs/execute/types.js';
import {
  FIXTURE_TOOL,
  fixtureAction,
  fixtureIntentArgs,
  fixtureRunbook,
  fixtureStep,
  findFixtureAction,
} from './fixtures.js';

const passing = fixtureAction({ name: 'fixture_pass' });

function depsFor(
  steps: Parameters<typeof fixtureRunbook>[1],
  overrides: Partial<CompileDeps> = {},
): CompileDeps {
  return {
    runbookTable: [fixtureRunbook('fixture-intent', steps)],
    findAction: findFixtureAction([passing]),
    argSchemas: { 'fixture-intent': fixtureIntentArgs },
    ...overrides,
  };
}

const SUBJECT = { streamId: 'wf-compile' };
const ARGS = { taskId: 'task-1' };

function refusalOf(outcome: ReturnType<typeof compileIntent>): { code: string; message: string; step?: string } {
  if (outcome.ok) throw new Error('expected a compile refusal, got a segment');
  return outcome.refusal;
}

function segmentOf(outcome: ReturnType<typeof compileIntent>): readonly CompiledLeaf[] {
  if (!outcome.ok) throw new Error(`expected a segment, got ${outcome.refusal.code}: ${outcome.refusal.message}`);
  return outcome.segment.leaves;
}

describe('compileIntent refusals', () => {
  it('UnknownIntent_NoRunbookDeclaresIt_Refuses', () => {
    const refusal = refusalOf(
      compileIntent('nope', SUBJECT, ARGS, depsFor([fixtureStep('fixture_pass', 'stop')])),
    );
    expect(refusal.code).toBe('INTENT_UNKNOWN');
  });

  it('RunbookWithoutArgSchema_IsNotCompilable', () => {
    const deps = depsFor([fixtureStep('fixture_pass', 'stop')], { argSchemas: {} });
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_NOT_COMPILABLE');
  });

  it('IntentArgs_MissingRequiredField_Refuses', () => {
    const refusal = refusalOf(
      compileIntent('fixture-intent', SUBJECT, {}, depsFor([fixtureStep('fixture_pass', 'stop')])),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('taskId');
  });

  it('IntentArgs_BooleanSpelledAsString_Refuses', () => {
    // A string is not a boolean, and the intent schema is where that is caught —
    // downstream the gate would route on a truthy string it never declared.
    const refusal = refusalOf(
      compileIntent(
        'fixture-intent',
        SUBJECT,
        { taskId: 'task-1', boundaryTouching: 'true' },
        depsFor([fixtureStep('fixture_pass', 'stop')]),
      ),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('boundaryTouching');
  });

  it('IntentArgs_UnknownKey_Refuses', () => {
    const refusal = refusalOf(
      compileIntent(
        'fixture-intent',
        SUBJECT,
        { taskId: 'task-1', notAField: 1 },
        depsFor([fixtureStep('fixture_pass', 'stop')]),
      ),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
  });

  it('NativeStep_IsNotClosed', () => {
    const deps = depsFor([
      fixtureStep('fixture_pass', 'stop'),
      { tool: 'native:Task', action: 'spawn', onFail: 'stop' },
    ]);
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_NOT_CLOSED');
    expect(refusal.step).toBe('1:spawn');
  });

  it('DecideStep_IsAHostObligation', () => {
    const deps = depsFor([
      {
        tool: 'none',
        action: 'decide',
        onFail: 'stop',
        decide: { question: 'which way?', source: 'human', branches: {} },
      },
    ]);
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_HOST_OBLIGATION');
    expect(refusal.step).toBe('0:decide');
  });

  it('RetryOnFail_IsRefusedAtCompileTime', () => {
    const deps = depsFor([fixtureStep('fixture_pass', 'retry')]);
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_RETRY_UNSUPPORTED');
  });

  it('UnregisteredAction_Refuses', () => {
    const deps = depsFor([fixtureStep('fixture_missing', 'stop')]);
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_ACTION_UNREGISTERED');
  });

  it('HostAuthorityAction_IsNotLocallyExecutable', () => {
    const hostOwned = fixtureAction({
      name: 'fixture_host',
      executionAuthority: { kind: 'host', obligation: 'human-approval' },
    });
    const deps = depsFor([fixtureStep('fixture_host', 'stop')], {
      findAction: findFixtureAction([hostOwned]),
    });
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_ACTION_NOT_LOCAL');
  });

  it('LeafArgs_RejectedByTheLeafSchema_Refuses', () => {
    const demanding = fixtureAction({
      name: 'fixture_pass',
      schema: z.object({ featureId: z.string().min(1), mandatory: z.string().min(1) }).strict(),
    });
    const deps = depsFor([fixtureStep('fixture_pass', 'stop')], {
      findAction: findFixtureAction([demanding]),
    });
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_LEAF_ARGS_INVALID');
    expect(refusal.message).toContain('mandatory');
  });

  it('LeafArgs_UnknownRunbookParam_IsRejectedByTheStrictLeafSchema', () => {
    // The chokepoint the dispatch layer holds for a direct call: a param the
    // leaf never declared does not get quietly dropped.
    const deps = depsFor([fixtureStep('fixture_pass', 'stop', { notDeclared: 'x' })]);
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_LEAF_ARGS_INVALID');
  });
});

describe('compileIntent argument construction', () => {
  it('SubstitutesTypedPlaceholders_AndPreservesLiterals', () => {
    const deps = depsFor([
      fixtureStep('fixture_pass', 'stop', {
        worktreePath: '<worktreePath>',
        riskTier: '<riskTier>',
        boundaryTouching: '<boundaryTouching>',
      }),
    ]);
    const leaves = segmentOf(
      compileIntent(
        'fixture-intent',
        SUBJECT,
        { taskId: 'task-1', worktreePath: '/tmp/wt', riskTier: 'high', boundaryTouching: true },
        deps,
      ),
    );
    expect(leaves[0]?.args).toEqual({
      featureId: 'wf-compile',
      taskId: 'task-1',
      worktreePath: '/tmp/wt',
      riskTier: 'high',
      boundaryTouching: true,
    });
  });

  it('UnboundPlaceholder_RefusesRatherThanDroppingOut', () => {
    // The placeholder used to drop out silently and the leaf ran without the
    // value. The step naming the variable is what makes it required.
    //
    // The fixture intent's schema deliberately leaves `riskTier` optional, so
    // this is the case a shipped schema no longer reaches: an intent whose
    // author forgot to require a variable their runbook references. That is
    // the population the compiler-side check exists for, and pinning it here
    // keeps the check from going vacuous as shipped schemas tighten.
    const deps = depsFor([fixtureStep('fixture_pass', 'stop', { riskTier: '<riskTier>' })]);
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_TEMPLATE_VAR_UNBOUND');
    expect(refusal.step).toBe('0:fixture_pass');
    expect(refusal.message).toContain('riskTier');
  });

  it('BoundPlaceholder_IsTheControl_SameStepCompilesWithTheBinding', () => {
    const deps = depsFor([fixtureStep('fixture_pass', 'stop', { riskTier: '<riskTier>' })]);
    const leaves = segmentOf(
      compileIntent('fixture-intent', SUBJECT, { ...ARGS, riskTier: 'low' }, deps),
    );
    expect(leaves[0]?.args).toMatchObject({ riskTier: 'low' });
  });

  it('StepParamNamedStreamId_CannotDisplaceTheSubject', () => {
    // Subject identity is the executor's contract with the emission check: the
    // leaf commits to the stream the check watches. A runbook param spelled
    // like the subject used to win, because step params were merged AFTER it —
    // so a leaf would run against one stream while verification read another.
    const identityShaped = fixtureAction({
      name: 'fixture_pass',
      schema: z
        .object({
          featureId: z.string().min(1),
          streamId: z.string().min(1),
          taskId: z.string().min(1),
        })
        .strict(),
    });
    const deps = depsFor(
      [
        fixtureStep('fixture_pass', 'stop', {
          streamId: 'other-stream',
          featureId: 'other-feature',
        }),
      ],
      { findAction: findFixtureAction([identityShaped]) },
    );
    const leaves = segmentOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(leaves[0]?.args).toEqual({
      featureId: 'wf-compile',
      streamId: 'wf-compile',
      taskId: 'task-1',
    });
  });
});

describe('compileIntent over the live registry', () => {
  it('TaskCompletion_CompilesToFiveLocalLeaves', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', riskTier: 'high', boundaryTouching: true },
      PRODUCTION_COMPILE_DEPS,
    );
    const leaves = segmentOf(outcome);
    expect(leaves.map((leaf) => leaf.action)).toEqual([
      'check_test_adequacy',
      'check_contract_drift',
      'check_mock_boundary',
      'check_static_analysis',
      'task_complete',
    ]);
    // The runbook's literal survives; the frozen steering reaches the gate that
    // routes on it; the terminal leaf gets the subject under both spellings.
    expect(leaves[0]?.args).toMatchObject({
      repoRoot: 'auto',
      worktreePath: '/tmp/agent-wt',
      riskTier: 'high',
      boundaryTouching: true,
      featureId: 'wf-live',
      taskId: 'task-9',
    });
    expect(leaves[4]?.args).toMatchObject({
      taskId: 'task-9',
      featureId: 'wf-live',
      streamId: 'wf-live',
    });
    expect(leaves.map((leaf) => leaf.onFail)).toEqual(['stop', 'stop', 'continue', 'stop', 'stop']);
  });

  it('TaskCompletion_MissingWorktreePath_RefusesBeforeAnyEffect', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9' },
      PRODUCTION_COMPILE_DEPS,
    );
    expect(refusalOf(outcome).code).toBe('INTENT_ARGS_INVALID');
  });

  it('TaskCompletion_WithoutRiskTier_RefusesBeforeAnyEffect', () => {
    // Every gate step in this runbook passes `<riskTier>`, and the kill-probe
    // gate routes on it — arriving tierless degrades an unproven probe to an
    // advisory skip. The intent's own schema now REQUIRES the tier, so the
    // refusal lands on the schema rather than on the step that would have used
    // it; either way nothing runs. The compiler's own refusal keeps its teeth
    // over a fixture intent above, where the schema leaves the var optional.
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', boundaryTouching: true },
      PRODUCTION_COMPILE_DEPS,
    );
    const refusal = refusalOf(outcome);
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('riskTier');
  });

  it('TaskCompletion_WithoutBoundaryTouching_RefusesToo', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', riskTier: 'high' },
      PRODUCTION_COMPILE_DEPS,
    );
    const refusal = refusalOf(outcome);
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('boundaryTouching');
  });

  it('EveryOtherRunbook_IsNotCompilable_ThreeIntentsShip', () => {
    // Reaching past INTENT_NOT_COMPILABLE is what "executable" means here, so
    // the denominator is every declared runbook, not a hand-kept list. The
    // order is the table's own.
    const executable = PRODUCTION_COMPILE_DEPS.runbookTable
      .map((runbook) => {
        const outcome = compileIntent(runbook.id, { streamId: 'wf-live' }, {}, PRODUCTION_COMPILE_DEPS);
        return { id: runbook.id, notCompilable: !outcome.ok && outcome.refusal.code === 'INTENT_NOT_COMPILABLE' };
      })
      .filter((entry) => !entry.notCompilable);
    expect(PRODUCTION_COMPILE_DEPS.runbookTable.length).toBeGreaterThan(3);
    expect(executable.map((entry) => entry.id)).toEqual([
      'task-completion',
      'quality-evaluation',
      'plan-closeout',
    ]);
  });
});

describe('fixture leaf declarations are the real thing', () => {
  it('FixtureAction_CarriesANormalizedContract', () => {
    expect(passing.actionContract?.executionAuthority).toEqual({ kind: 'local' });
    expect(passing.actionContract?.needs).toEqual({ kind: 'declared', values: ['mcp:exarchos'] });
  });

  it('FixtureTool_IsTheOnlyToolTheFixtureLookupAnswersFor', () => {
    expect(findFixtureAction([passing])(FIXTURE_TOOL, 'fixture_pass')).toBe(passing);
    expect(findFixtureAction([passing])('exarchos_view', 'fixture_pass')).toBeUndefined();
  });
});
