// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds after the segment runs — queried back by each leaf's DERIVED operation id rather than read off the receipt the executor built, so a receipt that claims events nobody wrote cannot satisfy the comparison
//
// ─── Executing the plan-closeout segment end to end ─────────────────────────
//
// The LIVE orchestrate handler table against a real store and a real spec on
// disk. Nothing here is a fixture leaf: the point is that the shipped runbook,
// compiled by the shipped compiler, driven by the shipped executor, produces the
// rows the shipped gates produce — and that the operation record commits on both
// outcomes.
//
// Per-leaf scoping is asserted by DERIVED operation id, not by counting rows on
// the stream. A count would be satisfied by one leaf writing everything.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import {
  derivedLeafOperationId,
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  type ExecuteIntentDeps,
  type LeafHandlerTable,
} from '../../../../src/verbs/execute/executor.js';
import type { IntentReceipt } from '../../../../src/verbs/execute/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring, receiptOf } from './fixtures.js';

const INTENT = 'plan-closeout';
const STREAM = 'wf-plan-closeout-exec';

/** The two blocking gate leaves — the ones that owe durable evidence. */
const GATE_LEAVES: readonly [number, string][] = [
  [0, 'check_plan_coverage'],
  [1, 'check_provenance_chain'],
];

/**
 * A unified spec whose design region defines one requirement and whose
 * decomposition implements it. Both gates read the SAME file, which is the
 * arrangement the single `specPath` argument exists to express.
 */
const COHERENT_SPEC = [
  '# Feature Spec',
  '',
  '## Design & Rationale',
  '',
  '### DR-1: Durable closeout',
  '',
  'The plan gates run over the unified spec and the matrix is emitted.',
  '',
  '## Decomposition',
  '',
  '### Task 001: Durable closeout',
  '**Implements:** DR-1',
  '',
  'Wire the closeout segment.',
  '',
].join('\n');

/** The same document with its requirement definitions removed. */
const SPEC_WITHOUT_REQUIREMENTS = [
  '# Feature Spec',
  '',
  '## Design & Rationale',
  '',
  'Prose with no requirement identifiers at all.',
  '',
  '## Decomposition',
  '',
  '### Task 001: Something',
  '',
].join('\n');

let stateDir: string;
let store: EventStore;
let specPath: string;

function deps(handlers: LeafHandlerTable = ACTION_HANDLERS): ExecuteIntentDeps {
  return {
    runbookTable: ALL_RUNBOOKS,
    findAction: findActionInRegistry,
    argSchemas: INTENT_ARG_SCHEMAS,
    // The LIVE table the orchestrate composite hands the executor, unless a
    // case substitutes one leaf to stage a failure the shipped table cannot.
    handlers,
    handlerTool: 'exarchos_orchestrate',
  };
}

async function execute(
  operationId: string,
  args: Record<string, unknown>,
  handlers?: LeafHandlerTable,
): Promise<ToolResult> {
  return runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent(
      { intent: INTENT, streamId: STREAM, args, operationId },
      stateDir,
      fixtureWiring(stateDir, store),
      deps(handlers),
    ),
  );
}

