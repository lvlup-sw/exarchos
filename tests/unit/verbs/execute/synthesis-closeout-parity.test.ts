// @oracle-sources: ../../../../src/verbs/execute/executor.ts, the by-hand primitive baseline this file drives — the same compiled leaves invoked one at a time through the orchestrate handler table against a SECOND event store with the runbook's stop policy applied by the loop rather than by the executor
//
// ─── Composition parity: driving the closeout vs executing the intent ──────
//
// The bounded executor's claim is that it changes WHO drives the runbook, not
// WHAT running it does. For this segment the claim is worth more than usual,
// because the middle of it opens a pull request — so the comparison covers a
// leaf with a remote side effect rather than only local verdicts.
//
// The denominator is NOT empty, which is the reason this file exists. The body
// check appends nothing, but `create_pr` journals its intent and its result
// onto the shared `vcs` stream, and those two rows carry the title, the body
// actually sent, the branch pair, then the number and url the provider
// answered.
//
// What that compares and what it does not: BOTH paths build their leaf
// arguments with the shipped compiler, the way the sibling parity suites do, so
// a mis-bound argument moves both sides together and is not what this catches.
// What it catches is the DRIVING — the order the leaves run in, the failure
// policy applied between them, what each handler left on which stream, and the
// one row the executor adds that a hand-followed runbook does not.
//
// The provider is the only thing stubbed, at the factory both paths import.
// Stubbing it is not what the sibling parity suites exclude — those drop leaves
// that shell out to git or the project's toolchain, whose verdict would depend
// on the machine. A provider call answered in-process depends on nothing.
//
// EXCLUDED FROM THE COMPARISON, and why each can never byte-match: the
// operation id (the executor stamps a DERIVED per-leaf id, the baseline the one
// ambient dispatch id — the mechanism under test, not a divergence) and the
// store-allocated or wall-clock scaffolding around it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { VcsProvider } from '../../../../src/vcs/provider.js';
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
import { fixtureCorrelation, fixtureWiring, receiptOf } from './fixtures.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';

const INTENT = 'synthesis-closeout';
const STREAM = 'wf-synthesis-parity';
const VCS_STREAM = 'vcs';

const ARGS = {
  title: 'feat: compare the two drivers',
  prBody: ['## Summary', '', 'x', '', '## Changes', '', '- y', '', '## Test Plan', '', '- z'].join('\n'),
  baseBranch: 'main',
  headBranch: 'feature/synthesis-parity',
};

function makeProvider(): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn().mockResolvedValue({ number: 7, url: 'https://example.invalid/pr/7' }),
    listPrs: vi.fn().mockResolvedValue([]),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  } as unknown as VcsProvider;
}

function deps(): ExecuteIntentDeps {
  return {
    runbookTable: ALL_RUNBOOKS,
    findAction: findActionInRegistry,
    argSchemas: INTENT_ARG_SCHEMAS,
    // The LIVE orchestrate table, not a fixture one — the composite hands the
    // executor this same object, so both paths reach the same handlers.
    handlers: ACTION_HANDLERS,
    handlerTool: 'exarchos_orchestrate',
  };
}

// ─── Normalization ──────────────────────────────────────────────────────────

