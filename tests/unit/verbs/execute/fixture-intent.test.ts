// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the three-leaf CHAIN table this file writes by hand — the population every per-leaf predicate quantifies over is pinned against that list on the line above each quantifier so an empty receipt cannot satisfy one vacuously
//
// ─── Fixture intents: what the executor's semantics look like end to end ────
//
// The suite in `executor.test.ts` pins one property per test. This one runs
// whole segments and asks the questions that only a segment can answer:
//
//   ordering and per-leaf identity across a three-leaf chain, with the receipt
//   as the caller's whole view of what happened;
//
//   whether placing admission BEFORE EACH LEAF rather than once up front buys
//   anything. None of the shipped task-completion leaves declares a `requires`,
//   so on the shipped surface the placement is unfalsifiable. A fixture whose
//   terminal leaf declares a real resolved-gate requirement — satisfied only by
//   evidence an earlier leaf records — is what makes it falsifiable: the same
//   leaf is admitted after its predecessor ran and denied before it;
//
//   whether a retry after a crash duplicates the rows the completed leaves
//   already wrote;
//
//   whether an oversized real receipt survives the registered economy cap with
//   the fields a caller needs to keep following the operation;
//
//   whether a caller holding nothing but the receipt can retrieve the trace.
//
// Everything here runs through the injected dependency seam: fixture runbooks,
// fixture leaves, fixture handlers. No shell, no test-only entry in the live
// registry.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { enforceResponseEconomy } from '../../../../src/dispatch/core/dispatch.js';
import { evaluateDispatchAdmission } from '../../../../src/dispatch/core/dispatch-admission.js';
import { estimateOutputTokens } from '../../../../src/dispatch/core/economy.js';
import {
  runWithDispatchContext,
  type DispatchContext as CorrelationContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { handleEventQuery } from '../../../../src/events/tools.js';
import { EventStore } from '../../../../src/events/store.js';
import { declared, findActionInRegistry } from '../../../../src/registry.js';
import type { ToolResult } from '../../../../src/format.js';
import type { RunbookStep } from '../../../../src/runbooks/types.js';
import { compileIntent } from '../../../../src/verbs/execute/compile.js';
import {
  derivedLeafOperationId,
  handleExecuteIntent,
  INTENT_EXECUTED_EVENT,
  type ExecuteIntentDeps,
  type LeafHandlerTable,
} from '../../../../src/verbs/execute/executor.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import {
  appendingHandler,
  countingHandler,
  failingHandler,
  fixtureAction,
  fixtureCorrelation,
  fixtureIntentArgs,
  fixtureRunbook,
  fixtureStep,
  fixtureWiring,
  findFixtureAction,
  gateEvidenceHandler,
  keyedAppendingHandler,
  receiptOf,
  silentHandler,
  throwingHandler,
} from './fixtures.js';

const STREAM = 'wf-fixture-intent';
const INTENT = 'fixture-intent';

let stateDir: string;
let store: EventStore;
let outer: CorrelationContext;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'execute-intent-fixture-'));
  store = new EventStore(stateDir);
  await store.initialize();
  outer = fixtureCorrelation();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

function depsFor(
  steps: readonly RunbookStep[],
  handlers: LeafHandlerTable,
  actions: Parameters<typeof findFixtureAction>[0],
): ExecuteIntentDeps {
  return {
    runbookTable: [fixtureRunbook(INTENT, steps)],
    findAction: findFixtureAction(actions),
    argSchemas: { [INTENT]: fixtureIntentArgs },
    handlers,
  };
}

async function execute(raw: Record<string, unknown>, deps: ExecuteIntentDeps): Promise<ToolResult> {
  return runWithDispatchContext(outer, () =>
    handleExecuteIntent(raw, stateDir, fixtureWiring(stateDir, store), deps),
  );
}

/** An action that promises the one event its handler appends, and nothing else. */
function announcing(name: string, event: string) {
  return fixtureAction({
    name,
    emissions: declared({ event, condition: 'always', owner: 'orchestrate', role: 'primary' }),
    ensures: declared({ source: 'event-append', when: 'success', event }),
  });
}

// ─── A deterministic chain, and the receipt as the caller's whole view ──────

