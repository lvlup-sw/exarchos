// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the persisted operation claim the SQLite appender hands back on a replay — read out of the store rather than rebuilt in process, so a receipt the first call invented and never durably recorded cannot satisfy the comparison
//
// The two receipt-equality assertions here compare a receipt the executor BUILT
// while running a segment against the one a later call with the same operation
// id READS from the claim row. One authority is the code under test; the other
// is the durable row it wrote. A replay answered out of memory would compare a
// value with itself and could never disagree.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { resolveConfig } from '../../../../src/config/resolve.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import { WorkflowEventBase, type WorkflowEvent } from '../../../../src/events/schemas.js';
import { declared, getFullRegistry } from '../../../../src/registry.js';
import { toEnvelope, type ToolResult } from '../../../../src/format.js';
import {
  derivedLeafOperationId,
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  MAX_CALLER_OPERATION_ID_LENGTH,
  type ExecuteIntentDeps,
  type LeafHandler,
  type LeafHandlerTable,
} from '../../../../src/verbs/execute/executor.js';
import { IntentExecutedOutputSchema } from '../../../../src/verbs/execute/schemas.js';
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
  gateEvidenceHandler,
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
  ctx?: DispatchContext,
): Promise<ToolResult> {
  return runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent(raw, stateDir, ctx ?? fixtureWiring(stateDir, store), deps),
  );
}

/** The wiring, with the project's emission enforcement resolved to `advisory`. */
function advisoryWiring(): DispatchContext {
  return {
    ...fixtureWiring(stateDir, store),
    projectConfig: resolveConfig({ events: { 'emission-enforcement': 'advisory' } }),
  };
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

// ─── The caller's operation key, and what it has to leave room for ──────────

describe('handleExecuteIntent operationId bound', () => {
  const deps = () => depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: silentHandler() });

  it('OperationIdAtTheBound_IsAccepted', async () => {
    const key = 'a'.repeat(MAX_CALLER_OPERATION_ID_LENGTH);
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: key },
      deps(),
    );
    expect(result.success).toBe(true);
    expect(receiptOf(result).operationId).toBe(key);
  });

  it('TheBound_LeavesRoomForTheLongestDerivedLeafIdTheRegistryCanProduce', () => {
    // The tooth the boundary tests below cannot carry: they take their input
    // FROM the constant, so raising it moves them with it. This one measures
    // the constant against the authority it has to fit — the event row's own
    // operation-id limit — over the worst suffix the live registry can add.
    const longestAction = getFullRegistry()
      .flatMap((tool) => tool.actions.map((action) => action.name))
      .reduce((longest, name) => (name.length > longest.length ? name : longest), '');
    expect(longestAction.length).toBeGreaterThan(0);

    const row = (operationId: string): boolean =>
      WorkflowEventBase.safeParse({
        streamId: STREAM,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: INTENT_EXECUTED_EVENT,
        operationId,
      }).success;

    const worstCase = derivedLeafOperationId(
      'a'.repeat(MAX_CALLER_OPERATION_ID_LENGTH),
      999,
      longestAction,
    );
    expect(row(worstCase)).toBe(true);
    // And the limit is real rather than assumed: the row refuses a longer id.
    expect(row('a'.repeat(worstCase.length + 200))).toBe(false);
  });

  it('OperationIdOneOverTheBound_IsRefusedBeforeAnyEffect', async () => {
    // The derived per-leaf id is the caller's key plus a suffix, and it is the
    // DERIVED id the event row has to hold. A key accepted at the admission
    // grammar's own ceiling produces leaf ids the store rejects mid-segment.
    const result = await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1' },
        operationId: 'a'.repeat(MAX_CALLER_OPERATION_ID_LENGTH + 1),
      },
      deps(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(await operationEvents()).toHaveLength(0);
  });
});

// ─── Subject identity: two spellings of one stream ──────────────────────────

