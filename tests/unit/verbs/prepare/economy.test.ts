/**
 * Tests for the summary that replaces a `prepare` receipt over the response budget.
 * The dispatcher does not measure a summary, so each case measures it with the estimator of the
 * dispatcher against the budget constant of `prepare`.
 *
 * Each receipt holds a capsule that the real compiler compiles from a batch of ready tasks.
 * The batch is large enough to put the receipt over the budget. The receipt of a continuation
 * also holds a recompile. Each case caps its receipt through the economy seam of the dispatcher.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/economy.ts, the receipts that this file builds around capsules of the real compiler and the response that the dispatcher seam returns for each
 */

import { describe, expect, it } from 'vitest';

import { capsuleDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { estimateOutputTokens, SUMMARY_FIRST_PAGE_ITEMS } from '../../../../src/dispatch/core/economy.js';
import { enforceResponseEconomy } from '../../../../src/dispatch/core/response-economy.js';
import { BundleRefV1Schema } from '../../../../src/events/bundle/digest-references.js';
import { ECONOMY_META_TRUNCATED } from '../../../../src/format.js';
import { CappedDataSchema } from '../../../../src/output-schema-declaration.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import {
  compileDelegationCapsule,
  PREPARE_COMPILER_VERSION,
} from '../../../../src/verbs/prepare/compile-capsule.js';
import {
  PREPARE_ECONOMY_BUDGET_TOKENS,
  summarizePreparedCapsuleReceipt,
  type PreparedCapsuleReceiptSummary,
} from '../../../../src/verbs/prepare/economy.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { partitionDelegationBatch } from '../../../../src/verbs/prepare/partition-tasks.js';
import { preparedBundleArtifactId } from '../../../../src/verbs/prepare/prepared-record.js';
import type { PreparedCapsuleReceipt, PreparedRecompile } from '../../../../src/verbs/prepare/types.js';
import { resolveVerificationPolicy } from '../../../../src/workflow/verification-policy-resolver.js';

const WORKFLOW = 'feat-capped-prepare';

/** The tasks of each compiled batch. The receipt of a batch of this size is over the budget. */
const LARGE_BATCH = 160;

/** The length limit of a task id. */
const MAX_TASK_ID_LENGTH = 256;

/** The most tasks that the search for the first trim adds. That many ids of the greatest length are over the budget. */
const SEARCH_BOUND = 256;

/** The id of the batch task at `index`. The padding keeps the ids in plan order when sorted. */
function taskIdOf(index: number): string {
  return `task-${String(index).padStart(4, '0')}`;
}

/** A task id of the greatest length that the id schema allows, distinct for each `index`. */
function longTaskIdOf(index: number): string {
  return taskIdOf(index).padEnd(MAX_TASK_ID_LENGTH, 'x');
}

/**
 * The receipt of one `prepare` over a batch of ready tasks, as the handler returns it. The real
 * compiler compiles the capsule. A continuation compiles the version after its prior capsule,
 * under its next design version.
 */
function receiptOf(recompile?: PreparedRecompile): PreparedCapsuleReceipt {
  const lowered = lowerBuiltInDefinition('feature');
  if (lowered === undefined) throw new Error('the feature workflow did not lower');
  const partition = partitionDelegationBatch(
    Array.from({ length: LARGE_BATCH }, (_, index) => ({
      id: taskIdOf(index),
      title: `title of ${taskIdOf(index)}`,
      status: 'pending',
      blockedBy: [],
    })),
  );
  if (!partition.ok) throw new Error(partition.refusal.message);
  const capsuleVersion = recompile === undefined ? 1 : recompile.priorCapsuleVersion + 1;
  const compiled = compileDelegationCapsule({
    workflowId: WORKFLOW,
    capsuleVersion,
    lowered,
    batch: partition.batch,
    catalogInvariants: [],
    designRef: 'docs/specs/capped-prepare.md',
    designVersion: recompile?.nextDesignVersion ?? 1,
    designRevisions: [],
    acceptedChanges: [],
    compilerVersion: PREPARE_COMPILER_VERSION,
    baseRef: 'feature/capped-prepare',
    executionProfile: { capabilities: ['fs:read', 'shell:exec'] },
    verificationSequence: (riskTier, boundaryTouching) =>
      resolveVerificationPolicy(riskTier, boundaryTouching).sequence,
    compiledAt: '2026-09-12T00:00:00.000Z',
  });
  if (!compiled.ok) throw new Error(compiled.refusal.message);
  const digest = capsuleDigest(compiled.capsule);
  return {
    operationId: `prepare:${digest}`,
    streamId: WORKFLOW,
    workflowId: WORKFLOW,
    capsuleVersion,
    capsuleDigest: digest,
    definitionVersion: compiled.capsule.identity.definitionVersion,
    capsule: compiled.capsule,
    tailSequence: LARGE_BATCH + 4,
    bundleRefs: [
      BundleRefV1Schema.parse({
        artifactId: preparedBundleArtifactId(WORKFLOW, capsuleVersion),
        digest: { algorithm: 'sha256', value: digest },
      }),
    ],
    ...(recompile !== undefined ? { recompile } : {}),
  };
}

