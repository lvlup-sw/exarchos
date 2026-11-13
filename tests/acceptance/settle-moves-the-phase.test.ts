/**
 * A settle moves the phase of a feature workflow through the real dispatcher, real git and the SQLite store.
 *
 * Each case starts a feature workflow through the workflow actions, plans two tasks and moves to `delegate`. Then it prepares
 * the batch and settles it with a claim on the linked worktree of each task. The commit moves the phase to `review`.
 *
 * Each call keeps the shipped defaults. Telemetry is on, and real git observes the repository of `repoRoot` and each claimed
 * worktree. The state document is the `workflow_state` row of the SQLite backend. The telemetry wrapper can append a gate row
 * after each call, so each case reads the rows by type. Each case spawns git, so it sets its own timeout.
 *
 * @oracle-sources: ../../src/verbs/settle/handler.ts, the rows and the state document that the real store holds after each dispatched call
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { foldWorkflowState } from '../../src/projections/guard-input/fold.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { configureStateStoreBackend } from '../../src/workflow/state-store.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../helpers/scoped-repository.js';

/** The stream of each case. */
const STREAM = 'settle-moves-the-phase';

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/settle-moves-the-phase';

/** The design record of the plan, relative to the checkout. */
const DESIGN_RECORD = 'design/settle-moves-the-phase.md';

/** The budget of one case. Each case spawns git for the repository, each worktree and each gate. */
const CASE_TIMEOUT_MS = 90_000 * WIN32_SPAWN_HEADROOM;

/** A real npm script that exits 0. */
const OK = 'node -e ""';

/** The ids of the two ready tasks of the plan. */
const TASK_IDS: readonly string[] = ['task-a', 'task-b'];

/** The row types of a plain move, in the order of the commit. */
const MOVE_ROW_TYPES: readonly string[] = ['workflow.transition', 'phase.exited', 'phase.entered'];

let stateDir: string;
let backend: SqliteBackend;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-moves-the-phase-'));
  backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
  configureStateStoreBackend(backend);
  repository = await scopedRepository({
    integrationBranch: INTEGRATION_BRANCH,
    files: {
      'package.json': JSON.stringify(
        { name: 'settle-moves-the-phase', version: '1.0.0', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } },
        null,
        2,
      ),
      [DESIGN_RECORD]: '# Settle moves the phase\n\nThe design record of the acceptance walk.\n',
    },
  });
  scratchDirs.push(repository.root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  configureStateStoreBackend(undefined);
  eventStore.close();
  backend.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** The dispatch context of an agent with the shipped defaults: telemetry on, and no seam that replaces git. */
function shippedContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'settle-moves-the-phase-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

type CallResult = z.infer<typeof CallResultSchema>;

/** One call through the dispatcher, with the context of the case. */
async function call(tool: string, args: Record<string, unknown>, context: DispatchContext): Promise<CallResult> {
  return CallResultSchema.parse(await dispatch(tool, { featureId: STREAM, ...args }, context));
}

/** One call that must succeed. */
async function succeed(tool: string, args: Record<string, unknown>, context: DispatchContext): Promise<CallResult> {
  const result = await call(tool, args, context);
  expect(result.success, `${tool} ${JSON.stringify(args)}: ${JSON.stringify(result)}`).toBe(true);
  return result;
}

/** The fields of a prepare receipt that the cases read. */
const PreparedView = z.object({ capsuleVersion: z.number().int() });

/** The fields of a settle receipt that the cases read. */
const SettledView = z.object({
  outcome: z.string(),
  tailSequence: z.number().int(),
  phaseMove: z.object({ kind: z.string() }).passthrough().optional(),
});

/** The fields of an idempotent transition reply that the cases read. */
const TransitionView = z.object({ phase: z.string(), idempotent: z.boolean().optional() }).passthrough();

/**
 * Starts a feature workflow, plans two ready tasks and moves to `delegate`, each step through the workflow actions.
 * Then it prepares the batch at the checkout of the repository and returns the capsule version.
 */
async function walkToAPreparedBatch(context: DispatchContext): Promise<number> {
  await succeed('exarchos_workflow', { action: 'init', workflowType: 'feature' }, context);
  await succeed('exarchos_workflow', { action: 'update', updates: { 'artifacts.plan': DESIGN_RECORD } }, context);
  await succeed('exarchos_workflow', { action: 'transition', target: 'plan-review' }, context);
  await succeed('exarchos_workflow', { action: 'update', updates: { planReview: { approved: true } } }, context);
  await succeed('exarchos_workflow', { action: 'transition', target: 'delegate' }, context);
  const tasks = TASK_IDS.map((id) => ({ id, title: id, status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }));
  await succeed('exarchos_workflow', { action: 'update', updates: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks } }, context);
  const prepared = await succeed('exarchos_orchestrate', { action: 'prepare', repoRoot: repository.checkout }, context);
  return PreparedView.parse(prepared.data).capsuleVersion;
}

