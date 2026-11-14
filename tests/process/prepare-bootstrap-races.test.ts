/**
 * Checks competing bootstrap calls and document repair through the packaged binary.
 * @oracle-sources: Recorded Git observations, SQLite ledger and claim rows, and approved bytes.
 */
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PLAN, STREAM, TASKS, changeDatabase, data, digest, gitBarrier, makeBarrier, prepareRequest, prepareRows,
  record, settleArgs, typedTasks, withRaceRepository, type RaceRepository,
} from '../helpers/capsule/s6-process-race.js';
import { textOf } from '../helpers/capsule/prepared-authority.js';

const PROCESS_TIMEOUT = 70_000;

interface BootstrapModel {
  readonly rowTypes: readonly string[];
  readonly claims: number;
  readonly phase: unknown;
  readonly cursor: unknown;
}

function stateOf(fixture: RaceRepository): BootstrapModel {
  const { rows, operations, document } = fixture.ledger();
  return { rowTypes: rows.map(row => row.type), claims: operations.length, phase: document?.phase, cursor: document?._eventSequence };
}

function accepted(model: BootstrapModel): boolean {
  return model.claims === 1 && model.rowTypes.filter(type => type === 'workflow.started').length === 1
    && model.rowTypes.filter(type => type === 'workflow.prepared').length === 1
    && model.rowTypes.filter(type => type === 'task.assigned').length === 1
    && model.phase === 'delegate' && model.cursor === model.rowTypes.length;
}

/** Both processes observe the empty stream before either caller can commit. */
async function compete(options: { moveBase: boolean; differentEntry: boolean; secondWins: boolean }) {
  const { moveBase, differentEntry, secondWins } = options;
  await withRaceRepository(async fixture => {
    const first = await prepareRequest(fixture);
    const a = await makeBarrier(fixture.controls, 'first');
    const b = await makeBarrier(fixture.controls, 'second');
    const wrap = await gitBarrier(fixture.controls, fixture.repository.checkout);
    const children: Promise<unknown>[] = [];
    const start = <T,>(run: Promise<T>): Promise<T> => {
      children.push(run);
      void run.catch(() => undefined);
      return run;
    };
    try {
      const left = start(fixture.cli(first.cli, wrap(a)));
      const initial = await a.wait();
      expect(initial).toEqual({ status: 0, commit: fixture.repository.baseCommit });
      expect(fixture.ledger().rows).toEqual([]);
      if (moveBase) await fixture.git(['commit', '--allow-empty', '-qm', 'advance base after first observation']);
      if (differentEntry) await fixture.writePlan(textOf(typedTasks([TASKS[0]])) + '\nDifferent approved bytes.\n');
      const second = await prepareRequest(fixture);
      const right = start(fixture.mcp('exarchos_orchestrate', second.mcp, wrap(b)));
      const observed = await b.wait();
      expect(observed).toEqual({ status: 0, commit: await fixture.git(['rev-parse', 'HEAD']) });
      expect(observed.commit === initial.commit).toBe(!moveBase);
      expect(second.intent.approval.designDigest === first.intent.approval.designDigest).toBe(!differentEntry);
      expect(fixture.ledger().rows).toEqual([]);

      const winner = secondWins ? b : a;
      const loser = secondWins ? a : b;
      await winner.release();
      const winningEnvelope = secondWins ? await right : (await left).envelope;
      const receipt = data(winningEnvelope);
      expect(receipt).toMatchObject({
        capsuleVersion: 1,
        capsule: { settlementContract: { taskVerification: { [TASKS[0]]: { baseCommit: secondWins ? observed.commit : initial.commit } } } },
      });
      const before = fixture.ledger();
      expect(accepted(stateOf(fixture))).toBe(true);
      expect(before.operations).toMatchObject([{ key: receipt.operationId, result: receipt }]);
      expect(before.operations[0]?.sequences).toEqual(before.rows.map(row => row.sequence));

      await loser.release();
      const losingEnvelope = secondWins ? (await left).envelope : await right;
      if (differentEntry) {
        expect(losingEnvelope).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
        const fresh = await fixture.cli((secondWins ? first : second).cli);
        expect(fresh.exitCode).not.toBe(0);
        expect(fresh.envelope).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
      } else {
        expect(data(losingEnvelope)).toEqual(receipt);
      }
      expect(fixture.ledger()).toEqual(before);
      expect(accepted({ ...stateOf(fixture), cursor: Number(receipt.tailSequence) - 1 })).toBe(false);
    } finally {
      await Promise.all([a.release(), b.release()]);
      await Promise.allSettled(children);
    }
  });
}

