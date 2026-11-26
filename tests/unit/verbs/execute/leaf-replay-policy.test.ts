// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds under a leaf's DERIVED operation id — queried back from the store rather than read off the receipt the executor built, so a receipt that claims a leaf ran once cannot satisfy a comparison against rows nobody wrote twice
//
// Tests for the `reject-replay` retry rule of the executor. On a crash-retry, the executor reads the
// rows of a leaf under its derived operation id. A `reject-replay` leaf with any row there is refused:
// the handler does not run again, and the segment does not pass. A leaf with no row runs again.
//
// Each case crashes a leaf. The retry then runs the segment again under the same operation id.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import { declared, type ToolAction } from '../../../../src/registry.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  derivedLeafOperationId,
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  type ExecuteIntentDeps,
  type LeafHandler,
  type LeafHandlerTable,
} from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  appendingHandler,
  countingHandler,
  FIXTURE_TOOL,
  fixtureAction,
  fixtureCorrelation,
  fixtureIntentArgs,
  fixtureRunbook,
  fixtureStep,
  fixtureWiring,
  findFixtureAction,
  silentHandler,
} from './fixtures.js';

const STREAM = 'wf-leaf-replay';
const INTENT = 'fixture-intent';

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'leaf-replay-policy-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

function depsFor(
  steps: Parameters<typeof fixtureRunbook>[1],
  handlers: LeafHandlerTable,
  actions: readonly ToolAction[],
): ExecuteIntentDeps {
  return {
    runbookTable: [fixtureRunbook(INTENT, steps)],
    findAction: findFixtureAction(actions),
    argSchemas: { [INTENT]: fixtureIntentArgs },
    handlers,
    handlerTool: FIXTURE_TOOL,
  };
}

async function execute(raw: Record<string, unknown>, deps: ExecuteIntentDeps): Promise<ToolResult> {
  return runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent(raw, stateDir, fixtureWiring(stateDir, store), deps),
  );
}

/** A handler that throws on its first call and succeeds on every call after. */
function crashesOnceThenSucceeds(inner: LeafHandler): LeafHandler {
  let crashed = false;
  return async (args, dir, ctx) => {
    if (!crashed) {
      crashed = true;
      throw new Error('leaf crashed on its first attempt');
    }
    return inner(args, dir, ctx);
  };
}

async function rowsFor(operationId: string, type?: string) {
  return store.query(STREAM, type === undefined ? { operationId } : { operationId, type });
}

const request = {
  intent: INTENT,
  streamId: STREAM,
  args: { taskId: 't1' },
  operationId: 'op-leaf-replay',
};

