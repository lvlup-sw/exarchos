// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds after the segment runs — queried back by each leaf's DERIVED operation id rather than read off the receipt, so a leaf that emitted nothing cannot borrow a predecessor's rows
//
// ─── Executing the review-closeout segment ──────────────────────────────────
//
// The LIVE orchestrate handler table over the DETERMINISTIC subset of the
// shipped review runbook. `check_static_analysis` is excluded because it shells
// out to the project's toolchain, which would make a unit verdict depend on the
// machine; the four remaining leaves reach a decision in-process. Their STEPS
// are lifted verbatim from the shipped runbook rather than rewritten, so the
// arguments the compiler builds are the shipped ones.
//
// Two facts are load-bearing here and each has its own case:
//
//   The segment's stated PRECONDITION is real. `check_invariant_conformance`
//   requires a resolved review gate, no leaf in the segment produces one, and
//   the verdict leaf's own evidence does not satisfy it — so a stream carrying
//   only an active phase attempt is refused at that leaf, by name.
//
//   The three gates repaired for this slice actually pay their declaration.
//   Each holds BOTH its evidence row and its signal row under its own derived
//   identity; the kill probe below reverts one to the bare-append shape it had
//   and shows the executor refusing it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { emitGateEvent } from '../../../../src/verbs/gates/gate-utils.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import {
  derivedLeafOperationId,
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  type ExecuteIntentDeps,
  type LeafHandlerTable,
} from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  seedActivePhaseAttempt,
  seedGateEvidence,
} from '../../../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring, receiptOf } from './fixtures.js';

const SHIPPED_INTENT = 'quality-evaluation';
const SUBSET_INTENT = 'quality-evaluation-no-shell-subset';
const STREAM = 'wf-quality-exec';

/** The leaves this file drives, in the order the shipped runbook lists them. */
const COVERED = [
  'check_security_scan',
  'check_convergence',
  'check_invariant_conformance',
  'check_review_verdict',
];

/** The three gates whose durable-evidence declaration this slice repaired. */
const REPAIRED = ['check_security_scan', 'check_convergence', 'check_invariant_conformance'];

const INTENT_ARGS = {
  high: 0,
  medium: 0,
  low: 0,
  diffContent: '+export const answer = 42;\n',
};

function shippedSteps(): readonly RunbookStep[] {
  const runbook = ALL_RUNBOOKS.find((entry) => entry.id === SHIPPED_INTENT);
  if (runbook === undefined) throw new Error(`the ${SHIPPED_INTENT} runbook is missing`);
  const steps = runbook.steps.filter((step) => COVERED.includes(step.action));
  expect(steps.map((step) => step.action)).toEqual(COVERED);
  return steps;
}

function subsetRunbook(): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === SHIPPED_INTENT);
  if (shipped === undefined) throw new Error(`the ${SHIPPED_INTENT} runbook is missing`);
  return { ...shipped, id: SUBSET_INTENT, steps: [...shippedSteps()] };
}

let stateDir: string;
let store: EventStore;
let phaseAttemptId: string;

function deps(handlers: LeafHandlerTable = ACTION_HANDLERS): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS[SHIPPED_INTENT];
  if (schema === undefined) throw new Error(`no argument schema for ${SHIPPED_INTENT}`);
  return {
    runbookTable: [subsetRunbook()],
    findAction: findActionInRegistry,
    argSchemas: { [SUBSET_INTENT]: schema },
    handlers,
  };
}

async function execute(
  operationId: string,
  handlers?: LeafHandlerTable,
): Promise<ToolResult> {
  return runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent(
      { intent: SUBSET_INTENT, streamId: STREAM, args: INTENT_ARGS, operationId },
      stateDir,
      fixtureWiring(stateDir, store),
      deps(handlers),
    ),
  );
}

async function rowsFor(operationId: string): Promise<WorkflowEvent[]> {
  return store.query(STREAM, { operationId });
}