/** One settle call of the batch, with a claim on the linked worktree of each task. */
async function settle(context: DispatchContext, capsuleVersion: number): Promise<z.infer<typeof SettledView>> {
  const claims: Record<string, unknown>[] = [];
  for (const taskId of TASK_IDS) {
    claims.push({ taskId, fields: { worktreePath: await repository.worktreeFor(taskId), files: [`src/${taskId}.ts`] }, evidence: [] });
  }
  const settled = await succeed('exarchos_orchestrate', { action: 'settle', capsuleVersion, batchId: 'batch-1', claims }, context);
  return SettledView.parse(settled.data);
}

/** The rows of one type on the stream, in commit order. */
async function rowsOf(type: string): Promise<Awaited<ReturnType<EventStore['query']>>> {
  return eventStore.query(STREAM, { type });
}

/** The state document of the stream, read through the SQLite backend. */
function documentOf(): Record<string, unknown> {
  const state = backend.getState(STREAM);
  if (state === null) throw new Error(`the store holds no document for '${STREAM}'`);
  return { ...state };
}

/** A copy of a value with no `phaseMove` key at any depth, as a build before the phase move wrote it. */
function withoutPhaseMove<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key: string, entry: unknown) => (key === 'phaseMove' ? undefined : entry));
}

/** Copies an older receipt and corrects its tail after removal of the phase rows. */
function earlierResult<T>(value: T, tailSequence: number): T {
  const result = withoutPhaseMove(value);
  if (typeof result !== 'object' || result === null || !('tailSequence' in result)) return result;
  return { ...result, tailSequence };
}

/** Makes each settle commit write what a build before the phase move wrote: no phase row and no `phaseMove`. */
function commitAsAnEarlierBuild(): void {
  const appender = eventStore.getAppender();
  const commit = appender.decideOnce.bind(appender);
  vi.spyOn(appender, 'decideOnce').mockImplementation(async (operationId, requestDigest, closure) => {
    if (!operationId.startsWith('settle:')) return commit(operationId, requestDigest, closure);
    return commit(operationId, requestDigest, (tx) => {
      const decision = closure(tx);
      const events = decision.events.filter((event) => !MOVE_ROW_TYPES.includes(event.type));
      const tail = tx.readStream(decision.streamId).version + events.length;
      return {
        ...decision,
        events,
        result: earlierResult(decision.result, tail),
      };
    });
  });
}