describe('a three-leaf fixture chain', () => {
  const CHAIN: readonly (readonly [string, string])[] = [
    ['fixture_claim', 'task.claimed'],
    ['fixture_gate', 'gate.executed'],
    ['fixture_finish', 'task.completed'],
  ];
  const actions = CHAIN.map(([name, event]) => announcing(name, event));
  const steps = CHAIN.map(([name]) => fixtureStep(name, 'stop'));

  function chainDeps(): ExecuteIntentDeps {
    const handlers: Record<string, ReturnType<typeof appendingHandler>> = {};
    for (const [name, event] of CHAIN) handlers[name] = appendingHandler(event);
    return depsFor(steps, handlers, actions);
  }

  it('RunsInRunbookOrder_StampsEachLeafWithItsOwnDerivedIdentity', async () => {
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-chain' },
      chainDeps(),
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.action)).toEqual(CHAIN.map(([name]) => name));
    expect(receipt.leaves.every((leaf) => leaf.status === 'passed')).toBe(true);

    // The stream's own order is the runbook's order — the segment is a
    // sequence, not a fan-out.
    const appended = (await store.query(STREAM)).filter(
      (event) => event.type !== INTENT_EXECUTED_EVENT,
    );
    expect(appended.map((event) => event.type)).toEqual(CHAIN.map(([, event]) => event));

    // Each leaf's event carries that leaf's derived id, not the caller's and
    // not its neighbour's.
    for (const [index, [name]] of CHAIN.entries()) {
      expect(appended[index]?.operationId).toBe(derivedLeafOperationId('op-chain', index, name));
    }
    expect(new Set(appended.map((event) => event.operationId)).size).toBe(CHAIN.length);
  });

  it('ReceiptDescribesEveryLeafAndTheTailItReached', async () => {
    const receipt = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-shape' },
        chainDeps(),
      ),
    );

    const appended = (await store.query(STREAM)).filter(
      (event) => event.type !== INTENT_EXECUTED_EVENT,
    );
    expect(receipt.leaves.map((leaf) => leaf.events)).toEqual(
      CHAIN.map(([, event], index) => [
        // Type, the stream the sequence numbers, and the sequence. Every leaf
        // here addresses the subject, so every pair names the subject stream.
        { type: event, streamId: STREAM, sequence: appended[index]?.sequence },
      ]),
    );
    expect(receipt.tailSequence).toBe(appended[appended.length - 1]?.sequence);
    expect(receipt.interaction).toMatchObject({
      leavesExecuted: 3,
      eventsAppended: 3,
      requests: 1,
    });
    expect(receipt.operationId).toBe('op-shape');
    expect(receipt.intent).toBe(INTENT);

    const committed = await store.query(STREAM, { type: INTENT_EXECUTED_EVENT });
    expect(committed).toHaveLength(1);
    expect(committed[0]?.data).toMatchObject({
      outcome: 'committed',
      leaves: CHAIN.map(([name], index) => ({
        action: name,
        status: 'passed',
        sequences: [appended[index]?.sequence],
      })),
    });
  });
});

// ─── Why per-leaf admission is placed where it is ───────────────────────────

