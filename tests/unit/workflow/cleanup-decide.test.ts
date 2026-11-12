/**
 * These tests check that the cleanup handler decides on the ledger fold of the rows, not on the state document.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row.
 * A seed writes the rows and the document through the handlers. A forge then changes the document only, or appends a row only.
 * The fold gives the source phase, the attempt id, the terminal checks, the guard events and the merge evidence.
 *
 * @oracle-sources: ./decide/__fixtures__/transition-rows.golden.json, ../../../src/workflow/cleanup.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { handleRequestSynthesize } from '../../../src/verbs/team/request-synthesize.js';
import { flushLiveShadowEvidence } from '../../../src/workflow/admission/live-shadow-observer.js';
import { handleCleanup } from '../../../src/workflow/cleanup.js';
import { hsmTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import { allocatePhaseAttemptId } from '../../../src/workflow/phase-attempt-id.js';
import { configureStateStoreBackend, readStateFile, writeStateFile } from '../../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../../src/workflow/tools.js';
import {
  captureTransitionRows,
  maskRows,
  renderTransitionRowsGolden,
  TRANSITION_ROW_SCENARIOS,
} from '../../helpers/decide/transition-rows.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface CleanupStore {
  readonly stateDir: string;
  readonly backend: SqliteBackend;
  readonly eventStore: EventStore;
}

/** The feature id of each case. Each case has its own store. */
const FEATURE_ID = 'cleanup-decide';

/** The plan artifact of the seeds. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** The pull request of the merge evidence. */
const PR_URL = 'https://example.com/pr/1';

/** The golden file that the scratch capture wrote once. */
const GOLDEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'decide/__fixtures__/transition-rows.golden.json');

/** The key form of a phase row that the legacy transition guard appended: the feature, the event, the edge and the document version. */
const LEGACY_TRANSITION_KEY = /^[^:]+:(transition|phase\.exited|phase\.entered|compound-entry|compound-exit|fix-cycle|plan-revision|cancel|cleanup):[^:]+:[^:]+:\d+$/;

