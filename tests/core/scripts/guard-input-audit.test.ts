/**
 * These tests check the read-only audit of the guard input over a store.
 * Each case seeds a SQLite store with the real handlers, so each document is a `workflow_state` row, as in production.
 * A case forges a document through `setState`, or it appends one row with no document write.
 * The command-line cases pass a temporary home, so no case opens or writes a live store.
 *
 * @oracle-sources: ../../../tools/audit/core/guard-input-audit.ts, the seeded stores and expected counts written in this file
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { flushLiveShadowEvidence } from '../../../src/workflow/admission/live-shadow-observer.js';
import { handleCleanup } from '../../../src/workflow/cleanup.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../../../src/workflow/schemas.js';
import { registerWorkflowType, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { configureStateStoreBackend } from '../../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../../src/workflow/tools.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import {
  auditGuardInputs,
  runGuardInputAudit,
  type GuardAuditOutcome,
  type GuardAuditReader,
  type GuardAuditReport,
} from '../../../tools/audit/core/guard-input-audit.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface SeedStore {
  readonly stateDir: string;
  readonly backend: SqliteBackend;
  readonly eventStore: EventStore;
}

/** The kinds of a document that the audit does not compare, other than a custom type and an unknown phase. */
type DocumentKind = 'notOnLedger' | 'noRows' | 'noStartRow' | 'foldError';

/** The custom workflow type of the seeded store. */
const CUSTOM_TYPE = 'guard-audit-custom';

/** The plan artifact of each feature seed. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** The pull request of each terminal seed. */
const PR_URL = 'https://example.com/pr/1';

/** The merged branch of the cleanup backfill. */
const MERGED_BRANCH = 'feat/guard-audit';

/** The name of the store file in a state directory. */
const STORE_FILE = 'exarchos.db';

/** The patch key of the row that makes the fold throw. The patch indexes into the artifacts object. */
const FOLD_ERROR_KEY = 'artifacts[0].x';

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
});

/** Makes a temporary directory that the teardown removes. */
function tempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  releases.push(() => rmrfAsync(dir));
  return dir;
}

/** Opens a store on a new temporary directory and makes it the backend of the state store. */
async function openStore(): Promise<SeedStore> {
  const stateDir = tempDir('guard-audit-');
  const backend = new SqliteBackend(path.join(stateDir, STORE_FILE));
  backend.initialize();
  releases.push(() => backend.close());
  const eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
  releases.push(() => eventStore.close());
  configureStateStoreBackend(backend);
  return { stateDir, backend, eventStore };
}

/** Closes a store, so its file holds each row and another backend can open a copy. */
async function closeStore(store: SeedStore): Promise<void> {
  await flushLiveShadowEvidence();
  store.eventStore.close();
  store.backend.close();
  configureStateStoreBackend(undefined);
}

/** Throws when a seed call does not succeed. */
function requireSuccess(step: string, result: ToolResult): void {
  if (result.success) return;
  throw new Error(`the seed step '${step}' failed with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`);
}

/** Starts a workflow, so the stream holds a start row. */
async function init(store: SeedStore, featureId: string, workflowType = 'feature'): Promise<void> {
  requireSuccess(`init ${featureId}`, await handleInit({ featureId, workflowType }, store.stateDir, store.eventStore));
}

/** Updates fields through the handler, so the stream gets a `state.patched` row and the document gets the fields. */
async function update(store: SeedStore, featureId: string, updates: Record<string, unknown>): Promise<void> {
  requireSuccess(`update ${featureId}`, await handleSet({ featureId, updates }, store.stateDir, store.eventStore));
}

/** Transitions through the handler and requires success. */
async function transition(store: SeedStore, featureId: string, phase: string): Promise<void> {
  requireSuccess(`transition ${featureId} ${phase}`, await handleSet({ featureId, phase }, store.stateDir, store.eventStore));
}

/** Starts a feature and moves it to the active phase `delegate` through the handlers. */
async function seedActive(store: SeedStore, featureId: string): Promise<void> {
  await init(store, featureId);
  await update(store, featureId, { 'artifacts.plan': PLAN_ARTIFACT });
  await transition(store, featureId, 'plan-review');
  await update(store, featureId, { planReview: { approved: true } });
  await transition(store, featureId, 'delegate');
}

