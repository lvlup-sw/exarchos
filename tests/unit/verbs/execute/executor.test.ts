// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the persisted operation claim the SQLite appender hands back on a replay — read out of the store rather than rebuilt in process, so a receipt the first call invented and never durably recorded cannot satisfy the comparison
//
// The receipt-equality assertions compare a receipt that the executor builds during a segment with the receipt that a replay reads from the claim row.
// A replay answered from memory compares a value with itself and cannot disagree.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { resolveConfig } from '../../../../src/config/resolve.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import {
  BUNDLE_REF_FIELD,
  SETTLED_EVENT_TYPES,
  type BundleRefV1,
} from '../../../../src/events/bundle/digest-references.js';
import { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  OrchestrateIntentExecutedData,
  WorkflowEventBase,
  type WorkflowEvent,
} from '../../../../src/events/schemas.js';
import { ContentAddressedStoreError } from '../../../../src/storage/artifacts/content-addressed-store.js';
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
import {
  decodeExecuteIntentBundle,
  executeIntentBundleArtifactId,
} from '../../../../src/verbs/execute/run-bundle.js';
import { IntentExecutedOutputSchema } from '../../../../src/verbs/execute/schemas.js';
import type { IntentReceipt } from '../../../../src/verbs/execute/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  appendingHandler,
  countingHandler,
  failingHandler,
  FIXTURE_TOOL,
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
  verdictHandler,
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
    handlerTool: FIXTURE_TOOL,
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

  /** A composing caller that reads the tier from a pinned capsule says so. The record never claims that the runtime supplied the terms. */
  it('CapsuleSteering_IsRecordedAsTheCapsules', async () => {
    const deps = { ...depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: silentHandler() }), steeringSource: 'capsule' as const };
    const result = await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1', riskTier: 'low', boundaryTouching: false },
        operationId: 'op-steer-capsule',
      },
      deps,
    );
    expect(receiptOf(result).steering).toEqual({ riskTier: 'low', boundaryTouching: false, source: 'capsule' });
    const committed = await operationEvents();
    expect(committed[0]?.data).toMatchObject({
      steering: { riskTier: 'low', boundaryTouching: false, source: 'capsule' },
    });
  });

  /** The commit event belongs to the outer dispatch, not to a leaf. The emission check for that dispatch queries by its operation id. */
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

    const committed = await operationEvents();
    expect(committed[0]?.operationId).not.toContain(':leaf-');
    expect(committed[0]?.operationId).toBeDefined();

    const byDerived = await store.query(STREAM, {
      operationId: derivedLeafOperationId('op-derived', 1, 'fixture_promises'),
    });
    expect(byDerived.map((event) => event.type)).toEqual(['task.completed']);
  });

  /** Each receipt event carries its stream next to its sequence. This leaf addresses the subject, so that stream is the subject stream. */
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
      { type: 'task.completed', streamId: STREAM, sequence: appended[0]?.sequence },
    ]);
  });
});

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

/** A leaf registered as a blocking gate. */
const blockingGate = fixtureAction({ name: 'fixture_blocking_gate', gate: { blocking: true } });

/** A leaf registered as a gate that does not block. */
const advisoryGate = fixtureAction({ name: 'fixture_advisory_gate', gate: { blocking: false } });

/** A leaf with no gate registration at all. */
const ungated = fixtureAction({ name: 'fixture_ungated' });

/** A blocking gate that blocks, in the carrier shape the kill probe returns. */
const BLOCKED_VERDICT = {
  passed: false,
  disposition: 'blocked',
  report: 'the scoped tests stayed GREEN with the task source reverted',
};