/** A response in the form that a carrier parses against the declared output schema. */
function wireEnvelopeOf(data: unknown): unknown {
  return JSON.parse(
    JSON.stringify({ success: true, data, next_actions: [], _meta: {}, _perf: { ms: 0, bytes: 0, tokens: 0 } }),
  );
}

/**
 * The summary that the dispatcher returns for a receipt. The receipt must be over the budget.
 * The summary is within the budget, and it parses against the capped shape and against the
 * output schema that the registry declares for `prepare`.
 */
function dispatchedSummaryOf(receipt: PreparedCapsuleReceipt): PreparedCapsuleReceiptSummary {
  expect(estimateOutputTokens(receipt)).toBeGreaterThan(PREPARE_ECONOMY_BUDGET_TOKENS);
  const dispatched = enforceResponseEconomy({ success: true, data: receipt }, 'exarchos_orchestrate', 'prepare');
  const summary = summarizePreparedCapsuleReceipt(receipt);

  expect(dispatched._meta).toMatchObject({ [ECONOMY_META_TRUNCATED]: true });
  expect(dispatched.data).toStrictEqual(summary);
  expect(estimateOutputTokens(dispatched.data)).toBeLessThanOrEqual(PREPARE_ECONOMY_BUDGET_TOKENS);
  expect(CappedDataSchema.safeParse(JSON.parse(JSON.stringify(summary))).success).toBe(true);
  const declared = findActionInRegistry('exarchos_orchestrate', 'prepare')?.outputSchema;
  if (declared === undefined) throw new Error('the registry declares no output schema for prepare');
  expect(declared.safeParse(wireEnvelopeOf(summary)).success).toBe(true);
  return summary;
}

/** The versions of each recompile here. The prior capsule is the fourth, so the receipt holds the fifth. */
const VERSIONS = { priorCapsuleVersion: 4, priorDesignVersion: 2, nextDesignVersion: 4 };

