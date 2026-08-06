import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'child_process';
import { EventStore } from '../event-store/store.js';
import { handleInit } from './tools.js';
import { handleCancel } from './cancel.js';
import { allocatePhaseAttemptId } from './phase-attempt-id.js';
import { createInMemoryResolver } from '../capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../dispatch/dispatch-context.js';

const mockedExecFile = vi.mocked(execFile);

describe('v2.12 cancellation process manager (DR-7)', () => {
  let stateDir: string;
  let store: EventStore;
  let featureId: string;
  let branchExists: boolean;
  let branchDeleteFails: boolean;
  let branchDeleteCalls: number;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cancel-process-manager-'));
    store = new EventStore(stateDir);
    await store.initialize();
    featureId = `cancel-pm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    branchExists = true;
    branchDeleteFails = false;
    branchDeleteCalls = 0;

    mockedExecFile.mockImplementation(
      (_command: unknown, argsValue: unknown, optionsValue: unknown, callbackValue?: unknown) => {
        const callback =
          typeof optionsValue === 'function' ? optionsValue : callbackValue;
        const args = argsValue as string[];
        const cb = callback as (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void;

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
      integrationBranch: 'integrate/cancel-process-manager',
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    };
    state.worktrees = {};
    state.tasks = [];
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
  }

  it('CancelInitialRequest_IsDurableBeforeCompensationIntentAndEffect', async () => {
    const result = await handleCancel({ featureId }, stateDir, store);

    expect(result.success).toBe(true);
    expect(branchDeleteCalls).toBe(1);
    const events = await store.query(featureId);
    const requested = events.find((event) => event.type === 'cancel.requested');
    const firstIntent = events.find(
      (event) => event.type === 'cancel.compensation-requested',
    );
    expect(requested?.sequence).toBeLessThan(firstIntent!.sequence);
    expect(requested?.data).toMatchObject({
      featureId,
      from: 'delegate',
      caller: { principalKind: 'operator' },
    });
    expect(requested?.idempotencyKey).toBeTruthy();
    const processFacts = events.filter((event) => event.type.startsWith('cancel.'));
    expect(processFacts.every((event) => /^cancel:[a-f0-9]{64}$/.test(
      event.idempotencyKey ?? '',
    ))).toBe(true);
    expect(new Set(processFacts.map((event) => event.idempotencyKey)).size)
      .toBe(processFacts.length);
  });

  it('CancelRetry_CompletedCompensation_IsNotRepeated', async () => {
    // P04-02 wiring: compensation outcomes are now recorded through the ATOMIC
    // fenced append (`AtomicAppender.decideOnce`), not `store.appendValidated`.
    // Re-point the crash-injection at that seam. The INTENT is unchanged: crash
    // AFTER the first compensation's durable completion lands but BEFORE the
    // second's, so the retry must NOT repeat the already-completed compensation.
    // `operationId` encodes {action, attempt, kind} for a precise, robust match.
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

    const partial = await handleCancel({ featureId }, stateDir, store);
    expect(partial).toMatchObject({
      success: false,
      error: { code: 'EVENT_APPEND_FAILED' },
    });
    expect(branchDeleteCalls).toBe(1);

    vi.restoreAllMocks();
    const retried = await handleCancel({ featureId }, stateDir, store);
    expect(retried.success).toBe(true);
    expect(branchDeleteCalls).toBe(1);

    const events = await store.query(featureId);
    const integrationOutcomes = events.filter(
      (event) =>
        event.type === 'cancel.compensation-completed'
        && event.data?.actionId === 'delegate:delete-integration-branch',
    );
    expect(integrationOutcomes).toHaveLength(1);
  });

  it('CancelFailedEffect_RecordsFailureAndNeverReadiness', async () => {
    branchDeleteFails = true;

    const result = await handleCancel({ featureId }, stateDir, store);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'COMPENSATION_PARTIAL' },
    });
    const events = await store.query(featureId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'cancel.compensation-failed',
        data: expect.objectContaining({
          actionId: 'delegate:delete-integration-branch',
          reason: 'effect-failed',
        }),
      }),
    );
    expect(events.some((event) => event.type === 'cancel.ready')).toBe(false);
    expect(events.some((event) => event.type === 'workflow.cancel')).toBe(false);
  });

  it('CancelAppendFailure_DoesNotBeginCompensationOrReportSuccess', async () => {
    vi.spyOn(store.getAppender(), 'decideOnce').mockRejectedValueOnce(
      new Error('request append unavailable'),
    );

    const result = await handleCancel({ featureId }, stateDir, store);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'EVENT_APPEND_FAILED' },
    });
    expect(branchDeleteCalls).toBe(0);
    expect(
      (await store.query(featureId)).some((event) =>
        event.type.startsWith('cancel.compensation-')),
    ).toBe(false);
  });

  it('CancelMalformedReplay_RecordsExplicitFailureAndFailsClosed', async () => {
    const file = join(stateDir, `${featureId}.state.json`);
    const state = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const phaseAttemptId = allocatePhaseAttemptId(
      featureId,
      'delegate',
      'cancelled',
      state.phaseAttemptId,
      Number(state._version ?? 1),
    );
    const cancelId = `cancel:${phaseAttemptId}`;
    await store.append(featureId, {
      type: 'cancel.compensation-completed',
      data: {
        cancelId,
        actionId: 'delegate:delete-integration-branch',
        status: 'executed',
      },
    });

    const result = await handleCancel({ featureId }, stateDir, store);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'COMPENSATION_PARTIAL' },
    });
    expect(branchDeleteCalls).toBe(0);
    expect(await store.query(featureId)).toContainEqual(
      expect.objectContaining({
        type: 'cancel.compensation-failed',
        data: expect.objectContaining({ reason: 'malformed-result' }),
      }),
    );
  });

  it('CancelReady_IsDurableBeforeCurrentFinalTransition', async () => {
    const result = await handleCancel({ featureId }, stateDir, store);
    expect(result.success).toBe(true);

    const events = await store.query(featureId);
    const ready = events.find((event) => event.type === 'cancel.ready');
    const terminal = events.find((event) => event.type === 'workflow.cancel');
    expect(ready?.sequence).toBeLessThan(terminal!.sequence);
    expect(ready?.data).toMatchObject({
      phaseAttemptId: (result.data as Record<string, unknown>).phaseAttemptId,
      completedActionIds: expect.arrayContaining([
        'delegate:delete-integration-branch',
        'delegate:cleanup-worktrees',
        'delegate:delete-feature-branches',
      ]),
    });
  });

  it('CancelReplay_AfterRestartResumesAfterReadyThroughLegacyFinalPath', async () => {
    const identity = deriveMcpCallerIdentity({ sessionId: 'cancel-replay-session' });
    const resolver = createInMemoryResolver([
      'fs:read',
      'fs:write',
      'shell:exec',
      'isolation:worktree',
      'mcp:exarchos',
    ]);
    const invoke = () => runWithDispatchContext(
      mintDispatchContext(
        undefined,
        snapshotCallerAuthorization(identity, resolver),
      ),
      () => handleCancel({ featureId }, stateDir, store),
    );
    // DR-7 — the final cancellation transition trail commits through ONE
    // atomic `appendTrailAtomically` transaction, so that is the seam a
    // simulated crash on the final transition has to interrupt.
    const originalTrail = store.appendTrailAtomically.bind(store);
    let failTransitionOnce = true;
    vi.spyOn(store, 'appendTrailAtomically').mockImplementation(async (...args) => {
      if (
        failTransitionOnce
        && args[1].some((event) => (event.data as Record<string, unknown> | undefined)?.to === 'cancelled')
      ) {
        failTransitionOnce = false;
        throw new Error('simulated final transition append failure');
      }
      return originalTrail(...args);
    });

    const interrupted = await invoke();
    expect(interrupted).toMatchObject({
      success: false,
      error: { code: 'EVENT_APPEND_FAILED' },
    });
    expect((await store.query(featureId)).some((event) => event.type === 'cancel.ready'))
      .toBe(true);
    expect(branchDeleteCalls).toBe(1);

    vi.restoreAllMocks();
    store.close();
    store = new EventStore(stateDir);
    await store.initialize();
    const replayed = await invoke();

    expect(replayed.success).toBe(true);
    expect(branchDeleteCalls).toBe(1);
    const events = await store.query(featureId);
    expect(events.filter((event) => event.type === 'cancel.requested')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'cancel.ready')).toHaveLength(1);
    expect(events.find((event) => event.type === 'cancel.requested')?.data?.caller)
      .toMatchObject({ principalKind: 'agent', principalId: identity.subjectId });
    expect(events.some((event) => event.type === 'workflow.cancel')).toBe(true);
    const persisted = JSON.parse(
      await readFile(join(stateDir, `${featureId}.state.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted.phase).toBe('cancelled');
  });
});
