// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds after the segment runs — queried back by each leaf's DERIVED operation id on the stream that leaf's contract declares, rather than read off the receipt the executor built, so a receipt that claims events nobody wrote cannot satisfy the comparison
//
// Tests that run the synthesis-closeout segment end to end over the live orchestrate handler
// table and a real store. The segment reaches a remote provider and commits one operation
// record with no suspension, continuation, or hand-off to the host.
//
// This file mocks the VCS factory at module scope, before the handler loads, so no test
// reaches a network. The store is real, because the two `vcs` rows must land and the tests read them back.
// The tests read the rows of each leaf by its derived operation id, because a row count passes
// when one leaf writes all the rows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { VcsProvider } from '../../../../src/vcs/provider.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import {
  derivedLeafOperationId,
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  type ExecuteIntentDeps,
  type LeafHandlerTable,
} from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring, receiptOf } from './fixtures.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';

const INTENT = 'synthesis-closeout';
const STREAM = 'wf-synthesis-closeout-exec';
const VCS_STREAM = 'vcs';

const PR_BODY = [
  '## Summary',
  '',
  'Compile the synthesis closeout.',
  '',
  '## Changes',
  '',
  '- one runbook',
  '',
  '## Test Plan',
  '',
  '- the suite this line is in',
  '',
].join('\n');

const ARGS = {
  title: 'feat: compile the synthesis closeout',
  prBody: PR_BODY,
  baseBranch: 'main',
  headBranch: 'feature/synthesis-closeout',
};

/** The leaf that reaches the provider — index and name, for the derived id. */
const CREATE_LEAF: readonly [number, string] = [1, 'create_pr'];

let stateDir: string;
let store: EventStore;
let createPr: ReturnType<typeof vi.fn>;

/**
 * Builds a stateful provider stub: `listPrs` returns each request that `createPr` opened.
 * A stub that lists no request after a create defeats the recovery precheck of the handler.
 * That precheck stops a retry from opening a second pull request. The journal dedups its rows
 * by idempotency key, so a check on row types alone does not see a second create.
 */
function makeProvider(): VcsProvider {
  const opened: { number: number; url: string; headRefName: string; baseRefName: string }[] = [];
  createPr = vi.fn().mockImplementation(async (input: { headBranch: string; baseBranch: string }) => {
    const pr = {
      number: 42,
      url: 'https://example.invalid/pr/42',
      headRefName: input.headBranch,
      baseRefName: input.baseBranch,
    };
    opened.push(pr);
    return { number: pr.number, url: pr.url };
  });
  return {
    name: 'github',
    createPr,
    listPrs: vi.fn().mockImplementation(async () => [...opened]),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  } as unknown as VcsProvider;
}

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

async function vcsRowsFor(operationId: string): Promise<WorkflowEvent[]> {
  return store.query(VCS_STREAM, { operationId });
}

/**
 * A PR body that the section check rejects. The intent accepts this body, so the shipped
 * handler causes the halt, not a fixture.
 */
