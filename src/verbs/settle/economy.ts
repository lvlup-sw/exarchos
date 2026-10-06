/**
 * The response budget of `settle`, and the summary that replaces a receipt over that budget.
 * The structural half of a receipt is small and fixed, but `findings` grows with the number of defects in the batch.
 * A settled batch of a dozen tasks with no findings is about 900 bytes, or about 225 estimated tokens.
 * Each finding adds about 150 bytes.
 * The budget is more than twice the settled shape, so a few findings show in full before the reducer pages.
 *
 * The dispatcher does not measure a summary. Thus the summary measures itself with the estimator
 * of the dispatcher, and it trims itself until it is within the budget.
 */

import { estimateOutputTokens, SUMMARY_FIRST_PAGE_ITEMS } from '../../dispatch/core/economy.js';

export const SETTLE_ECONOMY_BUDGET_TOKENS = 1000;

/** The most verification outcomes that a summary lists. */
const SUMMARY_VERIFICATION_OUTCOMES = 4;

/** One finding on the first page, without its message. */
interface SummaryFinding {
  readonly kind: unknown;
  readonly subject: unknown;
  readonly at: unknown;
}

/**
 * One verification outcome in a summary. A failure also names its operation and the leaf that halted it.
 * A caller reads the receipt of the halted segment through `execute_intent` with that operation id.
 */
interface SummaryVerificationOutcome {
  readonly taskId: unknown;
  readonly outcome: unknown;
  readonly operationId?: unknown;
  readonly failedLeaf?: unknown;
}

/**
 * The part of a summary that no trim removes. A decision round answers each pending deviation by
 * its id, so a held batch is decided from this part alone.
 */
interface SettlementSummaryCore {
  /** Which settlement round of the batch this is. */
  readonly round: unknown;
  /** Each deviation that a held batch waits on, as its id and its kind. */
  readonly pendingDeviations?: ReadonlyArray<{
    readonly deviationId: unknown;
    readonly deviationKind: unknown;
  }>;
  /** Each decision that the round recorded, as the deviation id and the decision. */
  readonly decisions?: ReadonlyArray<{
    readonly deviationId: unknown;
    readonly decision: unknown;
  }>;
  /** The design revision that the round recorded, as its two versions and its deviation ids. */
  readonly designRevision?: {
    readonly priorDesignVersion: unknown;
    readonly nextDesignVersion: unknown;
    readonly deviationIds: unknown;
  };
}

/**
 * The shape of the capped receipt. It is declared, not inferred, so each field that a caller needs is a compile-time obligation of the reducer.
 */
export interface SettlementReceiptSummary extends SettlementSummaryCore {
  readonly summary: string;
  /**
   * `shown` counts the findings on the first page. `verification` counts the outcomes of the
   * receipt, and `verificationOmitted` counts the outcomes that the summary does not list.
   */
  readonly counts: {
    readonly findings: number;
    readonly shown: number;
    readonly acceptedTasks: number;
    readonly verification: number;
    readonly verificationOmitted: number;
  };
  /** The first page of findings. A trim empties it, and it stays an array as the capped shape requires. */
  readonly firstPage: ReadonlyArray<SummaryFinding>;
  readonly operationId: unknown;
  readonly outcome: unknown;
  readonly capsule: unknown;
  readonly adjudicated: unknown;
  readonly tailSequence: unknown;
  /**
   * At most four verification outcomes, with the failures first. A trim empties the list.
   * A caller of a rejected batch needs the operation id of a halted segment to read its receipt.
   */
  readonly verification: ReadonlyArray<SummaryVerificationOutcome>;
  /** The custody reference survives the cap: it is the only pointer to the interior. */
  readonly bundleRefs: unknown;
}

/**
 * The receipt fields that the summary reads. Each field is optional, because a receipt replayed
 * from the claim of an earlier build carries fewer fields.
 */
interface CappableReceipt {
  readonly operationId?: unknown;
  readonly outcome?: unknown;
  readonly capsule?: { readonly batchId?: unknown; readonly capsuleVersion?: unknown };
  readonly adjudicated?: unknown;
  readonly tailSequence?: unknown;
  readonly bundleRefs?: unknown;
  readonly round?: unknown;
  readonly acceptedTasks?: ReadonlyArray<unknown>;
  readonly findings?: ReadonlyArray<{
    readonly kind?: unknown;
    readonly subject?: unknown;
    readonly at?: unknown;
  }>;
  readonly verification?: ReadonlyArray<{
    readonly taskId?: unknown;
    readonly outcome?: unknown;
    readonly operationId?: unknown;
    readonly failedLeaf?: unknown;
  }>;
  readonly pendingDeviations?: ReadonlyArray<{
    readonly deviationId?: unknown;
    readonly deviationKind?: unknown;
  }>;
  readonly decisions?: ReadonlyArray<{
    readonly deviationId?: unknown;
    readonly decision?: unknown;
  }>;
  readonly designRevision?: {
    readonly priorDesignVersion?: unknown;
    readonly nextDesignVersion?: unknown;
    readonly deviationIds?: unknown;
  };
}