describe('a terminal leaf whose requirement an earlier leaf satisfies', () => {
  // `review` is a family the contract normalizer accepts without a gate
  // whitelist, so a fixture can name a resolved gate the same way a shipped
  // action does. The evidence id spelling is one of the three the admission
  // evaluator matches a `{family, gate}` discriminant against.
  const REQUIREMENT_ID = 'gate:review:review';
  const PRODUCER = 'fixture.review-gate';

  const recorder = fixtureAction({ name: 'fixture_record_evidence' });
  const gated = fixtureAction({
    name: 'fixture_needs_evidence',
    requires: declared({ family: 'review', gate: 'review' }),
  });

  const steps = [
    fixtureStep('fixture_record_evidence', 'stop'),
    fixtureStep('fixture_needs_evidence', 'stop'),
  ];

  let phaseAttemptId: string;

  beforeEach(async () => {
    phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  });

  function gatedDeps(): ExecuteIntentDeps {
    return depsFor(
      steps,
      {
        fixture_record_evidence: gateEvidenceHandler({
          requirementId: REQUIREMENT_ID,
          phaseAttemptId,
          producerRef: PRODUCER,
        }),
        fixture_needs_evidence: silentHandler(),
      },
      [recorder, gated],
    );
  }

  it('InOrder_TheSegmentCommits', async () => {
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-gated' },
      gatedDeps(),
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(true);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves.map((leaf) => leaf.status)).toEqual(['passed', 'passed']);

    const evidence = await store.query(STREAM, { type: 'admission.evidence-recorded' });
    expect(evidence).toHaveLength(1);
  });

  it('SameLeafAdmittedBeforeItsPredecessorRan_IsDenied', async () => {
    // The control. Same declaration, same arguments, same evaluator — only the
    // store's contents differ, because the earlier leaf has not run. Admitting
    // the whole segment up front would have asked exactly this question, and
    // got exactly this answer, for a segment that in order succeeds.
    const compiled = compileIntent(INTENT, { streamId: STREAM }, { taskId: 't1' }, gatedDeps());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const terminal = compiled.segment.leaves[1];
    expect(terminal?.action).toBe('fixture_needs_evidence');
    if (terminal === undefined) return;

    const before = await runWithDispatchContext(outer, () =>
      evaluateDispatchAdmission({
        tool: terminal.tool,
        actionName: terminal.action,
        action: terminal.declaration,
        args: terminal.args,
        ctx: fixtureWiring(stateDir, store),
        authorization: outer.authorization,
      }),
    );
    expect(before).not.toBeNull();
    expect(before?.error?.code).toBe('ADMISSION_DENIED');

    // Run the predecessor, and only the predecessor.
    await execute(
      {
        intent: INTENT,
        streamId: STREAM,
        args: { taskId: 't1' },
        operationId: 'op-predecessor-only',
      },
      depsFor([steps[0] as RunbookStep], {
        fixture_record_evidence: gateEvidenceHandler({
          requirementId: REQUIREMENT_ID,
          phaseAttemptId,
          producerRef: PRODUCER,
        }),
      }, [recorder]),
    );

    const after = await runWithDispatchContext(outer, () =>
      evaluateDispatchAdmission({
        tool: terminal.tool,
        actionName: terminal.action,
        action: terminal.declaration,
        args: terminal.args,
        ctx: fixtureWiring(stateDir, store),
        authorization: outer.authorization,
      }),
    );
    expect(after).toBeNull();
  });

  it('DeniedLeaf_HaltsTheSegmentAndCommitsFailed', async () => {
    // The same denial reached through the executor: without the recording
    // leaf, the gated leaf is refused rather than run.
    const ran = countingHandler(silentHandler());
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-ungated' },
      depsFor([steps[1] as RunbookStep], { fixture_needs_evidence: ran.handler }, [gated]),
    );
    const receipt = receiptOf(result);

    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('fixture_needs_evidence');
    expect(result.error?.message).toContain('not admitted');
    expect(ran.calls()).toBe(0);
  });
});

// ─── Crash, retry, and the rows the completed leaves already wrote ──────────