describe('the capped prepare receipt', () => {
  /**
   * The summary of a continuation holds the versions and the two whole task lists of the
   * recompile. Its counts give the sizes of the lists. One declared task is in no plan.
   * The summary of an ordinary prepare over the same batch holds no recompile and no list count.
   */
  it('PrepareEconomy_ACappedContinuationReceipt_KeepsTheRecompile', () => {
    const recompile: PreparedRecompile = {
      ...VERSIONS,
      declaredTasks: [taskIdOf(7), 'task-removed'],
      invalidatedTasks: [taskIdOf(7), taskIdOf(8), taskIdOf(LARGE_BATCH + 40)],
    };
    const receipt = receiptOf(recompile);

    const summary = dispatchedSummaryOf(receipt);

    expect(summary.recompile).toStrictEqual(recompile);
    expect(summary.counts).toStrictEqual({
      tasks: LARGE_BATCH,
      shown: SUMMARY_FIRST_PAGE_ITEMS,
      declaredTasks: 2,
      invalidatedTasks: 3,
    });
    expect(summary.firstPage[0]).toStrictEqual({ taskId: taskIdOf(0), title: `title of ${taskIdOf(0)}` });
    expect(summary.capsuleVersion).toBe(5);
    expect(summary.capsuleDigest).toBe(receipt.capsuleDigest);
    expect(summary.bundleRefs).toStrictEqual(receipt.bundleRefs);
    expect(summary.summary).toContain('recompiled from capsule v4 for design version 2 to 4');

    const ordinary = dispatchedSummaryOf(receiptOf());
    expect('recompile' in ordinary).toBe(false);
    expect(ordinary.counts).toStrictEqual({ tasks: LARGE_BATCH, shown: SUMMARY_FIRST_PAGE_ITEMS });
    expect(ordinary.summary).not.toContain('recompiled');
  });

  /**
   * A claim of an earlier build holds a receipt with fewer fields, so the reducer reads each field as optional.
   * The first receipt holds only the fields that each build wrote, so it has no recompile.
   * The second holds a recompile that is null, and the third a recompile with one version and no task list.
   * The capsule of the fourth has no graph, and the fifth has no capsule. Each one is over the budget.
   *
   * The reducer gives each a summary within the budget. A summary has a recompile only when the
   * receipt holds one, and it has an empty list for each list that the receipt lacks.
   */
  it('PrepareEconomy_ASparseReceiptOverTheBudget_SummarisesWithoutItsAbsentFields', () => {
    const full = receiptOf();
    const keeping = (keys: readonly string[]): Record<string, unknown> =>
      Object.fromEntries(Object.entries(full).filter(([key]) => keys.includes(key)));
    const writtenByEachBuild = [
      'operationId',
      'streamId',
      'workflowId',
      'capsuleVersion',
      'capsuleDigest',
      'definitionVersion',
      'capsule',
      'tailSequence',
    ];
    const earliest = keeping(writtenByEachBuild);
    expect(Object.keys(earliest).sort()).toStrictEqual([...writtenByEachBuild].sort());
    const padding = 'p'.repeat(5 * PREPARE_ECONOMY_BUDGET_TOKENS);
    const sparse: readonly Record<string, unknown>[] = [
      earliest,
      { ...earliest, recompile: null },
      { ...earliest, recompile: { priorCapsuleVersion: 4 } },
      { ...earliest, capsule: { identity: full.capsule.identity, padding } },
      { ...keeping(writtenByEachBuild.filter((key) => key !== 'capsule')), padding },
    ];
    const wholeBatch = { tasks: LARGE_BATCH, shown: SUMMARY_FIRST_PAGE_ITEMS };
    const expectedCounts = [
      wholeBatch,
      wholeBatch,
      { ...wholeBatch, declaredTasks: 0, invalidatedTasks: 0 },
      { tasks: 0, shown: 0 },
      { tasks: 0, shown: 0 },
    ];
    expect(sparse).toHaveLength(expectedCounts.length);

    for (const [index, receipt] of sparse.entries()) {
      expect(estimateOutputTokens(receipt), `receipt ${index}`).toBeGreaterThan(PREPARE_ECONOMY_BUDGET_TOKENS);

      const summary = summarizePreparedCapsuleReceipt(receipt);

      expect(estimateOutputTokens(summary), `receipt ${index}`).toBeLessThanOrEqual(PREPARE_ECONOMY_BUDGET_TOKENS);
      expect(summary.counts, `receipt ${index}`).toStrictEqual(expectedCounts[index]);
      expect(summary.firstPage, `receipt ${index}`).toHaveLength(expectedCounts[index]?.shown ?? Number.NaN);
      expect('recompile' in summary, `receipt ${index}`).toBe(index === 2);
      expect(summary.capsuleDigest).toBe(full.capsuleDigest);
      expect(summary.bundleRefs).toBeUndefined();
      expect(CappedDataSchema.safeParse(JSON.parse(JSON.stringify(summary))).success).toBe(true);
      const dispatched = enforceResponseEconomy({ success: true, data: receipt }, 'exarchos_orchestrate', 'prepare');
      expect(dispatched._meta).toMatchObject({ [ECONOMY_META_TRUNCATED]: true });
      expect(dispatched.data).toStrictEqual(summary);
    }

    expect(summarizePreparedCapsuleReceipt(sparse[2]).recompile).toStrictEqual({
      priorCapsuleVersion: 4,
      priorDesignVersion: undefined,
      nextDesignVersion: undefined,
      declaredTasks: [],
      invalidatedTasks: [],
    });
    expect(summarizePreparedCapsuleReceipt(earliest).summary).not.toContain('recompiled');
  });

  /**
   * The invalidated list grows by one task until the summary with its task page is over the
   * budget. At that size the summary has no task page, and the recompile is still whole.
   * The last comparison puts the task page back, to show that the trim was necessary.
   * A list at the search bound is over the budget alone, so the search ends inside the bound.
   */
  it('PrepareEconomy_ASummaryOverTheBudget_LosesItsTaskPageBeforeAnyRecompileTask', () => {
    const receipt = receiptOf({ ...VERSIONS, declaredTasks: [], invalidatedTasks: [] });
    const invalidated: string[] = [];
    let summary = summarizePreparedCapsuleReceipt(receipt);
    let recompile: PreparedRecompile = { ...VERSIONS, declaredTasks: [], invalidatedTasks: [] };
    while (summary.firstPage.length > 0) {
      expect(invalidated.length, 'the summary kept its task page over the budget').toBeLessThan(SEARCH_BOUND);
      invalidated.push(longTaskIdOf(invalidated.length));
      recompile = { ...VERSIONS, declaredTasks: [invalidated[0] ?? ''], invalidatedTasks: [...invalidated] };
      summary = dispatchedSummaryOf({ ...receipt, recompile });
    }

    expect(invalidated.length).toBeGreaterThan(SUMMARY_FIRST_PAGE_ITEMS);
    expect(summary.firstPage).toStrictEqual([]);
    expect(summary.recompile).toStrictEqual(recompile);
    expect(summary.counts).toStrictEqual({
      tasks: LARGE_BATCH,
      shown: 0,
      declaredTasks: 1,
      invalidatedTasks: invalidated.length,
    });
    const taskPage = receipt.capsule.graph.tasks
      .slice(0, SUMMARY_FIRST_PAGE_ITEMS)
      .map((task) => ({ taskId: task.taskId, title: task.title }));
    expect(estimateOutputTokens({ ...summary, firstPage: taskPage })).toBeGreaterThan(PREPARE_ECONOMY_BUDGET_TOKENS);
  });

  /**
   * Both task lists hold ids of the greatest length, and each list alone is over the budget.
   * The summary cuts each list to its first page and keeps the three versions. The counts give
   * the sizes of the whole lists, so a reader sees that the lists are cut.
   */
  it('PrepareEconomy_ARecompileOverTheBudget_KeepsItsVersionsAndTheFirstPageOfEachList', () => {
    const declaredTasks = Array.from({ length: 512 }, (_, index) => longTaskIdOf(index));
    const invalidatedTasks = Array.from({ length: 640 }, (_, index) => longTaskIdOf(1000 + index));
    expect(estimateOutputTokens(declaredTasks)).toBeGreaterThan(PREPARE_ECONOMY_BUDGET_TOKENS);
    expect(estimateOutputTokens(invalidatedTasks)).toBeGreaterThan(PREPARE_ECONOMY_BUDGET_TOKENS);

    const summary = dispatchedSummaryOf(receiptOf({ ...VERSIONS, declaredTasks, invalidatedTasks }));

    expect(summary.recompile).toStrictEqual({
      ...VERSIONS,
      declaredTasks: declaredTasks.slice(0, SUMMARY_FIRST_PAGE_ITEMS),
      invalidatedTasks: invalidatedTasks.slice(0, SUMMARY_FIRST_PAGE_ITEMS),
    });
    expect(summary.counts).toStrictEqual({ tasks: LARGE_BATCH, shown: 0, declaredTasks: 512, invalidatedTasks: 640 });
    expect(summary.firstPage).toStrictEqual([]);
    expect(summary.summary).toContain('512 task(s) declared and 640 invalidated');
    expect(summary.summary).toContain(`the first ${SUMMARY_FIRST_PAGE_ITEMS} of each recompile list shown`);
  });
});
