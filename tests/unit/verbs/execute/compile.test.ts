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

/**
 * Builds compile deps for one fixture runbook. Every fixture step names `FIXTURE_TOOL`, so it is the default `handlerTool`.
 * A test of the owner fence overrides `handlerTool` directly.
 */
function depsFor(
  steps: Parameters<typeof fixtureRunbook>[1],
  overrides: Partial<CompileDeps> = {},
): CompileDeps {
  return {
    runbookTable: [fixtureRunbook('fixture-intent', steps)],
    findAction: findFixtureAction([passing]),
    argSchemas: { 'fixture-intent': fixtureIntentArgs },
    handlerTool: FIXTURE_TOOL,
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

  /** The intent schema must catch a string in a boolean field. Otherwise the gate routes on a truthy string that it never declared. */
  it('IntentArgs_BooleanSpelledAsString_Refuses', () => {
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

  /**
   * The step is registered, local, and valid, but the leaves run through one handler table, so it cannot run.
   * A refusal that waits until the executor reaches this leaf comes after the earlier leaves ran, possibly after an effect that cannot be undone.
   */
  it('StepWithNoHandlerInTheTable_IsNotClosed', () => {
    const orphan = fixtureAction({ name: 'fixture_no_handler' });
    const deps = depsFor(
      [fixtureStep('fixture_pass', 'stop'), fixtureStep('fixture_no_handler', 'stop')],
      {
        findAction: findFixtureAction([passing, orphan]),
        handlers: { fixture_pass: () => undefined },
      },
    );
    const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
    expect(refusal.code).toBe('INTENT_NOT_CLOSED');
    expect(refusal.step).toBe('1:fixture_no_handler');
    expect(refusal.message).toContain('no handler');
  });

  /** The fence refuses a missing handler, not a present one. */
  it('EveryStepHasAHandler_Compiles', () => {
    const deps = depsFor([fixtureStep('fixture_pass', 'stop')], {
      handlers: { fixture_pass: () => undefined },
    });
    expect(segmentOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps))).toHaveLength(1);
  });

  /** A caller that compiles a segment only to inspect it owns no handler table. The fence must not refuse that call. */
  it('NoHandlerTableSupplied_CompilesForInspection', () => {
    const deps = depsFor([fixtureStep('fixture_pass', 'stop')]);
    expect(segmentOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps))).toHaveLength(1);
  });

  /**
   * `findAcrossBothTools` resolves `fixture_pass` under two tool names, which is the collision that the fence catches.
   * `findFixtureAction` answers only for `FIXTURE_TOOL`, so only this local lookup reaches the collision.
   */
  describe('the handler table owner fence', () => {
    function findAcrossBothTools(tool: string, action: string) {
      return (tool === FIXTURE_TOOL || tool === 'exarchos_event') && action === 'fixture_pass'
        ? passing
        : undefined;
    }

    const collidingRunbook = [
      fixtureRunbook('fixture-intent', [
        { tool: 'exarchos_event', action: 'fixture_pass', onFail: 'stop' as const },
      ]),
    ];

    /**
     * Kill probe: delete the tool arm in `compile.ts`. The step then compiles into a leaf that dispatches to the
     * orchestrate handler table for an action that the step never named on that tool.
     */
    it('CrossToolActionNameCollision_IsRefusedBeforeAnyEffect', () => {
      const deps: CompileDeps = {
        runbookTable: collidingRunbook,
        findAction: findAcrossBothTools,
        argSchemas: { 'fixture-intent': fixtureIntentArgs },
        handlers: { fixture_pass: () => undefined },
        handlerTool: FIXTURE_TOOL,
      };
      const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
      expect(refusal.code).toBe('INTENT_HANDLER_TOOL_MISMATCH');
      expect(refusal.message).toContain('exarchos_event');
      expect(refusal.message).toContain(FIXTURE_TOOL);
    });

    /** The same collision, with no owner on the table. A caller that omits `handlerTool` must not turn the fence off. */
    it('HandlerTableWithoutAnOwner_RefusesRatherThanTrustingTheName', () => {
      const deps: CompileDeps = {
        runbookTable: collidingRunbook,
        findAction: findAcrossBothTools,
        argSchemas: { 'fixture-intent': fixtureIntentArgs },
        handlers: { fixture_pass: () => undefined },
      };
      const refusal = refusalOf(compileIntent('fixture-intent', SUBJECT, ARGS, deps));
      expect(refusal.code).toBe('INTENT_HANDLER_TABLE_UNOWNED');
    });
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

  /** The strict leaf schema refuses a param that the leaf never declared. The dispatch layer applies the same check to a direct call. */
  it('LeafArgs_UnknownRunbookParam_IsRejectedByTheStrictLeafSchema', () => {
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

  /**
   * A step that names a variable makes that variable required. The fixture schema leaves `riskTier` optional on purpose.
   * This case is an intent whose schema does not require a variable that its runbook uses. Shipped schemas do not reach it.
   * The fixture keeps the compiler check from going vacuous as shipped schemas get stricter.
   */
  it('UnboundPlaceholder_RefusesRatherThanDroppingOut', () => {
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

  /**
   * The leaf must commit to the stream that the emission check watches.
   * A step param with the name of a subject field must not replace the subject.
   */
  it('StepParamNamedStreamId_CannotDisplaceTheSubject', () => {
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
  /** The runbook literal stays, the gate gets the frozen steering, and the terminal leaf gets the subject under both names. */
  it('TaskCompletion_CompilesToFiveLocalLeaves', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', riskTier: 'high', boundaryTouching: true, baseRef: 'feature/wave' },
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

  it('TaskCompletion_TheFrozenBase_ReachesTheKillProbeAndNoOtherGate', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', riskTier: 'high', boundaryTouching: true, baseRef: 'feature/wave' },
      PRODUCTION_COMPILE_DEPS,
    );
    const byAction = new Map(segmentOf(outcome).map((leaf) => [leaf.action, leaf.args]));
    expect(byAction.get('check_test_adequacy')).toMatchObject({ baseBranch: 'feature/wave' });
    for (const gate of ['check_contract_drift', 'check_mock_boundary', 'check_static_analysis']) {
      const args = byAction.get(gate);
      expect(args, gate).toBeDefined();
      expect(args, gate).not.toHaveProperty('baseBranch');
      expect(args, gate).not.toHaveProperty('baseRef');
    }
  });

  it('TaskCompletion_WithoutABase_RefusesBeforeAnyEffect', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', riskTier: 'high', boundaryTouching: true },
      PRODUCTION_COMPILE_DEPS,
    );
    const refusal = refusalOf(outcome);
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('baseRef');
  });

  it('TaskCompletion_ABaseThatCouldBeReadAsAnOption_IsRefused', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', riskTier: 'high', boundaryTouching: true, baseRef: '--all' },
      PRODUCTION_COMPILE_DEPS,
    );
    expect(refusalOf(outcome).code).toBe('INTENT_ARGS_INVALID');
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

  /**
   * The kill-probe gate routes on `<riskTier>`. Without the tier, an unproven probe becomes an advisory skip.
   * The intent schema requires the tier, so the schema refuses the call and nothing runs.
   */
  it('TaskCompletion_WithoutRiskTier_RefusesBeforeAnyEffect', () => {
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

  /** A runbook is executable when it gets past `INTENT_NOT_COMPILABLE`. The test checks every declared runbook, in table order. */
  it('EveryOtherRunbook_IsNotCompilable_FourIntentsShip', () => {
    const executable = PRODUCTION_COMPILE_DEPS.runbookTable
      .map((runbook) => {
        const outcome = compileIntent(runbook.id, { streamId: 'wf-live' }, {}, PRODUCTION_COMPILE_DEPS);
        return { id: runbook.id, notCompilable: !outcome.ok && outcome.refusal.code === 'INTENT_NOT_COMPILABLE' };
      })
      .filter((entry) => !entry.notCompilable);
    expect(PRODUCTION_COMPILE_DEPS.runbookTable.length).toBeGreaterThan(4);
    expect(executable.map((entry) => entry.id)).toEqual([
      'task-completion',
      'quality-evaluation',
      'synthesis-closeout',
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
