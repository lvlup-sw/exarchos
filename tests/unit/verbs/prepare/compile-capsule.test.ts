// Compiling a delegation batch into a capsule, validated against the definition
// it pins — and, as the denominator, adjudicated by the real settlement pass.
//
// @oracle-sources: ../../../../src/verbs/prepare/compile-capsule.ts, the real settlement adjudicator's verdict on the compiled capsule and task ids and edges worked out by hand from each fixture plan

import { describe, it, expect } from 'vitest';

import { resolveCapsuleReferences } from '../../../../src/contract/capsule/capsule-references.js';
import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { bindCatalogInvariants } from '../../../../src/verbs/prepare/bind-authority.js';
import { builtInWorkflowAuthority } from '../../../../src/verbs/prepare/built-in-authority.js';
import {
  compileDelegationCapsule,
  type CompileCapsuleInput,
} from '../../../../src/verbs/prepare/compile-capsule.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import {
  partitionDelegationBatch,
  type DelegationBatch,
} from '../../../../src/verbs/prepare/partition-tasks.js';
import { adjudicateSettlement } from '../../../../src/verbs/settle/adjudicate.js';
import { resolveVerificationPolicy } from '../../../../src/workflow/verification-policy-resolver.js';

function featureDefinition(): NonNullable<ReturnType<typeof lowerBuiltInDefinition>> {
  const lowered = lowerBuiltInDefinition('feature');
  if (lowered === undefined) throw new Error('the feature workflow did not lower');
  return lowered;
}

function batchOf(tasks: readonly unknown[]): DelegationBatch {
  const outcome = partitionDelegationBatch(tasks);
  if (!outcome.ok) throw new Error(outcome.refusal.message);
  return outcome.batch;
}

function input(overrides: Partial<CompileCapsuleInput> = {}): CompileCapsuleInput {
  return {
    workflowId: 'feat-prepare-unit',
    capsuleVersion: 1,
    lowered: featureDefinition(),
    batch: batchOf([
      { id: 'T-1', title: 'first', status: 'pending', blockedBy: [] },
      { id: 'T-2', title: 'second', status: 'pending', blockedBy: ['T-1'] },
      { id: 'T-3', title: 'third', status: 'pending', blockedBy: [] },
    ]),
    catalogInvariants: [],
    designRef: 'docs/specs/feature.md',
    baseRef: 'feature/prepare-unit',
    executionProfile: { capabilities: ['fs:read', 'shell:exec'] },
    verificationSequence: (riskTier, boundaryTouching) => resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
    compiledAt: '2026-09-12T00:00:00Z',
    ...overrides,
  };
}

