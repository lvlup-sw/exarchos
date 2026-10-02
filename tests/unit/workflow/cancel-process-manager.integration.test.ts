// Integration proofs for the cancellation process manager.
// They drive the saga through the public `handleCancel` entry point, not through the engine alone.
// The engine-level proofs are in `cancel-process-manager.saga.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'child_process';
import { EventStore } from '../../../src/events/store.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { handleCancel } from '../../../src/workflow/cancel.js';
import {
  appendFencedCancelEvent,
  planCancelCompletion,
  queryCancelSaga,
  StaleEpochError,
} from '../../../src/workflow/cancel-process-manager.js';
import {
  deriveLocalOperatorIdentity,
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../src/dispatch/dispatch-context.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const mockedExecFile = vi.mocked(execFile);

const REQUIRED_ACTION_IDS = [
  'delegate:delete-integration-branch',
  'delegate:cleanup-worktrees',
  'delegate:delete-feature-branches',
] as const;

/**
 * `crashOnSecondCompletion` throws on the first attempt to record the `delegate:cleanup-worktrees` completion.
 * The `delegate:delete-integration-branch` completion is durable before that crash.
 */
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
    await rmrfAsync(stateDir);
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

  /**
   * The restart drops all in-memory state and opens the durable log again.
   * The completed `branch -D` compensation does not run a second time.
   */
  it('ExitProof_RestartMidCancel_DoesNotRepeatCompletedCompensation', async () => {
    crashOnSecondCompletion();

    const interrupted = await handleCancel({ featureId }, stateDir, store);
    expect(interrupted).toMatchObject({ success: false, error: { code: 'EVENT_APPEND_FAILED' } });
    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    vi.restoreAllMocks();
    store.close();
    store = new EventStore(stateDir);
    await store.initialize();

    const resumed = await handleCancel({ featureId }, stateDir, store);
    expect(resumed.success).toBe(true);

    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    const persisted = JSON.parse(
      await readFile(join(stateDir, `${featureId}.state.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted.phase).toBe('cancelled');
  });

  /**
   * Instance A completes the first compensation under epoch 1 and then crashes.
   * Instance B takes over through `handleCancel` with a higher epoch and skips the completed compensation.
   * A write with the stale epoch then fails with `StaleEpochError` and appends nothing.
   */
  it('ExitProof_Takeover_FencesStaleInstance_AndDoesNotRepeatCompletedCompensation', async () => {
    crashOnSecondCompletion();
    const instanceA = await handleCancel({ featureId }, stateDir, store);
    expect(instanceA).toMatchObject({ success: false, error: { code: 'EVENT_APPEND_FAILED' } });
    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    const { cancelId, phaseAttemptId } = await readCancelIdentity();
    const staleEpoch = (await queryCancelSaga(store, featureId, cancelId)).currentEpoch;
    expect(staleEpoch).toBe(1);

    vi.restoreAllMocks();
    const instanceB = await handleCancel({ featureId }, stateDir, store);
    expect(instanceB.success).toBe(true);

    expect(branchDeleteCalls).toBe(1);
    expect(completedFor(await events(), 'delegate:delete-integration-branch')).toHaveLength(1);

    const sagaAfterB = await queryCancelSaga(store, featureId, cancelId);
    expect(sagaAfterB.currentEpoch).toBeGreaterThan(staleEpoch);

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

  /**
   * The integration-branch compensation fails on every attempt.
   * Cancellation never reports ready, and after three attempts the saga records a manual-intervention terminal.
   * The completion plan is blocked, not only absent.
   */
  it('ExitProof_RetryExhaustion_BlocksReadiness_AndLandsInManualIntervention', async () => {
    branchDeleteFails = true;

    const result = await handleCancel({ featureId }, stateDir, store);

    expect(result).toMatchObject({ success: false, error: { code: 'COMPENSATION_PARTIAL' } });
    const message = (result.error as { message: string }).message;
    expect(message.toLowerCase()).toContain('manual intervention');
    expect(message).toContain('delegate:delete-integration-branch');

    const all = await events();
    expect(all.some((e) => e.type === 'cancel.ready')).toBe(false);
    expect(all.some((e) => e.type === 'workflow.cancel')).toBe(false);

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

    expect(all).toContainEqual(
      expect.objectContaining({
        type: 'cancel.manual-intervention-required',
        data: expect.objectContaining({
          actionId: 'delegate:delete-integration-branch',
          reason: 'retries-exhausted',
        }),
      }),
    );

    const { cancelId } = await readCancelIdentity();
    const saga = await queryCancelSaga(store, featureId, cancelId);
    const plan = planCancelCompletion(saga, REQUIRED_ACTION_IDS);
    expect(plan.kind).toBe('blocked');
    if (plan.kind === 'blocked') {
      expect(plan.reason).toBe('manual-intervention-required');
      expect(plan.pendingActionIds).toContain('delegate:delete-integration-branch');
    }
  });

  /**
   * The CLI path builds a local-operator identity from the state directory and wires no capability resolver.
   * The identity layer grants that trusted operator its baseline capabilities.
   * The authorization snapshot then passes `AuthorizationSnapshotV1Schema`, which needs at least one `capabilityIds` entry.
   */
  it('ExitProof_TrustedCliCaller_CanCancelWithGrantedCapabilities', async () => {
    const identity = deriveLocalOperatorIdentity(stateDir);
    const authorization = snapshotCallerAuthorization(identity, undefined);
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

  /**
   * The grant applies only to the trusted local-operator identity.
   * A remote MCP caller with no resolver capabilities keeps an empty set.
   * Schema validation rejects it before any event reaches the log.
   */
  it('ExitProof_UnauthorizedCaller_IsDeniedBeforeAnyWrite', async () => {
    const identity = deriveMcpCallerIdentity({ sessionId: 'untrusted-remote-agent' });
    const authorization = snapshotCallerAuthorization(identity, undefined);
    expect(authorization.capabilities).toHaveLength(0);

    const result = await runWithDispatchContext(
      mintDispatchContext(undefined, authorization),
      () => handleCancel({ featureId }, stateDir, store),
    );

    expect(result).toMatchObject({ success: false, error: { code: 'EVENT_APPEND_FAILED' } });
    const message = (result.error as { message: string }).message;
    expect(message).toContain('malformed');
    expect(message).toContain('capabilityIds');

    const all = await events();
    expect(all.some((e) => e.type === 'cancel.requested')).toBe(false);
    expect(all.some((e) => e.type === 'workflow.cancel')).toBe(false);
    expect(branchDeleteCalls).toBe(0);
  });
});