describe('retry after a crash mid-segment', () => {
  const first = announcing('fixture_first', 'task.claimed');
  const second = announcing('fixture_second', 'gate.executed');
  const third = fixtureAction({ name: 'fixture_third' });
  const fourth = fixtureAction({ name: 'fixture_fourth' });

  const steps = [
    fixtureStep('fixture_first', 'stop'),
    fixtureStep('fixture_second', 'stop'),
    fixtureStep('fixture_third', 'stop'),
    fixtureStep('fixture_fourth', 'stop'),
  ];

  it('SameOperationId_AppendsNoDuplicateRowsForTheLeavesThatAlreadyRan', async () => {
    const firstCalls = countingHandler(keyedAppendingHandler('task.claimed', 'fixture.first'));
    const secondCalls = countingHandler(
      keyedAppendingHandler('gate.executed', 'fixture.second'),
    );
    let crash = true;
    const handlers: LeafHandlerTable = {
      fixture_first: firstCalls.handler,
      fixture_second: secondCalls.handler,
      fixture_third: async (args, dir, ctx) =>
        crash
          ? throwingHandler('fixture crash at the third leaf')(args, dir, ctx)
          : silentHandler()(args, dir, ctx),
      fixture_fourth: silentHandler(),
    };
    const deps = depsFor(steps, handlers, [first, second, third, fourth]);
    const request = {
      intent: INTENT,
      streamId: STREAM,
      args: { taskId: 't1' },
      operationId: 'op-crash-retry',
    };

    await expect(execute(request, deps)).rejects.toThrow('fixture crash at the third leaf');
    const afterCrash = await store.query(STREAM);
    expect(afterCrash.map((event) => event.type)).toEqual(['task.claimed', 'gate.executed']);
    expect(await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).toHaveLength(0);

    crash = false;
    const result = await execute(request, deps);
    expect(result.success).toBe(true);

    // The retried receipt reports the rows the FIRST run wrote. A deduped
    // append notifies no observer — that is what dedupe means — so a receipt
    // built from the observer alone read zero events and a zero tail for rows
    // plainly in the log. The leaf's own derived id is what retrieves them.
    const retried = receiptOf(result);
    expect(retried.leaves.map((leaf) => leaf.events)).toEqual([
      [{ type: 'task.claimed', streamId: STREAM, sequence: afterCrash[0]?.sequence }],
      [{ type: 'gate.executed', streamId: STREAM, sequence: afterCrash[1]?.sequence }],
      [],
      [],
    ]);
    expect(retried.tailSequence).toBe(afterCrash[1]?.sequence);
    expect(retried.interaction.eventsAppended).toBe(2);

    // The two completed leaves genuinely RE-RAN — nothing skipped them. What
    // did not happen is a second row: the derived leaf id is the same on both
    // attempts, so the key each leaf appends under is the same, and the second
    // write collapses onto the first.
    expect(firstCalls.calls()).toBe(2);
    expect(secondCalls.calls()).toBe(2);
    const leafEvents = (await store.query(STREAM)).filter(
      (event) => event.type !== INTENT_EXECUTED_EVENT,
    );
    expect(leafEvents.map((event) => event.type)).toEqual(['task.claimed', 'gate.executed']);
    expect(leafEvents.map((event) => event.sequence)).toEqual(
      afterCrash.map((event) => event.sequence),
    );

    for (const [index, name] of ['fixture_first', 'fixture_second'].entries()) {
      const held = await store.query(STREAM, {
        operationId: derivedLeafOperationId('op-crash-retry', index, name),
      });
      expect(held).toHaveLength(1);
    }
  });

  it('AnUnkeyedLeafDuplicatesInstead_TheKeyIsWhatDedupes', async () => {
    // The control for the test above: the same crash and the same retry, with
    // the only change being that the leaf appends without a derived key. Two
    // rows. Stable ids do not dedupe by themselves — they make a key that can.
    const unkeyed = countingHandler(appendingHandler('task.claimed'));
    let crash = true;
    const handlers: LeafHandlerTable = {
      fixture_first: unkeyed.handler,
      fixture_second: async (args, dir, ctx) =>
        crash
          ? throwingHandler('fixture crash')(args, dir, ctx)
          : silentHandler()(args, dir, ctx),
    };
    const deps = depsFor([steps[0] as RunbookStep, steps[1] as RunbookStep], handlers, [
      first,
      second,
    ]);
    const request = {
      intent: INTENT,
      streamId: STREAM,
      args: { taskId: 't1' },
      operationId: 'op-unkeyed-retry',
    };

    await expect(execute(request, deps)).rejects.toThrow('fixture crash');
    crash = false;
    // The second leaf's registration promises an event its silent handler does
    // not append, so the retried segment halts there — the point of interest is
    // the first leaf's row count either way.
    await execute(request, deps);

    expect(unkeyed.calls()).toBe(2);
    expect(await store.query(STREAM, { type: 'task.claimed' })).toHaveLength(2);
  });
});

// ─── The registered economy cap, over a receipt the executor actually made ──

