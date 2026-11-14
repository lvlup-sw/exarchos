/**
 * The registered actions preserve start epochs, prepared custody and append claims across stores.
 * @oracle-sources: Authored requests, expected bootstrap rows, and the phase and task facts in this file.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { deriveLocalOperatorIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { estimateOutputTokens } from '../../src/dispatch/core/economy.js';
import { AdmissionEvidenceRecordedData, ExecutionSettledData, type WorkflowEvent } from '../../src/events/schemas.js';
import { toEnvelope } from '../../src/format.js';
import { EventStore } from '../../src/events/store.js';
import { findActionInRegistry } from '../../src/registry.js';
import { DECIDE_ONCE_CLAIM_STREAM } from '../../src/storage/sqlite/constants.js';
import { STORE_DB_FILENAME } from '../../src/utils/paths.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../src/verbs/prepare/economy.js';
import { PreparedCapsuleReceiptData } from '../../src/verbs/prepare/schemas.js';
import { decodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { settlementFactsOf } from '../../src/verbs/settle/settlement-reads.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../../src/workflow/schemas.js';
import { getHSMDefinition, getInitialPhase, registerWorkflowType, unregisterWorkflowType } from '../../src/workflow/state-machine.js';
import { CURRENT_ES_VERSION } from '../../src/workflow/handlers/shared.js';
import { initStateFile, readStateFile } from '../../src/workflow/state-store.js';
import { foldGuardInput, foldWorkflowState } from '../../src/projections/guard-input/fold.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';
import { releaseCheckDefinition } from '../helpers/definitions/user-definition.js';
import { copyWorkflowStream } from '../helpers/replay/workflow-replay.js';
import { scopedRepository } from '../helpers/scoped-repository.js';

const BASE = 'integration';
const PLAN = 'design.md';
const DEFINITION = '.exarchos/workflows/release-check.json';
const START = 'workflow.started';
const PREPARE = 'workflow.prepared';
const TASK = 'T-01';
const OK = 'node -e ""';
const PREFIX = [
  START, 'state.patched', 'phase.entered',
  'workflow.transition', 'phase.exited', 'phase.entered',
  'workflow.transition', 'workflow.compound-entry', 'phase.exited', 'phase.entered',
  'task.assigned', PREPARE,
];

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function openStore(stateDir: string) {
  const store = new EventStore(stateDir);
  await store.initialize();
  cleanup.push(() => store.close());
  return store;
}

async function fixture(tasks = [task(TASK, { files: ['src/task.ts'], testFiles: ['tests/task.test.ts'] })]) {
  const stateDir = makeTempDir('s6-dispatch-');
  cleanup.push(() => rmrfAsync(stateDir));
  const repository = await scopedRepository({
    integrationBranch: BASE,
    files: {
      [PLAN]: textOf(tasks),
      [DEFINITION]: JSON.stringify({ ...releaseCheckDefinition(), entryStepId: 'build' }),
      'package.json': JSON.stringify({ scripts: { lint: OK, typecheck: OK, 'test:files': OK, 'test:run': OK } }),
    },
  });
  cleanup.push(() => rmrfAsync(repository.root));
  return { stateDir, repository, store: await openStore(stateDir) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function caller(store: EventStore, telemetry = false) {
  const context = { eventStore: store, stateDir: store.dir, enableTelemetry: telemetry, callerIdentity: deriveLocalOperatorIdentity(store.dir) };
  return (tool: string, action: string, args: Record<string, unknown>) => dispatch(tool, { action, ...args }, context);
}

async function bootstrapArgs(s: Fixture, featureId: string, workflowType = 'feature') {
  const bytes = await readFile(path.join(s.repository.checkout, PLAN));
  return {
    featureId, repoRoot: s.repository.checkout,
    intent: { mode: 'bootstrap', workflowType, baseRef: BASE, designRef: PLAN,
      approval: { decision: 'approved', designDigest: createHash('sha256').update(bytes).digest('hex') } },
  };
}

function prepareAction() {
  const action = findActionInRegistry('exarchos_orchestrate', 'prepare');
  if (action === undefined) throw new Error('Missing prepare registration');
  return action;
}

function receipt(result: Awaited<ReturnType<typeof dispatch>>) {
  expect(result.success, JSON.stringify(result)).toBe(true);
  prepareAction().outputSchema.parse(toEnvelope(result));
  return PreparedCapsuleReceiptData.extend({ capsule: ExarchosCapsuleV1Schema }).parse(result.data);
}

function operations(store: EventStore, stream: string): string[] {
  const db = new Database(path.join(store.dir, STORE_DB_FILENAME), { readonly: true });
  try {
    return db.query<{ idempotencyKey: string }, [string, string]>(
      "SELECT idempotencyKey FROM idempotency_claims WHERE streamId = ? AND json_extract(events_json, '$.streamId') = ? ORDER BY idempotencyKey",
    ).all(DECIDE_ONCE_CLAIM_STREAM, stream).map(({ idempotencyKey }) => idempotencyKey);
  } finally {
    db.close();
  }
}

async function blobs(store: EventStore): Promise<string[]> {
  return readdir(store.bundleStore.root, { recursive: true }).then(
    files => files.sort(),
    (error: unknown) => {
      expect(error).toMatchObject({ code: 'ENOENT' });
      return [];
    },
  );
}

function telemetryRow(row: WorkflowEvent): boolean {
  return row.type === 'gate.executed' && row.data?.gateName === 'event-emissions';
}

function withoutId(row: WorkflowEvent) {
  const copy = { ...row };
  delete copy.eventId;
  return copy;
}

async function scratchStore() {
  const dir = makeTempDir('s6-replay-');
  cleanup.push(() => rmrfAsync(dir));
  return openStore(dir);
}

function statePath(store: EventStore, stream: string) {
  return path.join(store.dir, `${stream}.state.json`);
}

describe('registered prepare', () => {
  it('Dispatch_BootstrapThenReplay_NoExtraEmissionDebt', async () => {
    const s = await fixture();
    const stream = 'bootstrap-contract';
    const args = await bootstrapArgs(s, stream);
    const call = caller(s.store, true);
    const action = prepareAction();
    expect(action.schema.safeParse(args).success).toBe(true);
    expect(action.schema.safeParse({ ...args, intent: { ...args.intent, schemaVersion: '1.1' } }).success).toBe(false);
    expect(action.actionContract?.ensures.kind).toBe('none');
    expect(action.economy?.budgetTokens).toBe(PREPARE_ECONOMY_BUDGET_TOKENS);
    const declarations = action.actionContract?.emissions;
    if (declarations?.kind !== 'declared') throw new Error('Missing prepare emissions');
    const bootstrapEmissions = [...new Set(PREFIX.slice(0, -2))];
    expect(declarations.values.map(({ event, owner, condition, role }) => [event, owner, condition, role]).sort()).toEqual([
      ...bootstrapEmissions.map(event => [event, 'workflow', 'conditional', 'primary']),
      ...[PREPARE, 'task.assigned', 'capsule.recompiled'].map(event => [event, 'orchestrate', 'conditional', 'primary']),
    ].sort());

    const first = receipt(await call('exarchos_orchestrate', 'prepare', args));
    expect(estimateOutputTokens(first)).toBeLessThan(PREPARE_ECONOMY_BUDGET_TOKENS);
    expect(first.capsule.graph.tasks.map(({ taskId, stepId }) => [taskId, stepId])).toEqual([[TASK, 'delegate']]);
    expect(first.capsule.provenance.compilerVersion).toBe('exarchos-prepare-7');
    await vi.waitFor(async () => expect((await s.store.query(stream)).filter(telemetryRow)).toHaveLength(1));
    const before = (await s.store.query(stream)).filter(row => !telemetryRow(row));
    expect(before.map(({ type }) => type)).toEqual(PREFIX);
    expect(before[0]).toMatchObject({ schemaVersion: '1.1', data: { initialPhase: 'plan' } });
    const planGates = ['check_task_decomposition', 'check_plan_coverage', 'spec_coverage_check',
      'check_provenance_chain', 'generate_traceability'].map(gate => ({ family: 'plan', gate }));
    expect(before.filter(({ type }) => type === 'phase.entered').slice(0, 2).map(({ data }) => data)).toMatchObject([
      { phase: 'plan', designDepth: 'standard', resolvedGates: planGates },
      { phase: 'plan-review', designDepth: 'standard', resolvedGates: planGates },
    ]);
    expect(before.filter(({ type }) => type === 'phase.exited').map(({ data }) => [data?.phase, data?.allRequiredGatesPassed])).toEqual([
      ['plan', true], ['plan-review', true],
    ]);
    const claim = s.store.getAppender().ensureSqliteBackendSync().lookupOperationClaim(first.operationId);
    expect(claim?.sequences).toEqual(before.map(row => row.sequence));
    expect(claim?.result).toEqual(first);
    const custody = await blobs(s.store);
    expect(custody.length).toBeGreaterThan(0);

    const replay = receipt(await call('exarchos_orchestrate', 'prepare', args));
    expect(replay).toEqual(first);
    await vi.waitFor(async () => expect((await s.store.query(stream)).filter(telemetryRow)).toHaveLength(2));
    expect((await s.store.query(stream)).filter(row => !telemetryRow(row))).toEqual(before);
    expect(operations(s.store, stream)).toEqual([first.operationId]);
    expect(await blobs(s.store)).toEqual(custody);
  }, 30_000);

  it('Dispatch_ApprovalRefusal_WritesNothing', async () => {
    const s = await fixture();
    const stream = 'approval-refused';
    const args = await bootstrapArgs(s, stream);
    const call = caller(s.store);
    const invalid = await call('exarchos_orchestrate', 'prepare', { ...args, intent: { ...args.intent, approval: {} } });
    expect(invalid).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });

    const refused = await call('exarchos_orchestrate', 'prepare', {
      ...args, intent: { ...args.intent, approval: { decision: 'approved', designDigest: '0'.repeat(64) } },
    });
    expect(refused).toMatchObject({ success: false, error: { code: 'DESIGN_APPROVAL_MISMATCH' } });
    prepareAction().outputSchema.parse(toEnvelope(refused));
    expect(await s.store.query(stream)).toEqual([]);
    expect(operations(s.store, stream)).toEqual([]);
    expect(await blobs(s.store)).toEqual([]);
    expect(s.store.getAppender().ensureSqliteBackendSync().getState(stream)).toBeNull();
    await expect(readFile(statePath(s.store, stream))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Dispatch_DeepRequiredCheckRunsBeforeCustody', async () => {
    const s = await fixture();
    const stream = 'deep-exploration-refused';
    const args = await bootstrapArgs(s, stream);
    const call = caller(s.store);
    const refused = await call('exarchos_orchestrate', 'prepare', { ...args, intent: { ...args.intent, designDepth: 'deep' } });
    expect(refused).toMatchObject({ success: false, error: { code: 'PLAN_UNSOUND', message: expect.stringContaining('check_exploration_depth') } });
    expect(await s.store.query(stream)).toEqual([]);
    expect(operations(s.store, stream)).toEqual([]);
    expect(await blobs(s.store)).toEqual([]);
    await expect(readFile(statePath(s.store, stream))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(receipt(await call('exarchos_orchestrate', 'prepare', args)).capsuleVersion).toBe(1);
  });

  it('Dispatch_BootstrapEconomy_KeepsReceiptIdentityAndCustody', async () => {
    const tasks = Array.from({ length: 42 }, (_, i) => task(`T-${i + 1}`, {
      title: `Task ${i + 1} ${'long text '.repeat(360)}`, testFiles: [`tests/task-${i}.test.ts`],
    }));
    const s = await fixture(tasks);
    const stream = 'bootstrap-economy';
    const args = await bootstrapArgs(s, stream);
    const call = caller(s.store);
    const first = await call('exarchos_orchestrate', 'prepare', args);
    expect(first.success, JSON.stringify(first.error)).toBe(true);
    prepareAction().outputSchema.parse(toEnvelope(first));
    const rows = await s.store.query(stream);
    const prepared = rows.at(-1);
    expect(prepared?.type).toBe(PREPARE);
    expect(first.data).toMatchObject({
      counts: { tasks: tasks.length }, operationId: prepared?.data?.operationId,
      capsuleVersion: 1, capsuleDigest: prepared?.data?.capsuleDigest,
      tailSequence: prepared?.sequence, bundleRefs: prepared?.data?.bundleRefs,
    });
    expect(estimateOutputTokens(first.data)).toBeLessThanOrEqual(PREPARE_ECONOMY_BUDGET_TOKENS);
    const selection = selectPreparedAuthority(rows, stream);
    if (selection === undefined) throw new Error('Missing prepared record');
    const authority = await loadPreparedCustody(selection, s.store.bundleStore);
    expect(estimateOutputTokens(authority.capsule)).toBeGreaterThan(PREPARE_ECONOMY_BUDGET_TOKENS);
    expect(authority.capsule.graph.tasks.map(({ taskId }) => taskId)).toEqual(tasks.map(({ id }) => id));
    expect((await call('exarchos_orchestrate', 'prepare', args)).data).toEqual(first.data);
    expect(await s.store.query(stream)).toEqual(rows);
  }, 30_000);
});

describe('bootstrap claim replay', () => {
  it('Replay_CopiedBootstrapMarkerWithoutOperationClaim_Refuses', async () => {
    const s = await fixture();
    const stream = 'copied-bootstrap';
    const args = await bootstrapArgs(s, stream);
    const first = receipt(await caller(s.store)('exarchos_orchestrate', 'prepare', args));
    const target = await scratchStore();
    const copied = await copyWorkflowStream(s.store, target, stream);
    const before = await target.query(stream);
    expect(before.map(withoutId)).toEqual(copied.rows.map(withoutId));
    expect(before[0]).toMatchObject({ schemaVersion: '1.1', data: { initialPhase: 'plan' } });
    expect(before.at(-1)?.data).toMatchObject({
      operationId: first.operationId, bootstrapRequestDigest: expect.any(String), capsuleDigest: first.capsuleDigest,
    });
    expect(copied.digests).toHaveLength(1);
    for (const digest of copied.digests) {
      expect(await target.bundleStore.resolve(digest)).toEqual(await s.store.bundleStore.resolve(digest));
    }
    expect(operations(s.store, stream)).toEqual([first.operationId]);
    expect(operations(target, stream)).toEqual([]);
    const refused = await caller(target)('exarchos_orchestrate', 'prepare', args);
    expect(refused).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_INTEGRITY', message: expect.stringMatching(/claim/i) } });
    expect(await target.query(stream)).toEqual(before);
    expect(operations(target, stream)).toEqual([]);
    await expect(readFile(statePath(target, stream))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Replay_ReopenedOriginalStore_ReturnsOriginalBootstrapReceipt', async () => {
    const s = await fixture();
    const stream = 'reopened-bootstrap';
    const call = caller(s.store);
    await writeFile(path.join(s.repository.checkout, PLAN), textOf([
      task(TASK, { testFiles: ['tests/task.test.ts'] }),
      task('T-02', { blockedBy: [TASK], testFiles: ['tests/second.test.ts'] }),
    ]));
    const original = await bootstrapArgs(s, stream);
    const first = receipt(await call('exarchos_orchestrate', 'prepare', original));
    const worktreePath = await s.repository.worktreeFor(TASK, { 'src/task.ts': 'export const task = true;\n' });
    const settled = await call('exarchos_orchestrate', 'settle', {
      featureId: stream, capsuleVersion: first.capsuleVersion, batchId: 'reopen',
      claims: [{ taskId: TASK, fields: { worktreePath, files: ['src/task.ts'] }, evidence: [] }],
    });
    expect(settled.success, JSON.stringify(settled.error)).toBe(true);
    expect(settled.data).toMatchObject({ outcome: 'settled', acceptedTasks: [TASK], operationId: expect.any(String) });
    const { checkout } = s.repository;
    await writeFile(path.join(checkout, PLAN), textOf([task(TASK), task('T-02', { testFiles: ['tests/second.test.ts'] })]));
    const edited = await bootstrapArgs(s, stream);
    const next = receipt(await caller(s.store)('exarchos_orchestrate', 'prepare', {
      ...edited, intent: { ...edited.intent, mode: 'compile' },
    }));
    expect(next.capsuleVersion).toBe(2);
    expect(next.operationId).not.toBe(first.operationId);
    const before = await s.store.query(stream);
    const claimsBefore = operations(s.store, stream);
    const originalClaim = s.store.getAppender().ensureSqliteBackendSync().lookupOperationClaim(first.operationId);
    expect(originalClaim?.result).toEqual(first);
    s.store.close();
    const reopened = await openStore(s.stateDir);
    expect(reopened.getAppender().ensureSqliteBackendSync().lookupOperationClaim(first.operationId)).toEqual(originalClaim);
    expect(receipt(await caller(reopened)('exarchos_orchestrate', 'prepare', original))).toEqual(first);

    await writeFile(path.join(checkout, '.exarchos.yml'), 'workflow:\n  skip-phases: [review]\n');
    expect(receipt(await caller(reopened)('exarchos_orchestrate', 'prepare', original))).toEqual(first);
    await unlink(path.join(checkout, PLAN));
    await rename(reopened.bundleStore.root, `${reopened.bundleStore.root}-removed`);
    await unlink(statePath(reopened, stream));
    expect(receipt(await caller(reopened)('exarchos_orchestrate', 'prepare', original))).toEqual(first);
    expect(await reopened.query(stream)).toEqual(before);
    const settlementRows = await reopened.query(stream, { type: 'execution.settled' });
    expect(settlementRows).toHaveLength(1);
    const settlement = ExecutionSettledData.parse(settlementRows[0]?.data);
    expect(claimsBefore).toEqual(expect.arrayContaining([first.operationId, next.operationId, settlement.operationId]));
    expect(operations(reopened, stream)).toEqual(claimsBefore);
    expect(await blobs(reopened)).toEqual([]);
    expect(await readStateFile(statePath(reopened, stream))).toMatchObject({
      phase: 'delegate', _eventSequence: before.length,
      tasks: [expect.objectContaining({ id: TASK, status: 'complete' }), expect.objectContaining({ id: 'T-02', status: 'pending' })],
    });
  }, 30_000);
});

/** The model gives the task states and start epochs independently of the copy. */
async function assertMixedReplay(s: Fixture, membershipSize: number, legacyExtra: unknown) {
  const legacy = 'mixed-legacy';
  const typed = 'mixed-typed';
  const call = caller(s.store);
  const legacyTask = 'legacy-task';
  const appender = s.store.getAppender();
  const legacyKey = 'legacy-plan';
  const patch = { type: 'state.patched' as const, schemaVersion: '1.0', data: { patch: {
    'synthesis.integrationBranch': BASE,
    tasks: [{ id: legacyTask, title: legacyTask, status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }],
  } } };
  await s.store.append(legacy, { type: START, data: { featureId: legacy, workflowType: 'feature', initialPhase: legacyExtra } });
  await s.store.append(legacy, { type: 'workflow.transition', data: { from: 'plan', to: 'delegate' } });
  expect(await appender.append(legacy, [patch], legacyKey)).toMatchObject({ ok: true, kind: 'committed' });
  const legacyReceipt = receipt(await call('exarchos_orchestrate', 'prepare', { featureId: legacy, repoRoot: s.repository.checkout }));
  expect(legacyReceipt.capsule.graph.tasks.map(t => t.taskId)).toEqual([legacyTask]);

  const ids = [TASK, ...Array.from({ length: membershipSize - 1 }, (_, i) => `pending-${i}`)];
  await writeFile(path.join(s.repository.checkout, PLAN), textOf(ids.map((id, index) => task(id, {
    blockedBy: index === 0 ? [] : [TASK],
    files: index === 0 ? ['src/task.ts'] : [`src/${id}.ts`],
    testFiles: [`tests/${id}.test.ts`],
  }))));
  const typedReceipt = receipt(await call('exarchos_orchestrate', 'prepare', await bootstrapArgs(s, typed)));
  expect(typedReceipt.capsule.graph.tasks.map(t => t.taskId)).toEqual([TASK]);
  const worktreePath = await s.repository.worktreeFor(TASK, { 'src/task.ts': 'export const task = true;\n' });
  const evidenceResult = await call('exarchos_orchestrate', 'check_static_analysis', {
    featureId: typed, taskId: TASK, repoRoot: 'auto', worktreePath,
  });
  expect(evidenceResult.success, JSON.stringify(evidenceResult.error)).toBe(true);
  const evidenceRows = await s.store.query(typed, { type: 'admission.evidence-recorded' });
  expect(evidenceRows).toHaveLength(1);
  const evidenceRecord = AdmissionEvidenceRecordedData.parse(evidenceRows[0]?.data);
  expect(evidenceRecord.evidence).toMatchObject({ verdict: 'pass', requirementId: 'verification-ladder:static-analysis' });
  const citation = { kind: 'static-analysis', ref: evidenceRecord.evidence.evidenceId };
  const settled = await call('exarchos_orchestrate', 'settle', {
    featureId: typed, capsuleVersion: typedReceipt.capsuleVersion, batchId: 'mixed-batch',
    claims: [{ taskId: TASK, fields: { worktreePath, files: ['src/task.ts'] }, evidence: [citation] }],
  });
  expect(settled.success, JSON.stringify(settled.error)).toBe(true);
  expect(settled.data).toMatchObject({ operationId: expect.any(String), outcome: 'settled', acceptedTasks: [TASK] });
  const settledRows = await s.store.query(typed, { type: 'execution.settled' });
  expect(settledRows).toHaveLength(1);
  const settlement = ExecutionSettledData.parse(settledRows[0]?.data);

  const target = await scratchStore();
  for (const [stream, startVersion, prepareId] of [
    [legacy, '1.0', legacyReceipt.operationId],
    [typed, '1.1', typedReceipt.operationId],
  ] as const) {
    const copied = await copyWorkflowStream(s.store, target, stream);
    const rows = await target.query(stream);
    expect(rows.map(withoutId)).toEqual(copied.rows.map(withoutId));
    expect(rows.filter(row => row.type === START)).toEqual([expect.objectContaining({ schemaVersion: startVersion })]);
    expect(operations(s.store, stream)).toContain(prepareId);
    expect(operations(target, stream)).toEqual([]);
    expect(copied.digests.length).toBeGreaterThan(0);
    for (const digest of copied.digests) {
      expect(await target.bundleStore.resolve(digest)).toEqual(await s.store.bundleStore.resolve(digest));
    }
    const selection = selectPreparedAuthority(rows, stream);
    if (selection === undefined) throw new Error('Missing copied prepare');
    const authority = await loadPreparedCustody(selection, target.bundleStore);
    if (stream === legacy) {
      expect(authority.kind).toBe('legacy');
      expect(foldWorkflowState(rows).tasks.map(t => t.id)).toEqual([legacyTask]);
      expect(await target.getAppender().append(stream, [patch], legacyKey)).toMatchObject({
        ok: true, kind: 'cache-hit', sequences: [3],
      });
      expect(await target.query(stream)).toEqual(rows);
      continue;
    }
    if (authority.kind !== 'typed') throw new Error('Copied prepare lost typed authority');
    expect(authority.snapshot.tasks.map(t => t.id)).toEqual(ids);
    expect(foldGuardInput(rows, { authoritativeTasks: authority.snapshot.tasks }).tasks).toEqual(
      ids.map((id, i) => expect.objectContaining({ id, status: i === 0 ? 'complete' : 'pending' })),
    );
    expect(copied.digests.length).toBeGreaterThan(1);
    const ref = settlement.bundleRefs[0];
    if (ref === undefined) throw new Error('Missing settlement bundle reference');
    const storedBundle = decodeSettlementBundle(await target.bundleStore.resolve(ref.digest));
    expect(storedBundle.claims.flatMap(claim => claim.evidence)).toEqual([citation]);
    const reads = { pinnedSequence: selection.sequence, cited: [citation] };
    const facts = settlementFactsOf(rows, reads);
    expect(facts).toEqual(settlementFactsOf(copied.rows, reads));
    expect([...facts.cited.values()].map(record => record.record)).toEqual([evidenceRecord]);
    expect([...facts.completed]).toEqual([TASK]);
    expect(operations(s.store, stream)).toContain(settlement.operationId);
  }
}

