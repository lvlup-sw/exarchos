/**
 * These tests check that the cancel handler decides on the ledger fold of the rows, not on the state document.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row.
 * A seed writes the rows and the document through the handlers. A forge then changes the document only, or appends a row only.
 * The fold gives the source phase, the phase attempt id and the terminal check. `phaseMoveEvents` gives the trail of the move.
 *
 * @oracle-sources: ../../../src/workflow/phase-attempt-id.ts, hand-seeded stream rows
 */
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import { toEnvelope, type ToolResult } from '../../../src/format.js';
import { WorkflowCancelOutputSchema } from '../../../src/registry/output-schemas.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { flushLiveShadowEvidence } from '../../../src/workflow/admission/live-shadow-observer.js';
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

  /** A row that the fold cannot apply leaves the document path, so the cancel row names the document phase. */
  it('HandleCancel_AFoldError_TakesTheDocumentPhase', async () => {
    const store = await openStore();
    await debugAtInvestigate(store);
    await appendRow(store, 'state.patched', { featureId: FEATURE_ID, fields: ['artifacts[0].x'], patch: { 'artifacts[0].x': 1 } });

    const result = await handleCancel({ featureId: FEATURE_ID }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).previousPhase).toBe('investigate');
    expect((await documentOf(store)).phase).toBe('cancelled');
    expect(closingCancelRowOf(await rowsOf(store))).toMatchObject({ from: 'investigate', to: 'cancelled' });
  });

  /** A feature stream at `ideate`, which is no step, reaches `cancelled`. */
  it('HandleCancel_APhaseThatIsNoStep_ReachesCancelled', async () => {
    const store = await openStore();
    await init(store, 'feature');
    await appendRow(store, 'workflow.transition', { from: 'plan', to: 'ideate', trigger: 'test', featureId: FEATURE_ID });
    await store.backend.setState(FEATURE_ID, { ...(await documentOf(store)), phase: 'ideate' });

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
