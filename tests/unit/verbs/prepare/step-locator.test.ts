/**
 * The step locator classifies the step of a phase from the data of a registered definition.
 *
 * A task-batch step is a `skill` step of the step type `IMPLEMENT`, with an exit gate or approval that requires every task.
 * The cases read the five built-in definitions and clones of the fixture user definition. Each clone passes the user rules first.
 * The class table of the 45 built-in steps is written by hand in this file, from a read of the five definition files.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/step-locator.ts, the class table of the five built-in steps written in this file
 */

import { describe, expect, it } from 'vitest';

import { classifyStep, compilableSteps, locateStep } from '../../../../src/verbs/prepare/step-locator.js';
import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
  type BuiltInWorkflowType,
} from '../../../../src/workflow/definitions/built-in.js';
import type { ExarchosDefinition } from '../../../../src/workflow/definitions/extension.js';
import { checkUserDefinition } from '../../../../src/workflow/definitions/user.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';

/** The classes of the steps of one built-in type: the two compile classes by id, and the two other classes by count. */
interface ClassRow {
  readonly taskBatch: readonly string[];
  readonly singleAgent: readonly string[];
  readonly notAnImplementStep: number;
  readonly terminalStep: number;
}

/** The class table of the 45 built-in steps, written by hand from the five definition files. */
const CLASS_TABLE: Readonly<Record<BuiltInWorkflowType, ClassRow>> = {
  feature: { taskBatch: ['delegate'], singleAgent: [], notAnImplementStep: 6, terminalStep: 2 },
  debug: { taskBatch: [], singleAgent: ['debug-implement', 'hotfix-implement'], notAnImplementStep: 9, terminalStep: 2 },
  refactor: { taskBatch: ['overhaul-delegate'], singleAgent: ['polish-implement'], notAnImplementStep: 10, terminalStep: 2 },
  oneshot: { taskBatch: [], singleAgent: ['implementing'], notAnImplementStep: 2, terminalStep: 2 },
  discovery: { taskBatch: [], singleAgent: [], notAnImplementStep: 2, terminalStep: 2 },
};

