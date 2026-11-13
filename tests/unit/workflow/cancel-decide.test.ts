/**
 * These tests check that the cancel handler decides on the ledger fold of the rows, not on the state document.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row.
 * A seed writes the rows and the document through the handlers. A forge then changes the document only, or appends a row only.
 * The fold gives the source phase, the phase attempt id and the terminal check. `phaseMoveEvents` gives the trail of the move.
 *
 * The `child_process` mock runs the real `execFile` unless a case gives it a fake. The fake makes a compensation command fail.
 *
 * @oracle-sources: ../../../src/workflow/phase-attempt-id.ts, hand-seeded stream rows
 */
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args)) };
});

import { ChildProcess, execFile } from 'child_process';

import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import { toEnvelope, type ToolResult } from '../../../src/format.js';
import { WorkflowCancelOutputSchema } from '../../../src/registry/output-schemas.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { flushLiveShadowEvidence } from '../../../src/workflow/admission/live-shadow-observer.js';
import * as compensation from '../../../src/workflow/compensation.js';
import { handleCancel } from '../../../src/workflow/cancel.js';
import { hsmTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import { allocatePhaseAttemptId } from '../../../src/workflow/phase-attempt-id.js';
import { configureStateStoreBackend, readStateFile, writeStateFile } from '../../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../../src/workflow/tools.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface CancelStore {
  readonly stateDir: string;
  readonly backend: SqliteBackend;
  readonly eventStore: EventStore;
}

/** The feature id of each case. Each case has its own store. */
const FEATURE_ID = 'cancel-decide';

/** The prefix of the warning of a cancel that the state document decided. */
const DOCUMENT_FALLBACK = 'GUARD_INPUT_DOCUMENT_FALLBACK: ';

/** The phase attempt id that a hand-seeded cancel row gives the fold. */
const SEEDED_ATTEMPT_ID = `phase-attempt:${'c4'.repeat(32)}`;

/** The result type of the legacy guard. */
type LegacyAttempt = Awaited<ReturnType<typeof hsmTransitionGuard.attempt>>;

/** The real `execFile`. The teardown gives it back to the mock after a case that uses a fake. */
const actualExecFile = (await vi.importActual<typeof import('child_process')>('child_process')).execFile;

/** The integration branch of the saga case. Its delete fails in the fake `execFile`. */
const INTEGRATION_BRANCH = 'integrate/cancel-decide';

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
});

/** Returns the value as a record, or an empty record when it is no plain object. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/** Opens a store on a new temporary directory and makes it the backend of the state store. */
async function openStore(): Promise<CancelStore> {
  const stateDir = makeTempDir('cancel-decide-');
  releases.push(() => rmrfAsync(stateDir));
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  releases.push(() => backend.close());
  const eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
  releases.push(() => eventStore.close());
  configureStateStoreBackend(backend);
  return { stateDir, backend, eventStore };
}

/** Throws when a seed call does not succeed. */
function requireSuccess(step: string, result: ToolResult): void {
  if (result.success) return;
  throw new Error(`the seed step '${step}' failed with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`);
}

/** Starts a workflow. With `withStore` false, init gets no event store, so the stream holds no start row. */
async function init(store: CancelStore, workflowType: string, withStore = true): Promise<void> {
  requireSuccess('init', await handleInit({ featureId: FEATURE_ID, workflowType }, store.stateDir, withStore ? store.eventStore : null));
}

/** Moves a debug workflow to `investigate` through the handlers. */
async function debugAtInvestigate(store: CancelStore): Promise<void> {
  await init(store, 'debug');
  requireSuccess('update triage', await handleSet({ featureId: FEATURE_ID, updates: { triage: { symptom: 'the build fails' } } }, store.stateDir, store.eventStore));
  requireSuccess('transition investigate', await handleSet({ featureId: FEATURE_ID, phase: 'investigate' }, store.stateDir, store.eventStore));
}

/** Appends one row with no document write. */
async function appendRow(store: CancelStore, type: string, data: Record<string, unknown>): Promise<void> {
  await store.eventStore.append(FEATURE_ID, { type, data });
}

/** Returns the path of the state document of the feature. */
function stateFileOf(store: CancelStore): string {
  return path.join(store.stateDir, `${FEATURE_ID}.state.json`);
}

