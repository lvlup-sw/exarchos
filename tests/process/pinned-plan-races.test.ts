/**
 * Runs competing packaged prepare, transition and settle calls against one private store.
 * @oracle-sources: The original bundle bytes, segment claims and durable phase rows.
 */
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RUN_BUNDLE_DIRNAME } from '../../src/utils/paths.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { textOf } from '../helpers/capsule/prepared-authority.js';
import { runCli } from '../helpers/cli-runner.js';
import {
  DRIVER, STREAM, TASKS, data, makeBarrier, prepareRequest, prepareRows, record,
  settleArgs, typedTasks, withRaceRepository, type RaceRepository,
} from '../helpers/capsule/s6-process-race.js';

const PROCESS_TIMEOUT = 100_000;
const WORKFLOW_TYPE = 'release-check';
const MOVE = ['workflow', 'transition', '--feature-id', STREAM, '--target', 'verify'];

function taskFiles(id: string, value: number) {
  const module = `src/${id}.js`;
  return {
    [module]: `export const value = ${value};\n`,
    [`tests/${id}.test.js`]: `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from '../${module}';\ntest('value', () => assert.equal(value, 2));\n`,
  };
}

async function worktree(fixture: RaceRepository, id: string) {
  return fixture.repository.worktreeFor(id, taskFiles(id, 2));
}

async function completeOverCli(fixture: RaceRepository, id: string, capsuleVersion: unknown) {
  const worktreePath = await worktree(fixture, id);
  const checked = await fixture.cli([
    'orchestrate', 'check_static_analysis', '--feature-id', STREAM, '--task-id', id, '--repo-root', 'auto', '--worktree-path', worktreePath,
  ]);
  expect(checked.exitCode, JSON.stringify(checked.envelope)).toBe(0);
  data(checked.envelope);
  const completed = await fixture.cli([
    'orchestrate', 'task_complete', '--feature-id', STREAM, '--task-id', id, '--capsule-version', String(capsuleVersion),
    '--result', JSON.stringify({ worktreePath, files: [`src/${id}.js`] }),
  ]);
  expect(completed.exitCode, JSON.stringify(completed.envelope)).toBe(0);
  data(completed.envelope);
}

function phaseMoveAllowed(changed: boolean, moves: number): boolean {
  return moves === (changed ? 0 : 1);
}

function transitionRows(fixture: RaceRepository) {
  return fixture.ledger().rows.filter(row => row.type === 'workflow.transition');
}

function preparedPath(fixture: RaceRepository, receipt: Record<string, unknown>): string {
  const refs = receipt.bundleRefs;
  if (!Array.isArray(refs) || refs.length !== 1) throw new Error('Expected one prepared bundle');
  const digest = record(record(refs[0]).digest);
  const { value } = digest;
  if (digest.algorithm !== 'sha256' || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Expected a SHA-256 bundle digest');
  }
  return path.join(fixture.stateDir, RUN_BUNDLE_DIRNAME, 'sha256', value.slice(0, 2), value.slice(2));
}

