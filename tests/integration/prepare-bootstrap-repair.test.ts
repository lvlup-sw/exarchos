/**
 * SQLite and the compatibility document implement the bootstrap repair model.
 * @oracle-sources: authored model, fault positions and ledger trails in this file
 */
import { readdir, unlink, writeFile } from 'node:fs/promises';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import { DECIDE_ONCE_CLAIM_STREAM } from '../../src/storage/sqlite/constants.js';
import type { PreparedCapsuleReceipt } from '../../src/verbs/prepare/types.js';
import { buildInitialState, configureStateStoreBackend, readStateFile } from '../../src/workflow/state-store.js';
import { bootstrapFixture, planText, receipt, STREAM, type BootstrapFixture } from '../helpers/capsule/bootstrap-store.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  configureStateStoreBackend(undefined);
  for (const close of cleanup.splice(0).reverse()) await close();
});

const FEATURE_ROWS = 12;
type State = 'absent' | 'repair-needed' | 'committed';

function modelAccepts(state: State, rows: readonly WorkflowEvent[], claims: readonly PreparedCapsuleReceipt[], document: boolean): boolean {
  if (state === 'absent') return rows.length === 0 && claims.length === 0 && !document;
  return rows.length === FEATURE_ROWS && rows[0]?.type === 'workflow.started'
    && rows.filter(({ type }) => type === 'workflow.started').length === 1
    && rows.filter(({ type }) => type === 'workflow.prepared').length === 1
    && rows.at(-1)?.type === 'workflow.prepared' && claims.length === 1
    && claims[0]?.operationId === rows.at(-1)?.data?.operationId
    && claims[0]?.tailSequence === rows.at(-1)?.sequence
    && document === (state === 'committed');
}

function acceptedOperations(s: BootstrapFixture): string[] {
  const { db } = s.backend as unknown as {
    db: { query(sql: string): { all(stream: string, subject: string): { idempotencyKey: string }[] } };
  };
  return db.query(
    "SELECT idempotencyKey FROM idempotency_claims WHERE streamId = ? AND json_extract(events_json, '$.streamId') = ?",
  ).all(DECIDE_ONCE_CLAIM_STREAM, STREAM).map(({ idempotencyKey }) => idempotencyKey);
}

async function assertState(s: BootstrapFixture, state: State, operations: readonly string[]): Promise<void> {
  const rows = await s.events.query(STREAM);
  expect(acceptedOperations(s)).toEqual(state === 'absent' ? [] : [rows.at(-1)?.data?.operationId]);
  const claims = operations.flatMap((operationId) => {
    const claim = s.backend.lookupOperationClaim<PreparedCapsuleReceipt>(operationId);
    return claim === undefined ? [] : [claim.result];
  });
  const document = await readStateFile(s.stateFile).then(() => true, (error: unknown) => {
    expect(error).toMatchObject({ code: 'STATE_NOT_FOUND' });
    return false;
  });
  expect(modelAccepts(state, rows, claims, document)).toBe(true);
}

function failInsertAt(s: BootstrapFixture, position: number) {
  const { stmts } = s.backend as unknown as { stmts: { insertEventStrict: { run: (...args: unknown[]) => unknown } } };
  const run = stmts.insertEventStrict.run.bind(stmts.insertEventStrict);
  let inserts = 0;
  return vi.spyOn(stmts.insertEventStrict, 'run').mockImplementation((...args) => {
    inserts += 1;
    if (inserts === position) throw new Error(`strict insert fault at ${position}`);
    return run(...args);
  });
}

