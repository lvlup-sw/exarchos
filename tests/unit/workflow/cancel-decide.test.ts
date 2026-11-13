/**
 * These tests check that the cancel handler decides on the ledger fold of the rows, not on the state document.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row.
 * A seed writes the rows and the document through the handlers. A forge then changes the document only, or appends a row only.
 * The fold gives the source phase, the phase attempt id and the terminal check. `phaseMoveEvents` gives the trail of the move.
 *
 * The subprocess mock refuses unexpected commands. Resource cases supply explicit responses without external effects.
 *
 * @oracle-sources: ../../../src/workflow/phase-attempt-id.ts, hand-seeded stream rows
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn(() => { throw new Error('Unexpected subprocess'); }) };
});

import { ChildProcess, execFile } from 'child_process';

import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import { toEnvelope, type ToolResult } from '../../../src/format.js';
import { WorkflowCancelOutputSchema } from '../../../src/registry/output-schemas.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { flushLiveShadowEvidence } from '../../../src/workflow/admission/live-shadow-observer.js';
import * as folds from '../../../src/projections/guard-input/fold.js';
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
 * A remote lookup reports no branch. Each other command fails. The result gives the count of the branch deletes.
 */
function failEachBranchDelete(): () => number {
  let branchDeletes = 0;
  const fake = (_file: string, args?: unknown, options?: unknown, callback?: unknown): ChildProcess => {
    const done = typeof options === 'function' ? options : callback;
    const argv: readonly unknown[] = Array.isArray(args) ? args : [];
    let error: Error | null = null;
    let stdout = '';
    if (_file !== 'git' || !['rev-parse', 'ls-remote', 'branch'].includes(String(argv[0]))) throw new Error('Unexpected subprocess');
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
    vi.mocked(execFile).mockImplementation(() => { throw new Error('Unexpected subprocess'); });
  });
  return () => branchDeletes;
}

/**
 * Seeds a feature at `delegate` whose rows and document hold no phase attempt id. The start row and the transition row
 * carry none, and the document has none. Both sources name an integration branch, so the cancel saga deletes it.
 */
async function featureAtDelegateWithNoAttemptId(store: CancelStore): Promise<void> {
  await init(store, 'feature', false);
  await appendRow(store, 'workflow.started', { featureId: FEATURE_ID, workflowType: 'feature' });
  await appendRow(store, 'workflow.transition', { from: 'plan', to: 'delegate', trigger: 'test', featureId: FEATURE_ID });
  await appendRow(store, 'state.patched', { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH } });
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

/** Literal resources distinguish the workflow projection from the guard task overlay. */
const LEDGER_RESOURCES = {
  worktrees: { live: { path: '/absent-cancel-ledger/worktree', branch: 'task/ledger', taskId: 'live', status: 'active', detail: { owner: 'ledger' } } },
  tasks: [{ id: 'live', title: 'Ledger task', status: 'complete', branch: 'task/ledger', detail: { owner: 'ledger' } }],
  synthesis: { integrationBranch: 'integrate/ledger', prUrl: 'https://example.invalid/pull/17', mergeOrder: ['live'], mergedBranches: [], prFeedback: [] },
};

/** Creates a synthesize stream with a resource patch that the document does not contain. */
async function seedLedgerResources(store: CancelStore): Promise<void> {
  await init(store, 'feature');
  await appendRow(store, 'workflow.transition', { from: 'plan', to: 'synthesize', featureId: FEATURE_ID });
  await appendRow(store, 'state.patched', { patch: structuredClone(LEDGER_RESOURCES) });
}

/** Emulates only the resource commands of these fixtures and records each command. No subprocess runs. */
function stubResourceCommands(): string[][] {
  const calls: string[][] = [];
  vi.mocked(execFile).mockImplementation((file: string, args?: unknown, options?: unknown, callback?: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    calls.push([file, ...argv]);
    const done = typeof options === 'function' ? options : callback;
    let stdout: string;
    if (file === 'gh' && argv[0] === 'pr' && argv[1] === 'view') stdout = 'OPEN';
    else if (file === 'gh' && argv[0] === 'pr' && argv[1] === 'close') stdout = '';
    else if (file === 'git' && argv[0] === 'rev-parse' && argv[1] === '--verify') stdout = 'abc123';
    else if (file === 'git' && argv[0] === 'ls-remote' && argv[1] === '--heads') stdout = '';
    else if (file === 'git' && argv[0] === 'branch' && argv[1] === '-D') stdout = '';
    else if (file === 'git' && argv.join(' ') === 'worktree list') stdout = '/absent-cancel-ledger/worktree abc123 [task/ledger]';
    else if (file === 'git' && argv[0] === 'worktree' && argv[1] === 'remove') stdout = '';
    else throw new Error(`Unexpected subprocess: ${file} ${argv.join(' ')}`);
    if (typeof done !== 'function') throw new Error('Missing subprocess callback');
    Reflect.apply(done, undefined, [null, stdout, '']);
    return new ChildProcess();
  });
  releases.push(() => vi.mocked(execFile).mockImplementation(() => { throw new Error('Unexpected subprocess'); }));
  return calls;
}

