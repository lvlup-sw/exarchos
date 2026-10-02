// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds after the segment runs — queried back by each leaf's DERIVED operation id rather than read off the receipt, so a leaf that emitted nothing cannot borrow a predecessor's rows
//
// Runs the live orchestrate handler table over the deterministic subset of the
// shipped review runbook. The subset leaves out `check_static_analysis`, which
// runs the project toolchain in a shell. The four other leaves decide in-process.
// Their steps come unchanged from the shipped runbook, so the compiler builds the
// shipped arguments.
//
// `check_invariant_conformance` requires a resolved review gate, and no leaf in
// the segment produces one. Thus a stream with only an active phase attempt
// stops at that leaf. Each gate in `REPAIRED` holds its evidence row and its
// signal row under its own derived identity. The kill probe reverts one gate to
// a bare append and shows that the executor refuses it.

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

/** The three gates in the subset that declare `durable-evidence` in `ensures`. */
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
    handlerTool: 'exarchos_orchestrate',
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
  /**
   * The two leaves before the halt run and pass, so the halt comes from the
   * requirement, not from a segment that did not start. Admission runs in
   * execution order, so the refusal comes after the effects of the earlier
   * leaves. Their rows stay, and the operation record still commits.
   */
  it('QualityEvaluation_WithoutTheReviewFloor_HaltsAtInvariantConformance', async () => {
    const result = await execute('op-quality-unadmitted');
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.leaves.map((leaf) => [leaf.action, leaf.status])).toEqual([
      ['check_security_scan', 'passed'],
      ['check_convergence', 'passed'],
      ['check_invariant_conformance', 'failed'],
    ]);
    expect(receipt.failedLeaf).toBe('check_invariant_conformance');
    expect(receipt.failure?.message).toContain('was not admitted');

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

  /** Each leaf holds both rows under its own derived operation id. */
  it('QualityEvaluation_EveryLeaf_HoldsItsEvidenceAndSignal', async () => {
    await seedReviewFloor();
    await execute('op-quality-rows');

    for (const [index, action] of COVERED.entries()) {
      const derived = derivedLeafOperationId('op-quality-rows', index, action);
      const types = (await rowsFor(derived)).map((row) => row.type).sort();
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

  /**
   * The segment crashes before the commit, so no claim persists and the retry
   * runs each leaf again from the first. These gates emit their own
   * `gate.executed` inside the provider, and the retry runs the provider again.
   * Each leaf must still hold exactly one row of each type, not a second
   * `gate.executed` under the same identity.
   */
  it('QualityEvaluation_CrashedMidSegmentThenRetried_LeavesOneRowPerLeaf', async () => {
    await seedReviewFloor();

    const verdict = ACTION_HANDLERS.check_review_verdict;
    if (verdict === undefined) throw new Error('check_review_verdict has no handler');
    let crash = true;
    const handlers: LeafHandlerTable = {
      ...ACTION_HANDLERS,
      check_review_verdict: async (args, dir, ctx) => {
        if (crash) throw new Error('mid-segment crash');
        return verdict(args, dir, ctx);
      },
    };

    await expect(execute('op-quality-crash', handlers)).rejects.toThrow('mid-segment crash');
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(0);

    crash = false;
    const result = await execute('op-quality-crash', handlers);

    expect(result.success).toBe(true);
    for (const [index, action] of COVERED.entries()) {
      const derived = derivedLeafOperationId('op-quality-crash', index, action);
      const types = (await rowsFor(derived)).map((row) => row.type).sort();
      expect(types, action).toEqual(['admission.evidence-recorded', 'gate.executed']);
    }
  });

  /**
   * A kill probe. One leaf does a bare `gate.executed` append and returns a
   * success carrier, with no durable evidence. The contract of the action still
   * declares the evidence, so the executor refuses the leaf. The step has
   * `onFail: 'continue'`, but a leaf that breaks its own postcondition halts
   * the segment.
   */
  it('QualityEvaluation_GateRevertedToABareAppend_IsRefusedByTheExecutor', async () => {
    await seedReviewFloor();

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
    const step = subsetRunbook().steps.find((entry) => entry.action === 'check_convergence');
    expect(step?.onFail).toBe('continue');
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual([
      'check_security_scan',
      'check_convergence',
    ]);
  });

  /**
   * The denominator of the kill probe. Each gate in `REPAIRED` declares the
   * postcondition that the probe trips, so the probe samples a class of gates.
   */
  it('QualityEvaluation_RepairedGates_AllThreeDeclareDurableEvidence', () => {
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
