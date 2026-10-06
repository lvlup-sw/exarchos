/**
 * Response-economy declaration for `prepare`. The capsule is the response, and the harness runs
 * the batch from it with no other governance calls. The budget carries a realistic batch in full.
 * For a larger batch, the reducer keeps the identity, the digest, the task ids and the custody
 * reference that `settle` needs. It also keeps the recompile that a continuation recorded.
 *
 * The dispatcher does not measure a summary. Thus the summary measures itself with the estimator
 * of the dispatcher, and it trims itself until it is within the budget.
 */

import { estimateOutputTokens, SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const PREPARE_ECONOMY_BUDGET_TOKENS = 8000;

/** The list limit of a summary that no trim cut. */
const WHOLE_LIST = Number.POSITIVE_INFINITY;

/** One compiled task on the first page. */
interface SummaryTask {
  readonly taskId: unknown;
  readonly title: unknown;
}

/**
 * The recompile of a continuation, as the capped receipt carries it. No trim removes the three
 * versions. A trim can cut each task list to its first page, and `counts` holds the full sizes.
 * The full lists stay on the `capsule.recompiled` row.
 */
interface SummaryRecompile {
  readonly priorCapsuleVersion: unknown;
  readonly priorDesignVersion: unknown;
  readonly nextDesignVersion: unknown;
  readonly declaredTasks: ReadonlyArray<unknown>;
  readonly invalidatedTasks: ReadonlyArray<unknown>;
}

/** The capped receipt's shape, declared so a field the caller needs cannot be dropped silently. */
export interface PreparedCapsuleReceiptSummary {
  readonly summary: string;
  /**
   * `shown` counts the tasks on the first page. `declaredTasks` and `invalidatedTasks` count the
   * two lists of the recompile in the receipt, and they are present with `recompile`.
   */
  readonly counts: {
    readonly tasks: number;
    readonly shown: number;
    readonly declaredTasks?: number;
    readonly invalidatedTasks?: number;
  };
  /** The first page of compiled tasks. A trim empties it, and it stays an array as the capped shape requires. */
  readonly firstPage: ReadonlyArray<SummaryTask>;
  readonly operationId: unknown;
  readonly workflowId: unknown;
  readonly capsuleVersion: unknown;
  readonly capsuleDigest: unknown;
  readonly definitionVersion: unknown;
  readonly tailSequence: unknown;
  /** The custody reference survives the cap. It is the only pointer to the full capsule. */
  readonly bundleRefs: unknown;
  /** The recompile that the prepare recorded. It is present exactly when the receipt carries one. */
  readonly recompile?: SummaryRecompile;
}

/**
 * The receipt fields that the summary reads. Each field is optional, because a receipt replayed
 * from the claim of an earlier build carries fewer fields.
 */
interface CappableReceipt {
  readonly operationId?: unknown;
  readonly workflowId?: unknown;
  readonly capsuleVersion?: unknown;
  readonly capsuleDigest?: unknown;
  readonly definitionVersion?: unknown;
  readonly tailSequence?: unknown;
  readonly bundleRefs?: unknown;
  readonly capsule?: {
    readonly graph?: {
      readonly tasks?: ReadonlyArray<{ readonly taskId?: unknown; readonly title?: unknown }>;
    };
  };
  readonly recompile?: {
    readonly priorCapsuleVersion?: unknown;
    readonly priorDesignVersion?: unknown;
    readonly nextDesignVersion?: unknown;
    readonly declaredTasks?: ReadonlyArray<unknown>;
    readonly invalidatedTasks?: ReadonlyArray<unknown>;
  };
}

/** The list, or an empty list for a value that is not an array. */
function listOf<T>(value: ReadonlyArray<T> | undefined): ReadonlyArray<T> {
  return Array.isArray(value) ? value : [];
}

/**
 * Reduce a receipt to a summary that is within the budget.
 *
 * The summary holds the identity of the capsule, the first page of its tasks, and the recompile
 * of a continuation. A summary over the budget first loses its task page. Then each task list
 * of the recompile is cut to its first page. No trim removes the versions of the recompile.
 *
 * The fields after `firstPage` pass through `CappedDataSchema`, which is `.passthrough()`.
 */
export function summarizePreparedCapsuleReceipt(data: unknown): PreparedCapsuleReceiptSummary {
  const receipt = data as CappableReceipt;
  const tasks = listOf(receipt.capsule?.graph?.tasks);
  const page: ReadonlyArray<SummaryTask> = tasks
    .slice(0, SUMMARY_FIRST_PAGE_ITEMS)
    .map((task) => ({ taskId: task.taskId, title: task.title }));
  const recorded = receipt.recompile ?? undefined;
  const declared = listOf(recorded?.declaredTasks);
  const invalidated = listOf(recorded?.invalidatedTasks);

  const assemble = (
    firstPage: ReadonlyArray<SummaryTask>,
    listLimit: number,
  ): PreparedCapsuleReceiptSummary => {
    const cut = declared.length > listLimit || invalidated.length > listLimit;
    return {
      summary:
        `capsule v${String(receipt.capsuleVersion)} of '${String(receipt.workflowId)}' compiled over ` +
        `${tasks.length} task(s); the full capsule is in custody under bundleRefs` +
        (tasks.length > firstPage.length ? `; ${firstPage.length} task(s) shown` : '') +
        (recorded !== undefined
          ? `; recompiled from capsule v${String(recorded.priorCapsuleVersion)} for design version ` +
            `${String(recorded.priorDesignVersion)} to ${String(recorded.nextDesignVersion)}, with ` +
            `${declared.length} task(s) declared and ${invalidated.length} invalidated`
          : '') +
        (cut ? `; the first ${listLimit} of each recompile list shown` : ''),
      counts: {
        tasks: tasks.length,
        shown: firstPage.length,
        ...(recorded !== undefined
          ? { declaredTasks: declared.length, invalidatedTasks: invalidated.length }
          : {}),
      },
      firstPage,
      operationId: receipt.operationId,
      workflowId: receipt.workflowId,
      capsuleVersion: receipt.capsuleVersion,
      capsuleDigest: receipt.capsuleDigest,
      definitionVersion: receipt.definitionVersion,
      tailSequence: receipt.tailSequence,
      bundleRefs: receipt.bundleRefs,
      ...(recorded !== undefined
        ? {
            recompile: {
              priorCapsuleVersion: recorded.priorCapsuleVersion,
              priorDesignVersion: recorded.priorDesignVersion,
              nextDesignVersion: recorded.nextDesignVersion,
              declaredTasks: declared.slice(0, listLimit),
              invalidatedTasks: invalidated.slice(0, listLimit),
            },
          }
        : {}),
    };
  };
  const fits = (candidate: PreparedCapsuleReceiptSummary): boolean =>
    estimateOutputTokens(candidate) <= PREPARE_ECONOMY_BUDGET_TOKENS;

  const whole = assemble(page, WHOLE_LIST);
  if (fits(whole)) return whole;
  const withoutTaskPage = assemble([], WHOLE_LIST);
  if (fits(withoutTaskPage)) return withoutTaskPage;
  return assemble([], SUMMARY_FIRST_PAGE_ITEMS);
}
