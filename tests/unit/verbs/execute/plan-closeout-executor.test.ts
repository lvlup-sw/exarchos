// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds after the segment runs — queried back by each leaf's DERIVED operation id rather than read off the receipt the executor built, so a receipt that claims events nobody wrote cannot satisfy the comparison
//
// Tests that run the plan-closeout segment end to end. They use the live orchestrate handler
// table, a real store, and a real spec on disk. The shipped runbook, compiler, and executor must
// produce the rows of the shipped gates. The operation record commits on both outcomes.
//
// The tests read the rows of each leaf by its derived operation id. A row count on the stream
// passes even when one leaf writes all the rows.

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

/**
 * Builds the executor deps with the live orchestrate handler table. A case can pass a
 * table that replaces one leaf to stage a failure that the shipped table cannot.
 */
function deps(handlers: LeafHandlerTable = ACTION_HANDLERS): ExecuteIntentDeps {
  return {
    runbookTable: ALL_RUNBOOKS,
    findAction: findActionInRegistry,
    argSchemas: INTENT_ARG_SCHEMAS,
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

    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);
  });

  /**
   * Each gate leaf holds both rows under its own derived id, so the evidence of an earlier
   * leaf cannot answer for it. The matrix generator writes no row under its derived id.
   */
  it('PlanCloseout_EachGateLeaf_HoldsItsOwnEvidenceAndSignal', async () => {
    await execute('op-plan-closeout-rows', { specPath });

    for (const [index, action] of GATE_LEAVES) {
      const derived = derivedLeafOperationId('op-plan-closeout-rows', index, action);
      const types = (await rowsFor(derived)).map((row) => row.type).sort();
      expect(types, action).toEqual(['admission.evidence-recorded', 'gate.executed']);
    }

    const traceability = derivedLeafOperationId(
      'op-plan-closeout-rows',
      2,
      'generate_traceability',
    );
    expect(await rowsFor(traceability)).toHaveLength(0);
  });

  /**
   * The replay reads the receipt back from the persisted claim. The sequence and type of
   * each row in the log stay the same, so nothing ran again.
   */
  it('PlanCloseout_SameOperationIdSameRequest_ReplaysWithoutReExecuting', async () => {
    const first = receiptOf(await execute('op-plan-closeout-replay', { specPath }));
    const before = await store.query(STREAM);

    const second = receiptOf(await execute('op-plan-closeout-replay', { specPath }));
    const after = await store.query(STREAM);

    expect(second).toEqual(first);
    expect(after.map((row) => `${row.sequence}:${row.type}`)).toEqual(
      before.map((row) => `${row.sequence}:${row.type}`),
    );
  });

  /**
   * A crash before the commit leaves no claim, so the retry runs the gate leaves again.
   * The replay case cannot reach this path. Each gate appends its own `gate.executed` row
   * inside the provider, before the runner can see the earlier evidence. Without a key on
   * that row, the retry writes a duplicate, and the receipt keeps both sequences.
   */
  it('PlanCloseout_CrashedMidSegmentThenRetried_LeavesOneRowPerGateLeaf', async () => {
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

  /**
   * The spec has no requirement identifiers, so the coverage gate fails. The segment must
   * stop at the first blocking gate for the reason of that gate, not for a wiring fault.
   * The operation record commits when the segment ends, and only a crash leaves none. The
   * error carries the receipt facts, because an envelope does not carry the `data` of a failed dispatch.
   */
  it('PlanCloseout_BlockingLeafFails_HaltsAndStillCommits', async () => {
    await writeFile(specPath, SPEC_WITHOUT_REQUIREMENTS, 'utf8');

    const result = await execute('op-plan-closeout-halt', { specPath });
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('check_plan_coverage');
    expect(receipt.failure?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(receipt.failure?.message).toContain('No design subsections found');
    const attempted = receipt.leaves.map((leaf) => leaf.action);
    expect(attempted).toEqual(['check_plan_coverage']);
    expect(receipt.leaves.at(-1)?.status).toBe('failed');

    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);

    const detail = result.error?.intentReceipt as
      | { operationId: string; outcome: string; leaves: { action: string }[] }
      | undefined;
    expect(detail?.operationId).toBe('op-plan-closeout-halt');
    expect(detail?.outcome).toBe('failed');
    expect(detail?.leaves.map((leaf) => leaf.action)).toEqual(attempted);
  });

  /**
   * Both outcomes commit, so both outcomes replay. A failed segment that runs again on
   * replay repeats its effects for a call that the claim already answered.
   */
  it('PlanCloseout_FailedSegment_ReplaysToTheSameFailedReceipt', async () => {
    await writeFile(specPath, SPEC_WITHOUT_REQUIREMENTS, 'utf8');

    const first = await execute('op-plan-closeout-failreplay', { specPath });
    const second = await execute('op-plan-closeout-failreplay', { specPath });

    expect(receiptOf(second)).toEqual(receiptOf(first) satisfies IntentReceipt);
    expect(second.success).toBe(false);
    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);
  });
});
