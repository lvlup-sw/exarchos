/**
 * The compiler pins the scope of the batch and the base commit of each task, and it states where each task forks from.
 *
 * The compiler is pure, so each case passes the scope and the base commit that the handler observes.
 * The expectations are written by hand from those inputs.
 */

import { describe, expect, it } from 'vitest';

import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  compileDelegationCapsule,
  PREPARE_COMPILER_VERSION,
  type CompileCapsuleInput,
} from '../../../../src/verbs/prepare/compile-capsule.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { partitionDelegationBatch } from '../../../../src/verbs/prepare/partition-tasks.js';
import { resolveVerificationPolicy } from '../../../../src/workflow/verification-policy-resolver.js';

/** The base of the fixture batch. */
const BASE_REF = 'feature/compile-scope';

/** The commit of the base, as the handler resolves it in the checkout: a full SHA-256 object name. */
const BASE_COMMIT = '0123456789abcdef'.repeat(4);

/** The scope of the fixture batch, as the handler observes it. */
const SCOPE = {
  repository: '/repos/compile-scope/.git',
  checkout: '/repos/compile-scope',
  configDigest: 'e'.repeat(64),
};

/** The input of one compilation of two ready tasks with the fixture scope. */
function input(): CompileCapsuleInput {
  return { ...unpinnedInput(), pin: { scope: SCOPE, baseCommit: BASE_COMMIT } };
}

/** The same input with no pin, as a direct caller of the compiler can pass it. */
function unpinnedInput(): CompileCapsuleInput {
  const lowered = lowerBuiltInDefinition('feature');
  if (lowered === undefined) throw new Error('the feature workflow did not lower');
  const partition = partitionDelegationBatch([
    { id: 'T-1', title: 'first', status: 'pending', blockedBy: [], riskTier: 'high', boundaryTouching: true },
    { id: 'T-2', title: 'second', status: 'pending', blockedBy: [] },
  ]);
  if (!partition.ok) throw new Error(partition.refusal.message);
  return {
    workflowId: 'feat-compile-scope',
    capsuleVersion: 1,
    lowered,
    batch: partition.batch,
    catalogInvariants: [],
    designRef: undefined,
    designVersion: 1,
    designRevisions: [],
    acceptedChanges: [],
    compilerVersion: PREPARE_COMPILER_VERSION,
    baseRef: BASE_REF,
    executionProfile: { capabilities: ['fs:read', 'shell:exec'] },
    verificationSequence: (riskTier, boundaryTouching) => resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
    compiledAt: '2026-10-24T00:00:00Z',
  };
}

describe('the compiler pins the scope and the base commit', () => {
  /**
   * The settlement contract holds the scope once, and each task term holds the base beside its commit.
   * The capsule passes the published contract, so a reader of the stored capsule reads the same terms.
   */
  it('CompileCapsule_TwoTasks_HoldTheSameBaseCommitAndTheScope', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const { settlementContract } = outcome.capsule;

    expect(settlementContract.scope).toStrictEqual({
      repository: '/repos/compile-scope/.git',
      checkout: '/repos/compile-scope',
      configDigest: 'e'.repeat(64),
    });
    expect(settlementContract.taskVerification).toStrictEqual({
      'T-1': { riskTier: 'high', boundaryTouching: true, baseRef: BASE_REF, baseCommit: BASE_COMMIT },
      'T-2': { riskTier: 'medium', boundaryTouching: false, baseRef: BASE_REF, baseCommit: BASE_COMMIT },
    });
    expect(ExarchosCapsuleV1Schema.parse(outcome.capsule).settlementContract.scope?.checkout).toBe('/repos/compile-scope');
    expect(outcome.capsule.provenance.compilerVersion).toBe('exarchos-prepare-5');
  });

  /**
   * The fork statement follows the verification patterns, and it names the base and the commit.
   * A caller that passes no pin gets a capsule with no scope, no base commit and no fork statement.
   */
  it('CompileCapsule_TheForkStatement_NamesTheBaseAndTheCommit', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.knowledge.patterns.map((pattern) => pattern.statement).at(-1)).toBe(
      'Each task forks from feature/compile-scope at 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef. ' +
        'Settlement refuses a worktree that does not hold 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.',
    );
    expect(outcome.capsule.knowledge.patterns).toHaveLength(3);

    const unpinned = compileDelegationCapsule(unpinnedInput());
    if (!unpinned.ok) throw new Error(unpinned.refusal.message);
    expect(unpinned.capsule.settlementContract.scope).toBeUndefined();
    expect(unpinned.capsule.settlementContract.taskVerification?.['T-1']).toStrictEqual({
      riskTier: 'high',
      boundaryTouching: true,
      baseRef: BASE_REF,
    });
    expect(unpinned.capsule.knowledge.patterns.map((pattern) => pattern.statement).join(' ')).not.toContain('forks from');
  });
});