/** Starts a feature with an approved review and a pull request, and completes it through cleanup. `completed` is a final phase. */
async function seedTerminal(store: SeedStore, featureId: string): Promise<void> {
  await init(store, featureId);
  await update(store, featureId, { 'synthesis.prUrl': PR_URL, 'reviews.review': { status: 'approved' } });
  requireSuccess(
    `cleanup ${featureId}`,
    await handleCleanup(
      { featureId, mergeVerified: true, prUrl: PR_URL, mergedBranches: [MERGED_BRANCH] },
      store.stateDir,
      store.eventStore,
    ),
  );
}

/** Seeds a document at the active or the terminal phase of a kind seed. */
function seedAt(store: SeedStore, featureId: string, standing: 'active' | 'terminal'): Promise<void> {
  return standing === 'active' ? seedActive(store, featureId) : seedTerminal(store, featureId);
}

/** Returns the document of a feature, and fails when the store holds none. */
function documentOf(store: SeedStore, featureId: string): WorkflowState {
  const document = store.backend.getState(featureId);
  if (document === null) throw new Error(`the store holds no document for ${featureId}`);
  return document;
}

/** Changes the document of a feature through `setState` only, with no row. */
function forge(store: SeedStore, featureId: string, change: (document: WorkflowState) => WorkflowState): void {
  store.backend.setState(featureId, change(documentOf(store, featureId)));
}

/** Writes a copy of the document of `sourceId` at `phase` as the document of `featureId`, with no row. */
function copyDocument(store: SeedStore, sourceId: string, featureId: string, phase: string): void {
  store.backend.setState(featureId, { ...documentOf(store, sourceId), featureId, phase });
}

/** Appends one row with no document write. */
async function appendRow(store: SeedStore, streamId: string, type: string, data: Record<string, unknown>): Promise<void> {
  await store.eventStore.append(streamId, { type, data });
}

/** Appends the row that makes the fold throw. The patch indexes into an object, so the projection rethrows `INVALID_INPUT`. */
function appendFoldErrorRow(store: SeedStore, streamId: string): Promise<void> {
  return appendRow(store, streamId, 'state.patched', {
    featureId: streamId,
    fields: [FOLD_ERROR_KEY],
    patch: { [FOLD_ERROR_KEY]: 1 },
  });
}

/** Returns a task list entry. */
function task(id: string, status: string): Record<string, unknown> {
  return { id, title: id, status };
}

/** Sets the status of the named tasks to `complete` in the document only. */
function forgeComplete(store: SeedStore, featureId: string, ids: readonly string[]): void {
  forge(store, featureId, (document) => ({
    ...document,
    tasks: document.tasks.map((entry) => (ids.includes(entry.id) ? { ...entry, status: 'complete' } : entry)),
  }));
}

/** Seeds an active document with pending tasks on the ledger, and then forges the named tasks `complete` in the document only. */
async function seedForgedTasks(store: SeedStore, featureId: string, ids: readonly string[], forged: readonly string[]): Promise<void> {
  await seedActive(store, featureId);
  await update(store, featureId, { tasks: ids.map((id) => task(id, 'pending')) });
  forgeComplete(store, featureId, forged);
}

/**
 * Seeds one document of a kind at `delegate` for the active standing and at `completed` for the terminal standing.
 * A document with no stream or with no start row is a copy of the active document `sourceId` at that phase.
 */
async function seedKind(
  store: SeedStore,
  kind: DocumentKind,
  featureId: string,
  standing: 'active' | 'terminal',
  sourceId: string,
): Promise<void> {
  const phase = standing === 'active' ? 'delegate' : 'completed';
  switch (kind) {
    case 'notOnLedger':
      await seedAt(store, featureId, standing);
      forge(store, featureId, (document) => ({ ...document, _esVersion: 1 }));
      return;
    case 'noRows':
      copyDocument(store, sourceId, featureId, phase);
      return;
    case 'noStartRow':
      copyDocument(store, sourceId, featureId, phase);
      await appendRow(store, featureId, 'state.patched', { featureId, fields: ['notes'], patch: { notes: 'x' } });
      return;
    case 'foldError':
      await seedAt(store, featureId, standing);
      await appendFoldErrorRow(store, featureId);
      return;
  }
}

/** Registers the custom type for one case. The teardown removes it. */
function registerCustomType(): void {
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
}

