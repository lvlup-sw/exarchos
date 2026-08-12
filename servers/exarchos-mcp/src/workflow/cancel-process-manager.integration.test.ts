// ─── Cancellation process-manager integration exit proofs (P04-02 / EFF-005) ─
//
// These proofs drive the saga through the PUBLIC cancel entry point
// (`handleCancel`) — not the engine in isolation — so they pin the shipped
// behavior of transition task 053:
//   (A) restart mid-cancel does not repeat a completed compensation;
//   (B) takeover by a second instance does not repeat a completed compensation,
//       and the fenced-out (stale-epoch) instance's writes are rejected;
//   (C) cancellation cannot report complete before every outcome is recorded,
//       and retry exhaustion lands in a queryable manual-intervention terminal.
//
// The engine-level proofs live in `cancel-process-manager.saga.test.ts`; these
// prove the wiring actually delivers those guarantees to a real user-initiated
// cancellation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'child_process';
import { EventStore } from '../events/store.js';
import { handleInit } from './tools.js';
import { handleCancel } from './cancel.js';
import {
  appendFencedCancelEvent,
  planCancelCompletion,
  queryCancelSaga,
  StaleEpochError,
} from './cancel-process-manager.js';
import {
  deriveLocalOperatorIdentity,
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../dispatch/dispatch-context.js';
import type { WorkflowEvent } from '../events/schemas.js';

const mockedExecFile = vi.mocked(execFile);

const REQUIRED_ACTION_IDS = [
  'delegate:delete-integration-branch',
  'delegate:cleanup-worktrees',
  'delegate:delete-feature-branches',
] as const;

describe('cancellation process-manager — integration exit proofs (P04-02)', () => {
  let stateDir: string;
  let store: EventStore;
  let featureId: string;
  let branchExists: boolean;
  let branchDeleteFails: boolean;
  let branchDeleteCalls: number;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cancel-pm-integration-'));
    store = new EventStore(stateDir);
    await store.initialize();
    featureId = `cancel-int-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    branchExists = true;
    branchDeleteFails = false;
    branchDeleteCalls = 0;

    mockedExecFile.mockImplementation(
      (_command: unknown, argsValue: unknown, optionsValue: unknown, callbackValue?: unknown) => {
        const callback = typeof optionsValue === 'function' ? optionsValue : callbackValue;
        const args = argsValue as string[];
        const cb = callback as (error: Error | null, stdout?: string, stderr?: string) => void;

        if (args.includes('rev-parse') && args.includes('--verify')) {
          if (branchExists) cb(null, 'abc123\n', '');
          else cb(new Error('not a valid ref'), '', '');
          return undefined as never;
        }
        if (args.includes('ls-remote')) {
          cb(null, '', '');
          return undefined as never;
        }
        if (args.includes('branch') && args.includes('-D')) {
          branchDeleteCalls += 1;
          if (branchDeleteFails) cb(new Error('branch delete failed'), '', '');
          else {
            branchExists = false;
            cb(null, '', '');
          }
          return undefined as never;
        }
        cb(null, '', '');
        return undefined as never;
      },
    );

    await handleInit({ featureId, workflowType: 'feature' }, stateDir, store);
    await setDelegateState();
  });

  afterEach(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function setDelegateState(): Promise<void> {
    const file = join(stateDir, `${featureId}.state.json`);
    const state = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    state.phase = 'delegate';
    state.synthesis = {
      integrationBranch: 'integrate/cancel-pm-integration',
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    };
    state.worktrees = {};
    state.tasks = [];
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
  }

  function events(): Promise<readonly WorkflowEvent[]> {
    return store.query(featureId);
  }

  function completedFor(all: readonly WorkflowEvent[], actionId: string): readonly WorkflowEvent[] {
    return all.filter(
      (e) =>
        e.type === 'cancel.compensation-completed'
        && (e.data as Record<string, unknown> | undefined)?.actionId === actionId,
    );
  }

  async function readCancelIdentity(): Promise<{ cancelId: string; phaseAttemptId: string }> {
    const requested = (await events()).find((e) => e.type === 'cancel.requested');
    const data = requested?.data as Record<string, unknown> | undefined;
    return {
      cancelId: String(data?.cancelId),
      phaseAttemptId: String(data?.phaseAttemptId),
    };
  }

  /** Crash the first attempt to record `delegate:cleanup-worktrees` completion. */
  function crashOnSecondCompletion(): void {
    const appender = store.getAppender();
    const originalDecideOnce = appender.decideOnce.bind(appender);
    let crashOnce = true;
    vi.spyOn(appender, 'decideOnce').mockImplementation(
      async (operationId, requestDigest, closure) => {
        if (
          crashOnce
          && operationId.includes('delegate:cleanup-worktrees')
          && operationId.endsWith(':completed')
        ) {
          crashOnce = false;
          throw new Error('simulated crash before second durable result');
        }
        return originalDecideOnce(operationId, requestDigest, closure);
      },
    );
  }

  // ── (A) Restart mid-cancel does not repeat a completed compensation ────────
  it('ExitProof_RestartMidCancel_DoesNotRepeatCompletedCompensation', async () => {
    crashOnSecondCompletion();

    const interrupted = await handleCancel({ featureId }, stateDir, store);
    expect(interrupted).toMatchObject({ success: false, error: { code: 'EVENT_APPEND_FAILED' } });
    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    // Genuine restart: drop all in-memory state and reopen the durable log.
    vi.restoreAllMocks();
    store.close();
    store = new EventStore(stateDir);
    await store.initialize();

    const resumed = await handleCancel({ featureId }, stateDir, store);
    expect(resumed.success).toBe(true);

    // The completed compensation (branch -D) was NOT repeated across restart.
    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    const persisted = JSON.parse(
      await readFile(join(stateDir, `${featureId}.state.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted.phase).toBe('cancelled');
  });

  // ── (B) Takeover fences the stale instance and never repeats compensation ──
  it('ExitProof_Takeover_FencesStaleInstance_AndDoesNotRepeatCompletedCompensation', async () => {
    // Instance A: cancel far enough to durably complete the first compensation
    // (branch -D) under epoch 1, then crash before finishing. A keeps epoch 1.
    crashOnSecondCompletion();
    const instanceA = await handleCancel({ featureId }, stateDir, store);
    expect(instanceA).toMatchObject({ success: false, error: { code: 'EVENT_APPEND_FAILED' } });
    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    const { cancelId, phaseAttemptId } = await readCancelIdentity();
    const staleEpoch = (await queryCancelSaga(store, featureId, cancelId)).currentEpoch;
    expect(staleEpoch).toBe(1);

    // Instance B TAKES OVER via the same public entry point. It acquires a
    // strictly-higher epoch, folds the durable log, and MUST skip the
    // already-completed compensation rather than re-run it.
    vi.restoreAllMocks();
    const instanceB = await handleCancel({ featureId }, stateDir, store);
    expect(instanceB.success).toBe(true);

    // Not repeated: branch -D still ran exactly once, and there is still exactly
    // one durable completion for the integration-branch compensation.
    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    // B minted a higher epoch than the fenced-out A.
    const sagaAfterB = await queryCancelSaga(store, featureId, cancelId);
    expect(sagaAfterB.currentEpoch).toBeGreaterThan(staleEpoch);

    // The stale instance A (epoch 1) is now fenced out: an attempted write with
    // its epoch is rejected with a typed error, and nothing lands.
    const before = (await events()).length;
    await expect(
      appendFencedCancelEvent(store, {
        featureId,
        cancelId,
        writerEpoch: staleEpoch,
        type: 'cancel.compensation-requested',
        data: {
          eventVersion: '1.0',
          cancelId,
          featureId,
          phaseAttemptId,
          actionId: 'delegate:cleanup-worktrees',
          requestedAt: new Date().toISOString(),
        },
        idempotencyKey: `cancel:stale-write-${Date.now()}`,
        operationId: `cancel:stale-op:${cancelId}:${Date.now()}`,
      }),
    ).rejects.toBeInstanceOf(StaleEpochError);

    const after = (await events()).length;
    expect(after).toBe(before);
  });

  // ── (C) No premature completion + retry exhaustion → manual intervention ───
  it('ExitProof_RetryExhaustion_BlocksReadiness_AndLandsInManualIntervention', async () => {
    branchDeleteFails = true; // the integration-branch compensation fails forever

    const result = await handleCancel({ featureId }, stateDir, store);

    expect(result).toMatchObject({ success: false, error: { code: 'COMPENSATION_PARTIAL' } });
    const message = (result.error as { message: string }).message;
    expect(message.toLowerCase()).toContain('manual intervention');
    expect(message).toContain('delegate:delete-integration-branch');

    const all = await events();
    // Cancellation was NEVER reported complete — no readiness, no terminal cancel.
    expect(all.some((e) => e.type === 'cancel.ready')).toBe(false);
    expect(all.some((e) => e.type === 'workflow.cancel')).toBe(false);

    // Bounded retries: 3 attempts (branch -D x3), 2 retry-scheduled, 3 failures.
    expect(branchDeleteCalls).toBe(3);
    const retries = all.filter(
      (e) =>
        e.type === 'cancel.compensation-retry-scheduled'
        && (e.data as Record<string, unknown> | undefined)?.actionId
          === 'delegate:delete-integration-branch',
    );
    expect(retries).toHaveLength(2);
    const failures = all.filter(
      (e) =>
        e.type === 'cancel.compensation-failed'
        && (e.data as Record<string, unknown> | undefined)?.actionId
          === 'delegate:delete-integration-branch'
        && (e.data as Record<string, unknown> | undefined)?.reason === 'effect-failed',
    );
    expect(failures).toHaveLength(3);

    // A REAL, queryable manual-intervention terminal was recorded.
    expect(all).toContainEqual(
      expect.objectContaining({
        type: 'cancel.manual-intervention-required',
        data: expect.objectContaining({
          actionId: 'delegate:delete-integration-branch',
          reason: 'retries-exhausted',
        }),
      }),
    );

    // The completion gate is structurally blocked (not merely absent).
    const { cancelId } = await readCancelIdentity();
    const saga = await queryCancelSaga(store, featureId, cancelId);
    const plan = planCancelCompletion(saga, REQUIRED_ACTION_IDS);
    expect(plan.kind).toBe('blocked');
    if (plan.kind === 'blocked') {
      expect(plan.reason).toBe('manual-intervention-required');
      expect(plan.pendingActionIds).toContain('delegate:delete-integration-branch');
    }
  });

  // ── (D) A trusted CLI caller can cancel end-to-end ─────────────────────────
  // Regression for the packaged-proof defect (P05-02): the CLI trusted-caller
  // path wires NO runtime capability resolver, so `handleCancel` built a
  // cancellation authorization snapshot with an EMPTY `capabilityIds` array,
  // which `AuthorizationSnapshotV1Schema.capabilityIds.min(1)` rejects BEFORE
  // any event is appended — `exarchos wf cancel` failed for every CLI user
  // with EVENT_APPEND_FAILED. The identity layer now GRANTS the trusted
  // local-operator its baseline capabilities, so the snapshot is schema-valid
  // and cancellation proceeds.
  it('ExitProof_TrustedCliCaller_CanCancelWithGrantedCapabilities', async () => {
    // The CLI's dispatch context: a local-operator identity (derived solely
    // from the adapter-owned state dir) with NO capability resolver — exactly
    // what `createCliDispatchContext` + `dispatch()` produce for `wf cancel`.
    const identity = deriveLocalOperatorIdentity(stateDir);
    const authorization = snapshotCallerAuthorization(identity, undefined);
    // The pre-fix defect: without the identity-layer grant this array is empty.
    expect(authorization.capabilities.length).toBeGreaterThanOrEqual(1);

    const result = await runWithDispatchContext(
      mintDispatchContext(undefined, authorization),
      () => handleCancel({ featureId }, stateDir, store),
    );

    expect(result.success).toBe(true);

    const all = await events();
    const requested = all.find((e) => e.type === 'cancel.requested');
    expect(requested).toBeDefined();
    const recorded = (requested?.data as Record<string, unknown>).authorization as
      | Record<string, unknown>
      | undefined;
    // The authorization snapshot was recorded with a non-empty, schema-valid
    // capability set attributed to the trusted operator.
    expect(recorded).toBeDefined();
    expect(Array.isArray(recorded?.capabilityIds)).toBe(true);
    expect((recorded?.capabilityIds as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((requested?.data as Record<string, unknown>).caller).toMatchObject({
      principalKind: 'operator',
      role: 'operator',
      principalId: identity.subjectId,
    });

    const persisted = JSON.parse(
      await readFile(join(stateDir, `${featureId}.state.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted.phase).toBe('cancelled');
  });

  // ── (E) An unauthorized caller is still denied (fail-closed) ───────────────
  // The grant is scoped to the trusted local-operator identity, which a remote
  // caller can never forge. A remote `mcp-session`/agent caller with no
  // resolver capabilities keeps an EMPTY set and is rejected at schema
  // validation — the ≥1 `capabilityIds` requirement is NOT weakened.
  it('ExitProof_UnauthorizedCaller_IsDeniedBeforeAnyWrite', async () => {
    const identity = deriveMcpCallerIdentity({ sessionId: 'untrusted-remote-agent' });
    const authorization = snapshotCallerAuthorization(identity, undefined);
    // No grant for a non-operator identity: the capability set stays empty.
    expect(authorization.capabilities).toHaveLength(0);

    const result = await runWithDispatchContext(
      mintDispatchContext(undefined, authorization),
      () => handleCancel({ featureId }, stateDir, store),
    );

    expect(result).toMatchObject({ success: false, error: { code: 'EVENT_APPEND_FAILED' } });
    const message = (result.error as { message: string }).message;
    expect(message).toContain('malformed');
    expect(message).toContain('capabilityIds');

    // Fail-closed: the unauthorized request never reached the durable log.
    const all = await events();
    expect(all.some((e) => e.type === 'cancel.requested')).toBe(false);
    expect(all.some((e) => e.type === 'workflow.cancel')).toBe(false);
    expect(branchDeleteCalls).toBe(0);
  });
});