describe('handleExecuteIntent subject resolution', () => {
  const deps = () => depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: silentHandler() });

  it('BothSpellingsPresentAndAgreeing_ResolvesToThatStream', async () => {
    const result = await execute(
      { intent: INTENT, streamId: STREAM, featureId: STREAM, args: { taskId: 't1' }, operationId: 'op-agree' },
      deps(),
    );
    expect(result.success).toBe(true);
    expect(await operationEvents()).toHaveLength(1);
  });

  it('BothSpellingsPresentAndDisagreeing_IsRefused', async () => {
    // Resolving one of them silently commits the segment to one stream and has
    // the dispatch-layer emission check read the other.
    const result = await execute(
      {
        intent: INTENT,
        featureId: STREAM,
        streamId: 'wf-somewhere-else',
        args: { taskId: 't1' },
        operationId: 'op-disagree',
      },
      deps(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('different streams');
    expect(await operationEvents()).toHaveLength(0);
    expect(await store.query('wf-somewhere-else')).toHaveLength(0);
  });

  it('FeatureIdWins_MatchingTheDispatchLayerStreamResolver', async () => {
    // Not a preference: the dispatch-layer resolver reads `featureId` first,
    // and the two have to agree on which stream this call is about.
    const result = await execute(
      { intent: INTENT, featureId: STREAM, args: { taskId: 't1' }, operationId: 'op-feature-first' },
      deps(),
    );
    expect(result.success).toBe(true);
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
  });
});

// ─── Losing the claim to a concurrent call ──────────────────────────────────