describe('bootstrap repair', () => {
  it('Bootstrap_AppendFailsAtEachRow_RollsBackBatch', async () => {
    for (let position = 1; position <= FEATURE_ROWS; position += 1) {
      const s = await bootstrapFixture(cleanup);
      const appender = vi.spyOn(s.events.getAppender(), 'decideOnce');
      const insert = failInsertAt(s, position);
      try {
        expect(await s.call()).toMatchObject({ success: false, error: {
          code: 'INTERNAL_ERROR', message: expect.stringContaining(`strict insert fault at ${position}`),
        } });
        expect(insert).toHaveBeenCalledTimes(position);
        const operation = appender.mock.calls[0]?.[0];
        expect(operation).toMatch(/^prepare:[a-f0-9]{64}$/);
        if (operation === undefined) throw new Error('The commit did not reach the appender.');
        expect(s.backend.readSequenceHighWaterMark(STREAM)).toBe(0);
        await assertState(s, 'absent', [operation]);
        insert.mockRestore();
        const accepted = receipt(await s.call());
        expect(accepted.operationId).toBe(operation);
        await assertState(s, 'committed', [operation]);
      } finally {
        insert.mockRestore();
      }
    }
  });

  it.each(['upsertSequence', 'insertIdempotencyClaim'] as const)('Bootstrap_%s_FaultRollsBackTheStore', async (statement) => {
    const s = await bootstrapFixture(cleanup);
    const { stmts } = s.backend as unknown as {
      stmts: Record<typeof statement, { run: (...args: unknown[]) => unknown }>;
    };
    const fault = vi.spyOn(stmts[statement], 'run').mockImplementationOnce(() => { throw new Error('transaction fault'); });
    const appender = vi.spyOn(s.events.getAppender(), 'decideOnce');
    expect(await s.call()).toMatchObject({
      success: false, error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('transaction fault') },
    });
    expect(fault).toHaveBeenCalled();
    expect(s.backend.readSequenceHighWaterMark(STREAM)).toBe(0);
    const operation = appender.mock.calls[0]?.[0];
    if (operation === undefined) throw new Error('The commit did not reach the appender.');
    await assertState(s, 'absent', [operation]);
    expect(receipt(await s.call()).operationId).toBe(operation);
    await assertState(s, 'committed', [operation]);
  });

  it.each([false, true])('Bootstrap_LegacyDiskCollision_DoesNotMigrate_WithBackend_%s', async (withBackend) => {
    const s = await bootstrapFixture(cleanup);
    if (withBackend) configureStateStoreBackend(s.backend);
    const legacy = JSON.stringify({ version: '1.0', featureId: STREAM, workflowType: 'feature', phase: 'plan' });
    await writeFile(s.stateFile, legacy);
    const names = await readdir(s.stateDir);
    const put = vi.spyOn(s.events.bundleStore, 'put');
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
    expect(await readdir(s.stateDir)).toEqual(names);
    expect(put).not.toHaveBeenCalled();
    expect(s.observe).not.toHaveBeenCalled();
    expect(await s.events.query(STREAM)).toEqual([]);
  });

  it('Bootstrap_LegacyBackendCollision_DoesNotWrite', async () => {
    const s = await bootstrapFixture(cleanup);
    configureStateStoreBackend(s.backend);
    const legacy = buildInitialState(STREAM, 'feature', { version: '1.0' });
    s.backend.setState(STREAM, legacy, 0);
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
    expect(s.observe).not.toHaveBeenCalled();
    expect(s.backend.getState(STREAM)).toEqual(legacy);
    expect(await s.events.query(STREAM)).toEqual([]);
  });

  it('Bootstrap_CorruptBackendRow_RefusesWithoutDecoding', async () => {
    const s = await bootstrapFixture(cleanup);
    configureStateStoreBackend(s.backend);
    const { db } = s.backend as unknown as {
      db: { query(sql: string): { run(stream: string): unknown } };
    };
    s.backend.setState(STREAM, buildInitialState(STREAM, 'feature'), 0);
    db.query("UPDATE workflow_state SET state = 'null' WHERE featureId = ?").run(STREAM);
    const read = vi.spyOn(s.backend, 'getState');
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
    expect(read).not.toHaveBeenCalled();
    expect(s.backend.hasState(STREAM)).toBe(true);
    expect(await s.events.query(STREAM)).toEqual([]);
  });

  it('Repair_LaterPhaseWins_PreservesEffects', async () => {
    const s = await bootstrapFixture(cleanup);
    configureStateStoreBackend(s.backend);
    const first = receipt(await s.call());
    const initial = buildInitialState(STREAM, 'feature', { _version: 3 });
    s.backend.setState(STREAM, initial, 2);
    const set = s.backend.setState.bind(s.backend);
    const attempt = '3f8e2b7c-4d1a-4c3e-9b6f-2a5d8c7e1f30';
    const existing = await s.events.query(STREAM);
    vi.spyOn(s.backend, 'setState').mockImplementationOnce((...args) => {
      s.backend.appendEvent(STREAM, {
        streamId: STREAM, sequence: existing.length + 1, schemaVersion: '1.0', timestamp: '2026-11-13T01:00:00.000Z',
        type: 'workflow.transition', data: { from: 'delegate', to: 'review', phaseAttemptId: attempt },
      });
      s.backend.appendEvent(STREAM, {
        streamId: STREAM, sequence: existing.length + 2, schemaVersion: '1.0', timestamp: '2026-11-13T02:00:00.000Z',
        type: 'task.completed', data: { taskId: 'task-0' },
      });
      set(STREAM, { ...initial, _version: 4 }, 3);
      return set(...args);
    });
    expect(receipt(await s.call())).toEqual(first);
    expect(await readStateFile(s.stateFile)).toMatchObject({
      phase: 'review', phaseAttemptId: attempt, _eventSequence: existing.length + 2,
      tasks: [{ id: 'task-0', status: 'complete' }],
    });
  });

  it('Repair_CollisionAfterCasConflict_RefusesFreshDocument', async () => {
    const s = await bootstrapFixture(cleanup);
    configureStateStoreBackend(s.backend);
    const first = receipt(await s.call());
    const stale = buildInitialState(STREAM, 'feature', { _version: 3 });
    const unrelated = buildInitialState(STREAM, 'debug', { _version: 4 });
    s.backend.setState(STREAM, stale, 2);
    const set = s.backend.setState.bind(s.backend);
    vi.spyOn(s.backend, 'setState').mockImplementationOnce((...args) => {
      set(STREAM, unrelated, 3);
      return set(...args);
    });
    expect(await s.call()).toMatchObject({ success: false, error: {
      code: 'STATE_SYNC_FAILED', message: expect.stringContaining(first.operationId),
    } });
    expect(s.backend.getState(STREAM)).toEqual(unrelated);
    expect(await s.events.query(STREAM)).toHaveLength(first.tailSequence);
  });

  it('Repair_MalformedV11_NeverFallsBack', async () => {
    const s = await bootstrapFixture(cleanup);
    const first = receipt(await s.call());
    await unlink(s.stateFile);
    const query = s.events.query.bind(s.events);
    vi.spyOn(s.events, 'query').mockImplementation(async (...args) => (await query(...args)).map((row) =>
      row.type === 'workflow.started' ? { ...row, data: { ...row.data, initialPhase: null } } : row));
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_INTEGRITY' } });
    expect((await query(STREAM)).at(-1)?.data?.operationId).toBe(first.operationId);
    await expect(readStateFile(s.stateFile)).rejects.toMatchObject({ code: 'STATE_NOT_FOUND' });
  });

  it.each(['register', 'publish'] as const)('Repair_Committed_%s_FaultReturnsAcceptedIdentity', async (fault) => {
    const s = await bootstrapFixture(cleanup);
    configureStateStoreBackend(s.backend);
    if (fault === 'register') vi.spyOn(s.events, 'registerStream').mockImplementationOnce(() => { throw new Error('index fault'); });
    if (fault === 'publish') vi.spyOn(s.backend, 'setState').mockImplementationOnce(() => { throw new Error('publish fault'); });
    const result = await s.call();
    const op = (await s.events.query(STREAM)).at(-1)?.data?.operationId;
    if (typeof op !== 'string') throw new Error('The bootstrap did not commit.');
    const accepted = s.backend.lookupOperationClaim<PreparedCapsuleReceipt>(op)?.result;
    expect(result.error?.code).toBe('STATE_SYNC_FAILED');
    expect(result.error?.message).toContain(op);
    expect(result.error?.message).toContain(accepted?.capsuleDigest);
    await assertState(s, 'repair-needed', [op]);
    expect(receipt(await s.call())).toEqual(accepted);
    await assertState(s, 'committed', [op]);
  });

  it('Bootstrap_SameEntryRace_ReplaysDifferentFullKeyWinner', async () => {
    const s = await bootstrapFixture(cleanup);
    const bundles = s.events.bundleStore;
    const put = bundles.put.bind(bundles);
    vi.spyOn(bundles, 'put').mockImplementationOnce(async (...args) => {
      s.setHead('c'.repeat(40));
      const winner = receipt(await s.call());
      expect(winner.capsule.settlementContract.taskVerification?.['task-0']?.baseCommit).toBe('c'.repeat(40));
      return put(...args);
    });
    const loser = receipt(await s.call());
    expect(loser.capsule.settlementContract.taskVerification?.['task-0']?.baseCommit).toBe('c'.repeat(40));
    await assertState(s, 'committed', [loser.operationId]);
  });

  it('Bootstrap_SameEntryWinner_RecoversFromLosingCustodyFailure', async () => {
    const s = await bootstrapFixture(cleanup);
    let accepted: PreparedCapsuleReceipt | undefined;
    vi.spyOn(s.events.bundleStore, 'put').mockImplementationOnce(async () => {
      s.setHead('c'.repeat(40));
      accepted = receipt(await s.call());
      throw new Error('losing custody failed after the winner committed');
    });
    expect(receipt(await s.call())).toEqual(accepted);
    expect(await s.events.query(STREAM)).toHaveLength(FEATURE_ROWS);
  });

  it('Bootstrap_DifferentEntryRace_RefusesTheLoser', async () => {
    const s = await bootstrapFixture(cleanup);
    const bundles = s.events.bundleStore;
    const put = bundles.put.bind(bundles);
    let winningOperation: string | undefined;
    vi.spyOn(bundles, 'put').mockImplementationOnce(async (...args) => {
      const changed = planText(2);
      await s.write(changed);
      winningOperation = receipt(await s.call(s.intent(changed))).operationId;
      return put(...args);
    });
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
    const rows = await s.events.query(STREAM);
    expect(rows.filter(({ type }) => type === 'workflow.started')).toHaveLength(1);
    expect(rows.filter(({ type }) => type === 'workflow.prepared')).toHaveLength(1);
    expect(rows.at(-1)?.data?.operationId).toBe(winningOperation);
  });

  it('Bootstrap_DifferentEntryWinner_PreservesOriginalCustodyFailure', async () => {
    const s = await bootstrapFixture(cleanup);
    vi.spyOn(s.events.bundleStore, 'put').mockImplementationOnce(async () => {
      const changed = planText(2);
      await s.write(changed);
      receipt(await s.call(s.intent(changed)));
      throw new Error('original custody failure');
    });
    expect(await s.call()).toMatchObject({ success: false, error: {
      code: 'INTERNAL_ERROR', message: expect.stringContaining('original custody failure'),
    } });
    expect((await s.events.query(STREAM)).filter(({ type }) => type === 'workflow.prepared')).toHaveLength(1);
  });

  it('Bootstrap_RealStoreMatchesReducedModel', async () => {
    const action = fc.constantFrom('call', 'replay', 'custody-fault', 'publish-fault', 'append-fault', 'conflict');
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(action, fc.integer({ min: 1, max: FEATURE_ROWS })), {
      minLength: 1, maxLength: 8,
    }), async (steps) => {
      const s = await bootstrapFixture(cleanup);
      configureStateStoreBackend(s.backend);
      const operations = new Set<string>();
      let state: State = 'absent';
      const appender = vi.spyOn(s.events.getAppender(), 'decideOnce');
      for (const [command, position] of steps) {
        let fault: { mockRestore(): void } | undefined;
        if (command === 'custody-fault') fault = vi.spyOn(s.events.bundleStore, 'put').mockRejectedValueOnce(new Error('custody fault'));
        if (command === 'publish-fault') fault = vi.spyOn(s.backend, 'setState').mockImplementationOnce(() => { throw new Error('publish fault'); });
        if (command === 'append-fault') fault = failInsertAt(s, position);
        const result = await s.call(command === 'conflict' ? s.intent(undefined, { designDepth: 'thin' }) : undefined);
        fault?.mockRestore();
        appender.mock.calls.forEach(([operation]) => operations.add(operation));
        if (state === 'absent' && ['custody-fault', 'append-fault'].includes(command)) {
          expect(result.success).toBe(false);
        } else if (state !== 'committed' && command === 'publish-fault') {
          state = 'repair-needed';
          expect(result.error?.code).toBe('STATE_SYNC_FAILED');
        } else if (command === 'conflict' && state !== 'absent') {
          expect(result.error?.code).toBe('BOOTSTRAP_CONFLICT');
        } else {
          state = 'committed';
          expect(result.success).toBe(true);
        }
        await assertState(s, state, [...operations]);
        if (command === 'conflict' && result.success) break;
      }
      const rows = await s.events.query(STREAM);
      const claims = [...operations].flatMap((operation) => {
        const accepted = s.backend.lookupOperationClaim<PreparedCapsuleReceipt>(operation);
        return accepted ? [accepted.result] : [];
      });
      if (state !== 'absent') {
        expect(modelAccepts(state, rows.slice(0, 1), claims, state === 'committed')).toBe(false);
        expect(modelAccepts(state, rows, [...claims, ...claims], state === 'committed')).toBe(false);
      }
    }), { numRuns: 24, seed: 192711 });
  });
});
