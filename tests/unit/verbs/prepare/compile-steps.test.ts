/**
 * The compile path is generic over the steps of a registered definition.
 *
 * The partition stamps the step that the caller gives. The non-goals name each step that follows a step of the batch, in kernel order.
 * The capsule binds the authority of the pinned definition, with the catalog invariants on top.
 * The cases read the refactor definition and clones of the fixture user definition. Each clone passes the user rules first.
 * Each expected step and statement is written by hand from the fixture or from the refactor definition file.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/compile-capsule.ts, ../../../helpers/definitions/user-definition.ts
 */

import { describe, expect, it } from 'vitest';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  compileDelegationCapsule,
  PREPARE_COMPILER_VERSION,
  type CompileCapsuleInput,
  type CompileOutcome,
} from '../../../../src/verbs/prepare/compile-capsule.js';
import {
  lowerBuiltInDefinition,
  lowerDefinition,
  type LoweredDefinition,
} from '../../../../src/verbs/prepare/lower-definition.js';
import {
  partitionDelegationBatch,
  type BatchTaskVerification,
  type DelegationBatch,
} from '../../../../src/verbs/prepare/partition-tasks.js';
import type { ExarchosDefinition } from '../../../../src/workflow/definitions/extension.js';
import { checkUserDefinition } from '../../../../src/workflow/definitions/user.js';
import { resolveVerificationPolicy } from '../../../../src/workflow/verification-policy-resolver.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';

/** Two ready tasks of a plan, with no blocker. */
const PLAN: readonly unknown[] = [
  { id: 'T-1', title: 'first', status: 'pending', blockedBy: [] },
  { id: 'T-2', title: 'second', status: 'pending', blockedBy: [] },
];

/** The verification terms that the partition gives a task with no stamp and no file. */
const DEFAULT_TERMS: BatchTaskVerification = { riskTier: 'medium', boundaryTouching: false };

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

/** The checked definition of a raw document. A document that fails the user rules fails the case. */
function checked(document: unknown): ExarchosDefinition {
  const result = checkUserDefinition(document);
  if (!result.ok) throw new Error(`the document fails the user rules: ${JSON.stringify(result.findings)}`);
  return result.definition;
}

/** The lowered built-in definition of a type. A type that does not lower fails the case. */
function builtIn(workflowType: string): LoweredDefinition {
  const lowered = lowerBuiltInDefinition(workflowType);
  if (lowered === undefined) throw new Error(`the ${workflowType} workflow did not lower`);
  return lowered;
}

/** The batch of a plan at a step. A refused partition fails the case. */
function batchOf(plan: readonly unknown[], stepId: string): DelegationBatch {
  const outcome = partitionDelegationBatch(plan, stepId);
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome.batch;
}

/** The input of a direct compilation of a batch under a lowered definition, with no pin and no design record. */
function inputFor(
  lowered: LoweredDefinition,
  batch: DelegationBatch,
  overrides: Partial<CompileCapsuleInput> = {},
): CompileCapsuleInput {
  return {
    workflowId: 'release-check-unit',
    capsuleVersion: 1,
    lowered,
    batch,
    catalogInvariants: [],
    designRef: undefined,
    designVersion: 1,
    designRevisions: [],
    acceptedChanges: [],
    compilerVersion: PREPARE_COMPILER_VERSION,
    baseRef: 'feat/release-check',
    executionProfile: { capabilities: [] },
    verificationSequence: (riskTier, boundaryTouching) => resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
    compiledAt: '2026-11-11T00:00:00Z',
    ...overrides,
  };
}

/** The capsule of a compilation. A refused compilation fails the case. */
function capsuleOf(outcome: CompileOutcome): ExarchosCapsuleV1 {
  if (!outcome.ok) throw new Error(`${outcome.refusal.code}: ${outcome.refusal.message}`);
  return outcome.capsule;
}

