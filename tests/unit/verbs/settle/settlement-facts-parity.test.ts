// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the by-hand primitive baseline this file drives — the same compiled task-completion leaves invoked one at a time through the orchestrate handler table, once per task, against a SECOND event store seeded identically, whose rows and state document are compared verbatim with what one settle call leaves
//
// Composition parity for `settle`: a settled batch leaves the same durable facts and state as completing each task by hand with the task-completion runbook.
// Settlement has no verification of its own. It runs the executor segment, and the executor runs the registered leaves.
// Each path runs on its own seeded store. The test compares the leaf rows, the folded workflow projection, and the task statuses on the state document.
//
// The comparison excludes the operation id, because settlement derives one per task from the batch.
// It also excludes the ids and digests derived from it, and wall-clock, store-allocated, and correlation values.
//
// Parity covers two of the five leaves: `check_mock_boundary` and `task_complete`. The other three run git and the project toolchain.
// Both stores hold the `static-analysis` gate result that `task_complete` requires, so the two streams differ only by the path that completed the tasks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import { compileIntent } from '../../../../src/verbs/execute/compile.js';
import { INTENT_EXECUTED_EVENT, type ExecuteIntentDeps } from '../../../../src/verbs/execute/executor.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { initStateFile, readStateFile } from '../../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';

const STREAM = 'feat-settlement-parity';
const TASK_IDS = ['task-one', 'task-two'] as const;
const WORKTREE = '/nonexistent-parity-worktree';
/** The integration branch that the plan tasks fork from. `prepare` freezes it as the base of each task. */
const INTEGRATION_BRANCH = 'feature/settlement-parity';
/** Stamped on the plan so the one gate the cut runbook carries is IN the resolved sequence, not policy-skipped. */
const STAMP = { riskTier: 'medium', boundaryTouching: true } as const;
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];
/** The plane's own records, which the primitive path never writes and the comparison sets aside. */
const PLANE_RECORDS = new Set(['workflow.prepared', 'execution.settled', INTENT_EXECUTED_EVENT]);

const EXCLUDED_KEYS = new Set([
  'operationId',
  'correlationId',
  'causationId',
  'evidenceId',
  'supersedesEvidenceId',
  'evidenceIds',
  'artifactId',
  'invocationId',
  'contentDigest',
  'policyDigest',
  'digest',
  'timestamp',
  'createdAt',
  /** The projection folds `updatedAt`, `completedAt`, and `resolvedAt` from the timestamp of each fact. */
  'updatedAt',
  'completedAt',
  'resolvedAt',
  'eventId',
  'sequence',
  'idempotencyKey',
  'durationMs',
]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    out[key] = normalize(inner);
  }
  return out;
}

/**
 * Sorts each array, so that the comparison treats it as a set.
 * The projection keys its evidence by evidence id, an excluded operation-derived hash, so that id decides the array order.
 * The leaf-facts test proves the row order. This comparison checks the folded state as content.
 */
function orderless(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(orderless)
      .sort((a, b) => {
        const left = JSON.stringify(a);
        const right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = orderless(inner);
  }
  return out;
}

/** The leaf facts one path left, in order, with the plane's own records set aside. */
function leafFacts(events: readonly WorkflowEvent[]): unknown[] {
  return events
    .filter((event) => !PLANE_RECORDS.has(event.type))
    .map((event) => normalize({ type: event.type, streamId: event.streamId, data: event.data }));
}

function noShellTaskCompletion(): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
  if (shipped === undefined) throw new Error('the task-completion runbook is missing');
  const steps = shipped.steps.filter((step) => NO_SHELL_LEAVES.includes(step.action));
  expect(steps.map((step) => step.action)).toEqual(NO_SHELL_LEAVES);
  return { ...shipped, steps };
}

/** Uses the live orchestrate handler table, which the composite also gives `settle`, so both paths reach the same handlers. */
function executeDeps(): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    handlers: ACTION_HANDLERS,
    handlerTool: 'exarchos_orchestrate',
  };
}

let baselineDir: string;
let settleDir: string;
let baselineStore: EventStore;
let settleStore: EventStore;

async function seed(dir: string, store: EventStore): Promise<void> {
  const tasks = TASK_IDS.map((id) => ({ id, title: id, status: 'in_progress', blockedBy: [], ...STAMP }));
  await initStateFile(dir, STREAM, 'feature', { phase: 'delegate', tasks });
  await seedActivePhaseAttempt(store, STREAM);
  await store.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks } },
  });
  for (const taskId of TASK_IDS) {
    await store.append(STREAM, {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId } },
    });
  }
}

beforeEach(async () => {
  baselineDir = await mkdtemp(path.join(tmpdir(), 'settlement-parity-base-'));
  settleDir = await mkdtemp(path.join(tmpdir(), 'settlement-parity-settle-'));
  baselineStore = new EventStore(baselineDir);
  settleStore = new EventStore(settleDir);
  await baselineStore.initialize();
  await settleStore.initialize();
  await seed(baselineDir, baselineStore);
  await seed(settleDir, settleStore);
});