describe('handleExecuteIntent commit races', () => {
  const request = (operationId: string) => ({
    intent: INTENT,
    streamId: STREAM,
    args: { taskId: 't1' },
    operationId,
  });

  /**
   * Claim `operationId` from INSIDE a leaf handler — after the executor's
   * replay pre-flight has already missed, and before its commit runs. That is
   * the window a concurrent caller occupies, reproduced deterministically.
   */
  function claimingHandler(operationId: string, digest: () => string, result: IntentReceipt): LeafHandler {
    return async () => {
      await store.getAppender().decideOnce<IntentReceipt>(operationId, digest(), () => ({
        streamId: STREAM,
        // A claim carries at least one event, the same as any other commit.
        events: [{ type: 'task.progressed', data: { taskId: 'racing-writer' } }],
        result,
      }));
      return { success: true, data: { appended: null } };
    };
  }

  it('SameDigest_TheCallerGetsThePersistedReceiptNotTheLocalOne', async () => {
    // The digest is over the REQUEST, not the key, so an identical request
    // under a different key produces the digest the racing writer must use.
    const probe = receiptOf(
      await execute(
        request('op-race-probe'),
        depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: silentHandler() }),
      ),
    );
    const winner: IntentReceipt = { ...probe, operationId: 'op-race', tailSequence: 4242 };

    const result = await execute(
      request('op-race'),
      depsFor([fixtureStep('fixture_quiet', 'stop')], {
        fixture_quiet: claimingHandler('op-race', () => probe.requestDigest, winner),
      }),
    );

    // The loser's locally-built receipt says tailSequence 0 and is recorded
    // nowhere. Handing it back would leave the caller holding a receipt no
    // claim stores and no replay reproduces.
    expect(result.success).toBe(true);
    expect(receiptOf(result)).toEqual(winner);
    expect(claimFor('op-race')?.result).toEqual(winner);
  });

  it('DifferentDigest_IsTheTypedReplayRefusalNotAnInternalError', async () => {
    const foreign: IntentReceipt = {
      operationId: 'op-race-clash',
      intent: INTENT,
      outcome: 'committed',
      leaves: [],
      tailSequence: 0,
      requestDigest: 'sha256:someone-elses-request',
      interaction: { leavesExecuted: 0, eventsAppended: 0, requests: 1, deferred: [] },
    };
    const result = await execute(
      request('op-race-clash'),
      depsFor([fixtureStep('fixture_quiet', 'stop')], {
        fixture_quiet: claimingHandler('op-race-clash', () => foreign.requestDigest, foreign),
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INTENT_REPLAY_DIGEST_MISMATCH');
    // The segment DID run, and the refusal says so rather than implying the
    // pre-flight's "nothing was executed".
    expect(result.error?.message).toContain('effects are already performed');
  });
});

// ─── Correlation off a real dispatch ────────────────────────────────────────

describe('handleExecuteIntent without an ambient dispatch context', () => {
  it('OperationRecordAndLeafEvents_ShareTheMintedOuterCorrelationId', async () => {
    const deps = depsFor([fixtureStep('fixture_promises', 'stop')], {
      fixture_promises: appendingHandler('task.completed'),
    });
    // No `runWithDispatchContext` wrapper: a direct in-process call, where the
    // outer packet is minted rather than inherited. The commit used to stamp
    // from an ambient context that was still undefined, leaving the operation
    // record uncorrelated with the leaves it describes.
    const result = await handleExecuteIntent(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-no-ambient' },
      stateDir,
      fixtureWiring(stateDir, store),
      deps,
    );
    expect(result.success).toBe(true);

    const record = (await operationEvents())[0];
    const leafEvent = (await store.query(STREAM, { type: 'task.completed' }))[0];
    expect(record?.correlationId).toBeTypeOf('string');
    expect(record?.correlationId).toBe(leafEvent?.correlationId);
    expect(record?.operationId).not.toContain(':leaf-');
  });
});

// ─── Declared postconditions, observed the way dispatch observes them ───────

describe('handleExecuteIntent per-leaf ensures', () => {
  /** Declares an event-append postcondition it does NOT declare as an emission. */
  const ensuring = fixtureAction({
    name: 'fixture_ensures',
    ensures: declared({ source: 'event-append', when: 'success', event: 'gate.executed' }),
  });

  it('SilentLeafWithAnEnsuresEventOutsideItsEmissions_FailsItsContract', async () => {
    // The emissions axis cannot see this leaf at all — it declares none — so
    // the only thing that can catch it is the ensures observation.
    const deps = depsFor([fixtureStep('fixture_ensures', 'stop')], { fixture_ensures: silentHandler() }, [
      ensuring,
    ]);
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-ensures' },
      deps,
    );
    expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(result.error?.message).toContain('gate.executed');
    expect(receiptOf(result).failedLeaf).toBe('fixture_ensures');
  });

  /** Declares the durable-evidence source — the one an event query cannot see. */
  const evidencing = fixtureAction({
    name: 'fixture_evidences',
    ensures: declared({ source: 'durable-evidence', when: 'success', evidenceType: 'gate' }),
  });

  it('SilentLeafWithADurableEvidenceEnsures_FailsItsContract', async () => {
    // Every shipped gate leaf declares this source. A comparison built only
    // over appended event types skipped all of them without saying so.
    const deps = depsFor([fixtureStep('fixture_evidences', 'stop')], {
      fixture_evidences: silentHandler(),
    }, [evidencing]);
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-evidence' },
      deps,
    );
    expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(result.error?.message).toContain('evidence gate');
  });

  it('SameLeafRecordingTheEvidence_Passes', async () => {
    // The control: the evidence the gate runner would record, keyed the way it
    // keys one, under the leaf's own derived identity.
    const deps = depsFor([fixtureStep('fixture_evidences', 'stop')], {
      fixture_evidences: gateEvidenceHandler({
        requirementId: 'gate:review:review',
        phaseAttemptId: 'attempt-fixture-1',
        producerRef: 'fixture.evidence-gate',
      }),
    }, [evidencing]);
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-evidence-kept' },
      deps,
    );
    expect(
      result.success,
      `${result.error?.code ?? ''} ${result.error?.message ?? ''}`,
    ).toBe(true);
    expect(receiptOf(result).leaves[0]?.status).toBe('passed');
  });

  it('SameLeafAppendingTheEnsuredEvent_Passes', async () => {
    const deps = depsFor(
      [fixtureStep('fixture_ensures', 'stop')],
      { fixture_ensures: appendingHandler('gate.executed') },
      [ensuring],
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-ensures-kept' },
      deps,
    );
    expect(result.success).toBe(true);
    expect(receiptOf(result).leaves[0]?.status).toBe('passed');
  });
});