/** Returns the state document of the feature as a record. */
async function documentOf(store: CancelStore): Promise<Record<string, unknown>> {
  return { ...(await readStateFile(stateFileOf(store))) };
}

/** Changes the state document only, with no row. */
async function forgeDocument(store: CancelStore, change: (document: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await writeStateFile(stateFileOf(store), change(await documentOf(store)));
}

/** Returns the rows of the stream of the feature. */
function rowsOf(store: CancelStore): Promise<WorkflowEvent[]> {
  return store.eventStore.query(FEATURE_ID);
}

/** Returns the `workflow.cancel` row that closes the cancel trail. */
function closingCancelRowOf(rows: readonly WorkflowEvent[]): Record<string, unknown> {
  return recordOf(rows.find((row) => row.idempotencyKey === `${FEATURE_ID}:cancel:complete`)?.data);
}

/** Moves a feature to `review` on the rows, and leaves the document at `delegate`. */
async function featureAtReviewWithALaggingDocument(store: CancelStore): Promise<void> {
  await init(store, 'feature');
  await appendRow(store, 'workflow.transition', { from: 'plan', to: 'delegate', trigger: 'test', featureId: FEATURE_ID });
  await appendRow(store, 'workflow.transition', { from: 'delegate', to: 'review', trigger: 'test', featureId: FEATURE_ID });
  await forgeDocument(store, (document) => ({ ...document, phase: 'delegate', phaseAttemptId: 'an-older-attempt' }));
}

/** Replaces a method of an object for one case. The teardown restores the method. */
function replaceMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value: replacement, configurable: true, writable: true });
  releases.push(() => {
    if (ownDescriptor === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, ownDescriptor);
  });
}

/**
 * Runs one cancel inside the first full read of the stream, after the read returns its rows.
 * So the outer cancel decides on rows that do not hold the trail of the inner cancel. The result gives the inner reply.
 */
function cancelInsideTheFirstRead(store: CancelStore): () => ToolResult | undefined {
  const originalQuery = store.eventStore.query.bind(store.eventStore);
  let inner: ToolResult | undefined;
  let fired = false;
  replaceMethod(store.eventStore, 'query', async (streamId: string, filters?: Parameters<EventStore['query']>[1]) => {
    const rows = await originalQuery(streamId, filters);
    if (!fired && streamId === FEATURE_ID && filters === undefined) {
      fired = true;
      inner = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    }
    return rows;
  });
  return () => inner;
}

/**
 * Gives `execFile` a fake for one case. A branch lookup finds each branch, and each branch delete fails.
 * Each other command succeeds with no output. The result gives the count of the branch deletes.
 */
function failEachBranchDelete(): () => number {
  let branchDeletes = 0;
  const fake = (_file: string, args?: unknown, options?: unknown, callback?: unknown): ChildProcess => {
    const done = typeof options === 'function' ? options : callback;
    const argv: readonly unknown[] = Array.isArray(args) ? args : [];
    let error: Error | null = null;
    let stdout = '';
    if (argv.includes('rev-parse') && argv.includes('--verify')) stdout = 'abc123\n';
    if (argv.includes('branch') && argv.includes('-D')) {
      branchDeletes += 1;
      error = new Error('branch delete failed');
    }
    if (typeof done === 'function') Reflect.apply(done, undefined, [error, stdout, '']);
    return new ChildProcess();
  };
  vi.mocked(execFile).mockImplementation(fake);
  releases.push(() => {
    vi.mocked(execFile).mockImplementation((...args: Parameters<typeof actualExecFile>) => actualExecFile(...args));
  });
  return () => branchDeletes;
}

/**
 * Seeds a feature at `delegate` whose rows and document hold no phase attempt id. The start row and the transition row
 * carry none, and the document has none. The document names an integration branch, so the cancel saga deletes it.
 */
