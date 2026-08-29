// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the rows a real EventStore holds under a leaf's DERIVED operation id — queried back from the store rather than read off the receipt the executor built, so a receipt that claims a leaf ran once cannot satisfy a comparison against rows nobody wrote twice

// ─── The `reject-replay` durable gate ───────────────────────────────────────
//
// A compiled leaf's `reject-replay` declaration has exactly one production
// enforcer: the executor, reading the leaf's own unconditionally-declared
// rows back from the store under its stable derived operation identity before
// ever calling its handler again on a crash-retry. This suite pins that gate
// directly, at the unit the property belongs to, rather than only through the
// one shipped action (`create_pr`) that happens to also carry its own remote
// precheck — a suite that only exercised the shipped action could not tell
// the durable gate's effect apart from the precheck's.
//
// Every case here crashes a LATER leaf so the retry re-runs the segment from
// the top under the SAME operation id — the only path that ever reaches a
// completed leaf's turn twice.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EMISSION_VIOLATION_EVENT } from '../../../../src/dispatch/core/interceptors/emission-verifier.js';
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
  it('RejectReplayLeaf_CompletedBeforeALaterLeafCrashed_IsNotReInvokedOnRetry', async () => {
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
    // No claim committed for a crash mid-segment — the same distinguishability
    // the executor's own header promises independently of this gate.
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(0);

    const result = await execute(request, deps);
    expect(result.success).toBe(true);

    // Kill probe: revert the gate and this becomes 2 — the leaf's own effect
    // performed twice, which is exactly what `reject-replay` forbids.
    expect(counted.calls()).toBe(1);
    const derived = derivedLeafOperationId(request.operationId, 0, 'fixture_completed');
    expect(await rowsFor(derived, 'task.completed')).toHaveLength(1);
  });

  it('SafeRepeatLeaf_InTheSamePosition_IsReInvokedOnRetry', async () => {
    // The non-vacuity denominator: swap only the replay policy at the same
    // position, and the gate's silence has to be a choice, not a default that
    // would have elided this leaf too.
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

  it('RejectReplayLeaf_CrashedMidHandler_StillRunsOnRetry', async () => {
    // A partial (here, empty) row set under the derived id is not proof the
    // effect happened. The handler crashes BEFORE its own append, so nothing
    // durable exists for the retry to read as done — and this is the arm that
    // keeps a shipped action's own recovery precheck (e.g. `create_pr`'s
    // `listPrs`) reachable on retry instead of the gate eliding first.
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

  it('RejectReplayLeaf_DeclaringNoUnconditionalEmission_IsAlwaysInvoked', async () => {
    // Pins the empty-obliged-set branch: without it, "every owed event is
    // present" is vacuously true over the empty set and this leaf would be
    // elided on its very first retry, having never actually run.
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

  it('RejectReplayLeaf_DeclaringEnsures_IsNeverElidedOnRetry', async () => {
    // A declared `ensures` is a durable-evidence axis the elision gate cannot
    // stand in for — its own check only reads the unconditional-emissions
    // axis. Same shape as the first case (owed set fully landed before a
    // later leaf crashes), but this leaf ALSO declares an ensures, so it must
    // run its handler again on retry rather than being elided: eliding would
    // skip `observeActionPostconditions` entirely, which is the only place
    // this axis is actually checked.
    const withEnsures = fixtureAction({
      name: 'fixture_with_ensures',
      replay: {
        kind: 'reject-replay',
        because: 'fixture leaf refuses replay while declaring a durable postcondition',
      },
      emissions: declared({
        event: 'task.completed',
        condition: 'always',
        owner: 'orchestrate',
        role: 'primary',
      }),
      ensures: declared({ source: 'event-append', when: 'success', event: 'task.completed' }),
    });
    const crasher = fixtureAction({ name: 'fixture_crasher' });

    const counted = countingHandler(appendingHandler('task.completed'));
    const deps = depsFor(
      [fixtureStep('fixture_with_ensures', 'stop'), fixtureStep('fixture_crasher', 'stop')],
      { fixture_with_ensures: counted.handler, fixture_crasher: crashesOnceThenSucceeds(silentHandler()) },
      [withEnsures, crasher],
    );

    await expect(execute(request, deps)).rejects.toThrow('leaf crashed on its first attempt');
    const result = await execute(request, deps);
    expect(result.success).toBe(true);

    // Kill probe: drop the `leaf.contract.ensures.kind !== 'none'` guard from
    // `replayElidedRows` and this becomes 1 — the leaf elided on retry, its
    // postcondition never observed a second time.
    expect(counted.calls()).toBe(2);
  });

  it('RejectReplayLeaf_ElidedOnRetry_DoesNotFoldAPriorEmissionViolationRowIntoItsCaptures', async () => {
    // Seed an `emission.violated` bookkeeping row under the leaf's OWN derived
    // operation id, exactly as `runEmissionVerifierInterceptor` would have
    // left behind from a first attempt that landed its unconditional emission
    // but tripped a lifecycle finding. The row sits alongside the leaf's own
    // `task.completed` append under the same derived id — the shape
    // `replayElidedRows` actually queries on retry.
    const completed = fixtureAction({
      name: 'fixture_completed_with_prior_finding',
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
      [fixtureStep('fixture_completed_with_prior_finding', 'stop'), fixtureStep('fixture_crasher', 'stop')],
      {
        fixture_completed_with_prior_finding: counted.handler,
        fixture_crasher: crashesOnceThenSucceeds(silentHandler()),
      },
      [completed, crasher],
    );

    await expect(execute(request, deps)).rejects.toThrow('leaf crashed on its first attempt');

    const derived = derivedLeafOperationId(request.operationId, 0, 'fixture_completed_with_prior_finding');
    await store.append(STREAM, {
      type: EMISSION_VIOLATION_EVENT,
      operationId: derived,
      data: {
        action: 'fixture_completed_with_prior_finding',
        missingEvents: [],
        lifecycleViolations: [
          { event: 'task.completed', lifecycle: 'deprecated' },
        ],
        operationId: derived,
      },
    });

    const result = await execute(request, deps);
    expect(result.success).toBe(true);
    expect(counted.calls()).toBe(1); // elided, as the earlier case pins

    // Kill probe: drop the `EMISSION_VIOLATION_EVENT` filter from
    // `replayElidedRows`'s return and `leaf.events`/`eventsAppended` below
    // report the prior attempt's finding as something THIS run emitted.
    const receipt = result.data as {
      leaves?: readonly { events?: readonly { type: string }[] }[];
      interaction?: { eventsAppended?: number };
    };
    const leafEvents = receipt.leaves?.[0]?.events ?? [];
    expect(leafEvents.map((e) => e.type)).not.toContain(EMISSION_VIOLATION_EVENT);
    expect(leafEvents.map((e) => e.type)).toContain('task.completed');
  });
});
