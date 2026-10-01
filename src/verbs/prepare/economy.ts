/**
 * Response-economy declaration for `prepare`. The capsule is the response, and the harness runs
 * the batch from it with no other governance calls. The budget carries a realistic batch in full.
 * For a larger batch, the reducer keeps the identity, the digest, the task ids and the custody
 * reference that `settle` needs.
 */

import { SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const PREPARE_ECONOMY_BUDGET_TOKENS = 8000;

/** The capped receipt's shape, declared so a field the caller needs cannot be dropped silently. */
export interface PreparedCapsuleReceiptSummary {
  readonly summary: string;
  readonly counts: {
    readonly tasks: number;
    readonly shown: number;
  };
  readonly firstPage: ReadonlyArray<{ readonly taskId: unknown; readonly title: unknown }>;
  readonly operationId: unknown;
  readonly workflowId: unknown;
  readonly capsuleVersion: unknown;
  readonly capsuleDigest: unknown;
  readonly definitionVersion: unknown;
  readonly tailSequence: unknown;
  /** The custody reference survives the cap. It is the only pointer to the full capsule. */
  readonly bundleRefs: unknown;
}

export function summarizePreparedCapsuleReceipt(data: unknown): PreparedCapsuleReceiptSummary {
  const receipt = data as {
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
  };
  const tasks = Array.isArray(receipt.capsule?.graph?.tasks) ? receipt.capsule.graph.tasks : [];
  const firstPage = tasks.slice(0, SUMMARY_FIRST_PAGE_ITEMS).map((task) => ({
    taskId: task.taskId,
    title: task.title,
  }));
  return {
    summary:
      `capsule v${String(receipt.capsuleVersion)} of '${String(receipt.workflowId)}' compiled over ` +
      `${tasks.length} task(s); the full capsule is in custody under bundleRefs` +
      (tasks.length > firstPage.length ? `; ${firstPage.length} task(s) shown` : ''),
    counts: { tasks: tasks.length, shown: firstPage.length },
    firstPage,
    operationId: receipt.operationId,
    workflowId: receipt.workflowId,
    capsuleVersion: receipt.capsuleVersion,
    capsuleDigest: receipt.capsuleDigest,
    definitionVersion: receipt.definitionVersion,
    tailSequence: receipt.tailSequence,
    bundleRefs: receipt.bundleRefs,
  };
}