describe('delegation capsule compilation', () => {
  /** The test checks the schema and the references itself, so a compiler that skips its own validation still fails here. */
  it('Compile_ARealBatch_ParsesAndResolvesAgainstThePinnedDefinition', () => {
    const outcome = compileDelegationCapsule(input());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    const { capsule } = outcome;
    expect(ExarchosCapsuleV1Schema.safeParse(capsule).success).toBe(true);
    expect(resolveCapsuleReferences(capsule, { definition: featureDefinition().definition }).ok).toBe(true);
    expect(capsule.identity.definitionVersion).toBe(featureDefinition().definitionVersion);
    expect(capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-1', 'T-3']);
    expect(capsule.graph.dependencies).toEqual([]);
    expect(capsule.graph.joins).toEqual([{ joinId: 'batch-complete', waitsFor: ['T-1', 'T-3'], mode: 'all' }]);
    expect(capsule.settlementContract.requiredResults).toEqual(['T-1', 'T-3']);
  });

  it('Compile_TheCompletionPredicate_IsTheTaskObligationWithoutTeamTeardown', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const { declares } = outcome.capsule.graph.completionPredicate;
    const fields = Object.keys(declares.fields).sort();
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.startsWith('tasks.'))).toBe(true);
    expect(fields).not.toContain('team.disbandedOk');
  });

  /**
   * A runtime returns where it worked and what it produced, but no evidence and no verified flag.
   * Settlement derives both from the task verification against that worktree, so a result cannot certify itself.
   * The evidence kinds are the ladder gate classes from the registry.
   */
  it('Compile_EveryTaskResult_RequiresTheWorktree_AndCarriesNoEvidence', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const results = outcome.capsule.contracts.taskResults;
    expect(Object.keys(results).sort()).toEqual(['T-1', 'T-3']);
    for (const fields of Object.values(results)) {
      expect(fields.find((field) => field.name === 'worktreePath')).toEqual({
        name: 'worktreePath',
        type: 'string',
        required: true,
      });
      expect(fields.find((field) => field.name === 'branch')).toEqual({
        name: 'branch',
        type: 'string',
        required: false,
      });
      const names = fields.map((field) => field.name);
      expect(names).not.toContain('taskId');
      expect(names).not.toContain('evidence');
      expect(names).not.toContain('verified');
      expect(names).toEqual(expect.arrayContaining(['artifacts', 'files', 'tests', 'implements', 'duration']));
    }
    expect(outcome.capsule.contracts.evidenceKinds).toEqual([
      'static-analysis',
      'test-adequacy',
      'integration-suite',
      'contract-drift',
      'mock-boundary',
    ]);
  });

  /**
   * The planner stamp wins. Otherwise the file-and-layer heuristic decides, and a task with no signal is medium and not boundary-touching.
   * The terms live in the settlement contract and not on the graph node. The tier chooses the gates, so a runtime must not choose its own.
   */
  it('Compile_EveryTask_CarriesTheVerificationTermsThePlanResolves', () => {
    const outcome = compileDelegationCapsule(
      input({
        batch: batchOf([
          { id: 'T-1', title: 'stamped', status: 'pending', blockedBy: [], riskTier: 'high', boundaryTouching: false },
          { id: 'T-2', title: 'plain', status: 'pending', blockedBy: [] },
          { id: 'T-3', title: 'adapter', status: 'pending', blockedBy: [], testLayer: 'integration' },
        ]),
      }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.settlementContract.taskVerification).toEqual({
      'T-1': { riskTier: 'high', boundaryTouching: false, baseRef: 'feature/prepare-unit' },
      'T-2': { riskTier: 'medium', boundaryTouching: false, baseRef: 'feature/prepare-unit' },
      'T-3': { riskTier: 'medium', boundaryTouching: true, baseRef: 'feature/prepare-unit' },
    });
    expect(outcome.capsule.graph.tasks[0]).toEqual({ taskId: 'T-1', title: 'stamped', stepId: 'delegate' });
  });

  /** An empty profile says nothing, so the compiler omits the optional section. */
  it('Compile_TheExecutionProfile_IsAttachedAsHandedIn_AndOmittedWhenEmpty', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.executionProfile).toEqual({ capabilities: ['fs:read', 'shell:exec'] });
    const bare = compileDelegationCapsule(input({ executionProfile: { capabilities: [] } }));
    if (!bare.ok) throw new Error(bare.refusal.message);
    expect(bare.capsule.executionProfile).toBeUndefined();
  });

  /** One statement for each distinct profile in the batch, in profile order, from the policy resolver. */
  it('Compile_TheBoundKnowledge_NamesTheGatesEachTierIsVerifiedBy', () => {
    const outcome = compileDelegationCapsule(
      input({
        batch: batchOf([
          { id: 'T-1', title: 'stamped', status: 'pending', blockedBy: [], riskTier: 'high', boundaryTouching: true },
          { id: 'T-2', title: 'plain', status: 'pending', blockedBy: [] },
          { id: 'T-3', title: 'plain too', status: 'pending', blockedBy: [] },
        ]),
      }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.knowledge.patterns.map((p) => p.statement)).toEqual([
      'A task at riskTier=high, boundaryTouching=true is verified at settlement by: check_static_analysis, check_test_adequacy, check_integration_suite, check_contract_drift, check_mock_boundary.',
      'A task at riskTier=medium, boundaryTouching=false is verified at settlement by: check_static_analysis, check_test_adequacy.',
    ]);
  });

  /** Settlement reads the material kinds from the pinned capsule, so the compiler must write them there. */
  it('Compile_TheEnvelope_PinsTheMaterialKinds', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.capsule.contracts.deviationEnvelope.materialDeviationKinds).toEqual(['invalidated-assumption']);
  });

  /**
   * The envelope refuses a deviation of a kind that is not allowed, so a material kind outside the allowed kinds never applies.
   * The length assertion keeps the comparison from passing on an empty list.
   */
  it('Compile_EachMaterialKind_IsAlsoAnAllowedKind', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const { allowedDeviationKinds, materialDeviationKinds } = outcome.capsule.contracts.deviationEnvelope;
    const material = materialDeviationKinds ?? [];
    expect(material.length).toBeGreaterThan(0);
    expect(material.filter((kind) => !allowedDeviationKinds.includes(kind))).toEqual([]);
  });

  /**
   * This case is the denominator for the refusal cases below.
   * A compiler that emits terms that cannot settle passes the structural tests in this file.
   */
  it('Compile_ACompiledCapsule_IsOneTheRealAdjudicatorCanSettle', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const claims = ['T-1', 'T-3'].map((taskId) => ({
      taskId,
      fields: { worktreePath: `/worktrees/${taskId}`, files: ['src/a.ts'] },
      evidence: [],
    }));
    const verdict = adjudicateSettlement(outcome.capsule, claims, [], { evidenceResolves: () => true });
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
  });

  it('Compile_ACyclicBatch_IsRefusedAsUnsound', () => {
    const terms = { riskTier: 'medium', boundaryTouching: false } as const;
    const outcome = compileDelegationCapsule(
      input({
        batch: {
          tasks: [
            { taskId: 'T-1', title: 'first', stepId: 'delegate', verification: terms },
            { taskId: 'T-2', title: 'second', stepId: 'delegate', verification: terms },
          ],
          dependencies: [
            { from: 'T-1', to: 'T-2' },
            { from: 'T-2', to: 'T-1' },
          ],
          joins: [],
          requiredResults: ['T-1', 'T-2'],
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('CAPSULE_UNSOUND');
      expect(outcome.refusal.message).toContain('cycle');
    }
  });

  /** Tasks name the step `delegate`, so a pinned definition without that step cannot be the one they ran under. */
  it('Compile_ADefinitionWithoutTheDelegationStep_IsRefusedAsUnsound', () => {
    const lowered = featureDefinition();
    const withoutDelegate = {
      ...lowered,
      definition: {
        ...lowered.definition,
        steps: lowered.definition.steps.filter((step) => step.stepId !== 'delegate'),
        transitions: lowered.definition.transitions.filter(
          (t) => t.fromStepId !== 'delegate' && t.toStepId !== 'delegate',
        ),
      },
    };
    const outcome = compileDelegationCapsule(input({ lowered: withoutDelegate }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('CAPSULE_UNSOUND');
      expect(outcome.refusal.message).toContain('delegate');
    }
  });

  it('Compile_CatalogInvariants_AreBoundOnTopOfTheBuiltInAuthority', () => {
    const outcome = compileDelegationCapsule(
      input({ catalogInvariants: [{ id: 'INV-1', summary: 'a catalog statement' }] }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const ids = outcome.capsule.authority.invariants.map((i) => i.id);
    expect(ids).toContain('INV-1');
    expect(ids).toContain('append-only-history');
  });

  it('Compile_TheSameInputs_CompileTheSameCapsule', () => {
    const first = compileDelegationCapsule(input());
    const second = compileDelegationCapsule(input());
    expect(second).toEqual(first);
  });
});

describe('catalog invariant binding', () => {
  it('BindCatalog_AppendsInCatalogOrderAndBindsEachIdOnce', () => {
    const base = builtInWorkflowAuthority();
    const bound = bindCatalogInvariants(base, [
      { id: 'INV-2', summary: 'second' },
      { id: 'INV-2', summary: 'duplicate' },
      { id: 'append-only-history', summary: 'already in the base' },
      { id: 'INV-3', summary: '   ' },
      { id: 'INV-4', summary: 'fourth' },
    ]);
    const added = bound.invariants.slice(base.invariants.length);
    expect(added).toEqual([
      { id: 'INV-2', statement: 'second' },
      { id: 'INV-4', statement: 'fourth' },
    ]);
  });

  it('BindCatalog_AnEmptyCatalog_LeavesTheBaseAsItIs', () => {
    const base = builtInWorkflowAuthority();
    expect(bindCatalogInvariants(base, [])).toEqual(base);
  });
});
