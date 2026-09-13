// Compiling a delegation batch into a capsule, validated against the definition
// it pins — and, as the denominator, adjudicated by the real settlement pass.

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
    compiledAt: '2026-09-12T00:00:00Z',
    ...overrides,
  };
}

describe('delegation capsule compilation', () => {
  it('Compile_ARealBatch_ParsesAndResolvesAgainstThePinnedDefinition', () => {
    const outcome = compileDelegationCapsule(input());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    const { capsule } = outcome;
    // Asserted independently of the compiler's own validation, so a compiler
    // that skipped it would still be caught here.
    expect(ExarchosCapsuleV1Schema.safeParse(capsule).success).toBe(true);
    expect(resolveCapsuleReferences(capsule, { definition: featureDefinition().definition }).ok).toBe(true);
    expect(capsule.identity.definitionVersion).toBe(featureDefinition().definitionVersion);
    expect(capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(capsule.graph.dependencies).toEqual([{ from: 'T-1', to: 'T-2' }]);
    expect(capsule.graph.joins).toEqual([{ joinId: 'batch-complete', waitsFor: ['T-2', 'T-3'], mode: 'all' }]);
    expect(capsule.settlementContract.requiredResults).toEqual(['T-1', 'T-2', 'T-3']);
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

  it('Compile_EveryTaskResult_RequiresEvidence', () => {
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const results = outcome.capsule.contracts.taskResults;
    expect(Object.keys(results).sort()).toEqual(['T-1', 'T-2', 'T-3']);
    for (const fields of Object.values(results)) {
      expect(fields.find((field) => field.name === 'evidence')).toEqual({
        name: 'evidence',
        type: 'object',
        required: true,
      });
      expect(fields.map((field) => field.name)).not.toContain('taskId');
    }
    expect(outcome.capsule.contracts.evidenceKinds).toEqual(['test', 'build', 'typecheck', 'manual']);
  });

  it('Compile_ACompiledCapsule_IsOneTheRealAdjudicatorCanSettle', () => {
    // The denominator for every refusal below: a capsule this compiler emits
    // can actually be settled. A compiler that produced unsatisfiable terms
    // would pass every structural test in this file.
    const outcome = compileDelegationCapsule(input());
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const claims = ['T-1', 'T-2', 'T-3'].map((taskId) => ({
      taskId,
      fields: { evidence: { type: 'test', output: 'ok', passed: true } },
      evidence: [{ kind: 'test', ref: `run-${taskId}` }],
    }));
    const verdict = adjudicateSettlement(outcome.capsule, claims);
    expect(verdict.findings).toEqual([]);
    expect(verdict.outcome).toBe('settled');
  });

  it('Compile_ACyclicPlan_IsRefusedAsUnsound', () => {
    const outcome = compileDelegationCapsule(
      input({
        batch: batchOf([
          { id: 'T-1', status: 'pending', blockedBy: ['T-2'] },
          { id: 'T-2', status: 'pending', blockedBy: ['T-1'] },
        ]),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('CAPSULE_UNSOUND');
      expect(outcome.refusal.message).toContain('cycle');
    }
  });

  it('Compile_ADefinitionWithoutTheDelegationStep_IsRefusedAsUnsound', () => {
    // The pinned definition is consulted, not assumed: tasks name the step
    // `delegate`, and a definition that lacks it cannot be the one they ran
    // under.
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