describe('handleExecuteIntent blocking gate verdicts', () => {
  async function bundleOf(receipt: IntentReceipt): Promise<ReturnType<typeof decodeExecuteIntentBundle>> {
    const ref = receipt.bundleRefs?.[0];
    if (ref === undefined) throw new Error('receipt carries no bundle reference');
    return decodeExecuteIntentBundle(await RunBundleStore.forStateDir(stateDir).resolve(ref.digest));
  }

  it('BlockingGateThatBlocks_HaltsTheSegmentUnderStop', async () => {
    const later = countingHandler(silentHandler());
    const deps = depsFor(
      [fixtureStep('fixture_blocking_gate', 'stop'), fixtureStep('fixture_quiet', 'stop')],
      { fixture_blocking_gate: verdictHandler(BLOCKED_VERDICT), fixture_quiet: later.handler },
      [blockingGate, quiet],
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-gate-stop' },
      deps,
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(result.error?.message).toBe(
      "leaf 'fixture_blocking_gate' is a blocking gate and its verdict blocked (passed: false, disposition 'blocked')",
    );
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('fixture_blocking_gate');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['failed']);
    expect(later.calls()).toBe(0);

    const committed = await operationEvents();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.data).toMatchObject({ outcome: 'failed', failedLeaf: 'fixture_blocking_gate' });

    const bundle = await bundleOf(receipt);
    expect(bundle.leaves[0]?.disposition).toEqual({ kind: 'invoked', handler: { success: true } });
    expect(bundle.leaves[0]?.verdict).toEqual({
      status: 'failed',
      failure: { code: 'INTENT_SEGMENT_FAILED', message: result.error?.message },
    });
  });

  it('BlockingGateThatBlocks_IsAdvisoryFailedUnderContinue', async () => {
    const later = countingHandler(silentHandler());
    const deps = depsFor(
      [fixtureStep('fixture_blocking_gate', 'continue'), fixtureStep('fixture_quiet', 'stop')],
      { fixture_blocking_gate: verdictHandler(BLOCKED_VERDICT), fixture_quiet: later.handler },
      [blockingGate, quiet],
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-gate-continue' },
      deps,
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['advisory-failed', 'passed']);
    expect(later.calls()).toBe(1);

    const verdict = (await bundleOf(receipt)).leaves[0]?.verdict;
    expect(verdict?.status).toBe('advisory-failed');
    expect(verdict?.status === 'advisory-failed' ? verdict.failure.message : '').toContain('passed: false');
  });

  it('ABlockedVerdictUnderContinue_DoesNotExcuseAMissingEmission', async () => {
    const announcingGate = fixtureAction({
      name: 'fixture_blocking_gate',
      gate: { blocking: true },
      emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
    });
    const later = countingHandler(silentHandler());
    const deps = depsFor(
      [fixtureStep('fixture_blocking_gate', 'continue'), fixtureStep('fixture_quiet', 'stop')],
      { fixture_blocking_gate: verdictHandler(BLOCKED_VERDICT), fixture_quiet: later.handler },
      [announcingGate, quiet],
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-gate-integrity' },
      deps,
    );

    expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(receiptOf(result).leaves.map((leaf) => leaf.status)).toEqual(['failed']);
    expect(later.calls()).toBe(0);
  });

  it.each([
    ['a pass', { passed: true, disposition: 'proved' }],
    ['a policy skip', { passed: true, skipped: true, disposition: 'advisory-skip' }],
    ['an inconclusive skip', { passed: false, skipped: true, skipReason: 'no-toolchain' }],
    ['a skip named only by its disposition', { passed: false, disposition: 'advisory-skip' }],
  ])('BlockingGateThatDoesNotBlock_PassesTheLeaf (%s)', async (_label, data) => {
    const deps = depsFor(
      [fixtureStep('fixture_blocking_gate', 'stop'), fixtureStep('fixture_quiet', 'stop')],
      { fixture_blocking_gate: verdictHandler(data), fixture_quiet: silentHandler() },
      [blockingGate, quiet],
    );
    const result = await execute({ intent: INTENT, streamId: STREAM, args: { taskId: 't1' } }, deps);
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['passed', 'passed']);
  });

  it.each([
    ['a gate that does not block', advisoryGate],
    ['a leaf that is no gate', ungated],
  ])('PassedFalseFromANonBlockingLeaf_StaysAdvisory (%s)', async (_label, action) => {
    const deps = depsFor(
      [fixtureStep(action.name, 'stop'), fixtureStep('fixture_quiet', 'stop')],
      { [action.name]: verdictHandler(BLOCKED_VERDICT), fixture_quiet: silentHandler() },
      [action, quiet],
    );
    const result = await execute({ intent: INTENT, streamId: STREAM, args: { taskId: 't1' } }, deps);
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['passed', 'passed']);
  });

  it('ReplayOfABlockedSegment_ReproducesTheSameRefusal', async () => {
    const counted = countingHandler(verdictHandler(BLOCKED_VERDICT));
    const deps = depsFor([fixtureStep('fixture_blocking_gate', 'stop')], { fixture_blocking_gate: counted.handler }, [
      blockingGate,
    ]);
    const request = { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-gate-replay' };
    const first = await execute(request, deps);
    const second = await execute(request, deps);

    expect(second.error).toEqual(first.error);
    expect(second.error?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(counted.calls()).toBe(1);
  });
});