describe('a reject-replay leaf that already completed', () => {
  /**
   * A crash in the middle of the segment commits no claim event. The rows under the derived id do not prove that this request caused them.
   * So the retry refuses, the handler does not run twice, and no claim event commits.
   */
  it('RejectReplayLeaf_CompletedBeforeALaterLeafCrashed_RefusesTheRetry', async () => {
    const completed = fixtureAction({
      name: 'fixture_completed',
      replay: {
        kind: 'reject-replay',
        because: 'fixture leaf refuses replay so the durable gate has something to guard',
      },
      emissions: declared({
        event: 'task.completed',
        condition: 'always',
        owner: 'orchestrate',
        role: 'primary',
      }),
    });
    const crasher = fixtureAction({ name: 'fixture_crasher' });

    const counted = countingHandler(appendingHandler('task.completed'));
    const deps = depsFor(
      [fixtureStep('fixture_completed', 'stop'), fixtureStep('fixture_crasher', 'stop')],
      { fixture_completed: counted.handler, fixture_crasher: crashesOnceThenSucceeds(silentHandler()) },
      [completed, crasher],
    );

    await expect(execute(request, deps)).rejects.toThrow('leaf crashed on its first attempt');
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(0);

    await expect(execute(request, deps)).rejects.toThrow(
      "Interrupted leaf 'fixture_completed' has effects without a safe continuation contract",
    );

    expect(counted.calls()).toBe(1);
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(0);
    const derived = derivedLeafOperationId(request.operationId, 0, 'fixture_completed');
    expect(await rowsFor(derived, 'task.completed')).toHaveLength(1);
  });

  /**
   * The control case. Only the replay policy differs from the first case, so the retry
   * refuses a leaf because of `reject-replay` and not by default.
   */
  it('SafeRepeatLeaf_InTheSamePosition_IsReInvokedOnRetry', async () => {
    const repeatable = fixtureAction({
      name: 'fixture_repeatable',
      replay: { kind: 'safe-repeat' },
      emissions: declared({
        event: 'task.completed',
        condition: 'always',
        owner: 'orchestrate',
        role: 'primary',
      }),
    });
    const crasher = fixtureAction({ name: 'fixture_crasher' });

    const counted = countingHandler(appendingHandler('task.completed'));
    const deps = depsFor(
      [fixtureStep('fixture_repeatable', 'stop'), fixtureStep('fixture_crasher', 'stop')],
      { fixture_repeatable: counted.handler, fixture_crasher: crashesOnceThenSucceeds(silentHandler()) },
      [repeatable, crasher],
    );

    await expect(execute(request, deps)).rejects.toThrow('leaf crashed on its first attempt');
    const result = await execute(request, deps);
    expect(result.success).toBe(true);

    expect(counted.calls()).toBe(2);
  });

  /**
   * The handler crashes before its own append, so no row exists under the derived id.
   * The retry rule reads rows only, so a leaf that left no row runs again, and its own
   * precheck decides what to do.
   */
  it('RejectReplayLeaf_CrashedMidHandler_StillRunsOnRetry', async () => {
    const flaky = fixtureAction({
      name: 'fixture_flaky',
      replay: {
        kind: 'reject-replay',
        because: 'fixture leaf refuses replay so a crash before its own append stays observable',
      },
      emissions: declared({
        event: 'task.completed',
        condition: 'always',
        owner: 'orchestrate',
        role: 'primary',
      }),
    });

    const counted = countingHandler(crashesOnceThenSucceeds(appendingHandler('task.completed')));
    const deps = depsFor([fixtureStep('fixture_flaky', 'stop')], { fixture_flaky: counted.handler }, [
      flaky,
    ]);

    await expect(execute(request, deps)).rejects.toThrow('leaf crashed on its first attempt');
    const derived = derivedLeafOperationId(request.operationId, 0, 'fixture_flaky');
    expect(await rowsFor(derived)).toHaveLength(0);

    const result = await execute(request, deps);
    expect(result.success).toBe(true);

    expect(counted.calls()).toBe(2);
    expect(await rowsFor(derived, 'task.completed')).toHaveLength(1);
  });

  /**
   * A leaf that declares no unconditional emission and appends nothing leaves no row.
   * So the retry rule has nothing to refuse, and the leaf runs again.
   */
  it('RejectReplayLeaf_DeclaringNoUnconditionalEmission_IsAlwaysInvoked', async () => {
    const silent = fixtureAction({
      name: 'fixture_silent',
      replay: {
        kind: 'reject-replay',
        because: 'fixture leaf refuses replay while declaring no unconditional emission',
      },
    });
    const crasher = fixtureAction({ name: 'fixture_crasher' });

    const counted = countingHandler(silentHandler());
    const deps = depsFor(
      [fixtureStep('fixture_silent', 'stop'), fixtureStep('fixture_crasher', 'stop')],
      { fixture_silent: counted.handler, fixture_crasher: crashesOnceThenSucceeds(silentHandler()) },
      [silent, crasher],
    );

    await expect(execute(request, deps)).rejects.toThrow('leaf crashed on its first attempt');
    const result = await execute(request, deps);
    expect(result.success).toBe(true);

    expect(counted.calls()).toBe(2);
  });
});