describe('an oversized receipt through the registered economy path', () => {
  const LEAF_COUNT = 120;
  // The worker declares no emission: what is under test is the receipt's SIZE,
  // and a hundred-odd leaves each owing an event would make the run about the
  // emission check instead.
  const worker = fixtureAction({ name: 'fixture_worker' });
  const refuser = fixtureAction({ name: 'fixture_refuser' });

  function longDeps(terminal: 'passes' | 'refuses'): ExecuteIntentDeps {
    const steps = [
      ...Array.from({ length: LEAF_COUNT }, () => fixtureStep('fixture_worker', 'stop')),
      fixtureStep('fixture_refuser', 'stop'),
    ];
    return depsFor(
      steps,
      {
        fixture_worker: appendingHandler('task.progressed'),
        fixture_refuser:
          terminal === 'refuses' ? failingHandler('the terminal leaf refused') : silentHandler(),
      },
      [worker, refuser],
    );
  }

  it('CommittedAndOverBudget_KeepsOperationIdOutcomeAndTailSequence', async () => {
    const receipt = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-economy' },
        longDeps('passes'),
      ),
    );
    expect(receipt.outcome).toBe('committed');
    expect(receipt.leaves).toHaveLength(LEAF_COUNT + 1);

    const capped = enforceResponseEconomy(
      { success: true, data: receipt as unknown as Record<string, unknown> },
      'exarchos_orchestrate',
      'execute_intent',
    );
    expect(capped._meta).toMatchObject({ truncated: true });

    const data = capped.data as Record<string, unknown>;
    expect(data.operationId).toBe('op-economy');
    expect(data.outcome).toBe('committed');
    expect(data.tailSequence).toBe(receipt.tailSequence);
    expect(data.tailSequence).toBeGreaterThan(0);
    // The per-leaf detail is what the cap gave up.
    expect(data.leaves).toBeUndefined();
    expect(data.counts).toMatchObject({ leaves: LEAF_COUNT + 1, total: LEAF_COUNT + 1 });

    // And the capped payload is actually under the declared budget — over a
    // receipt the executor really produced, not a hand-built one.
    const budget = findActionInRegistry('exarchos_orchestrate', 'execute_intent')?.economy
      ?.budgetTokens;
    expect(budget).toBeGreaterThan(0);
    expect(estimateOutputTokens(data)).toBeLessThanOrEqual(budget ?? 0);
    expect((data.firstPage as unknown[]).length).toBeLessThan(LEAF_COUNT + 1);
    expect(data.counts).toMatchObject({ shown: (data.firstPage as unknown[]).length });
  });

  it('FailedAndOverBudget_IsReturnedVerbatimAndTheReducerStillPinsFailedLeaf', async () => {
    // A failure envelope is not measured or capped — `enforceResponseEconomy`
    // returns it whole, because a refusal's carrier has to survive. So the
    // `failedLeaf` pin can never be reached through the dispatch path; it is
    // the registered reducer's own promise, and that is where it is checked.
    const result = await execute(
      { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-economy-fail' },
      longDeps('refuses'),
    );
    const receipt = receiptOf(result);
    expect(result.success).toBe(false);
    expect(receipt.outcome).toBe('failed');
    expect(receipt.failedLeaf).toBe('fixture_refuser');

    const passthrough = enforceResponseEconomy(
      result,
      'exarchos_orchestrate',
      'execute_intent',
    );
    expect(passthrough).toBe(result);

    const summarize = findActionInRegistry(
      'exarchos_orchestrate',
      'execute_intent',
    )?.economy?.summarize;
    expect(summarize).toBeTypeOf('function');
    const summarized = summarize?.(receipt) as Record<string, unknown>;
    expect(summarized.operationId).toBe('op-economy-fail');
    expect(summarized.outcome).toBe('failed');
    expect(summarized.failedLeaf).toBe('fixture_refuser');
    expect(summarized.tailSequence).toBe(receipt.tailSequence);
  });
});

// ─── The trace, from nothing but the receipt ────────────────────────────────

describe('retrieving the trace a receipt describes', () => {
  const CHAIN: readonly (readonly [string, string])[] = [
    ['fixture_claim', 'task.claimed'],
    ['fixture_gate', 'gate.executed'],
  ];

  it('LeafEventsByDerivedId_OperationRecordByTheOuterDispatchId', async () => {
    const actions = CHAIN.map(([name, event]) => announcing(name, event));
    const handlers: LeafHandlerTable = {};
    for (const [name, event] of CHAIN) handlers[name] = appendingHandler(event);
    const deps = depsFor(
      CHAIN.map(([name]) => fixtureStep(name, 'stop')),
      handlers,
      actions,
    );

    const receipt = receiptOf(
      await execute(
        { intent: INTENT, streamId: STREAM, args: { taskId: 't1' }, operationId: 'op-trace' },
        deps,
      ),
    );

    // A caller holds the receipt and nothing else. Each leaf's events come
    // back from the derived-id convention over `receipt.operationId`.
    const seen: { type: string; sequence: number }[] = [];
    for (const [index, leaf] of receipt.leaves.entries()) {
      const page = await handleEventQuery(
        {
          stream: STREAM,
          filter: { operationId: derivedLeafOperationId(receipt.operationId, index, leaf.action) },
        },
        stateDir,
        store,
      );
      expect(page.success).toBe(true);
      const events = (page.data as { events: { type: string; sequence: number }[] }).events;
      expect(events.map((event) => event.type)).toEqual(leaf.events.map((event) => event.type));
      seen.push(...events);
    }
    expect(seen.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      receipt.leaves.flatMap((leaf) => leaf.events.map((event) => event.sequence)),
    );

    // The operation record is stamped with the OUTER dispatch's operation id,
    // not the caller's key — the emission check for `execute_intent` itself
    // queries by that dispatch id, so the commit has to carry it. The caller's
    // key is inside the record, which is how a receipt-holder recognizes it.
    const record = await handleEventQuery(
      { stream: STREAM, filter: { operationId: outer.operationId } },
      stateDir,
      store,
    );
    const recorded = (record.data as { events: { type: string; data: unknown }[] }).events;
    expect(recorded.map((event) => event.type)).toEqual([INTENT_EXECUTED_EVENT]);
    expect((recorded[0]?.data as { operationId?: string }).operationId).toBe('op-trace');
  });
});
