// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the by-hand primitive baseline this file drives — the same compiled leaves invoked one at a time through the orchestrate handler table against a SECOND event store with the runbook's stop policy applied by the loop rather than by the executor
//
// ─── Composition parity: driving the leaves vs executing the intent ─────────
//
// The bounded executor's whole claim is that it changes WHO drives the
// task-completion runbook, not WHAT running it does. That claim is only worth
// anything if it is compared against something: the primitive baseline here is
// the same registered handlers, invoked directly in runbook order, with the
// arguments the compiler builds — what an orchestrator following the runbook
// by hand does today.
//
// Two identically seeded stores, one path each, then the facts are compared:
// event types, their order, the stream each landed on, and the payload of the
// gate verdicts.
//
// EXCLUDED FROM THE COMPARISON, and why each can never byte-match:
//   - `operationId` — the executor stamps a DERIVED per-leaf id; the baseline
//     stamps the one ambient dispatch id. That difference is the mechanism
//     under test, not a divergence.
//   - `evidenceId`, `artifactId` and `invocationId` — all derived from the
//     operation id, so they move with it by construction.
//   - `contentDigest`, `policyDigest` and every `digest` — content addresses
//     over payloads that include the ids above.
//   - `timestamp`, `createdAt`, `eventId`, `sequence`, `idempotencyKey`,
//     `correlationId`, `causationId` — wall-clock, store-allocated, or
//     correlation scaffolding.
// Everything else is compared verbatim.
//
// PARITY COVERS TWO LEAVES, not five. `check_test_adequacy`,
// `check_contract_drift` and `check_static_analysis` shell out to git and the
// project's toolchain; running them here would make a unit test's verdict
// depend on the machine it runs on. The two leaves kept are the ones that
// reach a decision without leaving the process on a bare fixture workspace:
// `check_mock_boundary` (the runbook's one advisory leaf) and the terminal
// `task_complete`. Their STEPS are lifted verbatim from the shipped
// `task-completion` runbook rather than rewritten, so the arguments the
// compiler builds for them are the shipped ones.
//
// On a bare fixture workspace the advisory gate passes and the terminal leaf
// refuses, on both paths. A leaf refusing is not a problem for this test: what
// is being compared is whether the two paths produce the same facts, not
// whether the leaves are happy.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import { compileIntent } from '../../../../src/verbs/execute/compile.js';
import {
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  type ExecuteIntentDeps,
} from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring } from './fixtures.js';

const STREAM = 'wf-parity';
const TASK_ID = 'parity-task-1';
const SHIPPED_INTENT = 'task-completion';
const SUBSET_INTENT = 'task-completion-no-shell-subset';

/** The leaves this comparison covers, in the order the shipped runbook lists them. */
const COVERED = ['check_mock_boundary', 'task_complete'];

function shippedSteps(): readonly RunbookStep[] {
  const runbook = ALL_RUNBOOKS.find((entry) => entry.id === SHIPPED_INTENT);
  if (runbook === undefined) throw new Error(`the ${SHIPPED_INTENT} runbook is missing`);
  const steps = runbook.steps.filter((step) => COVERED.includes(step.action));
  expect(steps.map((step) => step.action)).toEqual(COVERED);
  return steps;
}

function subsetRunbook(): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === SHIPPED_INTENT);
  if (shipped === undefined) throw new Error(`the ${SHIPPED_INTENT} runbook is missing`);
  return { ...shipped, id: SUBSET_INTENT, steps: [...shippedSteps()] };
}

const INTENT_ARGS = {
  taskId: TASK_ID,
  worktreePath: '/nonexistent-parity-worktree',
  riskTier: 'medium' as const,
  boundaryTouching: true,
};

function deps(): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS[SHIPPED_INTENT];
  if (schema === undefined) throw new Error(`no argument schema for ${SHIPPED_INTENT}`);
  return {
    runbookTable: [subsetRunbook()],
    findAction: findActionInRegistry,
    argSchemas: { [SUBSET_INTENT]: schema },
    // The LIVE orchestrate table, not a fixture one — the composite hands the
    // executor this same object, so both paths reach the same handlers.
    handlers: ACTION_HANDLERS,
  };
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Keys dropped everywhere they appear, at any depth. Named in the header with
 * the reason each one cannot match across the two paths.
 */
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
  // The projection's own wall-clock stamp, folded from the newest event's
  // timestamp — the same exclusion as `timestamp`, one layer up.
  'updatedAt',
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

/** The leaf events one path produced, with the executor's own record removed. */
function leafFacts(events: readonly WorkflowEvent[]): unknown[] {
  return events
    .filter((event) => event.type !== INTENT_EXECUTED_EVENT)
    .map((event) => normalize({ type: event.type, streamId: event.streamId, data: event.data }));
}

// ─── Two identically seeded stores ──────────────────────────────────────────

let baselineDir: string;
let executorDir: string;
let baselineStore: EventStore;
let executorStore: EventStore;

async function seed(store: EventStore): Promise<void> {
  await seedActivePhaseAttempt(store, STREAM);
  await store.append(STREAM, {
    type: 'task.assigned',
    data: { taskId: TASK_ID, featureId: STREAM, agentId: 'parity-agent' },
  });
}