afterEach(async () => {
  baselineStore.close();
  settleStore.close();
  await rmrfAsync(baselineDir);
  await rmrfAsync(settleDir);
});

function wiring(stateDir: string, eventStore: EventStore): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false };
}

function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settlement-parity' });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)),
  );
}

/**
 * The primitive baseline: the registered handlers in runbook order, once per task, as an orchestrator that follows the runbook does.
 * The arguments are the ones that the compiler builds from what the capsule freezes.
 * The baseline first appends one `task.assigned` row per task. The plane compilation leaves the same rows, so the comparison includes them.
 */
async function completeByHand(): Promise<void> {
  const ctx = wiring(baselineDir, baselineStore);
  for (const taskId of TASK_IDS) {
    await baselineStore.append(STREAM, { type: 'task.assigned', data: { taskId, title: taskId } });
  }
  for (const taskId of TASK_IDS) {
    const compiled = compileIntent(
      'task-completion',
      { streamId: STREAM },
      { taskId, worktreePath: WORKTREE, ...STAMP, baseRef: INTEGRATION_BRANCH, result: { worktreePath: WORKTREE } },
      executeDeps(),
    );
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    if (!compiled.ok) return;
    await runWithDispatchContext(correlation(), async () => {
      for (const leaf of compiled.segment.leaves) {
        const handler = ACTION_HANDLERS[leaf.action];
        expect(handler).toBeTypeOf('function');
        const result = await handler?.(leaf.args, ctx.stateDir, ctx);
        expect(result?.success, JSON.stringify(result)).toBe(true);
      }
    });
  }
}

/** The plane: one prepare, one settle, every task claimed with its worktree. */
async function settleTheBatch(): Promise<void> {
  const ctx = wiring(settleDir, settleStore);
  const prepared = await runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: STREAM }, settleDir, ctx, { catalogInvariants: () => [] }),
  );
  expect(prepared.success, JSON.stringify(prepared)).toBe(true);
  const { capsuleVersion } = prepared.data as { capsuleVersion: number };
  const settled = await runWithDispatchContext(correlation(), () =>
    handleSettle(
      {
        featureId: STREAM,
        capsuleVersion,
        batchId: 'batch-parity',
        claims: TASK_IDS.map((taskId) => ({ taskId, fields: { worktreePath: WORKTREE }, evidence: [] })),
      },
      settleDir,
      ctx,
      { execute: executeDeps() },
    ),
  );
  expect(settled.success, JSON.stringify(settled)).toBe(true);
  expect((settled.data as { outcome: string }).outcome).toBe('settled');
}

async function taskStatuses(dir: string): Promise<[string, string][]> {
  const state = await readStateFile(path.join(dir, `${STREAM}.state.json`));
  return (state.tasks as { id: string; status: string }[]).map((t) => [t.id, t.status]);
}

describe('settlement composition — parity with completing each task by hand', () => {
  /**
   * After the seeded prelude, both paths leave the gate evidence, the gate signal, and the completion, once per task, in that order.
   * The settled store also holds the plane records: `workflow.prepared`, one segment record per task, and the settlement that reads them.
   */
  it('SettlementParity_ASettledBatch_LeavesTheSameLeafFacts', async () => {
    await completeByHand();
    await settleTheBatch();

    const baseline = leafFacts(await baselineStore.query(STREAM));
    const settled = leafFacts(await settleStore.query(STREAM));
    expect(settled).toEqual(baseline);

    const types = (await baselineStore.query(STREAM)).map((event) => event.type);
    expect(types.slice(-3 * TASK_IDS.length)).toEqual(
      TASK_IDS.flatMap(() => ['admission.evidence-recorded', 'gate.executed', 'task.completed']),
    );
    const plane = (await settleStore.query(STREAM)).filter((event) => PLANE_RECORDS.has(event.type)).map((e) => e.type);
    expect(plane).toEqual(['workflow.prepared', INTENT_EXECUTED_EVENT, INTENT_EXECUTED_EVENT, 'execution.settled']);
  });

  it('SettlementParity_ASettledBatch_LeavesTheSameWorkflowProjection', async () => {
    await completeByHand();
    await settleTheBatch();

    const project = async (store: EventStore): Promise<unknown> => {
      const { workflowStateProjection } = await import(
        '../../../../src/projections/views/workflow-state-projection.js'
      );
      let view = workflowStateProjection.init();
      for (const event of await store.query(STREAM)) {
        if (event.type === INTENT_EXECUTED_EVENT) continue;
        view = workflowStateProjection.apply(view, event);
      }
      return orderless(normalize(view));
    };

    expect(await project(settleStore)).toEqual(await project(baselineStore));
  });

  it('SettlementParity_ASettledBatch_LeavesTheSameStateDocument', async () => {
    await completeByHand();
    await settleTheBatch();

    const baseline = await taskStatuses(baselineDir);
    expect(baseline).toEqual([
      ['task-one', 'complete'],
      ['task-two', 'complete'],
    ]);
    expect(await taskStatuses(settleDir)).toEqual(baseline);
  });
});
