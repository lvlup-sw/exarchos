// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the by-hand primitive baseline this file drives — the same compiled leaves invoked one at a time through the orchestrate handler table against a SECOND event store with the runbook's stop policy applied by the loop rather than by the executor
//
// Parity test for the executor on the `task-completion` runbook. The executor changes who drives
// the runbook, not what the runbook does. The baseline calls the same registered handlers in
// runbook order, with the arguments that the compiler builds. Each path runs on its own store,
// with the same seed. The test compares event types, order, streams, and payloads.
//
// The test covers two of the five leaves. Three leaves call git and the project toolchain, so
// their verdicts depend on the machine. The two kept leaves, `check_mock_boundary` and
// `task_complete`, decide in the process on a bare fixture workspace. Their steps come unchanged
// from the shipped runbook. On both paths, the advisory gate passes and the terminal leaf refuses.

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
  baseRef: 'feature/parity',
};

/** Builds the executor deps with the live orchestrate table, so both paths reach the same handlers. */
function deps(): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS[SHIPPED_INTENT];
  if (schema === undefined) throw new Error(`no argument schema for ${SHIPPED_INTENT}`);
  return {
    runbookTable: [subsetRunbook()],
    findAction: findActionInRegistry,
    argSchemas: { [SUBSET_INTENT]: schema },
    handlers: ACTION_HANDLERS,
    handlerTool: 'exarchos_orchestrate',
  };
}

/**
 * Keys that `normalize` drops at any depth, because they cannot match across the two paths.
 * The executor stamps a derived operation id for each leaf, and the baseline stamps the dispatch
 * id. The evidence, artifact, and invocation ids and the digests come from that id. The other
 * keys hold wall-clock stamps, store-allocated values, or correlation fields.
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
  /** The wall-clock stamp of the projection, from the timestamp of the newest event. */
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

/**
 * The primitive baseline: the registered handlers, called in runbook order. The loop applies
 * the `stop` policy of the runbook by hand.
 */
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
    if (result?.success === false && leaf.onFail === 'stop') break;
  }
  return outcomes;
}

describe('task-completion over the no-shell leaf subset', () => {
  /**
   * Both paths append past the two seeded events, and the gate leaf reaches a real verdict.
   * The leaf verdicts must also match, because the event log does not show them. Only the
   * executor writes the operation record.
   */
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

    expect(leafFacts(executorEvents)).toEqual(leafFacts(baselineEvents));

    const types = baselineEvents.map((event) => event.type);
    expect(types).toEqual([
      'workflow.started',
      'task.assigned',
      'admission.evidence-recorded',
      'gate.executed',
    ]);

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