describe('handleExecuteIntent per-leaf emission verification', () => {
  /** Seeded violation: the registration promises `task.completed` on each successful call, and the handler appends nothing. */
  it('SilentLeafThatDeclaredAnEmission_FailsItsOwnContract', async () => {
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

  /** The control for the test above. Only the handler changes. */
  it('SameLeafDeclarationAppendingTheEvent_Passes', async () => {
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

  /**
   * An earlier leaf that appends the event a later leaf owes must not satisfy the later leaf.
   * The verifier records its finding against the derived operation id of the leaf.
   * With one shared id, its query finds the earlier `task.completed` and reports the contract as kept.
   */
  it('LeafEmissionCheckIsScopedToItsOwnOperationId', async () => {
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

    const findings = await store.query(STREAM, { type: 'emission.violated' });
    expect(findings.map((event) => (event.data as { operationId?: string }).operationId)).toEqual([
      derivedLeafOperationId('op-scoped', 1, 'fixture_promises'),
    ]);
  });
});

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

describe('handleExecuteIntent crash distinguishability', () => {
  /** The work of the completed leaf stays durable, under a leaf id derived from the operation id of the caller. */
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

    const durable = await store.query(STREAM, {
      operationId: derivedLeafOperationId('op-crash', 0, 'fixture_quiet'),
    });
    expect(durable.map((event) => event.type)).toEqual(['task.completed']);
  });

  /** No claim exists after the crash, so the retry runs the segment again from the top. */
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
    expect(counted.calls()).toBe(2);
    const durable = await store.query(STREAM, {
      operationId: derivedLeafOperationId('op-retry', 0, 'fixture_quiet'),
    });
    expect(durable).toHaveLength(2);
  });
});

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

  /**
   * The other boundary tests take their input from the constant, so a larger constant moves them too.
   * This test measures the constant against the operation-id limit of the event row, with the longest suffix the live registry can add.
   * It also proves that the row refuses a longer id.
   */
  it('TheBound_LeavesRoomForTheLongestDerivedLeafIdTheRegistryCanProduce', () => {
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
    expect(row('a'.repeat(worstCase.length + 200))).toBe(false);
  });

  /**
   * The event row holds the derived leaf id, which is the caller key plus a suffix.
   * A key at the ceiling of the admission grammar gives leaf ids that the store rejects mid-segment.
   */
  it('OperationIdOneOverTheBound_IsRefusedBeforeAnyEffect', async () => {
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

/** `streamId` and `featureId` are two spellings of one stream. */
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

  /** A silent choice commits the segment to one stream while the dispatch-layer emission check reads the other. */
  it('BothSpellingsPresentAndDisagreeing_IsRefused', async () => {
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

  /**
   * `vcs` is a reserved infrastructure stream. A segment bound to it mixes the operation claim and receipts with the journal records that the reservation keeps apart from feature streams.
   */
  it('ReservedInfraStreamAsStreamId_IsRefusedBeforeCompilation', async () => {
    const result = await execute(
      { intent: INTENT, streamId: 'vcs', args: { taskId: 't1' }, operationId: 'op-reserved-stream' },
      deps(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('reserved infrastructure stream');
    expect(await store.query('vcs')).toHaveLength(0);
  });

  it('ReservedInfraStreamAsFeatureIdAlias_IsRefusedTheSameWay', async () => {
    const result = await execute(
      { intent: INTENT, featureId: 'telemetry', args: { taskId: 't1' }, operationId: 'op-reserved-alias' },
      deps(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('reserved infrastructure stream');
    expect(await store.query('telemetry')).toHaveLength(0);
  });

  /** The dispatch-layer resolver reads `featureId` first, and the executor must agree with it on the stream. */
  it('FeatureIdWins_MatchingTheDispatchLayerStreamResolver', async () => {
    const result = await execute(
      { intent: INTENT, featureId: STREAM, args: { taskId: 't1' }, operationId: 'op-feature-first' },
      deps(),
    );
    expect(result.success).toBe(true);
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
  });
});

/**
 * A concurrent call can take the operation claim after the replay pre-flight misses and before the commit.
 * The `claimingHandler` helper takes the claim from inside a leaf handler to reproduce that window.
 * Like any other commit, its claim carries at least one event.
 */
describe('handleExecuteIntent commit races', () => {
  const request = (operationId: string) => ({
    intent: INTENT,
    streamId: STREAM,
    args: { taskId: 't1' },
    operationId,
  });

  function claimingHandler(operationId: string, digest: () => string, result: IntentReceipt): LeafHandler {
    return async () => {
      await store.getAppender().decideOnce<IntentReceipt>(operationId, digest(), () => ({
        streamId: STREAM,
        events: [{ type: 'task.progressed', data: { taskId: 'racing-writer' } }],
        result,
      }));
      return { success: true, data: { appended: null } };
    };
  }

  /**
   * The digest covers the request, not the key. Thus a probe with the same request under a different key gives the digest for the racing writer.
   * No claim stores the local receipt of the loser, so the caller must get the persisted receipt.
   */
  it('SameDigest_TheCallerGetsThePersistedReceiptNotTheLocalOne', async () => {
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

    expect(result.success).toBe(true);
    expect(receiptOf(result)).toEqual(winner);
    expect(claimFor('op-race')?.result).toEqual(winner);
  });

  /** The segment ran, so the refusal says that effects are already performed, not the "nothing was executed" text of the pre-flight. */
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
    expect(result.error?.message).toContain('effects are already performed');
  });

  /**
   * The executor serializes in-process calls with the same operation id.
   * The second call waits, finds the claim of the first call in its pre-flight, and replays it.
   * Without that order, both calls see an empty pre-flight and both run the leaves.
   */
  it('ConcurrentSameRequest_RunsTheSegmentOnceAndBothCallersGetTheReceipt', async () => {
    const leaf = vi.fn(silentHandler());
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], {
      fixture_quiet: leaf,
    });

    const [first, second] = await Promise.all([
      execute(request('op-concurrent-same'), deps),
      execute(request('op-concurrent-same'), deps),
    ]);

    expect(leaf).toHaveBeenCalledTimes(1);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(receiptOf(second)).toEqual(receiptOf(first));
    expect(await operationEvents()).toHaveLength(1);
  });

  /**
   * The pre-flight of the waiting call finds a claim with a different digest and refuses before its leaves run.
   * The "effects are already performed" text is for a racer in another process, which only the commit can catch.
   */
  it('ConcurrentDifferentRequest_SecondIsRefusedWithoutRunningItsLeaves', async () => {
    const leaf = vi.fn(silentHandler());
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], {
      fixture_quiet: leaf,
    });

    const [first, second] = await Promise.all([
      execute(request('op-concurrent-clash'), deps),
      execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't2' }, operationId: 'op-concurrent-clash' },
        deps,
      ),
    ]);

    expect(leaf).toHaveBeenCalledTimes(1);
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('INTENT_REPLAY_DIGEST_MISMATCH');
    expect(second.error?.message).toContain('Nothing was executed');
  });
});

