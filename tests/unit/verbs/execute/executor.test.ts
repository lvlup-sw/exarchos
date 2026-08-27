import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { declared } from '../../../../src/registry.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  derivedLeafOperationId,
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  type ExecuteIntentDeps,
  type LeafHandlerTable,
} from '../../../../src/verbs/execute/executor.js';
import type { IntentReceipt } from '../../../../src/verbs/execute/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  appendingHandler,
  countingHandler,
  failingHandler,
  fixtureAction,
  fixtureCorrelation,
  fixtureIntentArgs,
  fixtureRunbook,
  fixtureStep,
  fixtureWiring,
  findFixtureAction,
  receiptOf,
  silentHandler,
  throwingHandler,
} from './fixtures.js';

const STREAM = 'wf-executor';
const INTENT = 'fixture-intent';

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'execute-intent-unit-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** A leaf that appends nothing and declares nothing. */
const quiet = fixtureAction({ name: 'fixture_quiet' });

/** A leaf whose registration promises `task.completed` on every successful call. */
const promising = fixtureAction({
  name: 'fixture_promises',
  emissions: declared({
    event: 'task.completed',
    condition: 'always',
    owner: 'orchestrate',
    role: 'primary',
  }),
  ensures: declared({ source: 'event-append', when: 'success', event: 'task.completed' }),
});

function depsFor(
  steps: Parameters<typeof fixtureRunbook>[1],
  handlers: LeafHandlerTable,
  actions = [quiet, promising],
): ExecuteIntentDeps {
  return {
    runbookTable: [fixtureRunbook(INTENT, steps)],
    findAction: findFixtureAction(actions),
    argSchemas: { [INTENT]: fixtureIntentArgs },
    handlers,
  };
}

async function execute(
  raw: Record<string, unknown>,
  deps: ExecuteIntentDeps,
): Promise<ToolResult> {
  return runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent(raw, stateDir, fixtureWiring(stateDir, store), deps),
  );
}

async function operationEvents(): Promise<WorkflowEvent[]> {
  return store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
}

function claimFor(operationId: string): { requestDigest: string; result: IntentReceipt } | undefined {
  return store.getAppender().ensureSqliteBackendSync().lookupOperationClaim<IntentReceipt>(operationId);
}

// ─── Request validation ─────────────────────────────────────────────────────

describe('handleExecuteIntent request validation', () => {
  const deps = () => depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: silentHandler() });

  it('MissingIntent_IsRejected', async () => {
    const result = await execute({ streamId: STREAM, args: { taskId: 't1' } }, deps());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('MissingSubject_IsRejected', async () => {
    const result = await execute({ intent: INTENT, args: { taskId: 't1' } }, deps());
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('FeatureIdIsAcceptedAsTheStreamAlias', async () => {
    const result = await execute({ intent: INTENT, featureId: STREAM, args: { taskId: 't1' } }, deps());
    expect(result.success).toBe(true);
  });

  it('OperationIdOutsideTheAdmissionGrammar_IsRejected', async () => {
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op/one' },
      deps(),
    );
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(await operationEvents()).toHaveLength(0);
  });

  it('AbsentOperationId_IsCoreMintedAndReturned', async () => {
    const result = await execute({ intent: INTENT, streamId: STREAM, args: { taskId: 't1' } }, deps());
    const receipt = receiptOf(result);
    expect(receipt.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimFor(receipt.operationId)).toBeDefined();
  });

  it('CompileRefusal_ReachesTheCallerAndCommitsNothing', async () => {
    const result = await execute({ intent: 'no-such-intent', streamId: STREAM, args: {} }, deps());
    expect(result.error?.code).toBe('INTENT_UNKNOWN');
    expect(await operationEvents()).toHaveLength(0);
  });
});

// ─── The committed path ─────────────────────────────────────────────────────

describe('handleExecuteIntent commit', () => {
  it('EveryLeafPasses_CommitsTheOperationEvent', async () => {
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
      { fixture_quiet: silentHandler(), fixture_promises: appendingHandler('task.completed') },
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-commit' },
      deps,
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['passed', 'passed']);
    expect(receipt.interaction).toMatchObject({ leavesExecuted: 2, eventsAppended: 1, requests: 1 });
    expect(receipt.interaction.deferred).toContain('suspensions');

    const committed = await operationEvents();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.data).toMatchObject({
      operationId: 'op-commit',
      intent: INTENT,
      outcome: 'committed',
      requestDigest: receipt.requestDigest,
    });
  });

  it('CallerSteering_IsRecordedWithItsProvenance', async () => {
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: silentHandler() });
    const result = await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1', riskTier: 'high', boundaryTouching: true },
        operationId: 'op-steer',
      },
      deps,
    );
    expect(receiptOf(result).steering).toEqual({
      riskTier: 'high',
      boundaryTouching: true,
      source: 'caller-args',
    });
    const committed = await operationEvents();
    expect(committed[0]?.data).toMatchObject({
      steering: { riskTier: 'high', boundaryTouching: true, source: 'caller-args' },
    });
  });

  it('LeafEvents_CarryTheDerivedPerLeafOperationId', async () => {
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
      { fixture_quiet: silentHandler(), fixture_promises: appendingHandler('task.completed') },
    );
    await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-derived' },
      deps,
    );

    const appended = await store.query(STREAM, { type: 'task.completed' });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.operationId).toBe(derivedLeafOperationId('op-derived', 1, 'fixture_promises'));

    // The commit is the OUTER dispatch's event, not a leaf's — the emission
    // check running over that dispatch queries by its operation id.
    const committed = await operationEvents();
    expect(committed[0]?.operationId).not.toContain(':leaf-');
    expect(committed[0]?.operationId).toBeDefined();

    const byDerived = await store.query(STREAM, {
      operationId: derivedLeafOperationId('op-derived', 1, 'fixture_promises'),
    });
    expect(byDerived.map((event) => event.type)).toEqual(['task.completed']);
  });

  it('TailSequence_IsTheHighestSequenceTheLeavesReached', async () => {
    const deps = depsFor([fixtureStep('fixture_promises', 'stop')], {
      fixture_promises: appendingHandler('task.completed'),
    });
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-tail' },
      deps,
    );
    const receipt = receiptOf(result);
    const appended = await store.query(STREAM, { type: 'task.completed' });
    expect(receipt.tailSequence).toBe(appended[0]?.sequence);
    expect(receipt.leaves[0]?.events).toEqual([
      { type: 'task.completed', sequence: appended[0]?.sequence },
    ]);
  });
});