describe('mixed stored histories', () => {
  it('Replay_MixedLegacyAndTypedRows_PreservesEvidenceCustodyAndMembership', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 4 }), fc.jsonValue(), async (count, extra) => {
      await assertMixedReplay(await fixture(), count, extra);
    }), { seed: 192713, numRuns: 3 });
  }, 60_000);

  it('Replay_LegacyUnknownExtras_RetainFallbacks', async () => {
    const store = await scratchStore();
    const call = caller(store);
    const versions = [undefined, '1.0', '1.2', 'custom'];
    const extras = ['ignored', 42, null, { ignored: true }, undefined];
    for (const [i, schemaVersion] of versions.entries()) {
      for (const [j, initialPhase] of extras.entries()) {
        const stream = `legacy-start-${i}-${j}`;
        const data = initialPhase === undefined ? undefined : { featureId: stream, workflowType: 'constructor', initialPhase };
        const appended = await store.getAppender().appendUnkeyed(stream, [{ type: START, schemaVersion, data }]);
        expect(appended.ok).toBe(true);
        const rows = await store.query(stream);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.schemaVersion).toBe(schemaVersion);
        expect(rows[0]?.data).toEqual(data);
        expect(foldWorkflowState(rows).phase).toBe('plan');
        const status = await call('exarchos_view', 'workflow_status', { workflowId: stream, asOf: { untilSequence: 1 } });
        expect(status.success, JSON.stringify(status)).toBe(true);
        expect(status.data).toMatchObject({ phase: 'started' });
        const rehydrated = await call('exarchos_workflow', 'rehydrate', { featureId: stream });
        expect(rehydrated.success, JSON.stringify(rehydrated.error)).toBe(true);
        expect(rehydrated.data).toMatchObject({ workflowState: { phase: '' } });
      }
      const known = `legacy-debug-${i}`;
      await store.getAppender().appendUnkeyed(known, [{
        type: START, schemaVersion, data: { featureId: known, workflowType: 'debug', initialPhase: 'ignored' },
      }]);
      expect(await call('exarchos_workflow', 'reconcile', { featureId: known })).toMatchObject({ success: true, data: { reconciled: true } });
      expect(await readStateFile(statePath(store, known))).toMatchObject({ phase: 'triage', _checkpoint: { phase: 'triage' } });
      expect(await call('exarchos_workflow', 'reconcile', { featureId: `legacy-start-${i}-4` })).toMatchObject({
        success: true, data: { reconciled: false, eventsApplied: 0 },
      });
    }
    expect(() => getHSMDefinition('constructor')).toThrow('Unknown workflow type: constructor');
    expect(() => getInitialPhase('constructor')).toThrow('Unknown workflow type: constructor');
    expect(() => registerWorkflowType('invalid-parent', {
      extends: 'constructor', initialPhase: 'plan', phases: ['plan'], transitions: [],
    })).toThrow('Cannot extend unknown workflow type: constructor');
  }, 30_000);

  it('Dispatch_GenericStartEpochAndOwnPhase_RefuseZeroWrite', async () => {
    const store = await scratchStore();
    const call = caller(store);
    const stream = 'generic-start-refused';
    const ordinary = { type: START, data: { featureId: stream, workflowType: 'feature' }, idempotencyKey: 'ordinary' };
    const attempted = [
      { ...ordinary, schemaVersion: '1.1', idempotencyKey: 'refused' },
      { ...ordinary, schemaVersion: 'custom', data: { ...ordinary.data, initialPhase: 'delegate' }, idempotencyKey: 'refused' },
      { ...ordinary, data: { ...ordinary.data, initialPhase: null }, idempotencyKey: 'refused' },
      { ...ordinary, data: { ...ordinary.data, workflowType: 'constructor' }, idempotencyKey: 'refused' },
    ];
    for (const event of attempted) {
      expect(await call('exarchos_event', 'append', { stream, event })).toMatchObject({
        success: false, error: { code: 'VALIDATION_ERROR' },
      });
      expect(await call('exarchos_event', 'batch_append', { stream, events: [ordinary, event] })).toMatchObject({
        success: false, error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('events[1]') },
      });
      expect(await store.query(stream)).toEqual([]);
    }
    const backend = store.getAppender().ensureSqliteBackendSync();
    expect(backend.lookupIdempotencyClaim(stream, 'ordinary')).toBeUndefined();
    expect(backend.lookupIdempotencyClaim(stream, 'refused')).toBeUndefined();
    expect(await call('exarchos_event', 'append', { stream, event: { ...ordinary, schemaVersion: 'custom' } })).toMatchObject({ success: true });
    expect(await store.query(stream)).toMatchObject([{ schemaVersion: '1.0', data: ordinary.data }]);
    cleanup.push(() => {
      unregisterWorkflowType('constructor');
      unextendWorkflowTypeEnum('constructor');
    });
    extendWorkflowTypeEnum('constructor');
    registerWorkflowType('constructor', {
      initialPhase: 'historic-entry', phases: ['historic-entry', 'completed'],
      transitions: [{ from: 'historic-entry', to: 'completed', event: 'finish' }],
    });
    expect(getHSMDefinition('constructor').id).toBe('constructor');
    expect(getInitialPhase('constructor')).toBe('historic-entry');
    for (const action of ['append', 'batch_append']) {
      const registered = `constructor-${action.replace('_', '-')}`;
      const event = { type: START, data: { featureId: registered, workflowType: 'constructor' } };
      const args = action === 'append' ? { event } : { events: [event] };
      expect(await call('exarchos_event', action, { stream: registered, ...args })).toMatchObject({ success: true });
      const rows = await store.query(registered);
      expect(rows).toMatchObject([{ data: event.data }]);
      expect(rows[0]?.schemaVersion).toBe(action === 'append' ? '1.0' : undefined);
    }
  });
});