describe('handleExecuteIntent without an ambient dispatch context', () => {
  /**
   * A direct in-process call with no `runWithDispatchContext` wrapper mints the outer packet.
   * With no ambient context, `stampFromAmbient` adds no correlation id, so the commit must run inside the minted packet.
   * The operation record and the leaf events must carry the same minted correlation id.
   */
  it('OperationRecordAndLeafEvents_ShareTheMintedOuterCorrelationId', async () => {
    const deps = depsFor([fixtureStep('fixture_promises', 'stop')], {
      fixture_promises: appendingHandler('task.completed'),
    });
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

/**
 * The `ensuring` leaf declares an event-append postcondition but no emission.
 * The `evidencing` leaf declares the durable-evidence source, which an event query cannot see.
 */
describe('handleExecuteIntent per-leaf ensures', () => {
  const ensuring = fixtureAction({
    name: 'fixture_ensures',
    ensures: declared({ source: 'event-append', when: 'success', event: 'gate.executed' }),
  });

  /** The leaf declares no emissions, so only the ensures observation can catch it. */
  it('SilentLeafWithAnEnsuresEventOutsideItsEmissions_FailsItsContract', async () => {
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

  const evidencing = fixtureAction({
    name: 'fixture_evidences',
    ensures: declared({ source: 'durable-evidence', when: 'success', evidenceType: 'gate' }),
  });

  /** Shipped gate actions declare this source. A comparison over appended event types alone skips it and reports nothing. */
  it('SilentLeafWithADurableEvidenceEnsures_FailsItsContract', async () => {
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

  /** The control: the leaf records gate evidence in the real evidence schema, under its derived operation id. */
  it('SameLeafRecordingTheEvidence_Passes', async () => {
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

  /**
   * The row commits with a real reference, but the blob is not under the root of the executor resolver.
   * A two-root producer split leaves the same shape, and it must halt like a missing blob.
   * The error names the blob digest, because "evidence gate" alone does not tell a missing row from an unreadable blob.
   */
  it('Executor_LeafArtifactEvidenceUnderAnotherRoot_HaltsWithEmissionContractViolated', async () => {
    const deps = depsFor([fixtureStep('fixture_evidences', 'stop')], {
      fixture_evidences: gateEvidenceHandler({
        requirementId: 'gate:review:review',
        phaseAttemptId: 'attempt-fixture-artifact-elsewhere',
        producerRef: 'fixture.evidence-gate-artifact-elsewhere',
        artifact: { content: { verdict: 'pass' }, root: 'elsewhere' },
      }),
    }, [evidencing]);
    const result = await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1' },
        operationId: 'op-evidence-artifact-elsewhere',
      },
      deps,
    );
    expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(result.error?.message).toMatch(/sha256:[0-9a-f]{64}/);
    expect(receiptOf(result).failedLeaf).toBe('fixture_evidences');
  });

  /** The pair of the test above: the same leaf and blob content, written under the root that the resolver reads. */
  it('Executor_LeafArtifactEvidenceUnderTheStateDir_Passes', async () => {
    const deps = depsFor([fixtureStep('fixture_evidences', 'stop')], {
      fixture_evidences: gateEvidenceHandler({
        requirementId: 'gate:review:review',
        phaseAttemptId: 'attempt-fixture-artifact-kept',
        producerRef: 'fixture.evidence-gate-artifact-kept',
        artifact: { content: { verdict: 'pass' }, root: 'state-dir' },
      }),
    }, [evidencing]);
    const result = await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1' },
        operationId: 'op-evidence-artifact-kept',
      },
      deps,
    );
    expect(
      result.success,
      `${result.error?.code ?? ''} ${result.error?.message ?? ''}`,
    ).toBe(true);
    expect(receiptOf(result).leaves[0]?.status).toBe('passed');
  });

  /**
   * The observer fails (an unreadable ledger, or a resolver failure outside its per-reference guard) instead of reporting a miss.
   * The leaf already ran its effects. An escaped throw loses the halt-regardless classification and leaves no receipt that names the unchecked postcondition.
   */
  it('Executor_PostconditionObservationThrows_HaltsInsteadOfEscaping', async () => {
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (streamId, filters) => {
      if (filters?.type === 'admission.evidence-recorded') {
        throw new Error('simulated ledger read failure');
      }
      return EventStore.prototype.query.call(store, streamId, filters);
    });
    try {
      const deps = depsFor([fixtureStep('fixture_evidences', 'stop')], {
        fixture_evidences: gateEvidenceHandler({
          requirementId: 'gate:review:review',
          phaseAttemptId: 'attempt-fixture-observer-throws',
          producerRef: 'fixture.evidence-gate-observer-throws',
        }),
      }, [evidencing]);
      const result = await execute(
        {
          intent: INTENT,
          streamId: STREAM,
          args: { taskId: 't1' },
          operationId: 'op-evidence-observer-throws',
        },
        deps,
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
      expect(receiptOf(result).failedLeaf).toBe('fixture_evidences');
    } finally {
      querySpy.mockRestore();
    }
  });
});

/** The `announcing` leaf promises an event on each call and declares no postcondition. */
describe('handleExecuteIntent emission enforcement on a continue leaf', () => {
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

  /**
   * `onFail: 'continue'` applies to the verdict of the leaf.
   * A broken emission contract breaks the integrity of the log, and the advisory policy of the runbook does not excuse that.
   */
  it('BlockMode_HaltsTheSegmentEvenThoughTheLeafIsAdvisory', async () => {
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

  /** Advisory mode reports the finding without the failure. The finding stays on the receipt leaf that produced it, so it is not lost. */
  it('AdvisoryMode_CommitsAndRecordsTheViolationOnTheLeaf', async () => {
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

  /**
   * The verifier records its advisory finding under the derived id of the violating leaf.
   * After a crash, the retried leaf finds that row under its own id. The row is about the leaf and is not a leaf emission.
   * The receipt must not report it as an appended event or count it toward the tail.
   */
  it('APriorAttemptsViolationRow_IsNotFoldedIntoTheRetriedReceipt', async () => {
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

  /**
   * The receipt of a failed segment travels inside the error.
   * The advisory finding must stay in that receipt, because the caller whose segment halted needs it most.
   */
  it('AnAdvisoryFindingOnAFailedSegment_SurvivesIntoTheErrorEnvelope', async () => {
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

/** The receipt of a failed segment must survive the envelope boundary. */
describe('handleExecuteIntent failure envelope', () => {
  /**
   * The assertions read the envelope, not the raw ToolResult.
   * The envelope keeps `data` only on the success path, so a receipt left there never reaches the caller.
   * A failed segment still ran, so the refusal carries its bundle references.
   */
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

    const envelope = toEnvelope(result);
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(Object.hasOwn(envelope, 'data')).toBe(false);
    expect(envelope.error.intentReceipt).toEqual({
      operationId: 'op-envelope',
      outcome: 'failed',
      failedLeaf: 'fixture_quiet',
      tailSequence: receipt.tailSequence,
      bundleRefs: receipt.bundleRefs,
      leaves: [
        { action: 'fixture_promises', status: 'passed', events: 1 },
        { action: 'fixture_quiet', status: 'failed', events: 0 },
      ],
    });
    expect(receipt.tailSequence).toBeGreaterThan(0);
    expect(receipt.bundleRefs).toHaveLength(1);
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

/** The run bundle is durable before the operation record names it. */
describe('handleExecuteIntent run bundle', () => {
  const bundles = () => RunBundleStore.forStateDir(stateDir);

  function blobPath(digest: { algorithm: string; value: string }): string {
    return path.join(bundles().root, digest.algorithm, digest.value.slice(0, 2), digest.value.slice(2));
  }

  function refsOf(receipt: IntentReceipt): readonly BundleRefV1[] {
    if (receipt.bundleRefs === undefined) throw new Error('receipt carries no bundle reference');
    return receipt.bundleRefs;
  }

  /**
   * The receipt and the row carry one reference, named for the operation.
   * The bundle holds the run interior: the args, the times, and the handler result of each leaf.
   * The bundle does not carry its own reference, because the digest is of these bytes.
   * Schema version `1.1` marks the custody epoch, so the sweep can tell this row from a row that settled before custody.
   * The type and the version are literals, so a third authority checks the binding of the executor to the oracle.
   */
  it('CommittedSegment_WritesItsInteriorToTheBundleStoreAndStampsTheReferenceOnTheRecord', async () => {
    const deps = depsFor(
      [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
      { fixture_quiet: silentHandler(), fixture_promises: appendingHandler('task.completed') },
    );
    const result = await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1', riskTier: 'medium' },
        operationId: 'op-bundle',
      },
      deps,
    );
    const receipt = receiptOf(result);
    expect(result.success).toBe(true);

    const refs = refsOf(receipt);
    expect(refs).toHaveLength(1);
    const [ref] = refs;
    if (ref === undefined) throw new Error('no reference');
    expect(ref.artifactId).toBe(executeIntentBundleArtifactId('op-bundle'));
    const committed = await operationEvents();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.data?.[BUNDLE_REF_FIELD]).toEqual(refs);

    const bundle = decodeExecuteIntentBundle(await bundles().resolve(ref.digest));
    expect(bundle).toMatchObject({
      kind: 'execute-intent-run',
      operationId: 'op-bundle',
      intent: INTENT,
      streamId: STREAM,
      outcome: 'committed',
      requestDigest: receipt.requestDigest,
      steering: { riskTier: 'medium', source: 'caller-args' },
      tailSequence: receipt.tailSequence,
      interaction: receipt.interaction,
    });
    expect(bundle.leaves.map((leaf) => [leaf.index, leaf.action, leaf.verdict.status])).toEqual([
      [0, 'fixture_quiet', 'passed'],
      [1, 'fixture_promises', 'passed'],
    ]);
    const [quiet, promises] = bundle.leaves;
    expect(quiet?.args).toMatchObject({ featureId: STREAM, taskId: 't1' });
    expect(quiet?.disposition).toEqual({ kind: 'invoked', handler: { success: true } });
    expect(quiet?.verdict).toEqual({ status: 'passed' });
    expect(Date.parse(quiet?.endedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(quiet?.startedAt ?? ''));
    expect(promises?.events).toEqual(receipt.leaves[1]?.events);
    expect(Object.hasOwn(bundle, 'bundleRefs')).toBe(false);

    expect(committed[0]?.type).toBe('orchestrate.intent_executed');
    expect(committed[0]?.schemaVersion).toBe('1.1');
    expect(SETTLED_EVENT_TYPES).toContain('orchestrate.intent_executed');
    expect(INTENT_EXECUTED_EVENT).toBe('orchestrate.intent_executed');
  });

  /**
   * The crash retry skips a reject-replay leaf that already landed its declared rows.
   * The bundle records this as one discriminated value, so "not reached" and "already proved" cannot disagree.
   */
  it('ReplayElidedLeaf_IsRecordedAsElidedNotInvoked', async () => {
    const guarded = fixtureAction({
      name: 'fixture_guarded',
      emissions: declared({ event: 'task.completed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
      replay: {
        kind: 'reject-replay',
        because: 'fixture leaf refuses replay so the elision has a leaf to record',
      },
    });
    const counted = countingHandler(appendingHandler('task.completed'));
    let crash = true;
    const deps = depsFor(
      [fixtureStep('fixture_guarded', 'stop'), fixtureStep('fixture_quiet', 'stop')],
      {
        fixture_guarded: counted.handler,
        fixture_quiet: async (args, dir, ctx) => {
          if (crash) throw new Error('fixture crash');
          return silentHandler()(args, dir, ctx);
        },
      },
      [guarded, quiet],
    );
    const request = { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-bundle-elided' };

    await expect(execute(request, deps)).rejects.toThrow('fixture crash');
    crash = false;
    const receipt = receiptOf(await execute(request, deps));

    expect(counted.calls(), 'the guarded leaf ran again on the retry').toBe(1);
    const [ref] = refsOf(receipt);
    if (ref === undefined) throw new Error('no reference');
    const bundle = decodeExecuteIntentBundle(await bundles().resolve(ref.digest));
    expect(bundle.leaves[0]?.disposition).toEqual({ kind: 'replay-elided' });
    expect(bundle.leaves[0]?.verdict).toEqual({ status: 'passed' });
    expect(bundle.leaves[1]?.disposition).toEqual({ kind: 'invoked', handler: { success: true } });
  });

  /**
   * The executor does not own the error codes of handlers. An empty code must not make the commit throw on each retry.
   * The trace records the refusal unchanged, and the segment commits as failed.
   */
  it('HandlerReturningAnEmptyErrorCode_StillCommits', async () => {
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], {
      fixture_quiet: async () => ({ success: false, error: { code: '', message: '' } }),
    });
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-bundle-empty-code' },
      deps,
    );

    expect(result.success).toBe(false);
    const receipt = receiptOf(result);
    expect(receipt.outcome).toBe('failed');
    expect(claimFor('op-bundle-empty-code')).toBeDefined();
    const [ref] = refsOf(receipt);
    if (ref === undefined) throw new Error('no reference');
    const bundle = decodeExecuteIntentBundle(await bundles().resolve(ref.digest));
    expect(bundle.leaves[0]?.disposition).toEqual({
      kind: 'invoked',
      handler: { success: false, error: { code: '', message: '' } },
    });
  });

  /**
   * A claim from a build before custody carries no `bundleRefs`, and a replay returns that receipt unchanged.
   * This case is the reason that `bundleRefs` is optional on the receipt.
   * The test seeds the claim with the commit primitive of the executor, under the digest that the executor computes for the request.
   */
  it('AClaimPersistedBeforeCustody_ReplaysThroughTheOutputSchema', async () => {
    const request = { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-pre-custody' };
    const ordered = Object.keys(request.args)
      .sort()
      .map((key) => [key, request.args[key as keyof typeof request.args]] as const);
    const canonical = JSON.stringify({ intent: INTENT, streamId: STREAM, args: ordered });
    const requestDigest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    const legacyReceipt: IntentReceipt = {
      operationId: 'op-pre-custody',
      intent: INTENT,
      outcome: 'committed',
      leaves: [{ action: 'fixture_quiet', status: 'passed', events: [] }],
      tailSequence: 0,
      requestDigest,
      interaction: { leavesExecuted: 1, eventsAppended: 0, requests: 1, deferred: [] },
    };
    await store.getAppender().decideOnce<IntentReceipt>('op-pre-custody', requestDigest, () => ({
      streamId: STREAM,
      events: [
        {
          type: INTENT_EXECUTED_EVENT,
          data: {
            operationId: 'op-pre-custody',
            intent: INTENT,
            outcome: 'committed',
            leaves: [{ action: 'fixture_quiet', status: 'passed', sequences: [] }],
            requestDigest,
          },
          timestamp: new Date().toISOString(),
          schemaVersion: '1.0',
        },
      ],
      result: legacyReceipt,
    }));

    const counted = countingHandler(silentHandler());
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: counted.handler });
    const result = await execute(request, deps);

    expect(counted.calls(), 'a claimed operation must not re-run').toBe(0);
    expect(receiptOf(result).bundleRefs).toBeUndefined();
    const envelope = toEnvelope(result);
    const parsed = IntentExecutedOutputSchema.safeParse(envelope);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? null)).toBe(true);
  });

  /** The compact receipt in the refusal points at the same bundle bytes. */
  it('FailedSegment_AlsoWritesItsBundle_AndTheTraceCarriesTheHandlersRefusal', async () => {
    const deps = depsFor(
      [fixtureStep('fixture_promises', 'stop'), fixtureStep('fixture_quiet', 'stop')],
      { fixture_promises: appendingHandler('task.completed'), fixture_quiet: failingHandler('refused') },
    );
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-bundle-failed' },
      deps,
    );
    const receipt = receiptOf(result);
    expect(result.success).toBe(false);

    const [ref] = refsOf(receipt);
    if (ref === undefined) throw new Error('no reference');
    const bundle = decodeExecuteIntentBundle(await bundles().resolve(ref.digest));
    expect(bundle.outcome).toBe('failed');
    expect(bundle.failedLeaf).toBe('fixture_quiet');
    expect(bundle.failure?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(bundle.leaves[1]?.disposition).toEqual({
      kind: 'invoked',
      handler: { success: false, error: { code: 'FIXTURE_LEAF_REFUSED', message: 'refused' } },
    });
    expect(bundle.leaves[1]?.verdict.status).toBe('failed');
    expect(result.error?.intentReceipt?.bundleRefs).toEqual(receipt.bundleRefs);
  });

  /** The claim answers the replay, and the blob bytes stay unchanged. */
  it('Replay_ReturnsThePersistedReferenceAndWritesNoSecondBundle', async () => {
    const counted = countingHandler(silentHandler());
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: counted.handler });
    const request = { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-bundle-replay' };

    const first = receiptOf(await execute(request, deps));
    const [ref] = refsOf(first);
    if (ref === undefined) throw new Error('no reference');
    const bytesBefore = await readFile(blobPath(ref.digest));

    const second = receiptOf(await execute(request, deps));

    expect(counted.calls()).toBe(1);
    expect(second.bundleRefs).toEqual(first.bundleRefs);
    expect((await readFile(blobPath(ref.digest))).equals(bytesBefore)).toBe(true);
    expect(claimFor('op-bundle-replay')?.result.bundleRefs).toEqual(first.bundleRefs);
  });

  /**
   * The executor makes the bundle durable before the record that names it.
   * A failed publish thus fails the commit: no claim, no operation event, and the leaf work stays in the log.
   * A leaf that throws mid-segment leaves the same shape, and the retry model can finish it.
   */
  it('BundleWriteFails_LeavesNoClaimAndNoOperationEvent_LikeAnyOtherCrash', async () => {
    const failing = new RunBundleStore(path.join(stateDir, 'failing-bundles'), {
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      readFile: async () => {
        throw new ContentAddressedStoreError('CONTENT_NOT_FOUND', 'nothing was published');
      },
      publish: async () => {
        throw new Error('bundle publish failed');
      },
      unlink: async () => undefined,
    });
    const deps = {
      ...depsFor(
        [fixtureStep('fixture_quiet', 'stop'), fixtureStep('fixture_promises', 'stop')],
        { fixture_quiet: appendingHandler('task.completed'), fixture_promises: silentHandler() },
        [fixtureAction({ name: 'fixture_quiet' }), fixtureAction({ name: 'fixture_promises' })],
      ),
      bundleStore: failing,
    };

    await expect(
      execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-bundle-crash' },
        deps,
      ),
    ).rejects.toThrow('bundle publish failed');

    expect(claimFor('op-bundle-crash')).toBeUndefined();
    expect(await operationEvents()).toHaveLength(0);
    const durable = await store.query(STREAM, {
      operationId: derivedLeafOperationId('op-bundle-crash', 0, 'fixture_quiet'),
    });
    expect(durable.map((event) => event.type)).toEqual(['task.completed']);
  });

  /**
   * After a real execution, the oracle is clear with a non-empty denominator.
   * It reports `digest-mismatch` when the bytes at the same path change, because the reference still parses but the re-hash disagrees.
   * It reports `blob-missing` when the bytes are deleted. The claim still answers the replay, so only the oracle names the deletion.
   */
  it('TheIntegrityOracle_HoldsANonEmptyDenominatorOnTheProducersOwnStream_AndNamesASeededLoss', async () => {
    const deps = depsFor([fixtureStep('fixture_quiet', 'stop')], { fixture_quiet: silentHandler() });
    const receipt = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-bundle-oracle' },
        deps,
      ),
    );
    const [ref] = refsOf(receipt);
    if (ref === undefined) throw new Error('no reference');

    const clear = await store.runBundleIntegrityCheck();
    expect(clear.ok).toBe(true);
    if (clear.ok !== true) return;
    expect(clear.referenceCount).toBe(1);
    expect(clear.scannedStreamCount).toBeGreaterThanOrEqual(1);

    const blob = blobPath(ref.digest);
    const original = await readFile(blob);
    await writeFile(blob, Buffer.concat([original, Buffer.from('\n// altered', 'utf8')]));
    const tampered = await store.runBundleIntegrityCheck();
    expect(tampered.ok).toBe(false);
    if (tampered.ok !== false) return;
    expect(tampered.violations).toEqual([
      { kind: 'digest-mismatch', streamId: STREAM, sequence: expect.any(Number), digest: `sha256:${ref.digest.value}` },
    ]);

    await unlink(blob);
    const replayed = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-bundle-oracle' },
        deps,
      ),
    );
    expect(replayed.bundleRefs).toEqual(receipt.bundleRefs);
    const missing = await store.runBundleIntegrityCheck();
    expect(missing.ok).toBe(false);
    if (missing.ok !== false) return;
    expect(missing.violations.map((v) => v.kind)).toEqual(['blob-missing']);
    expect(missing.violations[0]?.digest).toBe(`sha256:${ref.digest.value}`);
  });

  /**
   * The schema refuses a record that names no bundle bytes.
   * Thus a producer that forgets custody fails at commit, before it appends a row that the oracle rejects.
   */
  it('TheOperationRecord_CannotBeBuiltWithoutAReference', () => {
    const withoutRefs = {
      operationId: 'op-x',
      intent: INTENT,
      outcome: 'committed',
      leaves: [],
      requestDigest: 'sha256:abc',
    };
    expect(OrchestrateIntentExecutedData.safeParse(withoutRefs).success).toBe(false);
    expect(OrchestrateIntentExecutedData.safeParse({ ...withoutRefs, bundleRefs: [] }).success).toBe(false);
    expect(
      OrchestrateIntentExecutedData.safeParse({
        ...withoutRefs,
        bundleRefs: [{ artifactId: 'run-bundle:x', digest: { algorithm: 'sha256', value: 'a'.repeat(64) } }],
      }).success,
    ).toBe(true);
  });
});

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