// ─── Failure policy ─────────────────────────────────────────────────────────

describe('handleExecuteIntent onFail', () => {
  it('StopFailure_HaltsTheSegmentAndCommitsFailed', async () => {
    const later = countingHandler(silentHandler());
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
      { fixture_quiet: failingHandler('gate refused'), fixture_promises: later.handler },
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-stop' },
      deps,
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('fixture_quiet');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['failed']);
    expect(later.calls()).toBe(0);

    const committed = await operationEvents();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.data).toMatchObject({ outcome: 'failed', failedLeaf: 'fixture_quiet' });
  });

  it('BlockingFailure_CannotProduceACommittedOutcome', async () => {
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], {
      fixture_quiet: failingHandler('gate refused'),
    });
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-blocked' },
      deps,
    );
    expect(receiptOf(result).outcome).toBe('failed');
    const claim = claimFor('op-blocked');
    expect(claim?.result.outcome).toBe('failed');
    const committed = await operationEvents();
    expect(committed.map((event) => (event.data as { outcome?: string }).outcome)).toEqual(['failed']);
  });

  it('ContinueFailure_IsAdvisoryAndTheSegmentProceeds', async () => {
    const later = countingHandler(silentHandler());
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'continue'), fixtureStep('fixture_promises', 'continue')],
      { fixture_quiet: failingHandler('advisory finding'), fixture_promises: later.handler },
      [quiet, fixtureAction({ name: 'fixture_promises' })],
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-continue' },
      deps,
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['advisory-failed', 'passed']);
    expect(later.calls()).toBe(1);
  });
});

// ─── Per-leaf emission verification ─────────────────────────────────────────

describe('handleExecuteIntent per-leaf emission verification', () => {
  it('SilentLeafThatDeclaredAnEmission_FailsItsOwnContract', async () => {
    // The seeded violation: the registration promises `task.completed` on every
    // successful call and the handler appends nothing.
    const deps = depsFor([fixtureStep('fixture_promises', 'stop')], {
      fixture_promises: silentHandler(),
    });
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-silent' },
      deps,
    );
    const receipt = receiptOf(result);

    expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(result.error?.message).toContain('task.completed');
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('fixture_promises');
  });

  it('SameLeafDeclarationAppendingTheEvent_Passes', async () => {
    // The control for the test above: only the handler changes.
    const deps = depsFor([fixtureStep('fixture_promises', 'stop')], {
      fixture_promises: appendingHandler('task.completed'),
    });
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-loud' },
      deps,
    );
    expect(result.success).toBe(true);
    expect(receiptOf(result).leaves[0]?.status).toBe('passed');
  });

  it('LeafEmissionCheckIsScopedToItsOwnOperationId', async () => {
    // An earlier leaf appending the event a later leaf owes must not satisfy
    // the later leaf — the derived per-leaf identity is what rules that out.
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
      { fixture_quiet: appendingHandler('task.completed'), fixture_promises: silentHandler() },
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-scoped' },
      deps,
    );
    expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(receiptOf(result).failedLeaf).toBe('fixture_promises');

    // The verifier's own finding, recorded against the LEAF's operation id.
    // Under one shared id its query would have found the earlier leaf's
    // `task.completed` and reported the contract kept.
    const findings = await store.query(STREAM, { type: 'emission.violated' });
    expect(findings.map((event) => (event.data as { operationId?: string }).operationId)).toEqual([
      derivedLeafOperationId('op-scoped', 1, 'fixture_promises'),
    ]);
  });
});

