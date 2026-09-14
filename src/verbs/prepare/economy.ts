// ─── Response-economy declaration for `prepare` ──────────────────────────────
//
// The capsule IS the response. The harness runs the batch from it with no
// further governance calls, so a budget that routinely cut it would turn the
// two-call path into a three-call one. The budget is therefore sized to carry a
// realistic batch in full, and the reducer is the exception path for a batch
// too large to carry: it keeps what `settle` needs — the identity, the digest,
// the task ids and the custody reference — and says that the full capsule is
// in custody under that reference.

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
  /** The custody reference survives the cap: it is the only pointer to the full capsule. */
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