/** The list, or undefined for a value that is not an array. */
function listOrUndefined<T>(value: ReadonlyArray<T> | undefined): ReadonlyArray<T> | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * The core of a summary. A deviation keeps its id and its kind, and a decision keeps its id and
 * its decision. The statement, the affected tasks, the actor and the rationale stay in the
 * settlement bundle. A field that the receipt does not carry is absent.
 */
function summaryCoreOf(receipt: CappableReceipt): SettlementSummaryCore {
  const pending = listOrUndefined(receipt.pendingDeviations);
  const decisions = listOrUndefined(receipt.decisions);
  const revision = receipt.designRevision;
  return {
    round: receipt.round,
    ...(pending !== undefined
      ? {
          pendingDeviations: pending.map((deviation) => ({
            deviationId: deviation.deviationId,
            deviationKind: deviation.deviationKind,
          })),
        }
      : {}),
    ...(decisions !== undefined
      ? {
          decisions: decisions.map((decision) => ({
            deviationId: decision.deviationId,
            decision: decision.decision,
          })),
        }
      : {}),
    ...(revision !== undefined
      ? {
          designRevision: {
            priorDesignVersion: revision.priorDesignVersion,
            nextDesignVersion: revision.nextDesignVersion,
            deviationIds: revision.deviationIds,
          },
        }
      : {}),
  };
}

/**
 * Reduce a receipt to a summary that is within the budget.
 *
 * The summary holds a core, the first page of findings, and at most four verification outcomes.
 * A summary over the budget first loses its findings page, and then its verification outcomes.
 * No trim removes the core. The full findings and outcomes stay in the referenced bundle.
 *
 * `adjudicated` stays whole, because the census tells zero findings apart from the first page of many.
 * The fields after `firstPage` pass through `CappedDataSchema`, which is `.passthrough()`.
 */
export function summarizeSettlementReceipt(data: unknown): SettlementReceiptSummary {
  const receipt = data as CappableReceipt;
  const findings = listOrUndefined(receipt.findings) ?? [];
  const accepted = listOrUndefined(receipt.acceptedTasks) ?? [];
  const traces = listOrUndefined(receipt.verification) ?? [];
  const core = summaryCoreOf(receipt);

  const firstPage: ReadonlyArray<SummaryFinding> = findings
    .slice(0, SUMMARY_FIRST_PAGE_ITEMS)
    .map((finding) => ({ kind: finding.kind, subject: finding.subject, at: finding.at }));
  const failuresFirst = [
    ...traces.filter((trace) => trace.outcome === 'failed'),
    ...traces.filter((trace) => trace.outcome !== 'failed'),
  ];
  const outcomes: ReadonlyArray<SummaryVerificationOutcome> = failuresFirst
    .slice(0, SUMMARY_VERIFICATION_OUTCOMES)
    .map((trace) =>
      trace.outcome === 'failed'
        ? {
            taskId: trace.taskId,
            outcome: trace.outcome,
            operationId: trace.operationId,
            failedLeaf: trace.failedLeaf,
          }
        : { taskId: trace.taskId, outcome: trace.outcome },
    );

  const assemble = (
    page: ReadonlyArray<SummaryFinding>,
    shown: ReadonlyArray<SummaryVerificationOutcome>,
  ): SettlementReceiptSummary => ({
    summary:
      `batch '${String(receipt.capsule?.batchId)}' of capsule v${String(receipt.capsule?.capsuleVersion)} ` +
      `${String(receipt.outcome)} — ${accepted.length} task(s) accepted, ${findings.length} finding(s)` +
      (findings.length > page.length ? `; ${page.length} shown` : '') +
      (traces.length > shown.length
        ? `; ${shown.length} of ${traces.length} verification outcome(s) shown`
        : ''),
    counts: {
      findings: findings.length,
      shown: page.length,
      acceptedTasks: accepted.length,
      verification: traces.length,
      verificationOmitted: traces.length - shown.length,
    },
    firstPage: page,
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    capsule: receipt.capsule,
    adjudicated: receipt.adjudicated,
    tailSequence: receipt.tailSequence,
    verification: shown,
    bundleRefs: receipt.bundleRefs,
    ...core,
  });
  const fits = (candidate: SettlementReceiptSummary): boolean =>
    estimateOutputTokens(candidate) <= SETTLE_ECONOMY_BUDGET_TOKENS;

  const whole = assemble(firstPage, outcomes);
  if (fits(whole)) return whole;
  const withoutFindingsPage = assemble([], outcomes);
  if (fits(withoutFindingsPage)) return withoutFindingsPage;
  return assemble([], []);
}