// ─── Enforcement mode, and what an advisory leaf may not wave through ───────

describe('handleExecuteIntent emission enforcement on a continue leaf', () => {
  /** Promises an event unconditionally; declares no postcondition. */
  const announcing = fixtureAction({
    name: 'fixture_announces',
    emissions: declared({
      event: 'task.completed',
      condition: 'always',
      owner: 'orchestrate',
      role: 'primary',
    }),
  });

  function continueDeps(later: LeafHandlerTable[string]): ExecuteIntentDeps {
    return depsFor(
      [fixtureStep('fixture_announces', 'continue'), fixtureStep('fixture_quiet', 'stop')],
      { fixture_announces: silentHandler(), fixture_quiet: later },
      [announcing, quiet],
    );
  }

  it('BlockMode_HaltsTheSegmentEvenThoughTheLeafIsAdvisory', async () => {
    // `onFail: 'continue'` is a policy about the leaf's own VERDICT. A leaf
    // that broke its declared emission contract broke the log's integrity, and
    // the runbook's advisory policy never licensed that.
    const later = countingHandler(silentHandler());
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-continue-block' },
      continueDeps(later.handler),
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(receipt.outcome).toBe('failed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['failed']);
    expect(later.calls()).toBe(0);
  });

  it('AdvisoryMode_CommitsAndRecordsTheViolationOnTheLeaf', async () => {
    // The operator asked for the finding without the failure. A finding
    // suppressed to keep an advisory run quiet is a finding lost, so it rides
    // on the receipt leaf that produced it.
    const later = countingHandler(silentHandler());
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-continue-advisory' },
      continueDeps(later.handler),
      advisoryWiring(),
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['passed', 'passed']);
    expect(receipt.leaves[0]?.emissionViolation).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(receipt.leaves[1]?.emissionViolation).toBeUndefined();
    expect(later.calls()).toBe(1);
  });

  it('APriorAttemptsViolationRow_IsNotFoldedIntoTheRetriedReceipt', async () => {
    // The verifier records its advisory finding under the violating leaf's own
    // derived id. After a crash, that row is among the rows the retried leaf's
    // identity durably holds — bookkeeping ABOUT the leaf, not a leaf emission —
    // so a receipt that folded it in would report the finding as an event the
    // leaf appended and count it toward the tail.
    let crash = true;
    const deps = depsFor(
      [fixtureStep('fixture_announces', 'continue'), fixtureStep('fixture_quiet', 'stop')],
      {
        fixture_announces: silentHandler(),
        fixture_quiet: async (args, dir, ctx) =>
          crash
            ? throwingHandler('fixture crash before commit')(args, dir, ctx)
            : silentHandler()(args, dir, ctx),
      },
      [announcing, quiet],
    );
    const request = {
      intent: INTENT,
      streamId: STREAM,
      args: { taskId: 't1' },
      operationId: 'op-prior-violation',
    };

    await expect(execute(request, deps, advisoryWiring())).rejects.toThrow(
      'fixture crash before commit',
    );
    const derived = derivedLeafOperationId('op-prior-violation', 0, 'fixture_announces');
    expect(
      await store.query(STREAM, { type: 'emission.violated', operationId: derived }),
    ).toHaveLength(1);

    crash = false;
    const result = await execute(request, deps, advisoryWiring());
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.leaves[0]?.emissionViolation).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(
      receipt.leaves.flatMap((leaf) => leaf.events.map((event) => event.type)),
    ).not.toContain('emission.violated');
    expect(receipt.interaction.eventsAppended).toBe(0);
  });

  it('AnAdvisoryFindingOnAFailedSegment_SurvivesIntoTheErrorEnvelope', async () => {
    // A failed segment's receipt travels inside the error. The advisory
    // finding is part of that receipt: dropping it at the envelope boundary
    // would make the one caller who most needs the finding — the one whose
    // segment then halted — the one caller who cannot see it.
    const result = await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1' },
        operationId: 'op-advisory-then-halt',
      },
      continueDeps(failingHandler('halted after the finding')),
      advisoryWiring(),
    );

    const envelope = toEnvelope(result);
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.intentReceipt?.leaves[0]?.emissionViolation).toBe(
      'INTENT_EMISSION_CONTRACT_VIOLATED',
    );
  });
});