const DEFICIENT_ARGS = {
  ...ARGS,
  prBody: 'A body with prose and no required section headers at all.',
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(createVcsProvider).mockResolvedValue(makeProvider());
  stateDir = await mkdtemp(path.join(tmpdir(), 'synthesis-closeout-exec-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM, { phase: 'synthesize' });
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('synthesis-closeout over the live handler table', () => {
  /** The segment calls the remote provider, but it needs only one request, with no suspension or continuation. */
  it('SynthesisCloseout_CoherentInput_CommitsOneOperationRecord', async () => {
    const result = await execute('op-synthesis-closeout', ARGS);
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual([
      'validate_pr_body',
      'create_pr',
    ]);
    expect(receipt.leaves.every((leaf) => leaf.status === 'passed')).toBe(true);
    expect(receipt.interaction.requests).toBe(1);
    expect(createPr).toHaveBeenCalledTimes(1);

    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);
  });

  /**
   * Both rows sit under the derived id of the leaf, on the stream that its contract declares.
   * A row count on `vcs` passes for any writer. The body check writes no row under its derived id.
   */
  it('SynthesisCloseout_CreatePrLeaf_HoldsBothJournalRowsOnTheVcsStream', async () => {
    await execute('op-synthesis-closeout-rows', ARGS);

    const [index, action] = CREATE_LEAF;
    const derived = derivedLeafOperationId('op-synthesis-closeout-rows', index, action);
    const types = (await vcsRowsFor(derived)).map((row) => row.type).sort();
    expect(types).toEqual(['pr.create.executed', 'pr.create.requested']);

    const bodyLeaf = derivedLeafOperationId('op-synthesis-closeout-rows', 0, 'validate_pr_body');
    expect(await vcsRowsFor(bodyLeaf)).toHaveLength(0);
    expect(await store.query(STREAM, { operationId: bodyLeaf })).toHaveLength(0);
  });

  /**
   * The `vcs` rows carry sequences in the numbering of the `vcs` stream. The receipt reports
   * the tail of the subject stream, and no leaf appends there, so the tail stays at 0. A tail
   * from the cross-stream rows gives the caller a sequence that the subject stream does not hold.
   */
  it('SynthesisCloseout_VcsLeaf_DoesNotMoveTheSegmentTail', async () => {
    const receipt = receiptOf(await execute('op-synthesis-closeout-tail', ARGS));

    const [index, action] = CREATE_LEAF;
    const derived = derivedLeafOperationId('op-synthesis-closeout-tail', index, action);
    const vcsRows = await vcsRowsFor(derived);
    expect(vcsRows.length).toBeGreaterThan(0);
    expect(vcsRows.every((row) => row.sequence > 0)).toBe(true);

    expect(receipt.tailSequence).toBe(0);
  });

  /**
   * The `tailSequence` of the receipt uses the numbering of the subject stream. Without a stream
   * on each event, a caller reads the event sequences as positions in the subject stream and
   * gets an unrelated event. The sequences must match the rows that the store holds.
   */
  it('SynthesisCloseout_ReceiptEvents_CarryTheStreamTheirSequencesNumber', async () => {
    const receipt = receiptOf(await execute('op-synthesis-closeout-receipt', ARGS));

    const createLeaf = receipt.leaves.find((leaf) => leaf.action === 'create_pr');
    expect(createLeaf?.events.map((event) => event.type).sort()).toEqual([
      'pr.create.executed',
      'pr.create.requested',
    ]);
    expect(createLeaf?.events.every((event) => event.streamId === VCS_STREAM)).toBe(true);

    const [index, action] = CREATE_LEAF;
    const derived = derivedLeafOperationId('op-synthesis-closeout-receipt', index, action);
    const rows = await vcsRowsFor(derived);
    expect(createLeaf?.events.map((event) => event.sequence).sort()).toEqual(
      rows.map((row) => row.sequence).sort(),
    );
  });

  /** On replay, the provider gets no second call and neither log changes. */
  it('SynthesisCloseout_SameOperationIdSameRequest_ReplaysWithoutReExecuting', async () => {
    const first = receiptOf(await execute('op-synthesis-closeout-replay', ARGS));
    const beforeSubject = await store.query(STREAM);
    const beforeVcs = await store.query(VCS_STREAM);
    const callsAfterFirst = createPr.mock.calls.length;

    const second = receiptOf(await execute('op-synthesis-closeout-replay', ARGS));

    expect(second).toEqual(first);
    expect(createPr.mock.calls.length).toBe(callsAfterFirst);
    expect((await store.query(STREAM)).map((row) => `${row.sequence}:${row.type}`)).toEqual(
      beforeSubject.map((row) => `${row.sequence}:${row.type}`),
    );
    expect((await store.query(VCS_STREAM)).map((row) => `${row.sequence}:${row.type}`)).toEqual(
      beforeVcs.map((row) => `${row.sequence}:${row.type}`),
    );
  });

  it('SynthesisCloseout_SameOperationIdDifferentRequest_IsRefused', async () => {
    await execute('op-synthesis-closeout-digest', ARGS);

    const result = await execute('op-synthesis-closeout-digest', {
      ...ARGS,
      title: 'feat: a different request under the same key',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INTENT_REPLAY_DIGEST_MISMATCH');
    expect(result.error?.message).toContain('Nothing was executed.');
  });

  /**
   * A crash before the commit leaves no claim, so the retry runs the leaves again. The create
   * handler journals its two rows itself, so each row must use the operation id that a retry
   * reuses. The journal dedups on that key, so a retry that calls the remote again also leaves
   * two rows. Thus the test also checks that `createPr` gets one call in total.
   */
  it('SynthesisCloseout_CrashedMidSegmentThenRetried_LeavesOneRowPerJournalPhase', async () => {
    let crash = true;
    const handlers: LeafHandlerTable = {
      ...ACTION_HANDLERS,
      create_pr: async (args, dir, ctx) => {
        const inner = ACTION_HANDLERS.create_pr;
        if (inner === undefined) throw new Error('create_pr has no handler');
        const result = await inner(args, dir, ctx);
        if (crash) throw new Error('mid-segment crash after the provider call');
        return result;
      },
    };

    await expect(execute('op-synthesis-closeout-crash', ARGS, handlers)).rejects.toThrow(
      'mid-segment crash',
    );
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(0);

    crash = false;
    const result = await execute('op-synthesis-closeout-crash', ARGS, handlers);
    expect(result.success).toBe(true);

    const [index, action] = CREATE_LEAF;
    const derived = derivedLeafOperationId('op-synthesis-closeout-crash', index, action);
    const types = (await vcsRowsFor(derived)).map((row) => row.type).sort();
    expect(types).toEqual(['pr.create.executed', 'pr.create.requested']);

    expect(createPr).toHaveBeenCalledTimes(1);
  });

  /**
   * The segment stops for the verdict of the leaf, not for a wiring fault. The receipt does not
   * hold the leaf payload, so the missing sections reach the caller in the failure message. The
   * create leaf never runs, and the operation record still commits. The error carries the
   * receipt facts, because an envelope does not carry the `data` of a failed dispatch.
   */
  it('SynthesisCloseout_BodyMissingRequiredSections_HaltsBeforeTheRemoteCall', async () => {
    const result = await execute('op-synthesis-closeout-halt', DEFICIENT_ARGS);
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('validate_pr_body');
    expect(receipt.failure?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(receipt.failure?.message).toContain('Summary');
    expect(receipt.failure?.message).toContain('Changes');
    expect(receipt.failure?.message).toContain('Test Plan');
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual(['validate_pr_body']);
    expect(createPr).not.toHaveBeenCalled();
    expect(await store.query(VCS_STREAM)).toHaveLength(0);

    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);

    const detail = result.error?.intentReceipt as
      | { operationId: string; outcome: string; leaves: { action: string }[] }
      | undefined;
    expect(detail?.operationId).toBe('op-synthesis-closeout-halt');
    expect(detail?.outcome).toBe('failed');
    expect(detail?.leaves.map((leaf) => leaf.action)).toEqual(['validate_pr_body']);
  });

  /**
   * Both outcomes commit, so both outcomes replay. A failed segment that runs again on
   * replay repeats its effects for a call that the claim already answered.
   */
  it('SynthesisCloseout_FailedSegment_ReplaysToTheSameFailedReceipt', async () => {
    const first = await execute('op-synthesis-closeout-failreplay', DEFICIENT_ARGS);
    const second = await execute('op-synthesis-closeout-failreplay', DEFICIENT_ARGS);

    expect(receiptOf(second)).toEqual(receiptOf(first));
    expect(second.success).toBe(false);
    expect(createPr).not.toHaveBeenCalled();
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
  });
});