beforeEach(async () => {
  baselineDir = await mkdtemp(path.join(tmpdir(), 'execute-intent-parity-base-'));
  executorDir = await mkdtemp(path.join(tmpdir(), 'execute-intent-parity-exec-'));
  baselineStore = new EventStore(baselineDir);
  executorStore = new EventStore(executorDir);
  await baselineStore.initialize();
  await executorStore.initialize();
  await seed(baselineStore);
  await seed(executorStore);
});

afterEach(async () => {
  baselineStore.close();
  executorStore.close();
  await rmrfAsync(baselineDir);
  await rmrfAsync(executorDir);
});

interface BaselineLeafOutcome {
  readonly action: string;
  readonly success: boolean;
  readonly message?: string;
}

/** The primitive baseline: the registered handlers, called in runbook order. */
async function runPrimitiveBaseline(ctx: DispatchContext): Promise<BaselineLeafOutcome[]> {
  const compiled = compileIntent(SUBSET_INTENT, { streamId: STREAM }, INTENT_ARGS, deps());
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return [];
  const outcomes: BaselineLeafOutcome[] = [];
  for (const leaf of compiled.segment.leaves) {
    const handler = ACTION_HANDLERS[leaf.action];
    expect(handler).toBeTypeOf('function');
    const result = await handler?.(leaf.args, ctx.stateDir, ctx);
    outcomes.push({
      action: leaf.action,
      success: result?.success === true,
      ...(result?.error?.message !== undefined ? { message: result.error.message } : {}),
    });
    // The runbook's failure policy, applied by hand: a `stop` leaf that failed
    // would halt an orchestrator following the runbook here too.
    if (result?.success === false && leaf.onFail === 'stop') break;
  }
  return outcomes;
}

describe('task-completion over the no-shell leaf subset', () => {
  it('ExecutorAndPrimitiveBaseline_ProduceTheSameFacts', async () => {
    const correlation = fixtureCorrelation();

    const baseline = await runWithDispatchContext(correlation, () =>
      runPrimitiveBaseline(fixtureWiring(baselineDir, baselineStore)),
    );

    const executed = await runWithDispatchContext(correlation, () =>
      handleExecuteIntent(
        {
          intent: SUBSET_INTENT,
          streamId: STREAM,
          args: INTENT_ARGS,
          operationId: 'op-parity',
        },
        executorDir,
        fixtureWiring(executorDir, executorStore),
        deps(),
      ),
    );

    const baselineEvents = await baselineStore.query(STREAM);
    const executorEvents = await executorStore.query(STREAM);

    // Same events, same order, same subject stream, same payload.
    expect(leafFacts(executorEvents)).toEqual(leafFacts(baselineEvents));

    // Not vacuous: both paths appended past the two-event seeded prelude, and
    // the gate leaf reached a real verdict rather than erroring out early.
    const types = baselineEvents.map((event) => event.type);
    expect(types).toEqual([
      'workflow.started',
      'task.assigned',
      'admission.evidence-recorded',
      'gate.executed',
    ]);

    // The per-leaf verdicts match too, which the event log alone does not say:
    // the advisory gate passed on both paths and the terminal leaf refused on
    // both, for the same stated reason.
    const receipt = executed.data as {
      leaves: { action: string; status: string }[];
      failedLeaf?: string;
    };
    expect(baseline.map((leaf) => [leaf.action, leaf.success])).toEqual([
      ['check_mock_boundary', true],
      ['task_complete', false],
    ]);
    expect(receipt.leaves.map((leaf) => [leaf.action, leaf.status])).toEqual([
      ['check_mock_boundary', 'passed'],
      ['task_complete', 'failed'],
    ]);
    expect(receipt.failedLeaf).toBe('task_complete');
    const refusal = baseline[1]?.message;
    expect(refusal).toBeTypeOf('string');
    expect(executed.error?.message).toContain(refusal ?? '<no refusal>');

    // The one fact only the executor produces: its own operation record. The
    // baseline has no such row, which is exactly what the commit is FOR.
    expect(
      executorEvents.filter((event) => event.type === INTENT_EXECUTED_EVENT),
    ).toHaveLength(1);
    expect(
      baselineEvents.filter((event) => event.type === INTENT_EXECUTED_EVENT),
    ).toHaveLength(0);
  });

  it('BothPathsLeaveTheSameWorkflowProjection', async () => {
    const correlation = fixtureCorrelation();
    await runWithDispatchContext(correlation, () =>
      runPrimitiveBaseline(fixtureWiring(baselineDir, baselineStore)),
    );
    await runWithDispatchContext(correlation, () =>
      handleExecuteIntent(
        {
          intent: SUBSET_INTENT,
          streamId: STREAM,
          args: INTENT_ARGS,
          operationId: 'op-parity-projection',
        },
        executorDir,
        fixtureWiring(executorDir, executorStore),
        deps(),
      ),
    );

    const project = async (store: EventStore): Promise<unknown> => {
      const { workflowStateProjection } = await import(
        '../../../../src/projections/views/workflow-state-projection.js'
      );
      let view = workflowStateProjection.init();
      for (const event of await store.query(STREAM)) {
        if (event.type === INTENT_EXECUTED_EVENT) continue;
        view = workflowStateProjection.apply(view, event);
      }
      return normalize(view);
    };

    expect(await project(executorStore)).toEqual(await project(baselineStore));
  });
});
