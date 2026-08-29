// ─── Replay of a committed operation, through the REAL dispatch path ────────
//
// The executor's own suite drives `handleExecuteIntent` directly, and a replay
// there is clean: the persisted receipt comes straight back. Everything that
// runs AFTER the handler is invisible from that seam — and that is where the
// replay contract and the action's declared bookkeeping meet.
//
// `dispatch()` verifies, after the handler returns, that the events the action
// declares unconditionally landed under THIS dispatch's operation id, and that
// every applicable `ensures` is observable on it. A replay returns the
// persisted receipt and appends nothing, by definition — so an unconditional
// emission or an event-append ensure would report every replay as drift, fail
// the call the caller was told is safe to make, and write an `emission.violated`
// row saying so. The declaration is what makes the replay path honest, and
// nothing below the dispatch seam can check it.
//
// The fixture intent goes in through the same seams a shipped intent uses: a
// runbook in the runbook table, a typed argument schema in the intent table, a
// registered action for the leaf, and a handler in the orchestrate table. No
// dependency injection — the point is the path that has none.
//
// The step names `exarchos_orchestrate` rather than a private fixture tool
// name, and the declaration is registered directly onto that tool's own
// action list rather than through `registerCustomTool` (which refuses a name
// colliding with a built-in tool). The executor now refuses a step whose tool
// disagrees with the handler table's declared owner — this fixture leaf is
// invoked through the REAL orchestrate table, so it has to be named the tool
// that owns that table, the same as every shipped leaf is.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Hoisted with the `vi.mock` factories that read them: a factory runs before
// this module's own top-level bindings are initialized.
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

// `registerCustomTool` refuses a name colliding with a built-in tool, and this
// leaf is deliberately named `exarchos_orchestrate` now (see the header) — so
// the declaration is spliced directly onto that tool's own action list rather
// than through the custom-tool surface, and removed the same way afterward.
const orchestrateTool = TOOL_REGISTRY.find((tool) => tool.name === FIXTURE_TOOL);
if (orchestrateTool === undefined) {
  throw new Error(`'${FIXTURE_TOOL}' is missing from TOOL_REGISTRY`);
}
const orchestrateActions = orchestrateTool.actions as unknown as ToolAction[];

beforeAll(() => {
  const fixtureLeaf = fixtureAction({
    name: FIXTURE_LEAF,
    // `admitActionContract` below is what makes this real — it does not
    // accept `safe-repeat` from a mutating annotation.
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  });
  // Admit the contract BEFORE touching the shared registry array, the same
  // gate `registerCustomTool` runs for every action it accepts
  // (`src/registry/custom-tools.ts`) — that surface refuses this fixture's
  // name outright (it collides with the built-in `exarchos_orchestrate`,
  // which this leaf is deliberately named to match the new handler-table
  // owner fence in `compile.ts`), so the admission call is made directly
  // here instead. Throwing here, before the push, means an invalid fixture
  // contract never reaches the shared array in the first place — nothing
  // for `afterAll` to have missed.
  admitActionContract(fixtureLeaf, FIXTURE_TOOL);
  orchestrateActions.push(fixtureLeaf);
  // The leaf's handler goes into the orchestrate table ITSELF, which is the
  // object the composite hands the executor. Replacing the module's export
  // would not reach it: the composite reads its own table directly, so an
  // override visible only to importers would leave the real path unchanged.
  // Reverted below, so the table this file borrows is the table it returns.
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
  it('SecondDispatchOfTheSameOperationId_ReturnsTheReceiptWithNoViolation', async () => {
    const first = await dispatch('exarchos_orchestrate', { ...REQUEST }, ctx());
    expect(
      first.success,
      `first dispatch failed: ${first.error?.code ?? ''} ${first.error?.message ?? ''}`,
    ).toBe(true);
    expect(leaf.calls).toBe(1);
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);

    // The replay. The handler answers from the persisted claim before any
    // effect: nothing re-executes and nothing is appended, which is exactly
    // what the post-dispatch verification has to be declared to tolerate.
    const second = await dispatch('exarchos_orchestrate', { ...REQUEST }, ctx());
    expect(
      second.success,
      `replay failed: ${second.error?.code ?? ''} ${second.error?.message ?? ''}`,
    ).toBe(true);
    expect(second.error).toBeUndefined();
    expect(leaf.calls).toBe(1);

    // The persisted receipt, not a fresh one.
    const receipt = second.data as { operationId?: string; outcome?: string };
    expect(receipt.operationId).toBe(REQUEST.operationId);
    expect(receipt.outcome).toBe('committed');

    // Nothing was written by the replay: no second operation record, and no
    // finding recorded against it.
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(1);
    expect(await store.query(STREAM, { type: EMISSION_VIOLATION_EVENT })).toHaveLength(0);
    expect(await store.query(STREAM, { type: 'task.completed' })).toHaveLength(1);
  });

  it('ThirdAndFourthReplays_StayClean', async () => {
    // A replay is not a one-shot allowance. The declaration either tolerates
    // the path or it does not, and repeating it is the cheapest way to say so.
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
