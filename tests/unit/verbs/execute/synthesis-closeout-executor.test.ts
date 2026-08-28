// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds after the segment runs — queried back by each leaf's DERIVED operation id on the stream that leaf's contract declares, rather than read off the receipt the executor built, so a receipt that claims events nobody wrote cannot satisfy the comparison
//
// ─── Executing the synthesis-closeout segment end to end ────────────────────
//
// The LIVE orchestrate handler table against a real store. Nothing here is a
// fixture leaf: the shipped runbook, compiled by the shipped compiler, driven
// by the shipped executor, reaching a remote provider — and committing one
// operation record without a suspension, a continuation, or a hand-off back to
// the host. External credentials do not imply a second agent round-trip.
//
// The provider is the ONLY thing stubbed, at the factory the handler imports.
// The event store is real, because the claim under test is that the two `vcs`
// rows land and are read back.
//
// Per-leaf scoping is asserted by DERIVED operation id, not by counting rows on
// a stream. A count would be satisfied by one leaf writing everything.

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

// Mocked at module scope, before the handler that imports it is loaded — the
// same seam `tests/unit/verbs/vcs/create-pr.test.ts` stubs, for the same
// reason: nothing in this file may reach a network.
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

function makeProvider(): VcsProvider {
  createPr = vi.fn().mockResolvedValue({ number: 42, url: 'https://example.invalid/pr/42' });
  return {
    name: 'github',
    createPr,
    // "No existing PR", so the handler falls through to the create rather than
    // short-circuiting on the crash-recovery path.
    listPrs: vi.fn().mockResolvedValue([]),
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
 * The live handler table with the body check driven into ITS OWN refusal.
 *
 * A missing section is not a refusal: the shipped handler reports the section
 * verdict on its success carrier, so `onFail: 'stop'` never sees it and no
 * argument this intent accepts can make the first leaf fail. What the handler
 * does refuse is a call naming no body source at all — so the source is
 * stripped on the way in and the refusal that halts the segment is the shipped
 * handler's own, not a fabricated envelope standing in for one.
 */
function refusingBodyCheck(): LeafHandlerTable {
  const bodyCheck = ACTION_HANDLERS.validate_pr_body;
  if (bodyCheck === undefined) throw new Error('validate_pr_body has no handler');
  return {
    ...ACTION_HANDLERS,
    validate_pr_body: async (args, dir, ctx) => {
      const { body: _stripped, ...withoutSource } = args;
      return bodyCheck(withoutSource, dir, ctx);
    },
  };
}

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
    // One request in, one request out: no suspension and no continuation, even
    // though the middle of the segment talked to a remote provider.
    expect(receipt.interaction.requests).toBe(1);
    expect(createPr).toHaveBeenCalledTimes(1);

    const operationRows = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(operationRows).toHaveLength(1);
  });

  it('SynthesisCloseout_CreatePrLeaf_HoldsBothJournalRowsOnTheVcsStream', async () => {
    await execute('op-synthesis-closeout-rows', ARGS);

    const [index, action] = CREATE_LEAF;
    const derived = derivedLeafOperationId('op-synthesis-closeout-rows', index, action);
    const types = (await vcsRowsFor(derived)).map((row) => row.type).sort();
    // Both rows, under THIS leaf's identity and on the stream its contract
    // declares. Counting rows on `vcs` would be satisfied by anything at all
    // writing there.
    expect(types).toEqual(['pr.create.executed', 'pr.create.requested']);

    // The body check declares no emission and writes none, so its derived
    // identity holds nothing on either stream — the negative half of the same
    // scoping claim.
    const bodyLeaf = derivedLeafOperationId('op-synthesis-closeout-rows', 0, 'validate_pr_body');
    expect(await vcsRowsFor(bodyLeaf)).toHaveLength(0);
    expect(await store.query(STREAM, { operationId: bodyLeaf })).toHaveLength(0);
  });

  it('SynthesisCloseout_VcsLeaf_DoesNotMoveTheSegmentTail', async () => {
    const receipt = receiptOf(await execute('op-synthesis-closeout-tail', ARGS));

    const [index, action] = CREATE_LEAF;
    const derived = derivedLeafOperationId('op-synthesis-closeout-tail', index, action);
    const vcsRows = await vcsRowsFor(derived);
    expect(vcsRows.length).toBeGreaterThan(0);
    // The rows exist and carry real sequences — in the `vcs` stream's own
    // numbering, which has nothing to do with the subject stream's.
    expect(vcsRows.every((row) => row.sequence > 0)).toBe(true);

    // The tail the receipt reports is the SUBJECT stream's, and no leaf of this
    // segment appended there, so it stays where it was. A tail folded from the
    // cross-stream rows would hand the caller a sequence to resume from that
    // does not exist in the stream they asked about.
    expect(receipt.tailSequence).toBe(0);
  });

  it('SynthesisCloseout_SameOperationIdSameRequest_ReplaysWithoutReExecuting', async () => {
    const first = receiptOf(await execute('op-synthesis-closeout-replay', ARGS));
    const beforeSubject = await store.query(STREAM);
    const beforeVcs = await store.query(VCS_STREAM);
    const callsAfterFirst = createPr.mock.calls.length;

    const second = receiptOf(await execute('op-synthesis-closeout-replay', ARGS));

    expect(second).toEqual(first);
    // Nothing ran: the provider was not called again and neither log moved.
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

  it('SynthesisCloseout_CrashedMidSegmentThenRetried_LeavesOneRowPerJournalPhase', async () => {
    // The uncommitted retry, which the replay case above cannot reach: a crash
    // before the commit leaves no claim, so the retry re-runs the leaves rather
    // than short-circuiting on a persisted receipt. The create handler journals
    // its two rows itself, so each has to be keyed on the operation identity a
    // retry reuses — keyed on a per-call uuid, the second attempt writes a
    // second pair describing one pull request.
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
    // One of each. Two of either would be one pull request journalled twice,
    // and the receipt bakes those sequences in permanently.
    expect(types).toEqual(['pr.create.executed', 'pr.create.requested']);
  });

  it('SynthesisCloseout_BlockingLeafRefuses_HaltsBeforeTheRemoteCall', async () => {
    const result = await execute(
      'op-synthesis-closeout-halt',
      ARGS,
      refusingBodyCheck(),
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('validate_pr_body');
    expect(receipt.failure?.code).toBe('INTENT_SEGMENT_FAILED');
    // It stops for the leaf's OWN stated reason rather than a wiring error — a
    // halt for an admission or handler-lookup fault would prove nothing about
    // the failure policy.
    expect(receipt.failure?.message).toContain('No input source provided');
    // Halted: the create leaf never ran, so no request was opened and the
    // shared stream is untouched.
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual(['validate_pr_body']);
    expect(createPr).not.toHaveBeenCalled();
    expect(await store.query(VCS_STREAM)).toHaveLength(0);

    // "Ran and failed" is distinguishable from "crashed mid-segment": the
    // operation record is there either way the segment ENDED.
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);

    // The refusal reaches the caller with the receipt facts attached, not only
    // on `data` — a failed dispatch's `data` is not what an envelope carries.
    const detail = result.error?.intentReceipt as
      | { operationId: string; outcome: string; leaves: { action: string }[] }
      | undefined;
    expect(detail?.operationId).toBe('op-synthesis-closeout-halt');
    expect(detail?.outcome).toBe('failed');
    expect(detail?.leaves.map((leaf) => leaf.action)).toEqual(['validate_pr_body']);
  });

  it('SynthesisCloseout_FailedSegment_ReplaysToTheSameFailedReceipt', async () => {
    const handlers = refusingBodyCheck();

    const first = await execute('op-synthesis-closeout-failreplay', ARGS, handlers);
    const second = await execute('op-synthesis-closeout-failreplay', ARGS, handlers);

    // Both outcomes commit, so both outcomes replay. A failed segment that
    // re-ran on replay would repeat its effects for a call the claim already
    // answered.
    expect(receiptOf(second)).toEqual(receiptOf(first));
    expect(second.success).toBe(false);
    expect(createPr).not.toHaveBeenCalled();
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
  });
});