describe.skipIf(process.platform === 'win32')('packaged bootstrap schedules', () => {
  it('Race_SameEntryDifferentObservations_OneWinningReceipt', async () => {
    await compete({ moveBase: true, differentEntry: false, secondWins: true });
  }, PROCESS_TIMEOUT);

  it('Race_SameEntrySameObservations_OneWinningReceipt', async () => {
    await compete({ moveBase: false, differentEntry: false, secondWins: false });
  }, PROCESS_TIMEOUT);

  it('Race_DifferentEntry_LoserConflicts', async () => {
    await compete({ moveBase: false, differentEntry: true, secondWins: false });
  }, PROCESS_TIMEOUT);

  it('Race_BoundedSchedules_MatchSingleCommitModel', async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      moveBase: fc.boolean(), differentEntry: fc.boolean(), secondWins: fc.boolean(),
    }), compete), { seed: 192714, numRuns: 3 });
  }, PROCESS_TIMEOUT);

  it.each([false, true])('Race_PrecommitLookupError_RechecksOnlyForAnAcceptedWinner (winner %s)', async wins => {
    await withRaceRepository(async fixture => {
      const request = await prepareRequest(fixture);
      const hold = await makeBarrier(fixture.controls, 'failed-base-read');
      const wrap = await gitBarrier(fixture.controls, fixture.repository.checkout);
      await fixture.git(['update-ref', '-d', 'refs/heads/integration']);
      const pending = fixture.cli(request.cli, wrap(hold));
      void pending.catch(() => undefined);
      try {
        expect(await hold.wait()).toEqual({ status: 1, commit: '' });
        expect(fixture.ledger().rows).toEqual([]);
        await fixture.git(['update-ref', 'refs/heads/integration', fixture.repository.baseCommit]);
        const winner = wins ? data(await fixture.mcp('exarchos_orchestrate', request.mcp)) : undefined;
        await hold.release();
        const result = await pending;
        if (winner === undefined) {
          expect(result.exitCode).not.toBe(0);
          expect(result.envelope).toMatchObject({ success: false, error: { code: 'BASE_UNRESOLVED' } });
          expect(fixture.ledger()).toEqual({ rows: [], operations: [], document: undefined });
        } else {
          expect(result.exitCode).toBe(0);
          expect(data(result.envelope)).toEqual(winner);
          expect(accepted(stateOf(fixture))).toBe(true);
        }
      } finally {
        await hold.release();
        await Promise.allSettled([pending]);
      }
    });
  }, PROCESS_TIMEOUT);

  it('Race_ApprovedFileEdit_UsesCapturedBytesAndRequiresNewApproval', async () => {
    await withRaceRepository(async fixture => {
      const original = await prepareRequest(fixture);
      const hold = await makeBarrier(fixture.controls, 'approved-file');
      const wrap = await gitBarrier(fixture.controls, fixture.repository.checkout);
      const pending = fixture.cli(original.cli, wrap(hold));
      void pending.catch(() => undefined);
      try {
        expect(await hold.wait()).toMatchObject({ commit: fixture.repository.baseCommit });
        expect(fixture.ledger().rows).toEqual([]);
        await fixture.writePlan(original.bytes.toString() + '\nEdited after approval.\n');
        await hold.release();
        const first = data((await pending).envelope);
        expect(first.capsule).toMatchObject({ provenance: { sources: expect.arrayContaining([
          { sourceId: 'design-record', digest: digest(original.bytes) },
        ]) } });
        const before = fixture.ledger();
        const compile = await prepareRequest(fixture, { mode: 'compile' });
        const stale = { ...compile.mcp, intent: { ...compile.intent, approval: original.intent.approval } };
        expect(await fixture.mcp('exarchos_orchestrate', stale)).toMatchObject({
          success: false, error: { code: 'DESIGN_APPROVAL_MISMATCH' },
        });
        expect(fixture.ledger()).toEqual(before);
        const next = data((await fixture.cli(compile.cli)).envelope);
        expect(next.capsuleVersion).toBe(2);
        expect(next.capsule).toMatchObject({ provenance: { sources: expect.arrayContaining([
          { sourceId: 'design-record', digest: digest(compile.bytes) },
        ]) } });
        await unlink(path.join(fixture.repository.checkout, PLAN));
        expect(data(await fixture.mcp('exarchos_orchestrate', original.mcp))).toEqual(first);
        expect(prepareRows(fixture.ledger().rows)).toHaveLength(2);
        expect(fixture.ledger().rows.some(row => row.type === 'design.revised')).toBe(false);
      } finally {
        await hold.release();
        await Promise.allSettled([pending]);
      }
    });
  }, PROCESS_TIMEOUT);
});

