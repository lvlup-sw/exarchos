/**
 * These tests check the guard-input shadow on the transition path.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row, as in production.
 * A seed writes the document only, the rows only, or both. Then the case calls the handler and reads the result, the diagnostics file and the counts.
 *
 * The ledger fold decides each call on a stream with a start row. A disagreement adds a warning and a line, and it adds no row.
 * So a case that moves the phase with a disagreement holds the fact in the rows only, and the document lacks it.
 *
 * @oracle-sources: ../../src/projections/guard-input/shadow.ts, the seeded stores and expected lines written in this file
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkflowEvent } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { guardInputShadowCounts, type GuardInputShadowCounts } from '../../src/projections/guard-input/shadow.js';
import { VersionConflictError as BackendVersionConflictError } from '../../src/storage/memory-backend.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { handleFinalizeOneshot } from '../../src/verbs/tasks/finalize-oneshot.js';
import { flushLiveShadowEvidence } from '../../src/workflow/admission/live-shadow-observer.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../../src/workflow/schemas.js';
import { registerWorkflowType, unregisterWorkflowType } from '../../src/workflow/state-machine.js';
import {
  applyDotPath,
  configureStateStoreBackend,
  readStateFile,
  VersionConflictError,
  writeStateFile,
} from '../../src/workflow/state-store.js';
import { handleInit, handleSet, handleTransition } from '../../src/workflow/tools.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface ShadowStore {
  readonly stateDir: string;
  readonly backend: SqliteBackend;
  readonly eventStore: EventStore;
}

/** One line of a diagnostics file. */
type DiagnosticsLine = Record<string, unknown>;

/** The plan artifact of the seeds. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** The feature id of most cases. Each case has its own store. */
const FEATURE_ID = 'guard-shadow';

/** The name of the diagnostics directory under the state directory. */
const DIAGNOSTICS_DIRNAME = 'guard-input-diagnostics';

/** The name of the custom type of one case. */
const CUSTOM_TYPE = 'guard-shadow-custom';

/** The prefix of a disagreement warning. */
const DISAGREEMENT = 'GUARD_INPUT_DISAGREEMENT: ';

/** The prefix of a shadow-failure warning. */
const SHADOW_FAILED = 'GUARD_INPUT_SHADOW_FAILED: ';

/** The most bytes of a diagnostics file. */
const FILE_MAX_BYTES = 1024 * 1024;

/**
 * The handler options that the composite passes on a transition.
 * The default project config gives the plan-revision cap and the three mutation options. A project config adds the required reviews.
 */
const COMPOSITE_OPTIONS: NonNullable<Parameters<typeof handleSet>[3]> = {
  requiredReviews: ['review', 'mutation-adequacy'],
  maxPlanRevisions: 1,
  mutationEnforcement: 'advisory',
  mutationThreshold: 0.4,
  maxNoCoverage: 0,
};

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
});

