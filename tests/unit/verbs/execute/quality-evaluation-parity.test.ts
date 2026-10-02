// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the by-hand primitive baseline this file drives — the same compiled leaves invoked one at a time through the orchestrate handler table against a SECOND event store with the runbook's stop policy applied by the loop rather than by the executor
//
// Composition parity for `quality-evaluation`. The executor changes who drives the runbook, not what the run does.
// The baseline calls the registered handlers directly in runbook order, with the arguments that the compiler builds.
// Each path runs on its own seeded store. The test compares event types, order, streams, and gate verdict payloads.
// It excludes the derived per-leaf operation id, the values hashed over it, and wall-clock and store-allocated values.
//
// Parity covers four of the five leaves. `check_static_analysis` runs the project toolchain, so its verdict depends on the machine.
// The four kept leaves decide without leaving the process. Their steps come unchanged from the shipped runbook.

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
import {
  seedActivePhaseAttempt,
  seedGateEvidence,
} from '../../../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring } from './fixtures.js';

const STREAM = 'wf-quality-parity';
const SHIPPED_INTENT = 'quality-evaluation';
const SUBSET_INTENT = 'quality-evaluation-no-shell-subset';

/** The leaves this comparison covers, in the order the shipped runbook lists them. */
const COVERED = [
  'check_security_scan',
  'check_convergence',
  'check_invariant_conformance',
  'check_review_verdict',
];

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
  high: 0,
  medium: 0,
  low: 0,
  diffContent: '+export const answer = 42;\n',
};

/** Uses the live orchestrate handler table, which the composite also gives the executor, so both paths reach the same handlers. */
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

/** Keys dropped at any depth, because they cannot match across the two paths. */
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
  'updatedAt',
  'resolvedAt',
  /** The convergence gate writes the wall-clock time it last saw each dimension into its verdict payload. */
  'lastChecked',
  'eventId',
  'sequence',
  'idempotencyKey',
  'durationMs',
]);

/**
 * Arrays whose order comes from an excluded key, not from the run.
 * The admission projection sorts `activeEvidence` by evidence id, which is a hash over the operation id.
 * A set comparison still catches a missing, extra, or changed record.
 */
const ORDER_BY_EXCLUDED_KEY = new Set(['activeEvidence']);

function normalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item));
    if (key !== undefined && ORDER_BY_EXCLUDED_KEY.has(key)) {
      return [...items].sort((left, right) =>
        JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
      );
    }
    return items;
  }
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [innerKey, inner] of Object.entries(value as Record<string, unknown>)) {
    if (EXCLUDED_KEYS.has(innerKey)) continue;
    out[innerKey] = normalize(inner, innerKey);
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

/**
 * Seeds the review gate evidence that the invariant leaf requires and no covered leaf produces.
 * Both stores get it, so admission answers the same question on both paths.
 */
async function seed(store: EventStore): Promise<void> {
  const phaseAttemptId = await seedActivePhaseAttempt(store, STREAM, { phase: 'review' });
  await seedGateEvidence(store, { streamId: STREAM, requirementId: 'review', phaseAttemptId });
}

beforeEach(async () => {
  baselineDir = await mkdtemp(path.join(tmpdir(), 'quality-parity-base-'));
  executorDir = await mkdtemp(path.join(tmpdir(), 'quality-parity-exec-'));
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
 * The primitive baseline calls the registered handlers in runbook order.
 * It applies the `stop` failure policy by hand, as an orchestrator that follows the runbook does.
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

describe('quality-evaluation over the no-shell leaf subset', () => {
  /**
   * Both paths append the same events in the same order, on the same stream, with the same payload.
   * Each covered leaf writes the two rows that a gate owes, so the comparison is not vacuous.
   * The per-leaf verdicts must also match, because the event log alone does not show them.
   * Only the executor writes its own operation record.
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
          operationId: 'op-quality-parity',
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
    expect(types.slice(0, 2)).toEqual(['workflow.started', 'admission.evidence-recorded']);
    expect(types.filter((type) => type === 'gate.executed')).toHaveLength(COVERED.length);
    expect(types.filter((type) => type === 'admission.evidence-recorded')).toHaveLength(
      COVERED.length + 1,
    );

    const receipt = executed.data as { leaves: { action: string; status: string }[] };
    expect(baseline.map((leaf) => [leaf.action, leaf.success])).toEqual(
      COVERED.map((action) => [action, true]),
    );
    expect(receipt.leaves.map((leaf) => [leaf.action, leaf.status])).toEqual(
      COVERED.map((action) => [action, 'passed']),
    );

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
          operationId: 'op-quality-parity-projection',
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