/** Returns the types of the rows of a stream. */
async function rowTypesOf(store: SeedStore, streamId: string): Promise<readonly string[]> {
  return (await store.eventStore.query(streamId)).map((row) => row.type);
}

/** Returns a reader that wraps the backend and throws from `queryEvents` for one stream. */
function readerThatThrowsFor(backend: SqliteBackend, streamId: string): GuardAuditReader {
  return {
    listStates: () => backend.listStates(),
    listStreams: () => backend.listStreams(),
    queryEvents: (id) => {
      if (id === streamId) throw new Error(`the read of ${id} fails`);
      return backend.queryEvents(id);
    },
  };
}

/** Returns the report of a run that completed, and fails on a refusal. */
function reportOf(outcome: GuardAuditOutcome): GuardAuditReport {
  if (outcome.exitCode !== 0) throw new Error(`the audit refused with ${outcome.code}: ${outcome.message}`);
  return outcome.report;
}

/** Returns the refusal code of a run, or `undefined` for a run that completed. */
function codeOf(outcome: GuardAuditOutcome): string | undefined {
  return outcome.exitCode === 2 ? outcome.code : undefined;
}

/** Returns the refusal message of a run, or `undefined` for a run that completed. */
function messageOfRefusal(outcome: GuardAuditOutcome): string | undefined {
  return outcome.exitCode === 2 ? outcome.message : undefined;
}

/** Returns the sha256 of a file. */
function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Seeds one agreeing active document, closes the store and returns the path of its store file. */
async function seededStoreFile(): Promise<string> {
  const store = await openStore();
  await seedActive(store, 'copy-active');
  await closeStore(store);
  return path.join(store.stateDir, STORE_FILE);
}

/** Copies a store file into the directory, which the function makes, and returns that directory. */
function copyStoreInto(storeFile: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  copyFileSync(storeFile, path.join(dir, STORE_FILE));
  return dir;
}

/** The temporary directory and the temporary home of a live-store case. */
interface LiveDirs {
  readonly tmp: string;
  readonly home: string;
}

/** The text of the refusal of a live state directory. */
const DIRECTORY_RULE = 'is the live state directory';

/** The text of the refusal of a store file that is a link to the store file of a live state directory. */
const FILE_RULE = 'is the store file of the live state directory';

