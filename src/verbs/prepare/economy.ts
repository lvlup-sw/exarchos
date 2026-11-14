/**
 * Response-economy declaration for `prepare`. The capsule is the response, and the harness runs
 * the batch from it with no other governance calls. The budget carries a realistic batch in full.
 * For a larger batch, the reducer keeps the identity, the digest, the task ids and the custody
 * reference that `settle` needs. It also keeps the recompile that a continuation recorded.
 *
 * The dispatcher does not measure a summary. Thus the summary measures itself with the estimator
 * of the dispatcher, and it trims itself until it is within the budget.
 */

import type { ExarchosCapsuleV1 } from '../../contract/capsule/exarchos-capsule.js';
import type { BundleRefV1 } from '../../events/bundle/digest-references.js';
import { ArtifactIdSchema } from '../../workflow/admission/types.js';
import { estimateOutputTokens, SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const PREPARE_ECONOMY_BUDGET_TOKENS = 8000;

/**
 * The reads that serve what a summary of `prepare` drops. The next action of a capped response
 * names them, because the action takes no `limit` and no `offset`.
 */
export const PREPARE_DETAIL_READ =
  'The capsule in custody under bundleRefs holds each task and its verification terms. ' +
  'exarchos_event query with filter.type workflow.prepared returns the record of the compilation.';

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
  readonly detailRead?: PreparedDetailInvocation;
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
    readonly provenance?: { readonly compilerVersion?: string };
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
      ...(receipt.capsule?.provenance?.compilerVersion === 'exarchos-prepare-8'
        && typeof receipt.workflowId === 'string' && typeof receipt.capsuleVersion === 'number'
        ? { detailRead: preparedDetailInvocation(receipt.workflowId, receipt.capsuleVersion, 0, 10) } : {}),
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

/** The exact read invocation carries no mutable checkout input. */
export interface PreparedDetailInvocation {
  readonly tool: 'exarchos_orchestrate';
  readonly action: 'read_prepared_capsule';
  readonly arguments: { readonly streamId: string; readonly capsuleVersion: number; readonly offset: number; readonly limit: number };
}

/** Returns the named historical read, including its next page coordinates. */
export function preparedDetailInvocation(streamId: string, capsuleVersion: number, offset: number, limit: number): PreparedDetailInvocation {
  return { tool: 'exarchos_orchestrate', action: 'read_prepared_capsule', arguments: { streamId, capsuleVersion, offset, limit } };
}

/** Each item retains the full context and its authoritative result contract. */
export interface PreparedDetailItem {
  readonly taskId: string;
  readonly stage: NonNullable<ExarchosCapsuleV1['graph']['tasks'][number]['stage']>;
  readonly context: NonNullable<ExarchosCapsuleV1['graph']['tasks'][number]['taskContext']>;
  readonly resultContract: ExarchosCapsuleV1['contracts']['taskResults'][string];
}

/** Metadata is bounded independently of the authored context. */
export interface PreparedDetailMetadata {
  readonly operationId: string;
  readonly capsule: ExarchosCapsuleV1['identity'];
  readonly capsuleDigest: string;
  readonly bundleRefs: readonly [BundleRefV1];
  readonly total: number;
}

/** Builds the complete measured response, including continuation and envelope fields. */
export function preparedDetailCarrier(metadata: PreparedDetailMetadata, items: readonly PreparedDetailItem[], offset: number, limit: number, correlation: Readonly<Record<string, string>> = {}, warnings: readonly string[] = []) {
  const nextOffset = offset + items.length;
  const success: true = true;
  return {
    success,
    data: { ...metadata, offset, limit, count: items.length, items: [...items],
      ...(nextOffset < metadata.total ? { continuation: preparedDetailInvocation(metadata.capsule.workflowId, metadata.capsule.capsuleVersion, nextOffset, limit) } : {}) },
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
    next_actions: [], _meta: { ...correlation }, _perf: { ms: 0, bytes: 0, tokens: 0 },
  };
}

/** Extracts complete items without shortening authored obligations. */
export function preparedDetailItems(capsule: ExarchosCapsuleV1): PreparedDetailItem[] {
  return capsule.graph.tasks.map(task => {
    const context = task.taskContext;
    const stage = task.stage;
    const resultContract = capsule.contracts.taskResults[task.taskId];
    if (context === undefined || stage === undefined || resultContract === undefined) throw new Error('Prepared task lacks complete detail terms');
    return { taskId: task.taskId, stage, context, resultContract };
  });
}

/** Measures each item with the largest admitted metadata and continuation. */
export function preparedDetailDeliverable(capsule: ExarchosCapsuleV1): boolean {
  if (!Number.isSafeInteger(capsule.identity.capsuleVersion)) return false;
  const id = 'x'.repeat(256);
  const maximum = Number.MAX_SAFE_INTEGER;
  const metadata: PreparedDetailMetadata = { operationId: id,
    capsule: { workflowId: id, definitionVersion: 'f'.repeat(64), designVersion: id, capsuleVersion: maximum },
    capsuleDigest: 'f'.repeat(64), bundleRefs: [{ artifactId: ArtifactIdSchema.parse(id), digest: { algorithm: 'sha256', value: 'f'.repeat(64) } }], total: maximum };
  return preparedDetailItems(capsule).every(item => estimateOutputTokens(
    preparedDetailCarrier(metadata, [item], maximum - 2, 10, { operationId: 'x'.repeat(36), correlationId: 'x'.repeat(36) }),
  ) <= PREPARE_ECONOMY_BUDGET_TOKENS);
}