/** Returns exactly the resource containers from a compensation input. */
function resourcesOf(state: Record<string, unknown>): Record<string, unknown> {
  return { worktrees: state.worktrees, tasks: state.tasks, synthesis: state.synthesis };
}

describe('Cancellation resource authority', () => {
  it('HandleCancel_LedgerResources_SelectExactEffectsAndPreserveOperationalInput', async () => {
    const store = await openStore();
    await seedLedgerResources(store);
    await forgeDocument(store, (document) => ({ ...document, operatorNote: { owner: 'document' }, _compensationCheckpoint: { completedActions: ['kept-operational-marker'] } }));
    const before = await documentOf(store);
    const calls = stubResourceCommands();
    const original = compensation.executeCompensation;
    let selected: Record<string, unknown> | undefined;
    vi.spyOn(compensation, 'executeCompensation').mockImplementation(async (...args) => {
      selected = structuredClone(args[0]);
      expect(await documentOf(store)).toEqual(before);
      return original(...args);
    });
    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(resourcesOf(selected!)).toEqual(LEDGER_RESOURCES);
    for (const key of ['_checkpoint', '_compensationCheckpoint', '_version', '_esVersion', '_eventSequence', 'updatedAt', 'operatorNote']) {
      expect(selected![key]).toEqual(before[key]);
    }
    expect(selected!._events).toEqual(before._events);
    expect(calls.filter((call) => call.includes('-D') || call.includes('close') || call.includes('remove'))).toEqual([
      ['gh', 'pr', 'close', 'https://example.invalid/pull/17', '--comment', 'Cancelled via compensation'],
      ['git', 'branch', '-D', 'integrate/ledger'],
      ['git', 'worktree', 'remove', '/absent-cancel-ledger/worktree', '--force'],
      ['git', 'branch', '-D', 'task/ledger'],
    ]);
    expect(closingCancelRowOf(await rowsOf(store))).toMatchObject({ from: 'synthesize', to: 'cancelled' });
    expect(resourcesOf(await documentOf(store))).toEqual({ ...LEDGER_RESOURCES, tasks: [{ id: 'live', title: 'Ledger task', status: 'complete', branch: 'task/ledger', blockedBy: [] }] });
    expect((await documentOf(store))._compensationCheckpoint).toBeUndefined();
    expect((await documentOf(store))._eventSequence).toBe((await rowsOf(store)).at(-1)?.sequence);
  });

  it.each([false, true])('HandleCancel_EmptyLedgerContainers_ExcludeObsoleteDocumentResources (%s)', async (dryRun) => {
    const store = await openStore();
    await init(store, 'feature');
    await appendRow(store, 'workflow.transition', { from: 'plan', to: 'synthesize', featureId: FEATURE_ID });
    await forgeDocument(store, (document) => ({ ...document, ...structuredClone(LEDGER_RESOURCES), synthesis: { ...LEDGER_RESOURCES.synthesis, obsolete: { branch: 'obsolete' } } }));
    await appendRow(store, 'state.patched', { patch: { worktrees: {}, tasks: [], synthesis: {} } });
    const calls = stubResourceCommands();
    const capture = vi.spyOn(compensation, 'executeCompensation');
    const result = await handleCancel({ featureId: FEATURE_ID, dryRun }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(resourcesOf(capture.mock.calls[0]![0])).toEqual({ worktrees: {}, tasks: [], synthesis: { integrationBranch: null, prUrl: null, mergeOrder: [], mergedBranches: [], prFeedback: [] } });
    expect(calls).toEqual([]);
    expect(recordOf(result.data).actions).toEqual([
      { actionId: 'synthesize:close-pr', status: 'skipped', message: dryRun ? 'No PR to close' : 'Already completed (event replay)' },
      { actionId: 'delegate:delete-integration-branch', status: 'skipped', message: dryRun ? 'No integration branch to delete' : 'Already completed (event replay)' },
      { actionId: 'delegate:cleanup-worktrees', status: 'skipped', message: dryRun ? 'No worktrees to clean up' : 'Already completed (event replay)' },
      { actionId: 'delegate:delete-feature-branches', status: 'skipped', message: dryRun ? 'No feature branches to delete' : 'Already completed (event replay)' },
    ]);
  });

  it('HandleCancel_LedgerResourceDryRun_ReportsLiteralActionsWithoutWrites', async () => {
    const store = await openStore();
    await seedLedgerResources(store);
    const document = await documentOf(store);
    configureStateStoreBackend(undefined);
    await writeStateFile(stateFileOf(store), document);
    const before = await readFile(stateFileOf(store), 'utf8');
    const rows = await rowsOf(store);
    const calls = stubResourceCommands();
    const result = await handleCancel({ featureId: FEATURE_ID, dryRun: true }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(recordOf(result.data).actions).toEqual([
      { actionId: 'synthesize:close-pr', status: 'dry-run', message: 'Would close PR: https://example.invalid/pull/17' },
      { actionId: 'delegate:delete-integration-branch', status: 'dry-run', message: 'Would delete branch: integrate/ledger' },
      { actionId: 'delegate:cleanup-worktrees', status: 'dry-run', message: 'Would remove worktrees for branches: task/ledger' },
      { actionId: 'delegate:delete-feature-branches', status: 'dry-run', message: 'Would delete branches: task/ledger' },
    ]);
    expect(await readFile(stateFileOf(store), 'utf8')).toBe(before);
    expect(await rowsOf(store)).toEqual(rows);
    expect(calls).toEqual([]);
  });

  it('HandleCancel_CompensationResourceMutation_DoesNotAliasFoldRowsOrDocument', async () => {
    const store = await openStore();
    await seedLedgerResources(store);
    const before = await documentOf(store);
    const rows = await rowsOf(store);
    const views: { live: ReturnType<typeof folds.foldWorkflowState>; saved: ReturnType<typeof folds.foldWorkflowState> }[] = [];
    const originalFold = folds.foldWorkflowState;
    vi.spyOn(folds, 'foldWorkflowState').mockImplementation((input) => {
      const live = originalFold(input);
      views.push({ live, saved: structuredClone(live) });
      return live;
    });
    vi.spyOn(compensation, 'executeCompensation').mockImplementationOnce(async (state) => {
      expect(resourcesOf(state)).toEqual(LEDGER_RESOURCES);
      const resources = state as unknown as typeof LEDGER_RESOURCES;
      resources.worktrees.live.detail.owner = 'mutated';
      resources.tasks[0]!.detail.owner = 'mutated';
      resources.synthesis.mergeOrder.push('mutated');
      return { success: true, actions: [], events: [] };
    });
    await handleCancel({ featureId: FEATURE_ID, dryRun: true }, store.stateDir, store.eventStore);
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) expect(view.live).toEqual(view.saved);
    expect(await rowsOf(store)).toEqual(rows);
    expect(await documentOf(store)).toEqual(before);
  });

  it.each(['no-store', 'off-ledger', 'no-start', 'custom'])('HandleCancel_FallbackResources_KeepDocumentContainers (%s)', async (route) => {
    const store = await openStore();
    await init(store, 'feature', route !== 'no-start');
    await forgeDocument(store, (document) => ({ ...document, ...structuredClone(LEDGER_RESOURCES), phase: 'synthesize',
      ...(route === 'off-ledger' ? { _esVersion: 1 } : {}) }));
    if (route === 'custom') await writeStateFile(stateFileOf(store), { ...(await documentOf(store)), workflowType: 'custom' }, { skipValidation: true });
    const before = await documentOf(store);
    const capture = vi.spyOn(compensation, 'executeCompensation');
    const calls = stubResourceCommands();
    const result = await handleCancel({ featureId: FEATURE_ID, dryRun: true }, store.stateDir, route === 'no-store' ? null : store.eventStore);
    expect(result.success).toBe(true);
    expect(resourcesOf(capture.mock.calls[0]![0])).toEqual(LEDGER_RESOURCES);
    expect(await documentOf(store)).toEqual(before);
    expect(calls).toEqual([]);
  });
});