/** The non-goal statement of a step that follows the batch. */
function nonGoal(stepId: string): { statement: string } {
  return { statement: `The work of the '${stepId}' step, which follows this batch.` };
}

/**
 * A clone of the fixture with the task-batch step `assemble` after `build`. Its one exit is `assemble->completed`.
 * The transition comes after `build->verify` in the kernel order, so the two steps of a batch have different exits.
 */
function withAssemble(): ExarchosDefinition {
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
    transitionId: 'assemble->completed',
    fromStepId: 'assemble',
    toStepId: 'completed',
    isDefault: false,
  });
  const edges = recordAt(recordAt(document.exarchos, 'exarchos').edges, 'exarchos.edges');
  edges['assemble->completed'] = { category: 'route-condition', obligation: { kind: 'none' } };
  return checked(document);
}

describe('the step-generic compile path', () => {
  /** A refactor batch stamps `overhaul-delegate` on each task, and its one non-goal is the exit `overhaul-review`. */
  it('CompileSteps_ARefactorBatch_NamesTheStepsAfterOverhaulDelegate', () => {
    const capsule = capsuleOf(compileDelegationCapsule(inputFor(builtIn('refactor'), batchOf(PLAN, 'overhaul-delegate'))));

    expect(capsule.graph.tasks.map((task) => [task.taskId, task.stepId])).toStrictEqual([
      ['T-1', 'overhaul-delegate'],
      ['T-2', 'overhaul-delegate'],
    ]);
    expect(capsule.intent.nonGoals).toStrictEqual([nonGoal('overhaul-review')]);
  });

  /**
   * One batch holds a task of `build` and a task of `assemble`. The exit of `build` is `verify`, and the exit of
   * `assemble` is `completed`. The non-goals name both exits in the kernel order of the transitions.
   */
  it('CompileSteps_TwoStepsInOneBatch_NameTheStepsAfterEach', () => {
    const definition = withAssemble();
    const batch: DelegationBatch = {
      tasks: [
        { taskId: 'T-1', title: 'first', stepId: 'build', verification: DEFAULT_TERMS },
        { taskId: 'T-2', title: 'second', stepId: 'assemble', verification: DEFAULT_TERMS },
      ],
      dependencies: [],
      joins: [{ joinId: 'batch-complete', waitsFor: ['T-1', 'T-2'] }],
      requiredResults: ['T-1', 'T-2'],
    };

    const capsule = capsuleOf(compileDelegationCapsule(inputFor(lowerDefinition('release-check', definition), batch)));

    expect(definition.transitions.map((transition) => transition.transitionId)).toStrictEqual([
      'scope->build',
      'build->verify',
      'verify->completed',
      'assemble->completed',
    ]);
    expect(capsule.graph.tasks.map((task) => [task.taskId, task.stepId])).toStrictEqual([
      ['T-1', 'build'],
      ['T-2', 'assemble'],
    ]);
    expect(capsule.intent.nonGoals).toStrictEqual([nonGoal('verify'), nonGoal('completed')]);
  });

  /**
   * A clone of the fixture has the self-loop `build->build`, and the batch is stamped `build`.
   * The target of the self-loop is a step of the batch, so the one non-goal is the exit `verify`.
   */
  it('CompileSteps_ASelfLoopOnTheBatchStep_IsNoNonGoal', () => {
    const document = structuredClone(releaseCheckDefinition());
    listAt(document.transitions, 'transitions').push({
      transitionId: 'build->build',
      fromStepId: 'build',
      toStepId: 'build',
      isDefault: false,
    });
    const edges = recordAt(recordAt(document.exarchos, 'exarchos').edges, 'exarchos.edges');
    edges['build->build'] = { category: 'route-condition', obligation: { kind: 'none' } };
    const definition = checked(document);

    const capsule = capsuleOf(compileDelegationCapsule(inputFor(lowerDefinition('release-check', definition), batchOf(PLAN, 'build'))));

    expect(definition.transitions.map((transition) => transition.transitionId)).toContain('build->build');
    expect(capsule.graph.tasks.map((task) => task.stepId)).toStrictEqual(['build', 'build']);
    expect(capsule.intent.nonGoals).toStrictEqual([nonGoal('verify')]);
  });

  /**
   * The capsule of the fixture binds the authority of the fixture, with the catalog invariant appended.
   * So the capsule delegates the one decision of the fixture, `release-order`, and no built-in decision.
   */
  it('CompileSteps_TheAuthority_IsTheAuthorityOfTheDefinition', () => {
    const fixture = recordAt(releaseCheckDefinition().authority, 'authority');
    const catalogInvariants = [{ id: 'release-tags', summary: 'A release ships from a tagged commit.' }];

    const capsule = capsuleOf(
      compileDelegationCapsule(
        inputFor(lowerDefinition('release-check', checked(releaseCheckDefinition())), batchOf(PLAN, 'build'), {
          catalogInvariants,
        }),
      ),
    );

    expect(capsule.authority).toStrictEqual({
      ...fixture,
      invariants: [
        ...listAt(fixture.invariants, 'authority.invariants'),
        { id: 'release-tags', statement: 'A release ships from a tagged commit.' },
      ],
    });
    expect(capsule.authority.delegatedDecisions.map((decision) => decision.id)).toStrictEqual(['release-order']);
    expect(capsule.provenance.sources).toContainEqual({ sourceId: 'authority', digest: contentDigest(capsule.authority) });
  });

  /**
   * The kernel takes an empty list of delegated decisions, and the capsule authority schema refuses it.
   * The compilation refuses the capsule as unsound, and the message names the finding and the path of the fault.
   */
  it('CompileSteps_AnAuthorityThatTheCapsuleRefuses_IsCapsuleUnsound', () => {
    const definition = checked(releaseCheckDefinition());
    const refusedAuthority: ExarchosDefinition = {
      ...definition,
      authority: { ...definition.authority, delegatedDecisions: [] },
    };

    const outcome = compileDelegationCapsule(
      inputFor(lowerDefinition('release-check', refusedAuthority), batchOf(PLAN, 'build')),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('CAPSULE_UNSOUND');
    expect(outcome.refusal.message).toContain('(finding: authority)');
    expect(outcome.refusal.message).toContain('authority.delegatedDecisions');
  });

  /** The partition stamps the step that the caller gives on each task of the batch. */
  it('PartitionSteps_TheBatch_StampsTheGivenStep', () => {
    const batch = batchOf(PLAN, 'build');

    expect(batch.tasks.map((task) => [task.taskId, task.stepId])).toStrictEqual([
      ['T-1', 'build'],
      ['T-2', 'build'],
    ]);
  });

  /**
   * A user definition lowers to its kernel: the fixture without its `exarchos` key. Its version is the digest of that kernel.
   * An edit of the extension alone does not move the version.
   */
  it('LowerDefinition_AUserDefinition_IsItsKernelWithItsDigest', () => {
    const { exarchos: _extension, ...kernel } = releaseCheckDefinition();
    const edited = releaseCheckDefinition();
    const buildEdge = recordAt(
      recordAt(recordAt(edited.exarchos, 'exarchos').edges, 'exarchos.edges')['build->verify'],
      'build->verify',
    );
    recordAt(buildEdge.obligation, 'build->verify.obligation').gateId = 'release-tasks-renamed';

    const lowered = lowerDefinition('release-check', checked(releaseCheckDefinition()));

    expect(lowered.workflowType).toBe('release-check');
    expect(lowered.definition).toStrictEqual(kernel);
    expect(lowered.definitionVersion).toBe(contentDigest(kernel));
    expect(lowerDefinition('release-check', checked(edited)).definitionVersion).toBe(lowered.definitionVersion);
  });
});
