// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the by-hand primitive baseline this file drives — the same compiled task-completion leaves invoked one at a time through the orchestrate handler table, once per task, against a SECOND event store seeded identically, whose rows and state document are compared verbatim with what one settle call leaves
//
// ─── Composition parity: settling a batch vs completing each task by hand ───
//
// The claim under test is the plane's replay-equivalence gate stated for one
// intent: a settled batch leaves the SAME durable facts, and the same state,
// as an orchestrator following the task-completion runbook by hand for each
// task. Not similar facts — the same rows, in the same order, on the same
// stream, with the same payload — because settlement does not have a
// verification of its own: it runs the executor's segment, and the executor
// runs the registered leaves.
//
// Two identically seeded stores, one path each, then the facts are compared:
// every leaf row's type, order, stream and payload; the workflow projection
// folded over both; and every task's status on the document the transition
// guards read.
//
// EXCLUDED FROM THE COMPARISON, and why each can never byte-match:
//   - `operationId` — settlement runs each task under an operation derived
//     from the batch; the baseline runs each leaf under one ambient dispatch.
//     That difference is the mechanism under test, not a divergence.
//   - `evidenceId`, `artifactId` and `invocationId` — derived from the
//     operation id, so they move with it by construction.
//   - `contentDigest`, `policyDigest` and every `digest` — content addresses
//     over payloads that include the ids above.
//   - `timestamp`, `createdAt`, `updatedAt`, `eventId`, `sequence`,
//     `idempotencyKey`, `correlationId`, `causationId`, `durationMs` —
//     wall-clock, store-allocated, or correlation scaffolding.
// Everything else is compared verbatim.
//
// PARITY COVERS TWO LEAVES, not five, for the reason the executor's own parity
// suite gives: `check_test_adequacy`, `check_contract_drift` and
// `check_static_analysis` shell out to git and the project's toolchain, and a
// unit verdict must not depend on the machine. The two kept are the ones that
// decide without leaving the process — `check_mock_boundary` and the terminal
// `task_complete` — with their steps lifted verbatim from the shipped runbook.
// The gate `task_complete` demands is seeded in BOTH stores, so the two
// streams differ only by the path that completed the tasks.

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
  // The projection's own stamps, folded from each fact's timestamp — the
  // same exclusion as `timestamp`, one layer up.
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
 * The same, with every array compared as a set. The projection keys its
 * evidence by evidence id — an operation-derived hash the comparison
 * excludes — so two paths that folded the same rows list them in an order
 * the excluded id decided. Row ORDER is proved by the leaf-facts case, which
 * compares the streams as sequences; here the folded state is compared as
 * content.
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

function executeDeps(): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    // The LIVE orchestrate table — the composite hands settle this same
    // object, so both paths reach the same handlers.
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
  await store.append(STREAM, { type: 'state.patched', data: { patch: { tasks } } });
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
 * The primitive baseline: the registered handlers, in runbook order, once per
 * task, with the arguments the compiler builds from what the capsule will
 * freeze — the way an orchestrator following the runbook by hand does it.
 */
async function completeByHand(): Promise<void> {
  const ctx = wiring(baselineDir, baselineStore);
  // The primitive path announces its tasks before it dispatches — by hand
  // once, by `prepare_delegation` now — one row per task; the plane's
  // compilation leaves the same rows, in the same shape, ahead of its record.
  // So the announcement is a leaf fact both sides leave, and it is compared.
  for (const taskId of TASK_IDS) {
    await baselineStore.append(STREAM, { type: 'task.assigned', data: { taskId, title: taskId } });
  }
  for (const taskId of TASK_IDS) {
    const compiled = compileIntent(
      'task-completion',
      { streamId: STREAM },
      { taskId, worktreePath: WORKTREE, ...STAMP, result: { worktreePath: WORKTREE } },
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
  it('SettlementParity_ASettledBatch_LeavesTheSameLeafFacts', async () => {
    await completeByHand();
    await settleTheBatch();

    const baseline = leafFacts(await baselineStore.query(STREAM));
    const settled = leafFacts(await settleStore.query(STREAM));
    expect(settled).toEqual(baseline);

    // Not vacuous: past the seeded prelude, both paths left the gate's proof,
    // its signal and the completion, once per task, in that order.
    const types = (await baselineStore.query(STREAM)).map((event) => event.type);
    expect(types.slice(-3 * TASK_IDS.length)).toEqual(
      TASK_IDS.flatMap(() => ['admission.evidence-recorded', 'gate.executed', 'task.completed']),
    );
    // And the settled store carries the plane's own records beside them: one
    // segment record per task, and the settlement that read them.
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