/** Opens a store on a new temporary directory and makes it the backend of the state store. */
async function openStore(): Promise<ShadowStore> {
  const stateDir = makeTempDir('guard-shadow-');
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
async function init(store: ShadowStore, featureId: string, workflowType = 'feature', withStore = true): Promise<void> {
  requireSuccess('init', await handleInit({ featureId, workflowType }, store.stateDir, withStore ? store.eventStore : null));
}

/** Updates fields through the handler, so the stream gets a `state.patched` row and the document gets the fields. */
async function update(store: ShadowStore, featureId: string, updates: Record<string, unknown>): Promise<void> {
  requireSuccess(`update ${Object.keys(updates).join(', ')}`, await handleSet({ featureId, updates }, store.stateDir, store.eventStore));
}

/** Transitions through the handler and requires success. */
async function transition(store: ShadowStore, featureId: string, phase: string): Promise<void> {
  requireSuccess(`transition ${phase}`, await handleSet({ featureId, phase }, store.stateDir, store.eventStore));
}

/** Returns the path of the state document of a feature. */
function stateFileOf(store: ShadowStore, featureId: string): string {
  return path.join(store.stateDir, `${featureId}.state.json`);
}

/** Changes the state document only, with no row. */
async function forgeDocument(
  store: ShadowStore,
  featureId: string,
  change: (document: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const document: Record<string, unknown> = { ...(await readStateFile(stateFileOf(store, featureId))) };
  await writeStateFile(stateFileOf(store, featureId), change(document));
}

/** Returns the artifacts of a document as a record. */
function artifactsOf(document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const artifacts = document.artifacts;
  return typeof artifacts === 'object' && artifacts !== null && !Array.isArray(artifacts) ? { ...artifacts } : {};
}

/** Sets the plan artifact in the state document only. The rows hold no plan artifact. */
async function forgePlanArtifact(store: ShadowStore, featureId: string, plan = PLAN_ARTIFACT): Promise<void> {
  await forgeDocument(store, featureId, (document) => ({ ...document, artifacts: { ...artifactsOf(document), plan } }));
}

/** Appends a `state.patched` row with one field and writes no document. */
async function appendPatchRow(store: ShadowStore, featureId: string, key: string, value: unknown): Promise<void> {
  await store.eventStore.append(featureId, {
    type: 'state.patched',
    data: { featureId, fields: [key], patch: { [key]: value } },
  });
}

/** Starts a feature at `plan` whose state document alone holds the plan artifact. */
async function seedDocumentOnlyPlan(store: ShadowStore, featureId = FEATURE_ID): Promise<void> {
  await init(store, featureId);
  await forgePlanArtifact(store, featureId);
}

/** Starts a feature at `plan` whose rows alone hold the plan artifact. The fold admits `plan-review`, and the document disagrees. */
async function seedRowOnlyPlan(store: ShadowStore, featureId = FEATURE_ID, plan = PLAN_ARTIFACT): Promise<void> {
  await init(store, featureId);
  await appendPatchRow(store, featureId, 'artifacts.plan', plan);
}

/** The prefix of the warning of a transition that the state document decided. */
const DOCUMENT_FALLBACK = 'GUARD_INPUT_DOCUMENT_FALLBACK: ';

/** Starts a feature at `plan` that holds the plan artifact in the rows and in the document. */
async function seedHonestPlan(store: ShadowStore, featureId = FEATURE_ID): Promise<void> {
  await init(store, featureId);
  await update(store, featureId, { 'artifacts.plan': PLAN_ARTIFACT });
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

/** Returns the path of the diagnostics file of a feature. */
function diagnosticsFileOf(store: ShadowStore, featureId = FEATURE_ID): string {
  return path.join(diagnosticsDirOf(store), `${featureId}.jsonl`);
}

/** Returns the parsed lines of the diagnostics file of a feature. */
async function linesOf(store: ShadowStore, featureId = FEATURE_ID): Promise<DiagnosticsLine[]> {
  const text = await readFile(diagnosticsFileOf(store, featureId), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): DiagnosticsLine => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`a line is not a record: ${line}`);
      return { ...parsed };
    });
}

/** Returns the one line of the diagnostics file of a feature, and fails when the file holds another count. */
async function oneLineOf(store: ShadowStore, featureId = FEATURE_ID): Promise<DiagnosticsLine> {
  const lines = await linesOf(store, featureId);
  expect(lines).toHaveLength(1);
  const [line] = lines;
  if (line === undefined) throw new Error('the diagnostics file holds no line');
  return line;
}