async function directEntry(s: Fixture, stream: string) {
  const result = receipt(await caller(s.store)('exarchos_orchestrate', 'prepare', await bootstrapArgs(s, stream, 'release-check')));
  const rows = await s.store.query(stream);
  expect(rows.filter(row => row.type === 'workflow.transition')).toEqual([]);
  expect(rows[0]).toMatchObject({ schemaVersion: '1.1', data: { initialPhase: 'build', workflowType: 'release-check' } });
  expect(foldWorkflowState(rows).phase).toBe('build');
  expect(result.capsule.graph.tasks[0]?.stepId).toBe('build');
  return result;
}

async function rawStart(store: EventStore, stream: string, data?: Record<string, unknown>) {
  const result = await store.getAppender().appendUnkeyed(stream, [{ type: START, schemaVersion: '1.1', data }]);
  expect(result).toMatchObject({ ok: true, kind: 'committed' });
}

describe('committing snapshots', () => {
  it('Replay_V11Envelope_SurvivesAllAdapters', async () => {
    const s = await fixture();
    const call = caller(s.store);
    const moveStream = 'entry-transition';
    await directEntry(s, moveStream);
    await s.store.append(moveStream, { type: 'task.completed', data: { taskId: TASK, verified: true } });
    const moved = await call('exarchos_workflow', 'transition', { featureId: moveStream, target: 'verify' });
    expect(moved.success, JSON.stringify(moved.error)).toBe(true);
    expect(await s.store.query(moveStream, { type: 'workflow.transition' })).toMatchObject([{ data: { from: 'build', to: 'verify' } }]);

    const settleStream = 'entry-settle';
    const prepared = await directEntry(s, settleStream);
    const worktreePath = await s.repository.worktreeFor(TASK, { 'src/task.ts': 'export const task = true;\n' });
    const settled = await call('exarchos_orchestrate', 'settle', {
      featureId: settleStream, capsuleVersion: prepared.capsuleVersion, batchId: 'entry',
      claims: [{ taskId: TASK, fields: { worktreePath, files: ['src/task.ts'] }, evidence: [] }],
    });
    expect(settled.success, JSON.stringify(settled.error)).toBe(true);
    expect(settled.data).toMatchObject({ outcome: 'settled', phaseMove: { kind: 'moved', from: 'build', to: 'verify' } });

    const cancelStream = 'entry-finalization';
    await rawStart(s.store, cancelStream, { featureId: cancelStream, workflowType: 'feature', initialPhase: 'plan-review' });
    await initStateFile(s.stateDir, cancelStream, 'feature', { _esVersion: CURRENT_ES_VERSION }, 'plan-review');
    const cancelled = await call('exarchos_workflow', 'cancel', { featureId: cancelStream, reason: 'end fixture' });
    expect(cancelled.success, JSON.stringify(cancelled.error)).toBe(true);
    expect((await s.store.query(cancelStream, { type: 'workflow.cancel' })).map(row => [row.data?.from, row.data?.to])).toEqual([
      ['plan-review', 'cancelled'], ['plan-review', 'cancelled'],
    ]);
  }, 30_000);

  it('Replay_MalformedV11_ColdReadersAndRecoveryRefuse', async () => {
    const store = await scratchStore();
    const call = caller(store);
    const valid = 'valid-start-recovery';
    await rawStart(store, valid, { featureId: valid, workflowType: 'release-check', initialPhase: 'build' });
    expect(await call('exarchos_view', 'workflow_status', { workflowId: valid, asOf: { untilSequence: 1 } })).toMatchObject({
      success: true, data: { phase: 'build' },
    });
    expect(await call('exarchos_workflow', 'rehydrate', { featureId: valid })).toMatchObject({
      success: true, data: { workflowState: { phase: 'build' } },
    });
    expect(await call('exarchos_workflow', 'reconcile', { featureId: valid })).toMatchObject({ success: true, data: { reconciled: true } });
    expect(await readStateFile(statePath(store, valid))).toMatchObject({ phase: 'build', _checkpoint: { phase: 'build' } });
    const malformed = [undefined, {}, { initialPhase: '' }, { initialPhase: 1 }, { initialPhase: null }, { initialPhase: {} }];
    for (const [i, extra] of malformed.entries()) {
      const stream = `malformed-start-${i}`;
      await rawStart(store, stream, extra === undefined ? undefined : { featureId: stream, workflowType: 'release-check', ...extra });
      const rows = await store.query(stream);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.schemaVersion).toBe('1.1');
      const validation = extra === undefined ? 'expected object' : 'initialPhase';
      expect(() => foldWorkflowState(rows)).toThrow(validation);
      const view = await call('exarchos_view', 'workflow_status', { workflowId: stream, asOf: { untilSequence: 1 } });
      expect(view).toMatchObject({ success: false, error: { code: 'VIEW_ERROR', message: expect.stringContaining(validation) } });
      const recovered = await call('exarchos_workflow', 'reconcile', { featureId: stream });
      expect(recovered).toMatchObject({ success: false, error: { message: expect.stringContaining(validation) } });
      await call('exarchos_workflow', 'rehydrate', { featureId: stream });
      expect(await store.query(stream, { type: 'workflow.projection_degraded' })).toMatchObject([
        { data: { cause: 'reducer-throw', fallbackSource: 'state-store-only' } },
      ]);
      await expect(readFile(statePath(store, stream))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 30_000);
});
