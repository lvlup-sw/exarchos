// @oracle-sources: ../../../../src/verbs/tasks/tools.ts, the by-hand primitive baseline this file drives — task_complete invoked once per task against a SECOND event store seeded identically, whose completion rows and state document are compared verbatim with what one settle call leaves
//
// ─── Fact parity: settling a batch vs completing its tasks by hand ──────────
//
// The claim under test is the plane's replay-equivalence gate stated for one
// intent: a settled batch leaves the SAME durable facts, and the same state,
// as an orchestrator completing each task through `task_complete`. Not
// similar facts — the same rows, on the same stream, with the same payload.
//
// Two identically seeded stores, one path each, then the facts are compared:
// every `task.completed` row's type, stream and payload, and every task's
// status on the document the transition guards read.
//
// EXCLUDED FROM THE COMPARISON, and why each can never byte-match:
//   - `operationId`, `correlationId`, `causationId` — the settle path stamps
//     the settlement's dispatch; the baseline stamps one dispatch per call.
//     That difference is the mechanism under test, not a divergence.
//   - `idempotencyKey` — `task_complete` keys each append by task; settlement
//     is keyed by the batch claim instead, one level up.
//   - `timestamp`, `eventId`, `sequence` — wall-clock and store-allocated.
// Everything else is compared verbatim.
//
// The baseline needs a passing `static-analysis` gate per task, which is the
// gate `task_complete` demands; it is seeded in BOTH stores so the two streams
// differ only by the path that completed the tasks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { deriveMcpCallerIdentity } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import { handleTaskComplete } from '../../../../src/verbs/tasks/tools.js';
import { initStateFile, readStateFile } from '../../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-settlement-parity';
const TASK_IDS = ['task-one', 'task-two'] as const;
const EVIDENCE = { type: 'test' as const, output: 'green', passed: true };

const EXCLUDED_KEYS = new Set([
  'operationId',
  'correlationId',
  'causationId',
  'idempotencyKey',
  'timestamp',
  'eventId',
  'sequence',
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

/** The completion facts one path left, in task order, stripped of what cannot match. */
function completionFacts(events: readonly WorkflowEvent[]): unknown[] {
  return events
    .filter((event) => event.type === 'task.completed')
    .map((event) => normalize({ type: event.type, streamId: event.streamId, data: event.data }))
    .sort((a, b) => {
      const ta = (a as { data: { taskId: string } }).data.taskId;
      const tb = (b as { data: { taskId: string } }).data.taskId;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
}

let baselineDir: string;
let settleDir: string;
let baselineStore: EventStore;
let settleStore: EventStore;

async function seed(dir: string, store: EventStore): Promise<void> {
  await initStateFile(dir, STREAM, 'feature', {
    phase: 'delegate',
    tasks: TASK_IDS.map((id) => ({ id, title: id, status: 'in_progress' })),
  });
  await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await store.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(STREAM, {
    type: 'state.patched',
    data: { patch: { tasks: TASK_IDS.map((id) => ({ id, title: id, status: 'in_progress', blockedBy: [] })) } },
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
  deriveMcpCallerIdentity({ sessionId: 'settlement-parity' });
  return mintDispatchContext(undefined);
}

/** The primitive baseline: `task_complete`, once per task, the way an orchestrator does it. */
async function completeByHand(): Promise<void> {
  for (const taskId of TASK_IDS) {
    const result = await handleTaskComplete(
      { taskId, featureId: STREAM, evidence: EVIDENCE },
      baselineDir,
      baselineStore,
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
  }
}

/** The plane: one prepare, one settle, every task claimed with the same evidence. */
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
        claims: TASK_IDS.map((taskId) => ({
          taskId,
          fields: { evidence: EVIDENCE },
          evidence: [{ kind: 'test', ref: `run-${taskId}` }],
        })),
      },
      settleDir,
      ctx,
    ),
  );
  expect(settled.success, JSON.stringify(settled)).toBe(true);
  expect((settled.data as { outcome: string }).outcome).toBe('settled');
}

async function taskStatuses(dir: string): Promise<[string, string][]> {
  const state = await readStateFile(path.join(dir, `${STREAM}.state.json`));
  return (state.tasks as { id: string; status: string }[]).map((t) => [t.id, t.status]);
}

describe('settlement facts — parity with completing each task by hand', () => {
  it('SettlementParity_ASettledBatch_LeavesTheSameCompletionFacts', async () => {
    await completeByHand();
    await settleTheBatch();

    const baseline = completionFacts(await baselineStore.query(STREAM));
    const settled = completionFacts(await settleStore.query(STREAM));
    expect(baseline).toHaveLength(TASK_IDS.length);
    expect(settled).toEqual(baseline);
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