// ─── Replay ─────────────────────────────────────────────────────────────────

describe('handleExecuteIntent replay', () => {
  it('ReplayOfACommittedOperation_ExecutesNothing', async () => {
    const counted = countingHandler(appendingHandler('task.completed'));
    const deps = depsFor([fixtureStep('fixture_promises', 'stop')], {
      fixture_promises: counted.handler,
    });
    const request = {
      intent: INTENT,
      streamId: STREAM,
      args: { taskId: 't1' },
      operationId: 'op-replay',
    };

    const first = receiptOf(await execute(request, deps));
    expect(counted.calls()).toBe(1);

    const second = await execute(request, deps);
    expect(second.success).toBe(true);
    expect(receiptOf(second)).toEqual(first);
    expect(counted.calls()).toBe(1);
    expect(await operationEvents()).toHaveLength(1);
    expect(await store.query(STREAM, { type: 'task.completed' })).toHaveLength(1);
  });

  it('ReplayOfAFailedOperation_ReproducesTheSameRefusal', async () => {
    const counted = countingHandler(failingHandler('gate refused'));
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: counted.handler });
    const request = {
      intent: INTENT,
      streamId: STREAM,
      args: { taskId: 't1' },
      operationId: 'op-replay-failed',
    };

    const first = await execute(request, deps);
    const second = await execute(request, deps);

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe(first.error?.code);
    expect(second.error?.message).toBe(first.error?.message);
    expect(counted.calls()).toBe(1);
  });

  it('SameOperationIdDifferentRequest_IsRejectedWithoutExecuting', async () => {
    const counted = countingHandler(silentHandler());
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: counted.handler });

    await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-digest' },
      deps,
    );
    expect(counted.calls()).toBe(1);

    const clash = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 'DIFFERENT' }, operationId: 'op-digest' },
      deps,
    );
    expect(clash.success).toBe(false);
    expect(clash.error?.code).toBe('INTENT_REPLAY_DIGEST_MISMATCH');
    expect(counted.calls()).toBe(1);
    expect(await operationEvents()).toHaveLength(1);
  });
});

// ─── Crash ──────────────────────────────────────────────────────────────────

describe('handleExecuteIntent crash distinguishability', () => {
  it('ThrowMidSegment_LeavesNoClaimAndNoOperationEvent', async () => {
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
      {
        fixture_quiet: appendingHandler('task.completed'),
        fixture_promises: throwingHandler('fixture crash'),
      },
      [fixtureAction({ name: 'fixture_quiet' }), fixtureAction({ name: 'fixture_promises' })],
    );

    await expect(
      execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-crash' },
        deps,
      ),
    ).rejects.toThrow('fixture crash');

    expect(claimFor('op-crash')).toBeUndefined();
    expect(await operationEvents()).toHaveLength(0);

    // The completed leaf's work is durable and keyed to the caller's operation.
    const durable = await store.query(STREAM, {
      operationId: derivedLeafOperationId('op-crash', 0, 'fixture_quiet'),
    });
    expect(durable.map((event) => event.type)).toEqual(['task.completed']);
  });

  it('RetryAfterCrash_RunsFromTheTopAndReusesTheDerivedLeafIds', async () => {
    const counted = countingHandler(appendingHandler('task.completed'));
    let crash = true;
    const handlers: LeafHandlerTable = {
      fixture_quiet: counted.handler,
      fixture_promises: async (args, dir, ctx) => {
        if (crash) throw new Error('fixture crash');
        return silentHandler()(args, dir, ctx);
      },
    };
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
      handlers,
      [fixtureAction({ name: 'fixture_quiet' }), fixtureAction({ name: 'fixture_promises' })],
    );
    const request = {
      intent: INTENT,
      streamId: STREAM,
      args: { taskId: 't1' },
      operationId: 'op-retry',
    };

    await expect(execute(request, deps)).rejects.toThrow('fixture crash');
    crash = false;

    const result = await execute(request, deps);
    expect(result.success).toBe(true);
    // No claim existed, so the segment genuinely re-ran from the top.
    expect(counted.calls()).toBe(2);
    const durable = await store.query(STREAM, {
      operationId: derivedLeafOperationId('op-retry', 0, 'fixture_quiet'),
    });
    expect(durable).toHaveLength(2);
  });
});