// ─── A failed segment's receipt has to survive the envelope boundary ────────

describe('handleExecuteIntent failure envelope', () => {
  it('SegmentFailure_CarriesTheCompactReceiptInsideTheError', async () => {
    const deps = depsFor(
      [fixtureStep('fixture_promises', 'stop'), fixtureStep('fixture_quiet', 'stop')],
      { fixture_promises: appendingHandler('task.completed'), fixture_quiet: failingHandler('refused') },
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-envelope' },
      deps,
    );
    const receipt = receiptOf(result);

    // Asserted over the ENVELOPE, not the raw ToolResult: the boundary keeps
    // `data` only on the success path, so a receipt left there is a receipt the
    // caller never receives.
    const envelope = toEnvelope(result);
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(Object.hasOwn(envelope, 'data')).toBe(false);
    expect(envelope.error.intentReceipt).toEqual({
      operationId: 'op-envelope',
      outcome: 'failed',
      failedLeaf: 'fixture_quiet',
      tailSequence: receipt.tailSequence,
      leaves: [
        { action: 'fixture_promises', status: 'passed', events: 1 },
        { action: 'fixture_quiet', status: 'failed', events: 0 },
      ],
    });
    expect(receipt.tailSequence).toBeGreaterThan(0);
  });

  it('ReplayOfAFailedOperation_CarriesItTheSecondTimeToo', async () => {
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], {
      fixture_quiet: failingHandler('refused'),
    });
    const request = {
      intent: INTENT,
      streamId: STREAM,
      args: { taskId: 't1' },
      operationId: 'op-envelope-replay',
    };
    const first = toEnvelope(await execute(request, deps));
    const second = toEnvelope(await execute(request, deps));
    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    if (first.success || second.success) return;
    expect(second.error.intentReceipt).toEqual(first.error.intentReceipt);
    expect(second.error.intentReceipt).toBeDefined();
  });
});

// ─── The registered output schema, over receipts the executor actually made ─

describe('the registered output schema accepts a real receipt', () => {
  function envelopeOf(receipt: IntentReceipt): Record<string, unknown> {
    return {
      success: true,
      data: receipt,
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
  }

  it('CommittedAndFailedReceipts_BothParse', async () => {
    const committed = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1', riskTier: 'high' }, operationId: 'op-schema-ok' },
        depsFor([fixtureStep('fixture_promises', 'stop')], {
          fixture_promises: appendingHandler('task.completed'),
        }),
      ),
    );
    const failed = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-schema-fail' },
        depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: failingHandler('refused') }),
      ),
    );

    expect(committed.outcome).toBe('committed');
    expect(failed.outcome).toBe('failed');
    for (const receipt of [committed, failed]) {
      const parsed = IntentExecutedOutputSchema.safeParse(envelopeOf(receipt));
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues),
      ).toBe(true);
    }
  });

  it('AnAdvisoryEmissionViolationOnALeaf_ParsesToo', async () => {
    const announcing = fixtureAction({
      name: 'fixture_announces',
      emissions: declared({
        event: 'task.completed',
        condition: 'always',
        owner: 'orchestrate',
        role: 'primary',
      }),
    });
    const receipt = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-schema-advisory' },
        depsFor([fixtureStep('fixture_announces', 'stop')], { fixture_announces: silentHandler() }, [
          announcing,
        ]),
        advisoryWiring(),
      ),
    );
    expect(receipt.leaves[0]?.emissionViolation).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(IntentExecutedOutputSchema.safeParse(envelopeOf(receipt)).success).toBe(true);
  });
});