/** Record the review gate the invariant leaf requires and no leaf here produces. */
async function seedReviewFloor(): Promise<void> {
  await seedGateEvidence(store, {
    streamId: STREAM,
    requirementId: 'review',
    phaseAttemptId,
  });
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'quality-eval-exec-'));
  store = new EventStore(stateDir);
  await store.initialize();
  phaseAttemptId = await seedActivePhaseAttempt(store, STREAM, { phase: 'review' });
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('quality-evaluation over the deterministic leaf subset', () => {
  it('QualityEvaluation_WithoutTheReviewFloor_HaltsAtInvariantConformance', async () => {
    const result = await execute('op-quality-unadmitted');
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    // The two leaves ahead of it ran and passed — the halt is the REQUIREMENT,
    // not a segment that never started.
    expect(receipt.leaves.map((leaf) => [leaf.action, leaf.status])).toEqual([
      ['check_security_scan', 'passed'],
      ['check_convergence', 'passed'],
      ['check_invariant_conformance', 'failed'],
    ]);
    expect(receipt.failedLeaf).toBe('check_invariant_conformance');
    expect(receipt.failure?.message).toContain('was not admitted');

    // Admission is evaluated in EXECUTION order, so the refusal happened after
    // its predecessors' effects rather than at compile time. Both still hold
    // their rows, and the operation record still committed.
    for (const [index, action] of [[0, 'check_security_scan'], [1, 'check_convergence']] as const) {
      const derived = derivedLeafOperationId('op-quality-unadmitted', index, action);
      expect((await rowsFor(derived)).length, action).toBeGreaterThan(0);
    }
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
  });

  it('QualityEvaluation_WithTheReviewFloorSeeded_Commits', async () => {
    await seedReviewFloor();

    const result = await execute('op-quality-committed');
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual(COVERED);
    expect(receipt.leaves.every((leaf) => leaf.status === 'passed')).toBe(true);
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
  });

  it('QualityEvaluation_EveryLeaf_HoldsItsEvidenceAndSignal', async () => {
    await seedReviewFloor();
    await execute('op-quality-rows');

    for (const [index, action] of COVERED.entries()) {
      const derived = derivedLeafOperationId('op-quality-rows', index, action);
      const types = (await rowsFor(derived)).map((row) => row.type).sort();
      // Both rows under THIS leaf's identity. The evidence row is the one three
      // of these four could not produce before this slice.
      expect(types, action).toEqual(['admission.evidence-recorded', 'gate.executed']);
    }
  });

  it('QualityEvaluation_Replay_ReturnsThePersistedReceiptAndRunsNothing', async () => {
    await seedReviewFloor();

    const first = receiptOf(await execute('op-quality-replay'));
    const before = await store.query(STREAM);
    const second = receiptOf(await execute('op-quality-replay'));
    const after = await store.query(STREAM);

    expect(second).toEqual(first);
    expect(after.map((row) => `${row.sequence}:${row.type}`)).toEqual(
      before.map((row) => `${row.sequence}:${row.type}`),
    );
  });

  // ─── Kill probe for the durable-evidence repair ───────────────────────────

  it('QualityEvaluation_GateRevertedToABareAppend_IsRefusedByTheExecutor', async () => {
    await seedReviewFloor();

    // One leaf reverted to what it did before the repair: a `gate.executed`
    // append and a success carrier, with no durable evidence behind it. The
    // action's own contract still declares the evidence, so the executor must
    // refuse the leaf rather than accept a success that broke its postcondition.
    // Reverting the real handler is what makes this a probe and not a
    // restatement — remove the repair and this is what the shipped path does.
    const reverted: LeafHandlerTable = {
      ...ACTION_HANDLERS,
      check_convergence: async (args, _stateDir, ctx) => {
        if (ctx === undefined) throw new Error('probe requires a dispatch context');
        await emitGateEvent(ctx.eventStore, String(args.featureId), 'convergence', 'meta', true, {
          phase: 'meta',
        });
        return { success: true, data: { passed: true } };
      },
    };

    const result = await execute('op-quality-killprobe', reverted);
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.failedLeaf).toBe('check_convergence');
    expect(receipt.failure?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(receipt.failure?.message).toContain(
      "leaf 'check_convergence' returned success without the postconditions it declares",
    );
    expect(receipt.failure?.message).toContain('evidence gate');
    // `onFail: 'continue'` on this step did NOT license it: a leaf that broke
    // its own postcondition halts whatever the step's failure policy says.
    const step = subsetRunbook().steps.find((entry) => entry.action === 'check_convergence');
    expect(step?.onFail).toBe('continue');
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual([
      'check_security_scan',
      'check_convergence',
    ]);
  });

  it('QualityEvaluation_RepairedGates_AllThreeDeclareDurableEvidence', () => {
    // The denominator for the probe above: the three repaired gates all declare
    // the postcondition the probe trips, so the probe is a sample of a class
    // rather than a one-off.
    for (const action of REPAIRED) {
      const declaration = findActionInRegistry('exarchos_orchestrate', action);
      expect(declaration, action).toBeDefined();
      const ensures = declaration?.actionContract?.ensures;
      expect(ensures?.kind, action).toBe('declared');
      const sources =
        ensures?.kind === 'declared' ? ensures.values.map((value) => value.source) : [];
      expect(sources, action).toContain('durable-evidence');
    }
  });
});