describe('a settle moves the phase of the stream', () => {
  /**
   * The settle moves `delegate -> review` and levels the document. A later `transition` to `review` through the dispatcher is
   * idempotent. It succeeds with no emission violation and appends no `workflow.transition` row.
   */
  it('SettleMovesThePhase_ThenTransition_IsIdempotentThroughDispatch', async () => {
    const context = shippedContext();
    const capsuleVersion = await walkToAPreparedBatch(context);
    const settled = await settle(context, capsuleVersion);
    expect(settled.outcome).toBe('settled');
    expect(settled.phaseMove).toMatchObject({ kind: 'moved', from: 'delegate', to: 'review' });
    expect(documentOf().phase).toBe('review');
    const transitions = (await rowsOf('workflow.transition')).length;

    const moved = await succeed('exarchos_workflow', { action: 'transition', target: 'review' }, context);

    expect(TransitionView.parse(moved.data)).toMatchObject({ phase: 'review', idempotent: true });
    expect(await rowsOf('workflow.transition')).toHaveLength(transitions);
    expect(await rowsOf('emission.violated')).toHaveLength(0);
  }, CASE_TIMEOUT_MS);

  /**
   * The case writes the document back to `delegate`, with `_eventSequence` at the tail before the settle rows. So the document
   * misses the level, as a document of an earlier build does. A reconcile folds the settle rows, and the document reaches `review`.
   */
  it('SettleMovesThePhase_ThenReconcile_KeepsThePhase', async () => {
    const context = shippedContext();
    const capsuleVersion = await walkToAPreparedBatch(context);
    const settled = await settle(context, capsuleVersion);
    expect(settled.phaseMove).toMatchObject({ kind: 'moved', to: 'review' });
    const settleRow = (await rowsOf('workflow.transition')).find((row) => row.data?.trigger === 'settle');
    if (settleRow === undefined) throw new Error('the stream holds no transition row of the settle');
    const lagging = documentOf();
    const state = backend.getState(STREAM);
    if (state === null) throw new Error('the store holds no document');
    backend.setState(STREAM, { ...state, phase: 'delegate', _eventSequence: settleRow.sequence - 1, _version: (state._version ?? 1) + 1 });
    expect(documentOf().phase).toBe('delegate');
    expect(lagging.phase).toBe('review');

    await succeed('exarchos_workflow', { action: 'reconcile' }, context);

    expect(documentOf().phase).toBe('review');
  }, CASE_TIMEOUT_MS);

  /** The fold of the rows of the stream ends in `review`, and the transition row of the settle comes before the record. */
  it('SettleMovesThePhase_TheFoldOfTheRows_EndsInReview', async () => {
    const context = shippedContext();
    const capsuleVersion = await walkToAPreparedBatch(context);

    const settled = await settle(context, capsuleVersion);

    expect(foldWorkflowState(await eventStore.query(STREAM)).phase).toBe('review');
    const settleRow = (await rowsOf('workflow.transition')).find((row) => row.data?.trigger === 'settle');
    expect(settleRow?.data).toMatchObject({ from: 'delegate', to: 'review' });
    const record = (await rowsOf('execution.settled')).at(-1);
    expect(record?.sequence).toBe(settled.tailSequence);
    expect(settleRow?.sequence ?? Number.POSITIVE_INFINITY).toBeLessThan(record?.sequence ?? 0);
  }, CASE_TIMEOUT_MS);

  /**
   * The claim of the batch holds the result of a build before the phase move, so its replay returns no `phaseMove`. The fallback
   * `transition` then moves the stream to `review` through the dispatcher, with one new `workflow.transition` row.
   */
  it('SettleMovesThePhase_AReplayWithNoPhaseMove_ThenTransition_Moves', async () => {
    const context = shippedContext();
    const capsuleVersion = await walkToAPreparedBatch(context);
    commitAsAnEarlierBuild();
    const first = await settle(context, capsuleVersion);
    const before = await eventStore.query(STREAM);
    expect(first.tailSequence).toBe(before.find((row) => row.type === 'execution.settled')?.sequence);
    vi.restoreAllMocks();
    const replayed = await settle(context, capsuleVersion);
    expect(replayed.outcome).toBe('settled');
    expect(replayed.phaseMove).toBeUndefined();
    expect(replayed.tailSequence).toBe(first.tailSequence);
    const after = await eventStore.query(STREAM);
    expect(after.slice(0, before.length)).toEqual(before);
    const appended = after.slice(before.length);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      streamId: STREAM, type: 'gate.executed', sequence: before.length + 1,
      data: {
        gateName: 'event-emissions', layer: 'observability', passed: false,
        details: { phase: 'delegate', checked: 5, missing: 5, missingTypes: ['team.spawned', 'team.task.planned', 'team.teammate.dispatched', 'team.disbanded', 'task.progressed'] },
      },
    });
    expect(appended[0]?.correlationId).toBe(appended[0]?.operationId);
    expect(appended[0]?.idempotencyKey).toBe(`gate.executed:event-emissions:${appended[0]?.operationId}`);
    expect(after.filter((row) => row.type !== 'gate.executed')).toEqual(before.filter((row) => row.type !== 'gate.executed'));
    const transitions = (await rowsOf('workflow.transition')).length;

    const moved = await succeed('exarchos_workflow', { action: 'transition', target: 'review' }, context);

    expect(TransitionView.parse(moved.data).phase).toBe('review');
    expect(await rowsOf('workflow.transition')).toHaveLength(transitions + 1);
    expect(documentOf().phase).toBe('review');
  }, CASE_TIMEOUT_MS);
});