const EXCLUDED_KEYS = new Set([
  'operationId',
  'correlationId',
  'causationId',
  'timestamp',
  'createdAt',
  'updatedAt',
  'eventId',
  'sequence',
  'idempotencyKey',
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

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(createVcsProvider).mockImplementation(async () => makeProvider());
  baselineDir = await mkdtemp(path.join(tmpdir(), 'synthesis-parity-base-'));
  executorDir = await mkdtemp(path.join(tmpdir(), 'synthesis-parity-exec-'));
  baselineStore = new EventStore(baselineDir);
  executorStore = new EventStore(executorDir);
  await baselineStore.initialize();
  await executorStore.initialize();
  await seedActivePhaseAttempt(baselineStore, STREAM, { phase: 'synthesize' });
  await seedActivePhaseAttempt(executorStore, STREAM, { phase: 'synthesize' });
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
}

/** The primitive baseline: the registered handlers, called in runbook order. */
async function runPrimitiveBaseline(ctx: DispatchContext): Promise<BaselineLeafOutcome[]> {
  const compiled = compileIntent(INTENT, { streamId: STREAM }, ARGS, deps());
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return [];
  const outcomes: BaselineLeafOutcome[] = [];
  for (const leaf of compiled.segment.leaves) {
    const handler = ACTION_HANDLERS[leaf.action];
    expect(handler).toBeTypeOf('function');
    const result = await handler?.(leaf.args, ctx.stateDir, ctx);
    outcomes.push({ action: leaf.action, success: result?.success === true });
    // The runbook's failure policy, applied by hand.
    if (result?.success === false && leaf.onFail === 'stop') break;
  }
  return outcomes;
}

describe('synthesis-closeout driven by hand and by the executor', () => {
  it('ExecutorAndPrimitiveBaseline_ProduceTheSameJournalFacts', async () => {
    const correlation = fixtureCorrelation();

    const baseline = await runWithDispatchContext(correlation, () =>
      runPrimitiveBaseline(fixtureWiring(baselineDir, baselineStore)),
    );
    const executed = await runWithDispatchContext(correlation, () =>
      handleExecuteIntent(
        { intent: INTENT, streamId: STREAM, args: ARGS, operationId: 'op-synthesis-parity' },
        executorDir,
        fixtureWiring(executorDir, executorStore),
        deps(),
      ),
    );

    const baselineVcs = await baselineStore.query(VCS_STREAM);
    const executorVcs = await executorStore.query(VCS_STREAM);

    // Same rows, same order, same stream, same payload — including the body
    // that was sent, which is the argument this segment exists to carry.
    expect(leafFacts(executorVcs)).toEqual(leafFacts(baselineVcs));

    // Not vacuous: the comparison ran over the two journal rows rather than
    // over nothing, and the body inside them is the one the caller supplied.
    expect(baselineVcs.map((row) => row.type)).toEqual([
      'pr.create.requested',
      'pr.create.executed',
    ]);
    expect((baselineVcs[0]?.data as { body?: string }).body).toBe(ARGS.prBody);

    // The per-leaf verdicts match too, which the log alone does not say.
    expect(baseline.map((leaf) => [leaf.action, leaf.success])).toEqual([
      ['validate_pr_body', true],
      ['create_pr', true],
    ]);
    expect(receiptOf(executed).leaves.map((leaf) => [leaf.action, leaf.status])).toEqual([
      ['validate_pr_body', 'passed'],
      ['create_pr', 'passed'],
    ]);

    // The one fact only the executor produces: its own operation record, on the
    // SUBJECT stream while the leaves wrote to the shared one.
    expect(
      (await executorStore.query(STREAM)).filter((row) => row.type === INTENT_EXECUTED_EVENT),
    ).toHaveLength(1);
    expect(
      (await baselineStore.query(STREAM)).filter((row) => row.type === INTENT_EXECUTED_EVENT),
    ).toHaveLength(0);
  });

  it('BothPathsHaltAtTheBodyCheck_WhenTheBodyIsDeficient', async () => {
    // Parity on the refusing path as well: the failure policy the executor
    // applies is the one an orchestrator following the runbook applies by hand,
    // so neither path reaches the remote and neither leaves a journal row.
    const correlation = fixtureCorrelation();
    const deficient = { ...ARGS, prBody: 'no required sections here' };

    const baseline = await runWithDispatchContext(correlation, async () => {
      const compiled = compileIntent(INTENT, { streamId: STREAM }, deficient, deps());
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return [];
      const ctx = fixtureWiring(baselineDir, baselineStore);
      const outcomes: BaselineLeafOutcome[] = [];
      for (const leaf of compiled.segment.leaves) {
        const result = await ACTION_HANDLERS[leaf.action]?.(leaf.args, ctx.stateDir, ctx);
        outcomes.push({ action: leaf.action, success: result?.success === true });
        if (result?.success === false && leaf.onFail === 'stop') break;
      }
      return outcomes;
    });

    const executed = await runWithDispatchContext(correlation, () =>
      handleExecuteIntent(
        {
          intent: INTENT,
          streamId: STREAM,
          args: deficient,
          operationId: 'op-synthesis-parity-halt',
        },
        executorDir,
        fixtureWiring(executorDir, executorStore),
        deps(),
      ),
    );

    expect(baseline.map((leaf) => [leaf.action, leaf.success])).toEqual([
      ['validate_pr_body', false],
    ]);
    expect(receiptOf(executed).leaves.map((leaf) => leaf.action)).toEqual(['validate_pr_body']);
    expect(await baselineStore.query(VCS_STREAM)).toHaveLength(0);
    expect(await executorStore.query(VCS_STREAM)).toHaveLength(0);
  });
});