/** The condition that the plan has at least one task and that every task is complete, written by hand. */
function tasksComplete(): Record<string, unknown> {
  return {
    kind: 'all',
    operands: [
      { kind: 'counterCompare', field: 'tasks.count', op: 'gte', value: 1 },
      { kind: 'factEquals', field: 'tasks.allComplete', value: true },
    ],
  };
}

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Returns the value as a list, or throws with its path. */
function listAt(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} is not a list`);
  return value;
}

/** The edges of a raw document. */
function edgesOf(document: Record<string, unknown>): Record<string, unknown> {
  return recordAt(recordAt(document.exarchos, 'exarchos').edges, 'exarchos.edges');
}

/** The checked definition of a raw document. A document that fails the user rules fails the case. */
function checked(document: unknown): ExarchosDefinition {
  const result = checkUserDefinition(document);
  if (!result.ok) throw new Error(`the document fails the user rules: ${JSON.stringify(result.findings)}`);
  return result.definition;
}

/** A clone of the fixture whose edge `build->verify` holds the obligation. */
function withBuildObligation(obligation: Record<string, unknown>): ExarchosDefinition {
  const document = structuredClone(releaseCheckDefinition());
  recordAt(edgesOf(document)['build->verify'], 'build->verify').obligation = obligation;
  return checked(document);
}

/** A clone of the fixture whose gate on the edge `build->verify` has the presence. */
function withBuildPresence(presence: Record<string, unknown>): ExarchosDefinition {
  return withBuildObligation({ kind: 'gate', gateId: 'release-tasks', presence });
}

describe('the step locator', () => {
  /** The feature step `delegate` has an exit gate whose presence nests the task condition in an `all` node. */
  it('StepLocator_FeatureDelegate_IsATaskBatch', () => {
    expect(locateStep(builtInDefinition('feature'), 'delegate')).toStrictEqual({
      ok: true,
      step: { stepId: 'delegate', kind: 'task-batch' },
    });
  });

  /** The refactor step `overhaul-delegate` has an exit gate whose presence is the task condition. */
  it('StepLocator_RefactorOverhaulDelegate_IsATaskBatch', () => {
    expect(locateStep(builtInDefinition('refactor'), 'overhaul-delegate')).toStrictEqual({
      ok: true,
      step: { stepId: 'overhaul-delegate', kind: 'task-batch' },
    });
  });

  /** An `IMPLEMENT` step with no exit that requires every task is a single-agent step. The refusal names the compilable steps. */
  it.each<[string, BuiltInWorkflowType, readonly string[]]>([
    ['polish-implement', 'refactor', ['overhaul-delegate']],
    ['debug-implement', 'debug', []],
    ['hotfix-implement', 'debug', []],
    ['implementing', 'oneshot', []],
  ])('StepLocator_%s_IsASingleAgentStep', (stepId, workflowType, compilable) => {
    expect(locateStep(builtInDefinition(workflowType), stepId)).toStrictEqual({
      ok: false,
      rule: 'single-agent-step',
      compilable,
    });
  });

  /** The two non-final discovery steps are `skill` steps of other step types, so each is not an implement step. */
  it('StepLocator_EachDiscoveryStep_IsNotAnImplementStep', () => {
    const discovery = builtInDefinition('discovery');
    const open = discovery.steps.filter((step) => !step.isTerminal).map((step) => step.stepId);

    expect(open).toStrictEqual(['gathering', 'synthesizing']);
    for (const stepId of open) {
      expect(locateStep(discovery, stepId)).toStrictEqual({ ok: false, rule: 'not-an-implement-step', compilable: [] });
    }
  });

  /** A final step is a terminal step, and the refusal names the compilable step of the definition. */
  it('StepLocator_AFinalStep_IsATerminalStep', () => {
    const feature = builtInDefinition('feature');

    expect(locateStep(feature, 'completed')).toStrictEqual({ ok: false, rule: 'terminal-step', compilable: ['delegate'] });
    expect(locateStep(feature, 'cancelled')).toStrictEqual({ ok: false, rule: 'terminal-step', compilable: ['delegate'] });
  });

  /** A phase that names no step of the definition is not a step. */
  it('StepLocator_APhaseOutsideTheDefinition_IsNotAStep', () => {
    expect(locateStep(builtInDefinition('feature'), 'nowhere')).toStrictEqual({
      ok: false,
      rule: 'not-a-step',
      compilable: ['delegate'],
    });
  });

  /** Each built-in step has the class of the table. The totals are 2, 4, 29 and 10 over 45 steps. */
  it('StepLocator_TheClassesOfTheBuiltIns_AreTheTable', () => {
    const totals = new Map<string, number>();
    for (const workflowType of BUILT_IN_WORKFLOW_TYPES) {
      const definition = builtInDefinition(workflowType);
      const ids = new Map<string, string[]>();
      for (const step of definition.steps) {
        const stepClass = classifyStep(definition, step.stepId);
        ids.set(stepClass, [...(ids.get(stepClass) ?? []), step.stepId]);
        totals.set(stepClass, (totals.get(stepClass) ?? 0) + 1);
      }
      const row = {
        taskBatch: ids.get('task-batch') ?? [],
        singleAgent: ids.get('single-agent-step') ?? [],
        notAnImplementStep: ids.get('not-an-implement-step')?.length ?? 0,
        terminalStep: ids.get('terminal-step')?.length ?? 0,
      };
      expect([workflowType, row]).toStrictEqual([workflowType, CLASS_TABLE[workflowType]]);
      expect(compilableSteps(definition)).toStrictEqual(CLASS_TABLE[workflowType].taskBatch);
    }

    expect(Object.fromEntries(totals)).toStrictEqual({
      'task-batch': 2,
      'single-agent-step': 4,
      'not-an-implement-step': 29,
      'terminal-step': 10,
    });
    expect([...totals.values()].reduce((sum, count) => sum + count, 0)).toBe(45);
  });

  /** A task condition under an `any` node does not require every task, so the step is a single-agent step. */
  it('StepLocator_AnExitThatNeedsTasksUnderAny_IsSingleAgent', () => {
    const definition = withBuildPresence({ kind: 'any', operands: [tasksComplete()] });

    expect(locateStep(definition, 'build')).toStrictEqual({ ok: false, rule: 'single-agent-step', compilable: [] });
  });

  /** A task condition under a `not` node does not require every task, so the step is a single-agent step. */
  it('StepLocator_AnExitThatNeedsTasksUnderNot_IsSingleAgent', () => {
    const definition = withBuildPresence({ kind: 'not', operand: tasksComplete() });

    expect(locateStep(definition, 'build')).toStrictEqual({ ok: false, rule: 'single-agent-step', compilable: [] });
  });

  /** A task condition nested in two `all` nodes beside another fact requires every task, so the step is a task batch. */
  it('StepLocator_AnExitThatNeedsTasksInANestedAll_IsATaskBatch', () => {
    const definition = withBuildPresence({
      kind: 'all',
      operands: [
        {
          kind: 'all',
          operands: [{ kind: 'factEquals', field: 'reviews.allPassed', value: true }, tasksComplete()],
        },
      ],
    });

    expect(locateStep(definition, 'build')).toStrictEqual({ ok: true, step: { stepId: 'build', kind: 'task-batch' } });
    expect(compilableSteps(definition)).toStrictEqual(['build']);
  });

  /** An approval whose presence requires every task makes a task batch, as a gate does. */
  it('StepLocator_AnApprovalThatNeedsTasks_IsATaskBatch', () => {
    const definition = withBuildObligation({
      kind: 'approval',
      approvalClass: 'release-approval',
      minimumApprovals: 1,
      presence: { kind: 'all', operands: [tasksComplete()] },
    });

    expect(definition.exarchos.edges['build->verify']?.obligation.kind).toBe('approval');
    expect(locateStep(definition, 'build')).toStrictEqual({ ok: true, step: { stepId: 'build', kind: 'task-batch' } });
  });

  /** A route that reads the task facts selects the edge only. With no obligation on the exit, the step is a single-agent step. */
  it('StepLocator_ARouteThatReadsTasks_IsSingleAgent', () => {
    const document = structuredClone(releaseCheckDefinition());
    const edge = recordAt(edgesOf(document)['build->verify'], 'build->verify');
    edge.route = { kind: 'all', operands: [tasksComplete()] };
    edge.obligation = { kind: 'none' };
    const definition = checked(document);

    expect(definition.exarchos.edges['build->verify']?.route).toStrictEqual({ kind: 'all', operands: [tasksComplete()] });
    expect(locateStep(definition, 'build')).toStrictEqual({ ok: false, rule: 'single-agent-step', compilable: [] });
  });

  /**
   * The clone adds the task-batch step `assemble` after `build`. The kernel order is `build`, `assemble`, and the
   * name order is `assemble`, `build`. The compilable steps follow the kernel order.
   */
  it('StepLocator_TheCompilableSteps_AreInKernelOrder', () => {
    const document = structuredClone(releaseCheckDefinition());
    listAt(document.steps, 'steps').splice(2, 0, {
      kind: 'skill',
      stepId: 'assemble',
      stepName: 'assemble',
      isTerminal: false,
      runtime: 'exarchos',
      stepType: 'IMPLEMENT',
    });
    listAt(document.transitions, 'transitions').push({
      transitionId: 'assemble->verify',
      fromStepId: 'assemble',
      toStepId: 'verify',
      isDefault: false,
    });
    const edges = edgesOf(document);
    edges['assemble->verify'] = structuredClone(edges['build->verify']);
    const definition = checked(document);

    expect(definition.steps.map((step) => step.stepId)).toStrictEqual([
      'scope',
      'build',
      'assemble',
      'verify',
      'completed',
      'cancelled',
    ]);
    expect(compilableSteps(definition)).toStrictEqual(['build', 'assemble']);
    expect(locateStep(definition, 'verify')).toStrictEqual({
      ok: false,
      rule: 'not-an-implement-step',
      compilable: ['build', 'assemble'],
    });
  });

  /** The fixture user definition locates its step `build`, and each other step has its class. */
  it('StepLocator_TheUserFixture_LocatesBuild', () => {
    const definition = checked(releaseCheckDefinition());

    expect(locateStep(definition, 'build')).toStrictEqual({ ok: true, step: { stepId: 'build', kind: 'task-batch' } });
    expect(compilableSteps(definition)).toStrictEqual(['build']);
    expect(definition.steps.map((step) => [step.stepId, classifyStep(definition, step.stepId)])).toStrictEqual([
      ['scope', 'not-an-implement-step'],
      ['build', 'task-batch'],
      ['verify', 'not-an-implement-step'],
      ['completed', 'terminal-step'],
      ['cancelled', 'terminal-step'],
    ]);
  });
});
