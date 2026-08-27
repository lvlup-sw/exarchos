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

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Hoisted with the `vi.mock` factories that read them: a factory runs before
// this module's own top-level bindings are initialized.
const { FIXTURE_TOOL, FIXTURE_LEAF, FIXTURE_INTENT, leaf } = vi.hoisted(() => ({
  FIXTURE_TOOL: 'fixture_dispatch_tool',
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

vi.mock('../../../../src/verbs/composite.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/composite.js')>();
  const { appendingHandler } = await import('./fixtures.js');
  const inner = appendingHandler('task.completed');
  return {
    ...actual,
    ACTION_HANDLERS: {
      ...actual.ACTION_HANDLERS,
      [FIXTURE_LEAF]: async (
        args: Record<string, unknown>,
        stateDir: string,
        ctx?: Parameters<typeof inner>[2],
      ) => {
        leaf.calls += 1;
        return inner(args, stateDir, ctx);
      },
    },
  };
});

import { deriveLocalOperatorIdentity } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { EMISSION_VIOLATION_EVENT } from '../../../../src/dispatch/core/interceptors/emission-verifier.js';
import { EventStore } from '../../../../src/events/store.js';
import { clearCustomTools, registerCustomTool } from '../../../../src/registry.js';
import { INTENT_EXECUTED_EVENT } from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { fixtureAction } from './fixtures.js';

let stateDir: string;
let store: EventStore;

beforeAll(() => {
  registerCustomTool({
    name: FIXTURE_TOOL,
    description: 'fixture tool carrying the dispatch-replay leaf',
    actions: [
      fixtureAction({
        name: FIXTURE_LEAF,
        // The registry admits a custom action's contract for real, and it does
        // not accept `safe-repeat` from a mutating annotation.
        replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      }),
    ],
  });
});

afterAll(() => {
  clearCustomTools();
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