/** A golden entry, as the comparison reads it. */
const GoldenEntrySchema = z.looseObject({
  name: z.string(),
  rows: z.array(z.looseObject({ idempotencyKey: z.string().nullable() })),
});

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
async function openStore(): Promise<CleanupStore> {
  const stateDir = makeTempDir('cleanup-decide-');
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

/** Updates fields through the handler, so the stream gets a `state.patched` row and the document gets the fields. */
async function update(store: CleanupStore, updates: Record<string, unknown>): Promise<void> {
  requireSuccess(`update ${Object.keys(updates).join(', ')}`, await handleSet({ featureId: FEATURE_ID, updates }, store.stateDir, store.eventStore));
}

/** Transitions through the handler and requires success. */
async function transition(store: CleanupStore, phase: string): Promise<void> {
  requireSuccess(`transition ${phase}`, await handleSet({ featureId: FEATURE_ID, phase }, store.stateDir, store.eventStore));
}

/** Appends one row with no document write. */
async function appendRow(store: CleanupStore, type: string, data: Record<string, unknown>): Promise<void> {
  await store.eventStore.append(FEATURE_ID, { type, data });
}

/** Returns the path of the state document of the feature. */
function stateFileOf(store: CleanupStore): string {
  return path.join(store.stateDir, `${FEATURE_ID}.state.json`);
}

/** Returns the state document of the feature as a record. */
async function documentOf(store: CleanupStore): Promise<Record<string, unknown>> {
  return { ...(await readStateFile(stateFileOf(store))) };
}

/** Changes the state document only, with no row. */
async function forgeDocument(store: CleanupStore, change: (document: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await writeStateFile(stateFileOf(store), change(await documentOf(store)));
}

/** Returns the rows of the stream of the feature. */
function rowsOf(store: CleanupStore): Promise<WorkflowEvent[]> {
  return store.eventStore.query(FEATURE_ID);
}

/** Returns the `workflow.cleanup` row that closes the cleanup trail. */
function closingCleanupRowOf(rows: readonly WorkflowEvent[]): Record<string, unknown> | undefined {
  const row = rows.find((candidate) => candidate.idempotencyKey === `${FEATURE_ID}:cleanup:complete`);
  return row === undefined ? undefined : recordOf(row.data);
}

/** Starts a oneshot workflow with the synthesis policy `on-request`, and moves it to `implementing`. */
async function oneshotAtImplementing(store: CleanupStore): Promise<void> {
  requireSuccess(
    'init',
    await handleInit({ featureId: FEATURE_ID, workflowType: 'oneshot', synthesisPolicy: 'on-request' }, store.stateDir, store.eventStore),
  );
  await update(store, { 'artifacts.plan': PLAN_ARTIFACT });
  await transition(store, 'implementing');
}

/** Starts a feature whose rows and document hold the merge evidence, and moves its rows to `synthesize`. */
async function featureAtSynthesizeOnTheRows(store: CleanupStore): Promise<void> {
  requireSuccess('init', await handleInit({ featureId: FEATURE_ID, workflowType: 'feature' }, store.stateDir, store.eventStore));
  await update(store, { 'synthesis.prUrl': PR_URL });
  await appendRow(store, 'workflow.transition', { from: 'plan', to: 'synthesize', trigger: 'test', featureId: FEATURE_ID });
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
 * Runs one cleanup inside the first full read of the stream, after the read returns its rows.
 * So the outer cleanup decides on rows that do not hold the trail of the inner cleanup. The result gives the inner reply.
 */
function cleanupInsideTheFirstRead(store: CleanupStore): () => ToolResult | undefined {
  const originalQuery = store.eventStore.query.bind(store.eventStore);
  let inner: ToolResult | undefined;
  let fired = false;
  replaceMethod(store.eventStore, 'query', async (streamId: string, filters?: Parameters<EventStore['query']>[1]) => {
    const rows = await originalQuery(streamId, filters);
    if (!fired && streamId === FEATURE_ID && filters === undefined) {
      fired = true;
      inner = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);
    }
    return rows;
  });
  return () => inner;
}

/** Returns an admitted legacy result with no events. */
function admittedWithNoEvents(from: string): LegacyAttempt {
  return {
    ok: true,
    idempotent: false,
    newPhase: 'completed',
    historyUpdates: {},
    emittedEvents: [],
    transitionEvent: { type: 'workflow.transition', from, to: 'completed', trigger: 'test', featureId: FEATURE_ID, sequence: -1 },
  };
}

/** Applies the named delta of the decide on the fold to one golden entry. A phase row of a transition move holds no idempotency key. */
function goldenEntryWithTheDelta(name: string): unknown {
  const golden = z.array(GoldenEntrySchema).parse(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')));
  const entry = golden.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`the golden holds no scenario '${name}'`);
  return {
    ...entry,
    rows: entry.rows.map((row) =>
      row.idempotencyKey !== null && LEGACY_TRANSITION_KEY.test(row.idempotencyKey) ? { ...row, idempotencyKey: null } : row,
    ),
  };
}

describe('the cleanup handler decides on the ledger fold', () => {
  /**
   * A `synthesize.requested` row that the stored `_events` list lacks closes the edge `implementing -> completed`.
   * No merge artifact exists, so the request falls to that edge, and the route reads the row events.
   */
  it('HandleCleanup_ReadsTheRowEvents_NotTheStoredEventsList', async () => {
    const store = await openStore();
    await oneshotAtImplementing(store);
    await appendRow(store, 'synthesize.requested', { featureId: FEATURE_ID, timestamp: new Date().toISOString() });
    const stored: unknown = (await documentOf(store))._events;
    expect(Array.isArray(stored) ? stored.map((event) => recordOf(event).type) : []).not.toContain('synthesize.requested');

    const result = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await rowsOf(store)).filter((row) => row.type === 'workflow.cleanup')).toEqual([]);
    expect((await documentOf(store)).phase).toBe('implementing');
  });

  /** A legacy guard that admits with no events does not empty the trail, because `phaseMoveEvents` builds it. */
  it('HandleCleanup_AStubAttemptWithNoEvents_StillWritesTheMoveRows', async () => {
    const store = await openStore();
    await featureAtSynthesizeOnTheRows(store);
    vi.spyOn(hsmTransitionGuard, 'attempt').mockResolvedValue(admittedWithNoEvents('synthesize'));

    const result = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    const moveRow = (await rowsOf(store)).find(
      (row) => row.idempotencyKey === `${FEATURE_ID}:cleanup:transition:synthesize:completed:synthesize`,
    );
    expect(moveRow?.type).toBe('workflow.cleanup');
    expect(moveRow?.data).toMatchObject({ from: 'synthesize', to: 'completed', trigger: 'cleanup' });
  });

  /** The rows end with a cleanup row and the document lags at `synthesize` with merge evidence. Cleanup refuses and appends no row. */
  it('HandleCleanup_AFoldAtCompletedAndALaggingDocument_RefusesAlreadyCompleted', async () => {
    const store = await openStore();
    await featureAtSynthesizeOnTheRows(store);
    await appendRow(store, 'workflow.cleanup', { from: 'synthesize', to: 'completed', trigger: 'test', featureId: FEATURE_ID });
    await forgeDocument(store, (document) => ({ ...document, phase: 'synthesize' }));
    const rows = await rowsOf(store);

    const result = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_COMPLETED');
    expect(await rowsOf(store)).toHaveLength(rows.length);
  });

  /**
   * Two cleanups read the same rows, so they share one phase attempt id and one trail operation. The inner cleanup commits the trail.
   * The outer cleanup gets the stored claim of the inner cleanup and wrote no row. It reads the rows again, finds the fold
   * at `completed` and refuses with `ALREADY_COMPLETED`, as a later cleanup does.
   */
  it('HandleCleanup_TwoCallsThatReadTheSameRows_TheSecondRefusesAlreadyCompleted', async () => {
    const store = await openStore();
    await featureAtSynthesizeOnTheRows(store);
    const inner = cleanupInsideTheFirstRead(store);

    const outer = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(inner()?.success).toBe(true);
    expect(recordOf(inner()?.data).phase).toBe('completed');
    expect(outer.success).toBe(false);
    expect(outer.error?.code).toBe('ALREADY_COMPLETED');
    const rows = await rowsOf(store);
    expect(rows.filter((row) => row.idempotencyKey === `${FEATURE_ID}:cleanup:complete`)).toHaveLength(1);
    expect((await documentOf(store)).phase).toBe('completed');
  });

  /** The rows hold `synthesize` and the document lags at `review`. The cleanup row names the fold phase. */
  it('HandleCleanup_TheFoldPhase_IsTheSourceOfTheCleanupRow', async () => {
    const store = await openStore();
    await featureAtSynthesizeOnTheRows(store);
    await forgeDocument(store, (document) => ({ ...document, phase: 'review' }));

    const result = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).previousPhase).toBe('synthesize');
    expect(closingCleanupRowOf(await rowsOf(store))).toMatchObject({ from: 'synthesize', previousPhase: 'synthesize', to: 'completed' });
  });

  /** The attempt id comes from the fold phase, the fold attempt id and the stream version, not from the lagging document. */
  it('HandleCleanup_ALaggingDocument_TakesThePhaseAttemptIdFromTheFold', async () => {
    const store = await openStore();
    await featureAtSynthesizeOnTheRows(store);
    await forgeDocument(store, (document) => ({ ...document, phase: 'review', phaseAttemptId: 'an-older-attempt' }));
    const rows = await rowsOf(store);
    const foldAttemptId = recordOf(rows.find((row) => row.type === 'workflow.started')?.data).phaseAttemptId;
    const expected = allocatePhaseAttemptId(FEATURE_ID, 'synthesize', 'completed', foldAttemptId, Math.max(...rows.map((row) => row.sequence)));

    const result = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).phaseAttemptId).toBe(expected);
    expect(closingCleanupRowOf(await rowsOf(store))?.phaseAttemptId).toBe(expected);
  });

  /** With no merge evidence, the cleanup request falls to the explicit edge `implementing -> completed`, which admits. */
  it('HandleCleanup_FalseMergeVerified_FallsToTheExplicitEdge', async () => {
    const store = await openStore();
    await oneshotAtImplementing(store);

    const result = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).phase).toBe('completed');
    expect(closingCleanupRowOf(await rowsOf(store))).toMatchObject({ from: 'implementing', mergeVerified: false });
  });

  /** The cleanup scenario of the capture gives its golden rows, with the named delta of the transition moves of its setup. */
  it('HandleCleanup_EachCapturedScenario_EqualsTheGolden', async () => {
    const scenarios = TRANSITION_ROW_SCENARIOS.filter((scenario) => scenario.call.kind === 'cleanup');
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      const captured = maskRows(await captureTransitionRows(scenario));

      expect(JSON.parse(renderTransitionRowsGolden([captured]))).toStrictEqual(
        JSON.parse(renderTransitionRowsGolden([goldenEntryWithTheDelta(scenario.name)])),
      );
    }
  });

  /** A merge artifact that only the document holds is no evidence. The request falls to `synthesize -> completed`, which denies. */
  it('HandleCleanup_AMergeArtifactOnlyInTheDocument_GivesNoCleanupMove', async () => {
    const store = await openStore();
    await oneshotAtImplementing(store);
    requireSuccess(
      'request synthesize',
      await handleRequestSynthesize({ featureId: FEATURE_ID, stateDir: store.stateDir, eventStore: store.eventStore }),
    );
    await transition(store, 'synthesize');
    await forgeDocument(store, (document) => ({ ...document, synthesis: { ...recordOf(document.synthesis), prUrl: PR_URL } }));

    const result = await handleCleanup({ featureId: FEATURE_ID, mergeVerified: true }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await rowsOf(store)).filter((row) => row.type === 'workflow.cleanup')).toEqual([]);
    expect((await documentOf(store)).phase).toBe('synthesize');
  });
});