/** Makes a symlink to the live directory under the temporary directory, and returns the symlink. */
function symlinkedDirectory(dirs: LiveDirs, liveDir: string): string {
  const link = path.join(dirs.tmp, 'linked-dir');
  symlinkSync(liveDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

/** Makes a directory under the temporary directory whose store file is a symlink to the live store file, and returns the directory. */
function symlinkedDatabaseFile(dirs: LiveDirs, liveDir: string): string {
  const dir = path.join(dirs.tmp, 'linked-file');
  mkdirSync(dir, { recursive: true });
  symlinkSync(path.join(liveDir, STORE_FILE), path.join(dir, STORE_FILE), 'file');
  return dir;
}

/** Makes a directory under the temporary directory whose store file is a hard link to the live store file, and returns the directory. */
function hardLinkedDatabaseFile(dirs: LiveDirs, liveDir: string): string {
  const dir = path.join(dirs.tmp, 'hard-linked-file');
  mkdirSync(dir, { recursive: true });
  linkSync(path.join(liveDir, STORE_FILE), path.join(dir, STORE_FILE));
  return dir;
}

describe('the read-only audit of the guard input', () => {
  /** The seeded store holds each standing of an agreeing and a disagreeing document, an off-ledger document and a custom type. */
  it('AuditGuardInputs_ASeededStore_GivesTheExactCountOfEachClass', async () => {
    registerCustomType();
    const store = await openStore();
    await seedActive(store, 'agree-active');
    await seedForgedTasks(store, 'disagree-active', ['t1', 't2', 't3'], ['t1', 't2']);
    await seedTerminal(store, 'agree-terminal');
    await seedTerminal(store, 'disagree-terminal');
    forge(store, 'disagree-terminal', (document) => ({ ...document, tasks: [{ id: 't9', title: 't9', status: 'complete', blockedBy: [] }] }));
    await seedActive(store, 'off-ledger');
    forge(store, 'off-ledger', (document) => ({ ...document, _esVersion: 1 }));
    const customResult = await handleInit({ featureId: 'custom', workflowType: CUSTOM_TYPE }, store.stateDir, store.eventStore);
    expect(customResult.success).toBe(true);
    expect(await rowTypesOf(store, 'custom')).toContain('workflow.started');
    await flushLiveShadowEvidence();

    const report = await auditGuardInputs(store.backend);

    expect(report.customType).toBe(1);
    expect(report.notOnLedger).toEqual({ active: 1, terminal: 0 });
    expect(report.compared).toEqual({ active: 2, terminal: 2 });
    expect(report.agreeing).toEqual({ active: 1, terminal: 1 });
    expect(report.disagreeing).toEqual({ active: 1, terminal: 1 });
    expect(report.byClass['task-status']).toEqual({ active: 1, terminal: 0 });
    expect(report.byClass['task-list']).toEqual({ active: 0, terminal: 1 });
    expect(report.byKey['tasks[*].complete']).toEqual({ active: 1, terminal: 1 });
    expect(report.activeDisagreements.map((entry) => entry.featureId)).toEqual(['disagree-active']);
    expect(report.clean).toBe(false);
  });

  /** A read error of one stream is a fold error of that document only, and the audit goes on. */
  it('AuditGuardInputs_AStreamWhoseReadThrows_IsAFoldErrorOfItsStream', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    await seedTerminal(store, 'agree-terminal');
    await seedActive(store, 'read-throws');

    const audit = auditGuardInputs(readerThatThrowsFor(store.backend, 'read-throws'));

    await expect(audit).resolves.toBeDefined();
    const report = await audit;
    expect(report.foldError).toEqual({ active: 1, terminal: 0 });
    expect(report.compared).toEqual({ active: 1, terminal: 1 });
    expect(report.agreeing).toEqual({ active: 1, terminal: 1 });
    expect(report.blockers).toEqual([{ featureId: 'read-throws', kind: 'foldError' }]);
    expect(report.clean).toBe(false);
  });

  /** A listing that throws refuses the whole audit as unreadable. */
  it('AuditGuardInputs_AListingThatThrows_IsRefusedAsUnreadable', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    const reader: GuardAuditReader = {
      listStates: () => {
        throw new Error('a state row does not parse');
      },
      listStreams: () => store.backend.listStreams(),
      queryEvents: (id) => store.backend.queryEvents(id),
    };

    await expect(auditGuardInputs(reader)).rejects.toMatchObject({ code: 'GUARD_AUDIT_UNREADABLE' });
  });

  /** A stream listing that throws refuses the whole audit as unreadable, as a state listing does. */
  it('AuditGuardInputs_AStreamListingThatThrows_IsRefusedAsUnreadable', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    const reader: GuardAuditReader = {
      listStates: () => store.backend.listStates(),
      listStreams: () => {
        throw new Error('the stream listing fails');
      },
      queryEvents: (id) => store.backend.queryEvents(id),
    };

    await expect(auditGuardInputs(reader)).rejects.toMatchObject({ code: 'GUARD_AUDIT_UNREADABLE' });
  });

  /** A document whose `_esVersion` is not 2 counts as `notOnLedger`, and the audit does not compare it. */
  it('AuditGuardInputs_ADocumentOffTheLedger_CountsAsNotOnLedger', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    await seedActive(store, 'off-ledger');
    forge(store, 'off-ledger', (document) => ({ ...document, _esVersion: 1 }));

    const report = await auditGuardInputs(store.backend);

    expect(report.notOnLedger).toEqual({ active: 1, terminal: 0 });
    expect(report.compared).toEqual({ active: 1, terminal: 0 });
    expect(report.blockers).toEqual([{ featureId: 'off-ledger', kind: 'notOnLedger' }]);
  });

  /** A store with only an infra stream compares no document, so it is not clean. */
  it('AuditGuardInputs_OnlyInfraStreams_IsNotClean', async () => {
    const store = await openStore();
    await appendRow(store, 'telemetry', 'tool.invoked', { tool: 'exarchos_view' });

    const report = await auditGuardInputs(store.backend);

    expect(report.nonWorkflowStreams).toBe(1);
    expect(report.compared).toEqual({ active: 0, terminal: 0 });
    expect(report.clean).toBe(false);
  });

  /** An active disagreement blocks `clean`. A terminal disagreement only reports. */
  it('AuditGuardInputs_AnActiveDisagreement_IsNotClean_AndATerminalOne_ReportsOnly', async () => {
    const active = await openStore();
    await seedActive(active, 'agree-active');
    await seedForgedTasks(active, 'disagree-active', ['t1'], ['t1']);
    const activeReport = await auditGuardInputs(active.backend);
    const document = documentOf(active, 'disagree-active');
    const rows = await active.eventStore.query('disagree-active');

    expect(activeReport.disagreeing).toEqual({ active: 1, terminal: 0 });
    expect(activeReport.activeDisagreements).toEqual([
      {
        featureId: 'disagree-active',
        classes: ['task-status'],
        keys: ['tasks.allComplete', 'tasks[t1].complete'],
        ledgerSequence: Math.max(...rows.map((row) => row.sequence)),
        documentSequence: document._eventSequence,
      },
    ]);
    expect(activeReport.clean).toBe(false);

    await closeStore(active);
    const terminal = await openStore();
    await seedActive(terminal, 'agree-active');
    await seedTerminal(terminal, 'disagree-terminal');
    forge(terminal, 'disagree-terminal', (entry) => ({ ...entry, tasks: [{ id: 't9', title: 't9', status: 'complete', blockedBy: [] }] }));
    const terminalReport = await auditGuardInputs(terminal.backend);

    expect(terminalReport.disagreeing).toEqual({ active: 0, terminal: 1 });
    expect(terminalReport.activeDisagreements).toEqual([]);
    expect(terminalReport.clean).toBe(true);
  });

  /** An active document of each kind blocks `clean`, and its terminal twin only reports. */
  it.each<DocumentKind>(['notOnLedger', 'noRows', 'noStartRow', 'foldError'])(
    'AuditGuardInputs_%s_AnActiveDocumentIsNotClean_AndItsTerminalTwinIs',
    async (kind) => {
      const active = await openStore();
      await seedActive(active, 'agree-active');
      await seedKind(active, kind, 'kind-doc', 'active', 'agree-active');
      const activeReport = await auditGuardInputs(active.backend);

      expect(activeReport.compared).toEqual({ active: 1, terminal: 0 });
      expect(activeReport[kind]).toEqual({ active: 1, terminal: 0 });
      expect(activeReport.blockers).toEqual([{ featureId: 'kind-doc', kind }]);
      expect(activeReport.clean).toBe(false);

      await closeStore(active);
      const terminal = await openStore();
      await seedActive(terminal, 'agree-active');
      await seedKind(terminal, kind, 'kind-doc', 'terminal', 'agree-active');
      const terminalReport = await auditGuardInputs(terminal.backend);

      expect(terminalReport.compared).toEqual({ active: 1, terminal: 0 });
      expect(terminalReport[kind]).toEqual({ active: 0, terminal: 1 });
      expect(terminalReport.blockers).toEqual([]);
      expect(terminalReport.clean).toBe(true);
    },
  );

  /** A feature document at `ideate` holds a phase that the feature machine does not hold, so it blocks `clean`. */
  it('AuditGuardInputs_AFeatureDocumentAtIdeate_IsUnknownPhaseAndNotClean', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    await init(store, 'at-ideate');
    forge(store, 'at-ideate', (document) => ({ ...document, phase: 'ideate' }));
    expect(documentOf(store, 'at-ideate').phase).toBe('ideate');

    const report = await auditGuardInputs(store.backend);

    expect(report.unknownPhase).toBe(1);
    expect(report.blockers).toEqual([{ featureId: 'at-ideate', kind: 'unknownPhase', phase: 'ideate' }]);
    expect(report.compared).toEqual({ active: 1, terminal: 0 });
    expect(report.clean).toBe(false);
  });

  /** One task of two forged `complete` in the document only gives `task-status`, while the summary facts agree. */
  it('AuditGuardInputs_OneForgedTaskWithEqualSummaries_IsTaskStatusAndNotClean', async () => {
    const store = await openStore();
    await seedForgedTasks(store, 'one-forged', ['t1', 't2'], ['t1']);

    const report = await auditGuardInputs(store.backend);

    expect(report.disagreeing).toEqual({ active: 1, terminal: 0 });
    expect(report.byClass).toEqual({ 'task-status': { active: 1, terminal: 0 } });
    expect(report.activeDisagreements.map((entry) => entry.keys)).toEqual([['tasks[t1].complete']]);
    expect(report.clean).toBe(false);
  });

  /** The audit reads only, so the event rows and the state rows of the store do not change. */
  it('AuditGuardInputs_TheCopy_KeepsItsEventAndStateRows', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    await seedForgedTasks(store, 'disagree-active', ['t1'], ['t1']);
    await seedTerminal(store, 'agree-terminal');
    await flushLiveShadowEvidence();
    const snapshot = (): unknown => ({
      states: store.backend.listStates(),
      rows: store.backend.listStreams().map((streamId) => store.backend.queryEvents(streamId)),
    });
    const before = snapshot();

    await auditGuardInputs(store.backend);

    expect(snapshot()).toEqual(before);
  });

  /** A fold error marks only its own document, and the audit compares each other document. */
  it('AuditGuardInputs_AFoldError_MarksOnlyItsStream', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    await seedTerminal(store, 'agree-terminal');
    await seedActive(store, 'fold-error');
    await appendFoldErrorRow(store, 'fold-error');

    const report = await auditGuardInputs(store.backend);

    expect(report.foldError).toEqual({ active: 1, terminal: 0 });
    expect(report.compared).toEqual({ active: 1, terminal: 1 });
    expect(report.agreeing).toEqual({ active: 1, terminal: 1 });
    expect(report.blockers).toEqual([{ featureId: 'fold-error', kind: 'foldError' }]);
  });

  /** A sidecar stream and an infra stream hold no start row, so they are no workflows. */
  it('AuditGuardInputs_ASidecarAndAnInfraStream_CountAsNonWorkflowStreams', async () => {
    const store = await openStore();
    await init(store, 'at-plan');
    await appendRow(store, 'at-plan/admission-shadow', 'tool.invoked', { tool: 'exarchos_workflow' });
    await appendRow(store, 'telemetry', 'tool.invoked', { tool: 'exarchos_view' });

    const report = await auditGuardInputs(store.backend);

    expect(report.nonWorkflowStreams).toBe(2);
    expect(report.streamWithoutDocument).toEqual({ count: 0, foldError: 0 });
    expect(report.compared).toEqual({ active: 1, terminal: 0 });
  });

  /** A stream with a start row and no document reports its fold error, and the error does not block `clean`. */
  it('AuditGuardInputs_AStreamWithAStartRowAndNoDocument_IsAStreamWithoutDocument', async () => {
    const store = await openStore();
    await seedActive(store, 'agree-active');
    await appendRow(store, 'orphan', 'workflow.started', { featureId: 'orphan', workflowType: 'feature' });
    await appendFoldErrorRow(store, 'orphan');
    await flushLiveShadowEvidence();

    const report = await auditGuardInputs(store.backend);

    expect(report.streamWithoutDocument).toEqual({ count: 1, foldError: 1 });
    expect(report.foldError).toEqual({ active: 0, terminal: 0 });
    expect(report.clean).toBe(true);
  });

  /** A call with no `--store` and a directory with no store file refuse before any open, so no database appears. */
  it.each<[string, string, (dir: string) => string[]]>([
    ['NoStoreArgument', 'GUARD_AUDIT_USAGE', (dir) => ['--out', path.join(dir, 'report.json')]],
    ['ADirectoryWithNoStoreFile', 'GUARD_AUDIT_NO_STORE', (dir) => ['--store', dir]],
  ])('RunGuardInputAudit_%s_IsRefusedAndMakesNoDatabase', async (_name, code, argv) => {
    const dir = tempDir('guard-audit-refused-');
    const home = tempDir('guard-audit-home-');

    const outcome = await runGuardInputAudit(argv(dir), { homedir: home, env: {} });

    expect(outcome.exitCode).toBe(2);
    expect(codeOf(outcome)).toBe(code);
    expect(existsSync(path.join(dir, STORE_FILE))).toBe(false);
    expect(existsSync(path.join(dir, 'report.json'))).toBe(false);
  });

  /**
   * Each live state directory, and each link to its store file, refuses before the open.
   * So the live store file keeps its bytes, and no journal file appears beside it or beside the link.
   * A row gives the live directory, the store directory of the call, and the text of the rule that refuses it.
   * Each link lives under the temporary directories of the case and points at the copy in the temporary home.
   */
  it.each<[string, (dirs: LiveDirs) => string, (dirs: LiveDirs, liveDir: string) => string, string]>([
    ['TheStateDirOfTheInputs', (dirs) => path.join(dirs.tmp, 'live-env'), (_dirs, liveDir) => liveDir, DIRECTORY_RULE],
    ['TheClaudeHomePath', (dirs) => path.join(dirs.home, '.claude', 'workflow-state'), (_dirs, liveDir) => liveDir, DIRECTORY_RULE],
    ['TheExarchosHomePath', (dirs) => path.join(dirs.home, '.exarchos', 'state'), (_dirs, liveDir) => liveDir, DIRECTORY_RULE],
    ['ASymlinkedDirectory', (dirs) => path.join(dirs.home, '.claude', 'workflow-state'), symlinkedDirectory, DIRECTORY_RULE],
    ['ASymlinkedDatabaseFile', (dirs) => path.join(dirs.home, '.claude', 'workflow-state'), symlinkedDatabaseFile, FILE_RULE],
    ['AHardLinkedDatabaseFile', (dirs) => path.join(dirs.home, '.exarchos', 'state'), hardLinkedDatabaseFile, FILE_RULE],
  ])('RunGuardInputAudit_ALiveStore_%s_IsRefusedAndKeepsItsBytes', async (_name, live, storeOf, rule) => {
    const storeFile = await seededStoreFile();
    const tmp = tempDir('guard-audit-live-');
    const home = tempDir('guard-audit-home-');
    const liveDir = copyStoreInto(storeFile, live({ tmp, home }));
    const liveFile = path.join(liveDir, STORE_FILE);
    const bytesBefore = sha256Of(liveFile);
    const storeDir = storeOf({ tmp, home }, liveDir);

    const outcome = await runGuardInputAudit(['--store', storeDir], {
      homedir: home,
      env: { WORKFLOW_STATE_DIR: path.join(tmp, 'live-env') },
    });

    expect(codeOf(outcome)).toBe('GUARD_AUDIT_LIVE_STORE');
    expect(outcome.exitCode).toBe(2);
    expect(messageOfRefusal(outcome)).toContain(rule);
    expect(sha256Of(liveFile)).toBe(bytesBefore);
    for (const dir of [liveDir, storeDir]) {
      expect(existsSync(path.join(dir, `${STORE_FILE}-wal`))).toBe(false);
      expect(existsSync(path.join(dir, `${STORE_FILE}-shm`))).toBe(false);
    }
  });

  /** A store with no document and no stream gives no verdict, so the audit refuses it. */
  it('RunGuardInputAudit_AnEmptyStore_IsRefused', async () => {
    const dir = tempDir('guard-audit-empty-');
    const backend = new SqliteBackend(path.join(dir, STORE_FILE));
    backend.initialize();
    backend.close();

    const outcome = await runGuardInputAudit(['--store', dir], { homedir: tempDir('guard-audit-home-'), env: {} });

    expect(codeOf(outcome)).toBe('GUARD_AUDIT_EMPTY_STORE');
    expect(outcome.exitCode).toBe(2);
  });

  /** A store file that does not open refuses as unreadable. */
  it('RunGuardInputAudit_AnUnreadableStore_IsRefused', async () => {
    const dir = tempDir('guard-audit-unreadable-');
    writeFileSync(path.join(dir, STORE_FILE), 'this file is not a SQLite database, and no open can read it.\n'.repeat(64));

    const outcome = await runGuardInputAudit(['--store', dir], { homedir: tempDir('guard-audit-home-'), env: {} });

    expect(codeOf(outcome)).toBe('GUARD_AUDIT_UNREADABLE');
    expect(outcome.exitCode).toBe(2);
  });

  /** A seeded copy gives exit 0, and the report file holds the report of the run. */
  it('RunGuardInputAudit_ASeededCopy_ExitsZeroAndWritesTheReport', async () => {
    const storeFile = await seededStoreFile();
    const dir = copyStoreInto(storeFile, path.join(tempDir('guard-audit-copy-'), 'store'));
    const out = path.join(dir, 'audit.json');

    const outcome = await runGuardInputAudit(['--store', dir, '--out', out], { homedir: tempDir('guard-audit-home-'), env: {} });

    expect(outcome.exitCode).toBe(0);
    const report = reportOf(outcome);
    expect(report.compared).toEqual({ active: 1, terminal: 0 });
    expect(report.agreeing).toEqual({ active: 1, terminal: 0 });
    expect(report.clean).toBe(true);
    const written: unknown = JSON.parse(readFileSync(out, 'utf8'));
    expect(written).toEqual(report);
  });
});
