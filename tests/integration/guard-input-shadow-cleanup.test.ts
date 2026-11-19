/**
 * These tests check the guard-input shadow on the cleanup path.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row, as in production.
 * A seed puts a review on the ledger and in the document, with a different status on each side.
 * Another seed appends a row with no document write.
 * The ledger fold decides each cleanup. A disagreement adds a warning and a line, and it adds no row.
 *
 * @oracle-sources: ../../src/workflow/cleanup.ts, the seeded stores and expected warnings written in this file
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { guardInputShadowCounts, type GuardInputShadowCounts } from '../../src/projections/guard-input/shadow.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { flushLiveShadowEvidence } from '../../src/workflow/admission/live-shadow-observer.js';
import { handleCleanup } from '../../src/workflow/cleanup.js';
import { configureStateStoreBackend, readStateFile, writeStateFile } from '../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../src/workflow/tools.js';
import type { CleanupInput } from '../../src/workflow/types.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface ShadowStore {
  readonly stateDir: string;
  readonly backend: SqliteBackend;
  readonly eventStore: EventStore;
}

/** One line of a diagnostics file. */
type DiagnosticsLine = Record<string, unknown>;

/** The feature id of each case. Each case has its own store. */
const FEATURE_ID = 'guard-shadow-cleanup';

/** The pull request of the seeds and of the cleanup backfill. */
const PR_URL = 'https://example.com/pr/1';

/** The merged branch of the cleanup backfill. */
const MERGED_BRANCH = 'feat/guard-shadow-cleanup';

/** The plan artifact of the oneshot seed. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** The name of the diagnostics directory under the state directory. */
const DIAGNOSTICS_DIRNAME = 'guard-input-diagnostics';

/** The prefix of a disagreement warning. */
const DISAGREEMENT = 'GUARD_INPUT_DISAGREEMENT: ';

/** The prefix of the warning of a cleanup that the state document decided. */
const DOCUMENT_FALLBACK = 'GUARD_INPUT_DOCUMENT_FALLBACK: ';

/** The prefix of a shadow-failure warning. */
const SHADOW_FAILED = 'GUARD_INPUT_SHADOW_FAILED: ';

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
});

