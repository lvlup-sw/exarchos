// Tests a replay of a committed operation through the real `dispatch()` path.
// The executor suite calls `handleExecuteIntent` directly, so it cannot see the
// checks that run after the handler returns.
//
// After the handler returns, `dispatch()` checks that the declared events landed
// under this operation id and that each applicable `ensures` holds. A replay
// returns the persisted receipt and appends nothing. An unconditional emission
// or an event-append ensure then reports each replay as drift and writes an
// `emission.violated` row. Only the dispatch seam can check that declaration.
//
// The fixture intent uses the seams of a shipped intent: the runbook table, the
// intent argument table, a registered action, and the orchestrate handler table.
// The executor refuses a step whose tool is not the owner of the handler table,
// so the step names `exarchos_orchestrate`.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

/** The `vi.mock` factories read these values and run before the top-level bindings of this module. */
const { FIXTURE_TOOL, FIXTURE_LEAF, FIXTURE_INTENT, leaf } = vi.hoisted(() => ({
  FIXTURE_TOOL: 'exarchos_orchestrate',
  FIXTURE_LEAF: 'fixture_dispatch_leaf',
  FIXTURE_INTENT: 'fixture-dispatch-intent',
  leaf: { calls: 0 },
}));

const STREAM = 'wf-dispatch-replay';

vi.mock('../../../../src/runbooks/definitions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/runbooks/definitions.js')>();
  return {
    ...actual,
    ALL_RUNBOOKS: [
      ...actual.ALL_RUNBOOKS,
      {
        id: FIXTURE_INTENT,
        phase: 'delegate',
        description: 'fixture intent for the dispatch replay path',
        steps: [{ tool: FIXTURE_TOOL, action: FIXTURE_LEAF, onFail: 'stop' }],
        templateVars: ['taskId', 'featureId'],
        autoEmits: [],
      },
    ],
  };
});

vi.mock('../../../../src/verbs/execute/arg-schemas.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/execute/arg-schemas.js')>();
  const { fixtureIntentArgs } = await import('./fixtures.js');
  return {
    ...actual,
    INTENT_ARG_SCHEMAS: { ...actual.INTENT_ARG_SCHEMAS, [FIXTURE_INTENT]: fixtureIntentArgs },
  };
});

import { deriveLocalOperatorIdentity } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { EMISSION_VIOLATION_EVENT } from '../../../../src/dispatch/core/interceptors/emission-verifier.js';
import { EventStore } from '../../../../src/events/store.js';
import { TOOL_REGISTRY, type ToolAction } from '../../../../src/registry.js';
import { admitActionContract } from '../../../../src/registry/annotations.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_EXECUTED_EVENT } from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { appendingHandler, fixtureAction } from './fixtures.js';

let stateDir: string;
let store: EventStore;

/**
 * `registerCustomTool` refuses a name that collides with a built-in tool.
 * The fixture declaration goes directly onto the action list of `exarchos_orchestrate`, and `afterAll` removes it.
 */
const orchestrateTool = TOOL_REGISTRY.find((tool) => tool.name === FIXTURE_TOOL);
if (orchestrateTool === undefined) {
  throw new Error(`'${FIXTURE_TOOL}' is missing from TOOL_REGISTRY`);
}
const orchestrateActions = orchestrateTool.actions as unknown as ToolAction[];

/**
 * Adds the fixture leaf to the shared registry and to the orchestrate handler table.
 * `admitActionContract` runs the check of `registerCustomTool` and refuses `safe-repeat` without an idempotent annotation.
 * It throws before the push, so an invalid fixture contract never reaches the shared array.
 * The handler goes into the table object, because the composite reads that table and not the module export.
 */
beforeAll(() => {
  const fixtureLeaf = fixtureAction({
    name: FIXTURE_LEAF,
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  });
  admitActionContract(fixtureLeaf, FIXTURE_TOOL);
  orchestrateActions.push(fixtureLeaf);
  const inner = appendingHandler('task.completed');
  Object.assign(ACTION_HANDLERS, {
    [FIXTURE_LEAF]: async (
      args: Record<string, unknown>,
      stateDir: string,
      ctx?: Parameters<typeof inner>[2],
    ) => {
      leaf.calls += 1;
      return inner(args, stateDir, ctx);
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(ACTION_HANDLERS, FIXTURE_LEAF);
  const index = orchestrateActions.findIndex((action) => action.name === FIXTURE_LEAF);
  if (index !== -1) orchestrateActions.splice(index, 1);
});

beforeEach(async () => {
  leaf.calls = 0;
  stateDir = await mkdtemp(path.join(tmpdir(), 'execute-intent-dispatch-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

function ctx(): DispatchContext {
  return {
    stateDir,
    eventStore: store,
    enableTelemetry: false,
    callerIdentity: deriveLocalOperatorIdentity(stateDir),
  };
}

const REQUEST = {
  action: 'execute_intent',
  intent: FIXTURE_INTENT,
  featureId: STREAM,
  args: { taskId: 'dispatch-t1' },
  operationId: 'op-dispatch-replay',
};

describe('execute_intent replayed through dispatch()', () => {
  /**
   * The replay answers from the persisted claim before any effect. It runs nothing again and appends nothing.
   * The post-dispatch check must accept that, so the replay writes no violation.
   */
  it('SecondDispatchOfTheSameOperationId_ReturnsTheReceiptWithNoViolation', async () => {
    const first = await dispatch('exarchos_orchestrate', { ...REQUEST }, ctx());
    expect(
      first.success,
      `first dispatch failed: ${first.error?.code ?? ''} ${first.error?.message ?? ''}`,
    ).toBe(true);
    expect(leaf.calls).toBe(1);
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);

    const second = await dispatch('exarchos_orchestrate', { ...REQUEST }, ctx());
    expect(
      second.success,
      `replay failed: ${second.error?.code ?? ''} ${second.error?.message ?? ''}`,
    ).toBe(true);
    expect(second.error).toBeUndefined();
    expect(leaf.calls).toBe(1);

    const receipt = second.data as { operationId?: string; outcome?: string };
    expect(receipt.operationId).toBe(REQUEST.operationId);
    expect(receipt.outcome).toBe('committed');

    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
    expect(await store.query(STREAM, { type: EMISSION_VIOLATION_EVENT })).toHaveLength(0);
    expect(await store.query(STREAM, { type: 'task.completed' })).toHaveLength(1);
  });

  /** A replay is not a one-time allowance. The declaration accepts the path or it does not, so the test repeats it. */
  it('ThirdAndFourthReplays_StayClean', async () => {
    await dispatch('exarchos_orchestrate', { ...REQUEST }, ctx());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await dispatch('exarchos_orchestrate', { ...REQUEST }, ctx());
      expect(replay.success).toBe(true);
    }
    expect(leaf.calls).toBe(1);
    expect(await store.query(STREAM, { type: EMISSION_VIOLATION_EVENT })).toHaveLength(0);
  });

  it('SameOperationIdDifferentRequest_IsTheTypedRefusalThroughDispatchToo', async () => {
    await dispatch('exarchos_orchestrate', { ...REQUEST }, ctx());
    const clash = await dispatch(
      'exarchos_orchestrate',
      { ...REQUEST, args: { taskId: 'a-different-task' } },
      ctx(),
    );
    expect(clash.success).toBe(false);
    expect(clash.error?.code).toBe('INTENT_REPLAY_DIGEST_MISMATCH');
    expect(leaf.calls).toBe(1);
  });
});