async function featureAtDelegateWithNoAttemptId(store: CancelStore): Promise<void> {
  await init(store, 'feature', false);
  await appendRow(store, 'workflow.started', { featureId: FEATURE_ID, workflowType: 'feature' });
  await appendRow(store, 'workflow.transition', { from: 'plan', to: 'delegate', trigger: 'test', featureId: FEATURE_ID });
  await forgeDocument(store, (document) => {
    const { phaseAttemptId: _noAttemptId, ...rest } = document;
    return {
      ...rest,
      _esVersion: 2,
      phase: 'delegate',
      synthesis: { integrationBranch: INTEGRATION_BRANCH, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      worktrees: {},
      tasks: [],
    };
  });
}

/** Returns an admitted legacy result with no events. */
function admittedWithNoEvents(from: string): LegacyAttempt {
  return {
    ok: true,
    idempotent: false,
    newPhase: 'cancelled',
    historyUpdates: {},
    emittedEvents: [],
    transitionEvent: { type: 'workflow.transition', from, to: 'cancelled', trigger: 'test', featureId: FEATURE_ID, sequence: -1 },
  };
}

describe('the cancel handler decides on the ledger fold', () => {
  /** A debug workflow at `investigate` reaches `cancelled` through `cancel`. */
  it('HandleCancel_ADebugWorkflowAtInvestigate_ReachesCancelled', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).phase).toBe('cancelled');
    expect((await documentOf(store)).phase).toBe('cancelled');
    expect(closingCancelRowOf(await rowsOf(store))).toMatchObject({ from: 'investigate', to: 'cancelled' });
  });

  /** The rows hold `review` and the document lags at `delegate`. The cancel row names the fold phase. */
  it('HandleCancel_TheFoldPhase_IsTheSourceOfTheCancelRow', async () => {
    const store = await openStore();
    await featureAtReviewWithALaggingDocument(store);

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).previousPhase).toBe('review');
    const rows = await rowsOf(store);
    expect(closingCancelRowOf(rows)).toMatchObject({ from: 'review', to: 'cancelled' });
    expect(rows.find((row) => row.type === 'cancel.requested')?.data).toMatchObject({ from: 'review' });
  });

  /** The attempt id comes from the fold phase, the fold attempt id and the stream version, not from the lagging document. */
  it('HandleCancel_ALaggingDocument_TakesThePhaseAttemptIdFromTheFold', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await forgeDocument(store, (document) => ({ ...document, phase: 'triage', phaseAttemptId: 'an-older-attempt' }));
    const rows = await rowsOf(store);
    const foldAttemptId = recordOf(rows.filter((row) => row.type === 'workflow.transition').at(-1)?.data).phaseAttemptId;
    const expected = allocatePhaseAttemptId(FEATURE_ID, 'investigate', 'cancelled', foldAttemptId, Math.max(...rows.map((row) => row.sequence)));

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).phaseAttemptId).toBe(expected);
    const after = await rowsOf(store);
    expect(closingCancelRowOf(after).phaseAttemptId).toBe(expected);
    const claims = store.eventStore.getAppender().ensureSqliteBackendSync();
    expect(claims.lookupOperationClaim(`cancel:${FEATURE_ID}:${expected}`)).toBeDefined();
  });

  /** Broken replay refuses before any ownership, compensation or final row. */
  it('HandleCancel_ABrokenCompletedLedger_RefusesBeforeCompensation', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await appendRow(store, 'workflow.cleanup', { featureId: FEATURE_ID, from: 'investigate', to: 'completed' });
    await appendRow(store, 'state.patched', { featureId: FEATURE_ID, fields: ['artifacts[0].x'], patch: { 'artifacts[0].x': 1 } });
    const before = await rowsOf(store);
    const document = await documentOf(store);
    const effects = vi.spyOn(compensation, 'executeCompensation');
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.error?.code).toBe('PROJECTION_REPLAY_FAILED');
    expect(effects).not.toHaveBeenCalled();
    expect(await rowsOf(store)).toEqual(before);
    expect(await documentOf(store)).toEqual(document);
  });

  /** A feature stream at `ideate`, which is no step, reaches `cancelled`. */
  it('HandleCancel_APhaseThatIsNoStep_ReachesCancelled', async () => {
    const store = await openStore();
    await init(store, 'feature');
    await appendRow(store, 'workflow.transition', { from: 'plan', to: 'ideate', trigger: 'test', featureId: FEATURE_ID });
    const unknownPhaseDocument = await documentOf(store);
    await writeStateFile(stateFileOf(store), { ...unknownPhaseDocument, phase: 'ideate' }, { skipValidation: true, expectedVersion: Number(unknownPhaseDocument._version) });

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).previousPhase).toBe('ideate');
    expect(closingCancelRowOf(await rowsOf(store))).toMatchObject({ from: 'ideate', to: 'cancelled' });
  });

  /** Each fallback case keeps the path of the state document. It reaches `cancelled` with one fallback warning. */
  it.each([
    { name: 'no store', seed: (store: CancelStore): Promise<void> => init(store, 'feature'), withStore: false },
    {
      name: 'a document off the ledger',
      seed: async (store: CancelStore): Promise<void> => {
        await init(store, 'feature');
        await forgeDocument(store, (document) => ({ ...document, _esVersion: 1 }));
      },
      withStore: true,
    },
    { name: 'no start row', seed: (store: CancelStore): Promise<void> => init(store, 'feature', false), withStore: true },
  ].map((row): [string, typeof row] => [row.name, row]))('HandleCancel_AFallbackCase_WarnsAndKeepsThePathOfMain %s', async (_name, row) => {
    const store = await openStore();
    await row.seed(store);

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, row.withStore ? store.eventStore : null);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).phase).toBe('cancelled');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]?.startsWith(DOCUMENT_FALLBACK)).toBe(true);
    expect((await documentOf(store)).phase).toBe('cancelled');
  });

  /** A legacy guard that admits with no events does not empty the trail, because `phaseMoveEvents` builds it. */
  it('HandleCancel_AStubAttemptWithNoEvents_StillWritesTheMoveRows', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    vi.spyOn(hsmTransitionGuard, 'attempt').mockResolvedValue(admittedWithNoEvents('investigate'));

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    const moveRow = (await rowsOf(store)).find(
      (row) => row.idempotencyKey === `${FEATURE_ID}:cancel:transition:cancel:investigate:cancelled`,
    );
    expect(moveRow?.type).toBe('workflow.cancel');
    expect(moveRow?.data).toMatchObject({ from: 'investigate', to: 'cancelled', trigger: 'user-cancel' });
  });

  /** The rows end with a cancel row and the document lags. The cancel appends no row, levels the document and replies idempotent. */
  it('Cancel_AnIdempotentRetry_RepairsSkippedProjectionEffects', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await appendRow(store, 'state.patched', { patch: { 'artifacts.plan': 'ledger-plan.md', reviews: { gate: { passed: true } } } });
    await appendRow(store, 'workflow.cancel', { from: 'investigate', to: 'cancelled', trigger: 'test', featureId: FEATURE_ID, phaseAttemptId: SEEDED_ATTEMPT_ID });
    const rows = await rowsOf(store);
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(await documentOf(store)).toMatchObject({ phase: 'cancelled', phaseAttemptId: SEEDED_ATTEMPT_ID,
      artifacts: { plan: 'ledger-plan.md' }, reviews: { gate: { passed: true } }, _eventSequence: rows.at(-1)?.sequence });
    expect(await rowsOf(store)).toEqual(rows);
    const current = await documentOf(store);
    expect((await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore)).error?.code).toBe('ALREADY_CANCELLED');
    expect(await documentOf(store)).toEqual(current);
  });

  it('Cancel_AnIdempotentDryRun_WritesNothing', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await appendRow(store, 'workflow.cancel', { from: 'investigate', to: 'cancelled', trigger: 'test', featureId: FEATURE_ID, phaseAttemptId: SEEDED_ATTEMPT_ID });
    const before = await documentOf(store);
    const rows = await rowsOf(store);
    const result = await handleCancel({ featureId: FEATURE_ID, dryRun: true }, store.stateDir, store.eventStore);
    expect(result.data).toEqual({ dryRun: true, actions: [], currentPhase: 'cancelled', wouldTransitionTo: 'cancelled' });
    expect(await documentOf(store)).toEqual(before);
    expect(await rowsOf(store)).toEqual(rows);
  });

  it('HandleCancel_AFoldAtCancelledAndALaggingDocument_RepliesIdempotentAndLevels', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await appendRow(store, 'workflow.cancel', {
      from: 'investigate',
      to: 'cancelled',
      trigger: 'test',
      featureId: FEATURE_ID,
      phaseAttemptId: SEEDED_ATTEMPT_ID,
    });
    const rows = await rowsOf(store);

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({
      phase: 'cancelled',
      actions: [],
      previousPhase: 'investigate',
      phaseAttemptId: SEEDED_ATTEMPT_ID,
      idempotent: true,
    });
    expect(WorkflowCancelOutputSchema.safeParse(toEnvelope(result)).success).toBe(true);
    expect(await rowsOf(store)).toHaveLength(rows.length);
    const document = await documentOf(store);
    expect(document.phase).toBe('cancelled');
    expect(document.phaseAttemptId).toBe(SEEDED_ATTEMPT_ID);
    expect(document._eventSequence).toBe(rows.at(-1)?.sequence);
  });

  /**
   * The stream has no phase attempt id. The first cancel meets a failed branch delete, and the retry runs.
   * The saga rows of the first cancel do not change the phase attempt id, so the retry continues the same saga.
   * The stream holds one cancel id, three branch deletes and one manual-intervention row.
   */
  it('HandleCancel_ARetryOnAStreamWithNoAttemptId_KeepsOneCancelId', async () => {
    const store = await openStore();
    await featureAtDelegateWithNoAttemptId(store);
    const branchDeletes = failEachBranchDelete();
    expect((await rowsOf(store)).map((row) => recordOf(row.data).phaseAttemptId).filter((id) => id !== undefined)).toEqual([]);
    expect((await documentOf(store)).phaseAttemptId).toBeUndefined();

    const first = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    const second = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(second.error?.code).toBe('COMPENSATION_PARTIAL');
    expect(first.error?.code).toBe('COMPENSATION_PARTIAL');
    const rows = await rowsOf(store);
    const cancelIds = new Set(rows.filter((row) => row.type === 'cancel.requested').map((row) => recordOf(row.data).cancelId));
    expect(cancelIds.size).toBe(1);
    expect(branchDeletes()).toBe(3);
    expect(rows.filter((row) => row.type === 'cancel.manual-intervention-required')).toHaveLength(1);
  });

  /**
   * Two cancels read the same rows, so they share one phase attempt id and one trail operation. The inner cancel commits the trail.
   * The outer cancel gets the stored claim of the inner cancel and wrote no row. It reads the rows again and replies `idempotent: true`.
   */
  it('HandleCancel_TwoCallsThatReadTheSameRows_TheSecondRepliesIdempotent', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    const inner = cancelInsideTheFirstRead(store);

    const outer = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(inner()?.success).toBe(true);
    expect(recordOf(inner()?.data).idempotent).toBeUndefined();
    expect(outer.success).toBe(true);
    expect(outer.data).toMatchObject({ phase: 'cancelled', previousPhase: 'investigate', idempotent: true });
    expect(recordOf(outer.data).phaseAttemptId).toBe(recordOf(inner()?.data).phaseAttemptId);
    expect(WorkflowCancelOutputSchema.safeParse(toEnvelope(outer)).success).toBe(true);
    const rows = await rowsOf(store);
    expect(rows.filter((row) => row.idempotencyKey === `${FEATURE_ID}:cancel:complete`)).toHaveLength(1);
    expect((await documentOf(store)).phase).toBe('cancelled');
  });

  /** The rows and the document are both at `cancelled`, so a second cancel refuses. */
  it('HandleCancel_BothAtCancelled_RefusesAlreadyCancelled', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    requireSuccess('first cancel', await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore));
    const rows = await rowsOf(store);

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CANCELLED');
    expect(await rowsOf(store)).toHaveLength(rows.length);
  });
});