async function rowsFor(operationId: string): Promise<WorkflowEvent[]> {
  return store.query(STREAM, { operationId });
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'plan-closeout-exec-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM, { phase: 'plan' });
  specPath = path.join(stateDir, 'spec.md');
  await writeFile(specPath, COHERENT_SPEC, 'utf8');
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('plan-closeout over the live handler table', () => {
  it('PlanCloseout_CoherentSpec_CommitsOneOperationRecord', async () => {
    const result = await execute('op-plan-closeout', { specPath });
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual([
      'check_plan_coverage',
      'check_provenance_chain',
      'generate_traceability',
    ]);
    expect(receipt.leaves.every((leaf) => leaf.status === 'passed')).toBe(true);

    // Exactly one operation record — the whole point of the commit.
    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);
  });

  it('PlanCloseout_EachGateLeaf_HoldsItsOwnEvidenceAndSignal', async () => {
    await execute('op-plan-closeout-rows', { specPath });

    for (const [index, action] of GATE_LEAVES) {
      const derived = derivedLeafOperationId('op-plan-closeout-rows', index, action);
      const types = (await rowsFor(derived)).map((row) => row.type).sort();
      // Both rows, under THIS leaf's identity: a predecessor's evidence cannot
      // answer for it.
      expect(types, action).toEqual(['admission.evidence-recorded', 'gate.executed']);
    }

    // The matrix generator declares no emission and writes none, so its derived
    // identity holds nothing — the negative half of the same scoping claim.
    const traceability = derivedLeafOperationId(
      'op-plan-closeout-rows',
      2,
      'generate_traceability',
    );
    expect(await rowsFor(traceability)).toHaveLength(0);
  });

  it('PlanCloseout_SameOperationIdSameRequest_ReplaysWithoutReExecuting', async () => {
    const first = receiptOf(await execute('op-plan-closeout-replay', { specPath }));
    const before = await store.query(STREAM);

    const second = receiptOf(await execute('op-plan-closeout-replay', { specPath }));
    const after = await store.query(STREAM);

    // The identical receipt, read back off the persisted claim.
    expect(second).toEqual(first);
    // And nothing ran: the log is byte-for-byte where the first call left it.
    expect(after.map((row) => `${row.sequence}:${row.type}`)).toEqual(
      before.map((row) => `${row.sequence}:${row.type}`),
    );
  });

  it('PlanCloseout_CrashedMidSegmentThenRetried_LeavesOneRowPerGateLeaf', async () => {
    // The uncommitted retry, which the replay case above cannot reach: a crash
    // before the commit leaves no claim, so the retry re-runs the gate leaves
    // instead of short-circuiting on a persisted receipt. Both gates mint their
    // own `gate.executed` from inside the provider, and the runner re-runs the
    // provider before it can see that this operation already produced evidence
    // — so the row has to be keyed or the second attempt writes a duplicate.
    const traceability = ACTION_HANDLERS.generate_traceability;
    if (traceability === undefined) throw new Error('generate_traceability has no handler');
    let crash = true;
    const handlers: LeafHandlerTable = {
      ...ACTION_HANDLERS,
      generate_traceability: async (args, dir, ctx) => {
        if (crash) throw new Error('mid-segment crash');
        return traceability(args, dir, ctx);
      },
    };

    await expect(execute('op-plan-closeout-crash', { specPath }, handlers)).rejects.toThrow(
      'mid-segment crash',
    );
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(0);

    crash = false;
    const result = await execute('op-plan-closeout-crash', { specPath }, handlers);

    expect(result.success).toBe(true);
    for (const [index, action] of GATE_LEAVES) {
      const derived = derivedLeafOperationId('op-plan-closeout-crash', index, action);
      const types = (await rowsFor(derived)).map((row) => row.type).sort();
      // One of each. Two `gate.executed` rows here would be one gate run
      // described twice, and the receipt bakes those sequences in permanently.
      expect(types, action).toEqual(['admission.evidence-recorded', 'gate.executed']);
    }
  });

  it('PlanCloseout_SameOperationIdDifferentRequest_IsRefused', async () => {
    await execute('op-plan-closeout-digest', { specPath });

    const other = path.join(stateDir, 'other-spec.md');
    await writeFile(other, COHERENT_SPEC, 'utf8');
    const result = await execute('op-plan-closeout-digest', { specPath: other });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INTENT_REPLAY_DIGEST_MISMATCH');
    expect(result.error?.message).toContain('Nothing was executed.');
  });

  it('PlanCloseout_BlockingLeafFails_HaltsAndStillCommits', async () => {
    // A spec with no requirement identifiers: the coverage gate has nothing to
    // cover and the provenance gate has nothing to trace.
    await writeFile(specPath, SPEC_WITHOUT_REQUIREMENTS, 'utf8');

    const result = await execute('op-plan-closeout-halt', { specPath });
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    // The FIRST blocking gate is where it stops, and it stops for the gate's own
    // stated reason rather than a wiring error — a halt on the wrong leaf, or
    // for an admission or handler-lookup fault, would prove nothing about the
    // failure policy.
    expect(receipt.failedLeaf).toBe('check_plan_coverage');
    expect(receipt.failure?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(receipt.failure?.message).toContain('No design subsections found');
    // Halted: the leaves AFTER the failure never ran, so the receipt is short.
    const attempted = receipt.leaves.map((leaf) => leaf.action);
    expect(attempted).toEqual(['check_plan_coverage']);
    expect(receipt.leaves.at(-1)?.status).toBe('failed');

    // "Ran and failed" is distinguishable from "crashed mid-segment": the
    // operation record is there either way the segment ENDED, and only a crash
    // leaves none.
    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);

    // The refusal reaches the caller with the receipt facts attached, not only
    // on `data` — a failed dispatch's `data` is not what an envelope carries.
    const detail = result.error?.intentReceipt as
      | { operationId: string; outcome: string; leaves: { action: string }[] }
      | undefined;
    expect(detail?.operationId).toBe('op-plan-closeout-halt');
    expect(detail?.outcome).toBe('failed');
    expect(detail?.leaves.map((leaf) => leaf.action)).toEqual(attempted);
  });

  it('PlanCloseout_FailedSegment_ReplaysToTheSameFailedReceipt', async () => {
    await writeFile(specPath, SPEC_WITHOUT_REQUIREMENTS, 'utf8');

    const first = await execute('op-plan-closeout-failreplay', { specPath });
    const second = await execute('op-plan-closeout-failreplay', { specPath });

    // Both outcomes commit, so both outcomes replay. A failed segment that
    // re-ran on replay would repeat its effects for a call the claim already
    // answered.
    expect(receiptOf(second)).toEqual(receiptOf(first) satisfies IntentReceipt);
    expect(second.success).toBe(false);
    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);
  });
});