describe('packaged prepared authority', () => {
  it.skipIf(process.platform !== 'linux')('Race_NewPinDuringTransition_RejectsOldPlanAdmission', async () => {
    const id = TASKS[0];
    await withRaceRepository(async fixture => {
      const request = await prepareRequest(fixture, { workflowType: WORKFLOW_TYPE });
      const original = data((await fixture.cli(request.cli)).envelope);
      await completeOverCli(fixture, id, original.capsuleVersion);
      expect(transitionRows(fixture)).toEqual([]);
      expect(fixture.ledger().rows.filter(row => row.type === 'task.completed')).toMatchObject([{ data: { taskId: id } }]);

      const bundle = preparedPath(fixture, original);
      const bytes = await readFile(bundle);
      const hold = await makeBarrier(fixture.controls, 'selected-old-custody');
      await rename(bundle, `${bundle}.original`);
      await execFileAsync('mkfifo', [bundle], { timeout: 3000 });
      const writer = runCli({ command: process.execPath, args: [DRIVER, 'fifo', bundle, hold.directory, bytes.toString('base64')], timeout: 30_000 });
      void writer.catch(() => undefined);
      const move = fixture.cli(MOVE);
      void move.catch(() => undefined);
      try {
        expect(await hold.wait()).toEqual({ fifo: bundle });
        await rename(bundle, `${bundle}.fixture-fifo`);
        await rename(`${bundle}.original`, bundle);
        expect(await readFile(bundle)).toEqual(bytes);
        await fixture.writePlan(textOf(typedTasks(TASKS)));
        const updated = await prepareRequest(fixture, { workflowType: WORKFLOW_TYPE, mode: 'compile' });
        const newer = data((await fixture.cli(updated.cli)).envelope);
        expect(newer).toMatchObject({ capsuleVersion: 2, capsule: { graph: { tasks: [{ taskId: TASKS[1] }] } } });
        expect(transitionRows(fixture)).toEqual([]);
        await hold.release();
        const transfer = await writer;
        expect(transfer.exitCode, transfer.stderr).toBe(0);
        const refused = await move;
        expect(transitionRows(fixture)).toEqual([]);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.envelope).toMatchObject({ success: false, error: { code: 'GUARD_FAILED' } });
        expect(fixture.ledger().document).toMatchObject({ phase: 'build' });
        expect(prepareRows(fixture.ledger().rows)).toHaveLength(2);
      } finally {
        await hold.release();
        await Promise.allSettled([move, writer]);
      }
    });
  }, PROCESS_TIMEOUT);

  it.each([false, true])('Race_NewPinAfterTaskSegment_NoUnsafeMove (changed pin %s)', async changed => {
    await withRaceRepository(async fixture => {
      const request = await prepareRequest(fixture, { workflowType: WORKFLOW_TYPE });
      const first = data((await fixture.cli(request.cli)).envelope);
      const trees = await Promise.all(TASKS.map(id => worktree(fixture, id)));
      const claims = TASKS.map((id, index) => ({ taskId: id, fields: { worktreePath: trees[index], files: [`src/${id}.js`] }, evidence: [] }));
      const hold = await makeBarrier(fixture.controls, 'second-task-integration');
      const args = settleArgs(first.capsuleVersion, claims);
      const pending = fixture.cli(args, { S6_BARRIER: hold.directory });
      void pending.catch(() => undefined);
      try {
        expect(await hold.wait()).toEqual({ tree: trees[1], gate: 'integration-suite' });
        const midway = fixture.ledger();
        const segmentBefore = midway.operations.filter(op => op.key.startsWith('settle-task:'));
        expect(segmentBefore).toHaveLength(1);
        expect(midway.rows.filter(row => row.type === 'task.completed').map(row => row.data?.taskId)).toEqual([TASKS[0]]);
        expect(midway.rows.filter(row => row.type === 'execution.settled')).toEqual([]);
        expect(transitionRows(fixture)).toEqual([]);
        if (changed) {
          await fixture.writePlan(request.bytes.toString() + '\nNewly approved plan text.\n');
          const updated = await prepareRequest(fixture, { workflowType: WORKFLOW_TYPE, mode: 'compile' });
          const next = data((await fixture.cli(updated.cli)).envelope);
          expect(next).toMatchObject({ capsuleVersion: 2, capsule: { graph: { tasks: [{ taskId: TASKS[1] }] } } });
        }
        await hold.release();
        const settled = data((await pending).envelope);
        expect(settled).toMatchObject({ outcome: 'settled', acceptedTasks: TASKS });
        const expectedMove = changed ? { kind: 'not-decided', reason: 'prepared-authority-mismatch' } : { kind: 'moved', from: 'build', to: 'verify' };
        expect(settled.phaseMove).toMatchObject(expectedMove);
        const final = fixture.ledger();
        expect(final.operations.filter(op => op.key.startsWith('settle-task:'))).toHaveLength(2);
        expect(final.operations).toContainEqual(segmentBefore[0]);
        expect(final.rows.filter(row => row.type === 'task.completed').map(row => row.data?.taskId)).toEqual(TASKS);
        expect(final.rows.filter(row => row.type === 'execution.settled')).toHaveLength(1);
        expect(phaseMoveAllowed(changed, transitionRows(fixture).length)).toBe(true);
        expect(phaseMoveAllowed(true, 1)).toBe(false);
        const runnerRows = final.rows.filter(row => row.type === 'gate.executed');
        expect(runnerRows.length).toBeGreaterThan(0);
        for (const id of TASKS) {
          const names = runnerRows.filter(row => record(row.data?.details).taskId === id).map(row => row.data?.gateName);
          expect(names.length).toBeGreaterThan(0);
          expect(names).toHaveLength(new Set(names).size);
        }
        const replay = data((await fixture.cli(args)).envelope);
        expect(replay).toEqual(settled);
        const repeated = fixture.ledger();
        expect(repeated.rows).toEqual(final.rows);
        expect(repeated.operations).toEqual(final.operations);
        expect(repeated.document).toMatchObject({
          phase: final.document?.phase, phaseAttemptId: final.document?.phaseAttemptId, _eventSequence: final.document?._eventSequence,
        });
      } finally {
        await hold.release();
        await Promise.allSettled([pending]);
      }
    }, {
      plan: textOf(typedTasks(TASKS, [TASKS[1]])),
      files: {
        'package.json': JSON.stringify({
          type: 'module', scripts: { lint: 'node -e ""', typecheck: 'node -e ""', 'test:files': 'node --test', 'test:run': 'node scripts/barrier.mjs suite' },
        }),
        'scripts/barrier.mjs': await readFile(DRIVER, 'utf8'),
        ...Object.fromEntries(TASKS.map(id => [`src/${id}.js`, 'export const value = 1;\n'])),
      },
    });
  }, PROCESS_TIMEOUT);
});