function representsMove(document: Record<string, unknown> | undefined, target: unknown, attempt: unknown, cursor: unknown): boolean {
  return document?.phase === target && document?.phaseAttemptId === attempt && document?._eventSequence === cursor;
}

describe('packaged compatibility document repair', () => {
  it('Race_RepairAfterLaterMove_KeepsLaterAttempt', async () => {
    await withRaceRepository(async fixture => {
      const request = await prepareRequest(fixture, { workflowType: 'release-check' });
      expect((await fixture.cli(['event', 'query', '--stream', STREAM])).exitCode).toBe(0);
      changeDatabase(fixture.database, `CREATE TRIGGER refuse_s6_document BEFORE INSERT ON workflow_state
        WHEN NEW.featureId = 's6-process-race' BEGIN SELECT RAISE(ABORT, 'fixture insert refused'); END`);
      const refused = await fixture.cli(request.cli);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.envelope).toMatchObject({ success: false, error: { code: 'STATE_SYNC_FAILED', message: expect.stringContaining('fixture insert refused') } });
      const failed = fixture.ledger();
      expect(failed.document).toBeUndefined();
      expect(failed.operations).toHaveLength(1);
      const claim = failed.operations[0];
      if (claim === undefined) throw new Error('Missing accepted bootstrap claim');
      expect(prepareRows(failed.rows)).toHaveLength(1);
      expect(failed.rows[0]).toMatchObject({ schemaVersion: '1.1', data: { initialPhase: 'build' } });

      changeDatabase(fixture.database, 'DROP TRIGGER refuse_s6_document');
      expect(data(await fixture.mcp('exarchos_orchestrate', request.mcp))).toEqual(claim.result);
      const id = TASKS[0];
      const worktreePath = await fixture.repository.worktreeFor(id, { [`src/${id}.js`]: 'export const value = 1;\n' });
      const settled = data((await fixture.cli(settleArgs(claim.result.capsuleVersion, [
        { taskId: id, fields: { worktreePath, files: [`src/${id}.js`] }, evidence: [] },
      ]))).envelope);
      const move = record(settled.phaseMove);
      expect(move).toMatchObject({ kind: 'moved', from: 'build', to: 'verify', phaseAttemptId: expect.any(String) });
      const advanced = fixture.ledger();
      expect(advanced.document).toMatchObject({ phase: 'verify', phaseAttemptId: move.phaseAttemptId });
      changeDatabase(fixture.database, 'DELETE FROM workflow_state WHERE featureId = ?', STREAM);
      expect(fixture.ledger().document).toBeUndefined();
      const recovered = data(await fixture.mcp('exarchos_orchestrate', request.mcp));
      expect(recovered).toEqual(claim.result);
      const final = fixture.ledger();
      expect(final.rows).toEqual(advanced.rows);
      expect(final.operations).toEqual(advanced.operations);
      expect(final.document).toMatchObject({
        phase: 'verify', phaseAttemptId: move.phaseAttemptId, _eventSequence: advanced.rows.at(-1)?.sequence,
        tasks: [expect.objectContaining({ id, status: 'complete' })],
      });
      const tail = advanced.rows.at(-1)?.sequence;
      expect(representsMove(final.document, move.to, move.phaseAttemptId, tail)).toBe(true);
      const seeded = { ...final.document, phase: 'build', phaseAttemptId: failed.rows[0]?.data?.phaseAttemptId };
      expect(representsMove(seeded, move.to, move.phaseAttemptId, tail)).toBe(false);
    });
  }, PROCESS_TIMEOUT);

  it('Acceptance_PackagedHistoricalConstructor_DecodesColdAndRequiresRegistrationForNewStarts', async () => {
    const config = 'exarchos.config.js';
    await withRaceRepository(async fixture => {
      const checkout = fixture.repository.checkout;
      const constructor = {
        initialPhase: 'recorded-local-entry', phases: ['recorded-local-entry', 'completed'],
        transitions: [{ from: 'recorded-local-entry', to: 'completed', event: 'finish' }],
      };
      await writeFile(path.join(checkout, config), `export default { workflows: { ['constructor']: ${JSON.stringify(constructor)} } };\n`);
      const legacy = 'historical-constructor';
      const event = { type: 'workflow.started', data: { featureId: legacy, workflowType: 'constructor' } };
      const append = (stream: string) => ['event', 'append', '--stream', stream, '--event', JSON.stringify({
        ...event, data: { ...event.data, featureId: stream },
      })];
      const registered = await fixture.cli(append(legacy), {}, checkout);
      expect(registered.exitCode, JSON.stringify(registered.envelope)).toBe(0);
      expect(fixture.ledger(legacy).rows).toMatchObject([{ schemaVersion: '1.0', data: event.data }]);
      await unlink(path.join(checkout, config));
      const cold = await fixture.mcp('exarchos_view', { action: 'workflow_status', workflowId: legacy });
      expect(data(cold)).toMatchObject({ workflowType: 'constructor', phase: 'started' });
      const hydrated = await fixture.mcp('exarchos_workflow', { action: 'rehydrate', featureId: legacy });
      expect(data(hydrated)).toMatchObject({ workflowState: { workflowType: 'constructor', phase: '' } });
      const unregistered = await fixture.cli(append('unregistered-constructor'), {}, checkout);
      expect(unregistered.exitCode).not.toBe(0);
      expect(unregistered.envelope).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
      expect(fixture.ledger('unregistered-constructor').rows).toEqual([]);
    });
  }, PROCESS_TIMEOUT);

  it('Race_BoundedBootstrapContention_RecordsFreshAndReplayTimings', async () => {
    await withRaceRepository(async fixture => {
      const request = await prepareRequest(fixture);
      const fresh = await fixture.cli(request.cli);
      const first = data(fresh.envelope);
      const serial = [];
      for (let i = 0; i < 3; i++) serial.push(await fixture.cli(request.cli));
      const parallelStart = performance.now();
      const samples = await Promise.all(Array.from({ length: 3 }, () => fixture.cli(request.cli)));
      const parallelWallMs = Math.round(performance.now() - parallelStart);
      expect([...serial, ...samples].map(sample => data(sample.envelope))).toEqual(Array.from({ length: 6 }, () => first));
      expect(accepted(stateOf(fixture))).toBe(true);
      console.log(JSON.stringify({
        scenario: 'one fresh bootstrap, three serial replays, three concurrent replays',
        freshMs: fresh.durationMs,
        serialMs: serial.map(sample => sample.durationMs),
        parallelMs: samples.map(sample => sample.durationMs),
        parallelWallMs,
      }));
    });
  }, PROCESS_TIMEOUT);
});