/** Opens a store on a new temporary directory and makes it the backend of the state store. */
async function openStore(): Promise<ShadowStore> {
  const stateDir = makeTempDir('guard-shadow-cleanup-');
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

/** Starts a workflow on the store, so the stream holds a start row. */
async function init(store: ShadowStore, workflowType: string): Promise<void> {
  requireSuccess('init', await handleInit({ featureId: FEATURE_ID, workflowType }, store.stateDir, store.eventStore));
}

/** Updates fields through the handler, so the stream gets one `state.patched` row and the document gets the fields. */
async function update(store: ShadowStore, updates: Record<string, unknown>): Promise<void> {
  requireSuccess(`update ${Object.keys(updates).join(', ')}`, await handleSet({ featureId: FEATURE_ID, updates }, store.stateDir, store.eventStore));
}

/** Returns the path of the state document of the feature. */
function stateFileOf(store: ShadowStore): string {
  return path.join(store.stateDir, `${FEATURE_ID}.state.json`);
}

/** Sets the status of the review in the state document only, with no row. */
async function forgeReviewStatus(store: ShadowStore, status: string): Promise<void> {
  const document: Record<string, unknown> = { ...(await readStateFile(stateFileOf(store))) };
  await writeStateFile(stateFileOf(store), { ...document, reviews: { review: { status } } });
}

/**
 * Starts a feature whose rows and document hold the pull request and the review.
 * The update writes `ledgerStatus` as one row and in the document. With `documentStatus`, the document alone then gets that status.
 */
async function seedReview(store: ShadowStore, ledgerStatus: string, documentStatus?: string): Promise<void> {
  await init(store, 'feature');
  await update(store, { 'synthesis.prUrl': PR_URL, 'reviews.review': { status: ledgerStatus } });
  if (documentStatus !== undefined) await forgeReviewStatus(store, documentStatus);
}

/** The review is `needs_fixes` on the ledger and `approved` in the document only. */
function seedForgedApprovedReview(store: ShadowStore): Promise<void> {
  return seedReview(store, 'needs_fixes', 'approved');
}

/** The review is `approved` on the ledger and `needs_fixes` in the document only. */
function seedForgedNeedsFixesReview(store: ShadowStore): Promise<void> {
  return seedReview(store, 'approved', 'needs_fixes');
}

/** The review is `approved` on the ledger and in the document. */
function seedAgreeingReview(store: ShadowStore): Promise<void> {
  return seedReview(store, 'approved');
}

/** Returns the cleanup input of the cleanup skill, with the backfills `prUrl` and `mergedBranches`. */
function cleanupInput(dryRun = false): CleanupInput {
  return { featureId: FEATURE_ID, mergeVerified: true, prUrl: PR_URL, mergedBranches: [MERGED_BRANCH], dryRun };
}

/** Runs cleanup on the store with its event store. */
function cleanup(store: ShadowStore, dryRun = false): Promise<ToolResult> {
  return handleCleanup(cleanupInput(dryRun), store.stateDir, store.eventStore);
}

/** Returns the counts of the recorded runs minus the counts before. */
function countsSince(before: GuardInputShadowCounts): GuardInputShadowCounts {
  const after = guardInputShadowCounts();
  return {
    compared: after.compared - before.compared,
    disagreeing: after.disagreeing - before.disagreeing,
    failed: after.failed - before.failed,
  };
}

/** Returns the path of the diagnostics directory of a store. */
function diagnosticsDirOf(store: ShadowStore): string {
  return path.join(store.stateDir, DIAGNOSTICS_DIRNAME);
}

/** Returns the one line of the diagnostics file of the feature, and fails when the file holds another count. */
async function oneLineOf(store: ShadowStore): Promise<DiagnosticsLine> {
  const text = await readFile(path.join(diagnosticsDirOf(store), `${FEATURE_ID}.jsonl`), 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  const parsed: unknown = JSON.parse(lines[0] ?? '');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`the line is not a record: ${text}`);
  return { ...parsed };
}

/** Returns the keys of the differences of a line. */
function differenceKeysOf(line: DiagnosticsLine): readonly unknown[] {
  const differences: unknown = line.differences;
  if (!Array.isArray(differences)) return [];
  const list: readonly unknown[] = differences;
  return list.map((difference) => (typeof difference === 'object' && difference !== null && 'key' in difference ? difference.key : undefined));
}

/** Returns the phase of a result, or `undefined` when the result holds no phase. */
function phaseOf(result: ToolResult): unknown {
  const data: unknown = result.data;
  return typeof data === 'object' && data !== null && 'phase' in data ? data.phase : undefined;
}

/** Returns the one warning of a result, and fails when the result holds another count. */
function oneWarningOf(result: ToolResult): string {
  expect(result.warnings).toHaveLength(1);
  const [warning] = result.warnings ?? [];
  if (warning === undefined) throw new Error('the result holds no warning');
  return warning;
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

describe('the guard-input shadow on the cleanup path', () => {
  /** A review forged `approved` in the document admits the cleanup move on the document side only. The fold refuses the cleanup with the warning. */
  it('HandleCleanup_AReviewForgedApprovedInTheDocument_WarnsAndRefuses', async () => {
    const store = await openStore();
    await seedForgedApprovedReview(store);
    const before = guardInputShadowCounts();

    const result = await cleanup(store);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await readStateFile(stateFileOf(store))).phase).toBe('plan');
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
    const line = await oneLineOf(store);
    expect(line).toMatchObject({ v: 1, featureId: FEATURE_ID, workflowType: 'feature', call: 'cleanup', from: 'plan', to: 'completed', pass: 0 });
    expect(line.edges).toContainEqual({ transitionId: 'cleanup', to: 'completed', document: 'allow', fold: 'deny' });
  });

  /** A dry run returns the warning and moves the counts, and it writes no diagnostics file. */
  it('HandleCleanup_ADryRun_WarnsAndWritesNoFile', async () => {
    const store = await openStore();
    await seedForgedNeedsFixesReview(store);
    const before = guardInputShadowCounts();

    const result = await cleanup(store, true);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ dryRun: true, wouldTransitionTo: 'completed' });
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
    expect(existsSync(diagnosticsDirOf(store))).toBe(false);
  });

  /** A dry run writes no line, so its warning names no diagnostics file and keeps its transition and its keys. */
  it('HandleCleanup_ADryRun_WarnsWithNoDiagnosticsPath', async () => {
    const store = await openStore();
    await seedForgedNeedsFixesReview(store);

    const result = await cleanup(store, true);

    const warning = oneWarningOf(result);
    expect(warning.startsWith(DISAGREEMENT)).toBe(true);
    expect(warning).not.toContain(`${DIAGNOSTICS_DIRNAME}/`);
    expect(warning).toContain('at plan -> completed');
    expect(warning).toContain('Keys: ');
    expect(existsSync(diagnosticsDirOf(store))).toBe(false);
  });

  /** A review `approved` on both sides compares and agrees, so cleanup gives no warning and no diagnostics directory. */
  it('HandleCleanup_AnAgreeingCleanup_GivesNoWarning', async () => {
    const store = await openStore();
    await seedAgreeingReview(store);
    const before = guardInputShadowCounts();

    const result = await cleanup(store);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('completed');
    expect(result.warnings).toBeUndefined();
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 0, failed: 0 });
    expect(existsSync(diagnosticsDirOf(store))).toBe(false);
  });

  /**
   * A `synthesize.requested` row after the last transition of a oneshot is not in the stored `_events` of the document.
   * The document side reads the stored list, so the edge `implementing -> completed` allows on the document side only. Cleanup completes.
   */
  it('HandleCleanup_AStaleStoredEventList_WarnsOnSynthesisOptedOut', async () => {
    const store = await openStore();
    await init(store, 'oneshot');
    await update(store, { 'artifacts.plan': PLAN_ARTIFACT, 'synthesis.prUrl': PR_URL });
    requireSuccess('transition implementing', await handleSet({ featureId: FEATURE_ID, phase: 'implementing' }, store.stateDir, store.eventStore));
    await store.eventStore.append(FEATURE_ID, {
      type: 'synthesize.requested',
      data: { featureId: FEATURE_ID, timestamp: new Date().toISOString() },
    });

    const result = await cleanup(store);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('completed');
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    const line = await oneLineOf(store);
    expect(differenceKeysOf(line)).toContain('events[synthesize.requested]');
    expect(line.edges).toContainEqual({ transitionId: 'implementing->completed', to: 'completed', document: 'allow', fold: 'deny' });
    expect(line.edges).toContainEqual({ transitionId: 'cleanup', to: 'completed', document: 'allow', fold: 'allow' });
  });

  /**
   * With no event store, the shadow gets no rows, so the start-row check skips the run of the forged-review seed.
   * The state document decides the cleanup, and the result carries the one fallback warning.
   */
  it('HandleCleanup_NoEventStore_GetsNoComparison', async () => {
    const store = await openStore();
    await seedForgedApprovedReview(store);
    const before = guardInputShadowCounts();

    const result = await handleCleanup(cleanupInput(), store.stateDir, null);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('completed');
    expect(oneWarningOf(result).startsWith(DOCUMENT_FALLBACK)).toBe(true);
    expect(existsSync(diagnosticsDirOf(store))).toBe(false);
    expect(countsSince(before)).toEqual({ compared: 0, disagreeing: 0, failed: 0 });
  });

  /** A row that makes the fold throw refuses the cleanup, and the cleanup warns that the shadow failed. */
  it('HandleCleanup_AFoldThatThrows_RefusesAndWarns', async () => {
    const store = await openStore();
    await seedAgreeingReview(store);
    await store.eventStore.append(FEATURE_ID, {
      type: 'state.patched',
      data: { featureId: FEATURE_ID, fields: ['artifacts[0].x'], patch: { 'artifacts[0].x': 1 } },
    });
    const before = guardInputShadowCounts();

    const result = await cleanup(store);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROJECTION_REPLAY_FAILED');
    expect((await readStateFile(stateFileOf(store))).phase).toBe('plan');
    expect(oneWarningOf(result).startsWith(SHADOW_FAILED)).toBe(true);
    expect(countsSince(before)).toEqual({ compared: 0, disagreeing: 0, failed: 1 });
  });

  /** A state write that throws follows the record of the run, so the line and the counts land and the call rejects. */
  it('HandleCleanup_AWriteThatThrows_RecordsTheRunBeforeTheThrow', async () => {
    const store = await openStore();
    await seedForgedNeedsFixesReview(store);
    replaceMethod(store.backend, 'setState', (): void => {
      throw new Error('the test refuses the state write');
    });
    const before = guardInputShadowCounts();

    await expect(cleanup(store)).rejects.toThrow('the test refuses the state write');

    expect(existsSync(path.join(diagnosticsDirOf(store), `${FEATURE_ID}.jsonl`))).toBe(true);
    const line = await oneLineOf(store);
    expect(line.edges).toContainEqual({ transitionId: 'cleanup', to: 'completed', document: 'deny', fold: 'allow' });
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
  });

  /** Each failure exit of cleanup records its run, so each failure carries the warning. */
  it.each(
    [
      {
        name: 'guard failure',
        code: 'GUARD_FAILED',
        seed: seedForgedApprovedReview,
      },
      {
        name: 'append failure',
        code: 'EVENT_APPEND_FAILED',
        seed: async (store: ShadowStore): Promise<void> => {
          await seedForgedNeedsFixesReview(store);
          replaceMethod(store.eventStore, 'appendTrailAtomically', () => Promise.reject(new Error('the test refuses the cleanup trail')));
        },
      },
    ].map((row): [string, typeof row] => [row.name, row]),
  )('HandleCleanup_%s_CarriesTheWarningOnItsExit', async (_name, { code, seed }) => {
    const store = await openStore();
    await seed(store);
    const before = guardInputShadowCounts();

    const result = await cleanup(store);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(code);
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    await oneLineOf(store);
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
  });
});