/** Returns the guard ids and targets of a line. */
function guardsOf(line: DiagnosticsLine): readonly { readonly guardId: unknown; readonly to: unknown }[] {
  const guards: unknown = line.guards;
  if (!Array.isArray(guards)) return [];
  const list: readonly unknown[] = guards;
  return list.map((guard) =>
    typeof guard === 'object' && guard !== null && 'guardId' in guard && 'to' in guard ? { guardId: guard.guardId, to: guard.to } : { guardId: undefined, to: undefined },
  );
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

/** Returns the count of each row type of a list of rows, as a record with sorted keys. */
function typeCounts(rows: readonly WorkflowEvent[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/** Returns the rows of each stream of a feature: the workflow stream and the sidecar stream of the admission observer. */
async function streamRows(store: ShadowStore, featureId: string): Promise<{ readonly main: WorkflowEvent[]; readonly sidecar: WorkflowEvent[] }> {
  return {
    main: await store.eventStore.query(featureId),
    sidecar: await store.eventStore.query(`${featureId}/admission-shadow`),
  };
}

/** Returns the row-type counts that one call adds to each stream of a feature. It awaits the admission evidence first. */
async function rowDelta(store: ShadowStore, featureId: string, call: () => Promise<ToolResult>): Promise<{ readonly result: ToolResult; readonly delta: Record<string, Record<string, number>> }> {
  await flushLiveShadowEvidence();
  const before = await streamRows(store, featureId);
  const result = await call();
  await flushLiveShadowEvidence();
  const after = await streamRows(store, featureId);
  return {
    result,
    delta: {
      main: typeCounts(after.main.slice(before.main.length)),
      sidecar: typeCounts(after.sidecar.slice(before.sidecar.length)),
    },
  };
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

/** Makes the `setState` of the backend throw a version conflict on the first `failures` calls. Each later call runs the original method. */
function failSetState(store: ShadowStore, failures: number): void {
  const original = store.backend.setState.bind(store.backend);
  let calls = 0;
  replaceMethod(store.backend, 'setState', (featureId: string, state: Parameters<SqliteBackend['setState']>[1], expectedVersion?: number): void => {
    calls += 1;
    if (calls <= failures) throw new BackendVersionConflictError(featureId, expectedVersion ?? 0, (expectedVersion ?? 0) + 1);
    original(featureId, state, expectedVersion);
  });
}

/** Returns the one warning of a result, and fails when the result holds another count. */
function oneWarningOf(result: ToolResult): string {
  expect(result.warnings).toHaveLength(1);
  const [warning] = result.warnings ?? [];
  if (warning === undefined) throw new Error('the result holds no warning');
  return warning;
}

describe('the guard-input shadow on the transition path', () => {
  /** A plan artifact in the document only warns and writes one line, and the fold of the rows fails the guard. */
  it('HandleSet_ADocumentOnlyPlanArtifact_WarnsWritesOneLineAndFailsTheGuard', async () => {
    const store = await openStore();
    await seedDocumentOnlyPlan(store);
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await readStateFile(stateFileOf(store, FEATURE_ID))).phase).toBe('plan');
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
    const line = await oneLineOf(store);
    expect(line).toMatchObject({ v: 1, featureId: FEATURE_ID, workflowType: 'feature', call: 'transition', from: 'plan', to: 'plan-review' });
    expect(differenceKeysOf(line)).toContain('artifacts.plan');
    expect(line.guards).toContainEqual({ guardId: 'plan-artifact-exists', to: 'plan-review', document: 'pass', fold: 'fail' });
  });

  /** A plan artifact in the rows only passes the guard on the fold, so the call transitions, and the result carries the warning. */
  it('HandleSet_ARowOnlyPlanArtifact_TransitionsWithTheWarning', async () => {
    const store = await openStore();
    await seedRowOnlyPlan(store);

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    const line = await oneLineOf(store);
    expect(line.guards).toContainEqual({ guardId: 'plan-artifact-exists', to: 'plan-review', document: 'fail', fold: 'pass' });
  });

  /** An honest workflow compares and agrees, so it gives no warning and no diagnostics directory. */
  it('HandleSet_AnHonestWorkflow_GivesNoWarningAndNoDirectory', async () => {
    const store = await openStore();
    await seedHonestPlan(store);
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    expect(result.warnings).toBeUndefined();
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 0, failed: 0 });
    expect(existsSync(diagnosticsDirOf(store))).toBe(false);
  });

  /** The fold side gets the handler options of the call, so an honest transition with the options of the composite agrees. */
  it('HandleSet_AnHonestTransitionWithHandlerOptions_GivesNoWarning', async () => {
    const store = await openStore();
    await seedHonestPlan(store);
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore, COMPOSITE_OPTIONS);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    expect(result.warnings).toBeUndefined();
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 0, failed: 0 });
    expect(existsSync(diagnosticsDirOf(store))).toBe(false);
  });

  /** A disagreeing call adds the same rows to each stream as its agreeing twin. The twin adds the rows of this literal list. */
  it('HandleSet_ADisagreeingCall_AddsTheRowsOfItsAgreeingTwin', async () => {
    const store = await openStore();
    await seedHonestPlan(store, 'guard-shadow-agreeing');
    await seedRowOnlyPlan(store, 'guard-shadow-disagreeing');

    const agreeing = await rowDelta(store, 'guard-shadow-agreeing', () =>
      handleSet({ featureId: 'guard-shadow-agreeing', phase: 'plan-review' }, store.stateDir, store.eventStore),
    );
    const disagreeing = await rowDelta(store, 'guard-shadow-disagreeing', () =>
      handleSet({ featureId: 'guard-shadow-disagreeing', phase: 'plan-review' }, store.stateDir, store.eventStore),
    );

    expect(agreeing.result.warnings).toBeUndefined();
    expect(oneWarningOf(disagreeing.result).startsWith(DISAGREEMENT)).toBe(true);
    expect(disagreeing.delta).toEqual(agreeing.delta);
    expect(agreeing.delta).toEqual({
      main: { 'phase.entered': 1, 'phase.exited': 1, 'workflow.transition': 1 },
      sidecar: { 'admission.shadow-attempt': 1 },
    });
  });

  /** A transition row with no document write puts the ledger phase ahead of the document, and the line holds the class `phase`. */
  it('HandleSet_ALedgerPhaseAheadOfTheDocument_RecordsThePhaseClass', async () => {
    const store = await openStore();
    await seedHonestPlan(store);
    await store.eventStore.append(FEATURE_ID, {
      type: 'workflow.transition',
      data: { from: 'plan', to: 'plan-review', trigger: 'test', featureId: FEATURE_ID },
    });

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    const line = await oneLineOf(store);
    expect(line.classes).toEqual(['phase']);
    expect(line.phase).toEqual({ document: 'plan', fold: 'plan-review' });
  });

  /** A call that skips `plan-review` lists the guards of the skipped machine: `plan` gets the guards of `plan-review`. */
  it('HandleSet_ASkippedPhase_ListsTheGuardsOfTheSkippedMachine', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    await update(store, FEATURE_ID, { planReview: { approved: true } });
    await forgePlanArtifact(store, FEATURE_ID);

    const result = await handleSet(
      { featureId: FEATURE_ID, phase: 'delegate' },
      store.stateDir,
      store.eventStore,
      { skipPhases: ['plan-review'] },
    );

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('delegate');
    const guards = guardsOf(await oneLineOf(store));
    expect(guards).toContainEqual({ guardId: 'plan-review-complete', to: 'delegate' });
    expect(guards.map((guard) => guard.guardId)).not.toContain('plan-artifact-exists');
  });

  /** One CAS retry records only the last pass. The first pass appended the transition rows, so the fold leads the document. */
  it('HandleSet_OneCasRetry_RecordsOnlyTheLastPass', async () => {
    const store = await openStore();
    await seedHonestPlan(store);
    failSetState(store, 1);
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
    const line = await oneLineOf(store);
    expect(line.pass).toBe(1);
    expect(line.classes).toEqual(['phase']);
  });

  /** After the last CAS retry, the handler records the run of the last pass and then rethrows. */
  it('HandleSet_TheCasRethrow_RecordsTheRunBeforeTheThrow', async () => {
    const store = await openStore();
    await seedHonestPlan(store);
    failSetState(store, Number.POSITIVE_INFINITY);
    const before = guardInputShadowCounts();

    await expect(handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore)).rejects.toBeInstanceOf(
      VersionConflictError,
    );

    expect(countsSince(before).compared).toBe(1);
    const line = await oneLineOf(store);
    expect(line.pass).toBe(3);
    expect(line.classes).toEqual(['phase']);
  });

  /**
   * Each row skips the comparison by one check. Each seed holds a plan artifact on one side only, which warns when the check is absent.
   * The rows off the ledger, with no start row and with no store keep the legacy guard on the document, with one fallback warning.
   */
  it.each(
    [
      {
        name: 'updates',
        seed: (store: ShadowStore) => seedRowOnlyPlan(store),
        call: (store: ShadowStore) =>
          handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.design': 'plans/design.md' } }, store.stateDir, store.eventStore),
        phase: 'plan-review',
        fallback: false,
      },
      {
        name: 'a self-transition',
        seed: (store: ShadowStore) => seedDocumentOnlyPlan(store),
        call: (store: ShadowStore) => handleSet({ featureId: FEATURE_ID, phase: 'plan' }, store.stateDir, store.eventStore),
        phase: 'plan',
        fallback: false,
      },
      {
        name: 'off the ledger',
        seed: async (store: ShadowStore) => {
          await seedDocumentOnlyPlan(store);
          await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, _esVersion: 1 }));
        },
        call: (store: ShadowStore) => handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore),
        phase: 'plan-review',
        fallback: true,
      },
      {
        name: 'no start row',
        seed: async (store: ShadowStore) => {
          await init(store, FEATURE_ID, 'feature', false);
          await forgePlanArtifact(store, FEATURE_ID);
          expect(await store.eventStore.query(FEATURE_ID)).toEqual([]);
        },
        call: (store: ShadowStore) => handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore),
        phase: 'plan-review',
        fallback: true,
      },
      {
        name: 'no store',
        seed: async (store: ShadowStore) => {
          await seedDocumentOnlyPlan(store);
          expect((await store.eventStore.query(FEATURE_ID)).map((row) => row.type)).toContain('workflow.started');
        },
        call: (store: ShadowStore) => handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, null),
        phase: 'plan-review',
        fallback: true,
      },
    ].map((row): [string, typeof row] => [row.name, row]),
  )('HandleSet_%s_GetsNoComparison', async (_name, { seed, call, phase, fallback }) => {
    const store = await openStore();
    await seed(store);
    const before = guardInputShadowCounts();

    const result = await call(store);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe(phase);
    if (fallback) expect(oneWarningOf(result).startsWith(DOCUMENT_FALLBACK)).toBe(true);
    else expect(result.warnings).toBeUndefined();
    expect(existsSync(diagnosticsDirOf(store))).toBe(false);
    expect(countsSince(before)).toEqual({ compared: 0, disagreeing: 0, failed: 0 });
  });

  /** A custom type has a start row and the document-only plan artifact, and only the type rule of the comparator skips the run. */
  it('HandleSet_ACustomType_GetsNoComparison', async () => {
    registerWorkflowType(CUSTOM_TYPE, {
      phases: ['plan', 'plan-review'],
      initialPhase: 'plan',
      transitions: [{ from: 'plan', to: 'plan-review', event: 'review' }],
    });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => {
      unextendWorkflowTypeEnum(CUSTOM_TYPE);
      unregisterWorkflowType(CUSTOM_TYPE);
    });
    const store = await openStore();
    const initResult = await handleInit({ featureId: FEATURE_ID, workflowType: CUSTOM_TYPE }, store.stateDir, store.eventStore);
    expect(initResult.success).toBe(true);
    expect((await store.eventStore.query(FEATURE_ID)).map((row) => row.type)).toContain('workflow.started');
    await forgePlanArtifact(store, FEATURE_ID);
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(countsSince(before)).toEqual({ compared: 0, disagreeing: 0, failed: 0 });
  });

  /** Each failure exit of a pass records its run, so each failure carries the warning. */
  it.each(
    [
      {
        name: 'no edge',
        target: 'review',
        code: 'INVALID_TRANSITION',
        prepare: (_store: ShadowStore): Promise<void> => Promise.resolve(),
      },
      {
        name: 'append failure',
        target: 'plan-review',
        code: 'EVENT_APPEND_FAILED',
        prepare: (store: ShadowStore): Promise<void> => {
          replaceMethod(store.eventStore, 'appendValidated', () => Promise.reject(new Error('the test refuses each append')));
          return Promise.resolve();
        },
      },
      {
        name: 'write refusal',
        target: 'plan-review',
        code: 'INVALID_INPUT',
        prepare: async (store: ShadowStore): Promise<void> => {
          await appendPatchRow(store, FEATURE_ID, 'artifacts.plan', PLAN_ARTIFACT);
          const document = await readStateFile(stateFileOf(store, FEATURE_ID));
          store.backend.setState(FEATURE_ID, { ...document, tasks: [{ id: 't1', status: 'pending' }] });
        },
      },
    ].map((row): [string, typeof row] => [row.name, row]),
  )('HandleSet_%s_CarriesTheWarningOnItsExit', async (_name, { target, code, prepare }) => {
    const store = await openStore();
    await seedDocumentOnlyPlan(store);
    await prepare(store);
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: target }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(code);
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    await oneLineOf(store);
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
  });

  /** A fold that throws refuses the call, as no guard decides. The warning and the line hold the first 120 characters of the error message. */
  it('HandleSet_AFoldThatThrows_RefusesTheCallAndWritesAShadowFailedLine', async () => {
    const key = `artifacts[0].${'x'.repeat(200)}`;
    let expectedMessage = '';
    try {
      applyDotPath({ artifacts: {} }, key, 1);
    } catch (err) {
      expectedMessage = err instanceof Error ? err.message : String(err);
    }
    expect(expectedMessage).toHaveLength(262);
    expect(expectedMessage.startsWith('INVALID_INPUT: ')).toBe(true);
    const store = await openStore();
    await seedHonestPlan(store);
    await appendPatchRow(store, FEATURE_ID, key, 1);
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROJECTION_REPLAY_FAILED');
    expect((await readStateFile(stateFileOf(store, FEATURE_ID))).phase).toBe('plan');
    expect(oneWarningOf(result)).toBe(`${SHADOW_FAILED}${expectedMessage.slice(0, 120)}. The state document decided.`);
    expect(countsSince(before)).toEqual({ compared: 0, disagreeing: 0, failed: 1 });
    const line = await oneLineOf(store);
    expect(line.error).toBe(expectedMessage.slice(0, 120));
    expect(line.truncated).toBe(true);
  });

  /** A regular file at the path of the diagnostics directory fails the write, and the call keeps its transition and its warning. */
  it('HandleSet_AFailedFileWrite_KeepsTheTransitionAndTheWarning', async () => {
    const store = await openStore();
    await seedRowOnlyPlan(store);
    const blocker = 'a regular file where the directory goes\n';
    await writeFile(diagnosticsDirOf(store), blocker, 'utf8');
    const before = guardInputShadowCounts();

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
    expect(countsSince(before)).toEqual({ compared: 1, disagreeing: 1, failed: 0 });
    expect(await readFile(diagnosticsDirOf(store), 'utf8')).toBe(blocker);
  });

  /** A failed file write leaves no line, so the warning of the call names no diagnostics file. */
  it('HandleSet_AFailedFileWrite_WarnsWithNoDiagnosticsPath', async () => {
    const store = await openStore();
    await seedRowOnlyPlan(store);
    await writeFile(diagnosticsDirOf(store), 'a regular file where the directory goes\n', 'utf8');

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    const warning = oneWarningOf(result);
    expect(warning.startsWith(DISAGREEMENT)).toBe(true);
    expect(warning).not.toContain(`${DIAGNOSTICS_DIRNAME}/`);
  });

  /** A line that takes the file past 1 MiB becomes one capped line. A file that ends with a capped line gets no more lines. */
  it('HandleSet_AtTheFileCap_WritesOneCappedLineAndThenNothing', async () => {
    const store = await openStore();
    await seedRowOnlyPlan(store);
    await mkdir(diagnosticsDirOf(store), { recursive: true });
    const filler = `${'f'.repeat(FILE_MAX_BYTES - 101)}\n`;
    await writeFile(diagnosticsFileOf(store), filler, 'utf8');

    const first = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);
    const afterFirst = await readFile(diagnosticsFileOf(store), 'utf8');
    const second = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(first.success).toBe(true);
    expect(oneWarningOf(first).startsWith(DISAGREEMENT)).toBe(true);
    expect(afterFirst.startsWith(filler)).toBe(true);
    const capped: unknown = JSON.parse(afterFirst.slice(filler.length));
    expect(capped).toMatchObject({ v: 1, featureId: FEATURE_ID, capped: true });
    expect(second.error?.code).toBe('INVALID_TRANSITION');
    expect(oneWarningOf(second).startsWith(DISAGREEMENT)).toBe(true);
    expect(await readFile(diagnosticsFileOf(store), 'utf8')).toBe(afterFirst);
  });

  /** A line holds the highest folded sequence, the sequence and the version of the document, its pass and a numeric fold time. */
  it('HandleSet_EachLine_HoldsItsReadPointsAndItsPass', async () => {
    const store = await openStore();
    await seedDocumentOnlyPlan(store);
    const rows = await store.eventStore.query(FEATURE_ID);
    const document = await readStateFile(stateFileOf(store, FEATURE_ID));

    await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    const line = await oneLineOf(store);
    expect(line.ledgerSequence).toBe(Math.max(...rows.map((row) => row.sequence)));
    expect(line.documentSequence).toBe(document._eventSequence);
    expect(line.documentVersion).toBe(document._version);
    expect(line.pass).toBe(0);
    expect(typeof line.foldMs).toBe('number');
    expect(typeof line.at).toBe('string');
  });

  /** A warning over 300 characters keeps its first 297 characters and `...`, so it keeps the whole details path. */
  it('HandleSet_AWarning_HoldsAtMost300Characters', async () => {
    const featureId = `guard-shadow-${'w'.repeat(70)}`;
    expect(featureId).toHaveLength(83);
    const store = await openStore();
    await seedDocumentOnlyPlan(store, featureId);
    const raw =
      'GUARD_INPUT_DISAGREEMENT: the ledger fold and the state document disagree on 2 guard inputs at plan -> plan-review. ' +
      `The state document decided. Details: guard-input-diagnostics/${featureId}.jsonl. Keys: artifacts.plan, artifacts.planNonEmpty.`;
    expect(raw.length).toBeGreaterThan(300);
    expect(raw).toHaveLength(313);

    const result = await handleSet({ featureId, phase: 'plan-review' }, store.stateDir, store.eventStore);

    const warning = oneWarningOf(result);
    expect(warning).toBe(`${raw.slice(0, 297)}...`);
    expect(warning).toHaveLength(300);
    expect(warning).toContain(`guard-input-diagnostics/${featureId}.jsonl`);
  });

  /** Forty tasks complete in the rows and pending in the document give 41 differences. The warning counts 41, and the line keeps 32. */
  it('HandleSet_MoreThan32Differences_KeepsEachListAt32', async () => {
    const store = await openStore();
    const ids = Array.from({ length: 40 }, (_, index) => `t${String(index + 1).padStart(2, '0')}`);
    await seedHonestPlan(store);
    await transition(store, FEATURE_ID, 'plan-review');
    await update(store, FEATURE_ID, { planReview: { approved: true } });
    await transition(store, FEATURE_ID, 'delegate');
    await update(store, FEATURE_ID, { tasks: ids.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) });
    for (const id of ids) {
      await store.eventStore.append(FEATURE_ID, { type: 'task.completed', data: { taskId: id } });
    }

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(phaseOf(result)).toBe('review');
    expect(oneWarningOf(result)).toContain('disagree on 41 guard inputs');
    const line = await oneLineOf(store);
    expect(differenceKeysOf(line)).toHaveLength(32);
    expect(differenceKeysOf(line)[0]).toBe('tasks.allComplete');
    expect(line.truncated).toBe(true);
  });

  /** A plan path of 9000 characters makes a line over 8 KiB, so the line empties its lists and keeps its classes. */
  it('HandleSet_ALineOver8KiB_EmptiesItsLists', async () => {
    const store = await openStore();
    await seedRowOnlyPlan(store, FEATURE_ID, `plans/${'p'.repeat(8991)}.md`);

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    const text = await readFile(diagnosticsFileOf(store), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    const line = await oneLineOf(store);
    expect(line.differences).toEqual([]);
    expect(line.guards).toEqual([]);
    expect(line.classes).toEqual(['unexplained']);
    expect(line.truncated).toBe(true);
  });

  /** The enriched guard failure of `transition` keeps the warning of the set result. */
  it('HandleTransition_AGuardFailure_KeepsTheWarningInTheEnrichedError', async () => {
    const store = await openStore();
    await seedDocumentOnlyPlan(store);

    const result = await handleTransition({ featureId: FEATURE_ID, target: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.validTargets).toBeDefined();
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
  });

  /** `finalize_oneshot` builds its own success result, and that result keeps the warning of its transition. */
  it('FinalizeOneshot_ADisagreeingTransition_KeepsTheWarningOnItsResult', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'oneshot');
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT });
    await transition(store, FEATURE_ID, 'implementing');
    await forgeDocument(store, FEATURE_ID, (document) => ({
      ...document,
      artifacts: { ...artifactsOf(document), pr: 'https://example.com/pr/1' },
    }));

    const result = await handleFinalizeOneshot({ featureId: FEATURE_ID, stateDir: store.stateDir, eventStore: store.eventStore });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ newPhase: 'completed' });
    expect(oneWarningOf(result).startsWith(DISAGREEMENT)).toBe(true);
  });
});