/** Final cancellation checks preserve saga effects but reject stale final trails. */
describe('Cancellation finalization', () => {
  it('HandleCancel_AQueryFailure_RefusesBeforeCompensation', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    const before = await rowsOf(store);
    const document = await documentOf(store);
    const effects = vi.spyOn(compensation, 'executeCompensation');
    vi.spyOn(store.eventStore, 'query').mockRejectedValueOnce(new Error('read failed'));
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.error?.code).toBe('PROJECTION_REPLAY_FAILED');
    expect(effects).not.toHaveBeenCalled();
    expect(await rowsOf(store)).toEqual(before);
    expect(await documentOf(store)).toEqual(document);
  });

  it('HandleCancel_ACompletedFold_RefusesBeforeCompensation', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await appendRow(store, 'workflow.cleanup', { featureId: FEATURE_ID, from: 'investigate', to: 'completed' });
    const before = await rowsOf(store);
    const document = await documentOf(store);
    const effects = vi.spyOn(compensation, 'executeCompensation');
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
    expect(effects).not.toHaveBeenCalled();
    expect(await rowsOf(store)).toEqual(before);
    expect(await documentOf(store)).toEqual(document);
  });

  it.each(['workflow.transition', 'workflow.cleanup'])('HandleCancel_ACompetingMoveDuringCompensation_RejectsTheFinalTrail (%s)', async (kind) => {
    const store = await openStore();
    await debugAtInvestigate(store);
    const before = await rowsOf(store);
    const document = await documentOf(store);
    const original = compensation.executeCompensation;
    vi.spyOn(compensation, 'executeCompensation').mockImplementationOnce(async (...args) => {
      await appendRow(store, kind, { featureId: FEATURE_ID, from: 'investigate', to: kind === 'workflow.cleanup' ? 'completed' : 'fix' });
      return original(...args);
    });
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.error?.code).toBe('VERSION_CONFLICT');
    const after = await rowsOf(store);
    expect(after.filter((row) => row.idempotencyKey?.startsWith(`${FEATURE_ID}:cancel:`))).toEqual([]);
    const attempt = allocatePhaseAttemptId(FEATURE_ID, 'investigate', 'cancelled', String(document.phaseAttemptId), Math.max(...before.filter((row) => ['workflow.started', 'workflow.transition'].includes(row.type)).map((row) => row.sequence)));
    expect(store.backend.lookupOperationClaim(`cancel:${FEATURE_ID}:${attempt}`)).toBeUndefined();
    expect(after.some((row) => row.type === 'cancel.requested')).toBe(true);
    expect(await documentOf(store)).toEqual(document);
  });

  it('HandleCancel_ASamePhaseReturnWithNoAttemptIds_RejectsTheFinalTrail', async () => {
    const store = await openStore();
    await featureAtDelegateWithNoAttemptId(store);
    const document = await documentOf(store);
    const phaseSequence = Math.max(...(await rowsOf(store)).filter((row) => ['workflow.started', 'workflow.transition'].includes(row.type)).map((row) => row.sequence));
    const attempt = allocatePhaseAttemptId(FEATURE_ID, 'delegate', 'cancelled', undefined, phaseSequence);
    vi.spyOn(compensation, 'executeCompensation').mockImplementationOnce(async () => {
      await appendRow(store, 'workflow.transition', { featureId: FEATURE_ID, from: 'delegate', to: 'review' });
      await appendRow(store, 'workflow.transition', { featureId: FEATURE_ID, from: 'review', to: 'delegate' });
      return { success: true, actions: [], events: [] };
    });
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.error?.code).toBe('VERSION_CONFLICT');
    expect((await rowsOf(store)).filter((row) => row.idempotencyKey?.startsWith(`${FEATURE_ID}:cancel:`))).toEqual([]);
    expect(store.backend.lookupOperationClaim(`cancel:${FEATURE_ID}:${attempt}`)).toBeUndefined();
    expect(await documentOf(store)).toEqual(document);
  });

  it('HandleCancel_SagaOnlyRows_KeepTheFinalizationEligible', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    const before = await rowsOf(store);
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    const after = await rowsOf(store);
    expect(after.slice(before.length).map((row) => row.type)).toContain('cancel.ready');
    expect(after.filter((row) => row.idempotencyKey === `${FEATURE_ID}:cancel:complete`)).toHaveLength(1);
    expect((await documentOf(store))._eventSequence).toBe(after.at(-1)?.sequence);
  });

  it('HandleCancel_ADryRunOnALaggingCancelledDocument_WritesNothing', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await appendRow(store, 'workflow.cancel', { featureId: FEATURE_ID, from: 'investigate', to: 'cancelled' });
    const before = await rowsOf(store);
    const document = await documentOf(store);
    const effects = vi.spyOn(compensation, 'executeCompensation');
    const result = await handleCancel({ featureId: FEATURE_ID, dryRun: true }, store.stateDir, store.eventStore);
    expect(result.data).toEqual({ dryRun: true, actions: [], currentPhase: 'cancelled', wouldTransitionTo: 'cancelled' });
    expect(effects).not.toHaveBeenCalled();
    expect(await rowsOf(store)).toEqual(before);
    expect(await documentOf(store)).toEqual(document);
  });
});
