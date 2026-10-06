/**
 * Tests for the summary that replaces a `settle` receipt over the response budget.
 * The dispatcher does not measure a summary, so each case measures it with the estimator of the
 * dispatcher against the budget constant of `settle`.
 *
 * Each receipt has one of the two forms that the handler returns. A submitting round can carry
 * pending deviations. A decision round carries decisions, and it can carry a design revision.
 * The handler returns no receipt with pending deviations and decisions together.
 *
 * @oracle-sources: ../../../../src/verbs/settle/economy.ts, the receipts that this file writes by hand and generates inside the input bounds of settle
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';

import { estimateOutputTokens, SUMMARY_FIRST_PAGE_ITEMS } from '../../../../src/dispatch/core/economy.js';
import { enforceResponseEconomy } from '../../../../src/dispatch/core/response-economy.js';
import { CappedDataSchema } from '../../../../src/output-schema-declaration.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { DELEGATION_DEVIATION_KINDS } from '../../../../src/verbs/prepare/compile-capsule.js';
import {
  SETTLEMENT_FINDING_KINDS,
  type SettlementFinding,
  type SettlementOutcome,
} from '../../../../src/verbs/settle/adjudicate.js';
import {
  SETTLE_ECONOMY_BUDGET_TOKENS,
  summarizeSettlementReceipt,
  type SettlementReceiptSummary,
} from '../../../../src/verbs/settle/economy.js';
import {
  MAX_AFFECTED_TASKS_PER_DEVIATION,
  MAX_DEVIATIONS_PER_BATCH,
  type PendingDeviation,
  type SettlementDecision,
  type SettlementDesignRevision,
} from '../../../../src/verbs/settle/types.js';

/** The most tasks in one batch of the input bounds. */
const MAX_TASKS = 40;
/** The longest task id of the input bounds. */
const MAX_TASK_ID_LENGTH = 48;
/** The length limit of a batch id and of a workflow id. */
const MAX_STABLE_ID_LENGTH = 256;
/** The most verification outcomes that a summary lists. */
const OUTCOMES_SHOWN = 4;
/** The leaf that halts each failed verification here. */
const FAILED_LEAF = 'check_static_analysis';

/** The start of each text that a summary must not carry. A case searches the summary for each one. */
const WITHHELD_TEXT = {
  statement: 'statement-text:',
  affectedTask: 'affected-task-',
  proposedChange: 'proposed-change-text:',
  actor: 'actor-text:',
  rationale: 'rationale-text:',
  message: 'message-text:',
};

type TaskOutcome = 'verified' | 'already-complete' | 'failed';

/** One task of a batch and how its verification ended. */
interface TaskSpec {
  readonly taskId: string;
  readonly outcome: TaskOutcome;
}

/** A bundle reference in its wire form. The artifact id here skips the length check of the store. */
interface WireBundleRef {
  readonly artifactId: string;
  readonly digest: { readonly algorithm: 'sha256'; readonly value: string };
}

interface WireTrace {
  readonly taskId: string;
  readonly outcome: TaskOutcome;
  readonly operationId?: string;
  readonly failedLeaf?: string;
  readonly message?: string;
  readonly bundleRefs?: readonly WireBundleRef[];
}

/** A settlement receipt as the handler returns it, with plain strings in place of branded ids. */
interface WireReceipt {
  readonly operationId: string;
  readonly streamId: string;
  readonly capsule: {
    readonly workflowId: string;
    readonly definitionVersion: string;
    readonly designVersion: string;
    readonly capsuleVersion: number;
    readonly batchId: string;
  };
  readonly outcome: SettlementOutcome;
  readonly acceptedTasks: readonly string[];
  readonly findings: readonly SettlementFinding[];
  readonly adjudicated: Readonly<Record<string, number>>;
  readonly requestDigest: string;
  readonly tailSequence: number;
  readonly verification: readonly WireTrace[];
  readonly bundleRefs: readonly WireBundleRef[];
  readonly round: number;
  readonly pendingDeviations?: readonly PendingDeviation[];
  readonly decisions?: readonly SettlementDecision[];
  readonly designRevision?: SettlementDesignRevision;
}

/** What one receipt of a case differs in. `receiptOf` derives each other field. */
interface ReceiptSpec {
  readonly workflowId: string;
  readonly batchId: string;
  /** The value of the capsule version, of the tail sequence and of each census count. */
  readonly magnitude: number;
  readonly outcome: SettlementOutcome;
  readonly round: number;
  readonly tasks: readonly TaskSpec[];
  readonly findings: readonly SettlementFinding[];
  readonly pendingDeviations?: readonly PendingDeviation[];
  readonly decisions?: readonly SettlementDecision[];
  readonly designRevision?: SettlementDesignRevision;
}

/** A batch with short ids and small numbers. Each case adds the parts that it reads. */
const SMALL_BATCH = { workflowId: 'feat-capped-receipt', batchId: 'batch-0001', magnitude: 3 };

/** A 64-character hexadecimal digest that ends in the number. */
function digestOf(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/** A deviation id in the form of the handler: `dev:` and 24 hexadecimal characters. */
function deviationIdOf(n: number): string {
  return `dev:${n.toString(16).padStart(24, '0')}`;
}

/** The operation id of the verification segment of the task at `index`, in the form of the handler. */
function verificationOperationIdOf(index: number): string {
  return `settle-task:${digestOf(index)}`;
}

/** A task id of exactly `length` characters. */
function taskIdOf(index: number, length: number): string {
  return `task-${String(index).padStart(2, '0')}`.padEnd(length, 'x');
}

/** One task for each outcome, in order, with ids of `idLength` characters. */
function tasksOf(outcomes: readonly TaskOutcome[], idLength: number): TaskSpec[] {
  return outcomes.map((outcome, index) => ({ taskId: taskIdOf(index, idLength), outcome }));
}

/** `count` findings with a long message each. The subjects cycle through the tasks. */
function findingsOf(count: number, tasks: readonly TaskSpec[]): SettlementFinding[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'verification-failed',
    subject: tasks[index % Math.max(tasks.length, 1)]?.taskId ?? 'task-none',
    at: `claims[${index}]`,
    message:
      `${WITHHELD_TEXT.message} verification of the task halted on its static analysis gate, ` +
      `and the gate reported ${index} errors in the worktree that the claim names`,
  }));
}

/**
 * `count` pending deviations with a long statement and three affected tasks each. Each entry also
 * carries a proposed change, which no receipt of the handler carries.
 */
function pendingDeviationsOf(count: number): PendingDeviation[] {
  return Array.from({ length: count }, (_, index) => ({
    deviationId: deviationIdOf(index),
    deviationKind: DELEGATION_DEVIATION_KINDS[index % DELEGATION_DEVIATION_KINDS.length] ?? 'missing-context',
    statement:
      `${WITHHELD_TEXT.statement} the capsule assumed that the reader of the plan returns each task ` +
      `in commit order, and case ${index} shows that it does not hold for a plan with a revision`,
    affectedTasks: [0, 1, 2].map((n) => `${WITHHELD_TEXT.affectedTask}${index}-${n}`),
    proposedChange: `${WITHHELD_TEXT.proposedChange} sort the tasks of the plan by sequence ${index}`,
  }));
}

/** `count` decisions with a long rationale each. Each third decision rejects its deviation. */
function decisionsOf(count: number): SettlementDecision[] {
  return Array.from({ length: count }, (_, index) => ({
    deviationId: deviationIdOf(index),
    decision: index % 3 === 2 ? 'rejected' : 'accepted',
    actor: `${WITHHELD_TEXT.actor} reviewer-${index}`,
    rationale:
      `${WITHHELD_TEXT.rationale} the deviation names a real gap in the capsule, and the proposed ` +
      `change of case ${index} stays inside the tasks that the batch does not claim`,
  }));
}

/** The verification trace of one task, with the fields that the handler gives each outcome. */
function traceOf(task: TaskSpec, index: number, ref: WireBundleRef): WireTrace {
  if (task.outcome === 'already-complete') return { taskId: task.taskId, outcome: task.outcome };
  if (task.outcome === 'verified') {
    return {
      taskId: task.taskId,
      outcome: task.outcome,
      operationId: verificationOperationIdOf(index),
      bundleRefs: [ref],
    };
  }
  return {
    taskId: task.taskId,
    outcome: task.outcome,
    operationId: verificationOperationIdOf(index),
    failedLeaf: FAILED_LEAF,
    message: `${WITHHELD_TEXT.message} the static analysis gate found errors in the worktree of the task`,
    bundleRefs: [ref],
  };
}

/** The receipt of one settlement round, in the shape that the handler returns. */
function receiptOf(spec: ReceiptSpec): WireReceipt {
  const ref: WireBundleRef = {
    artifactId: `run-bundle:settlement-adjudication:${spec.batchId}:${spec.magnitude}`,
    digest: { algorithm: 'sha256', value: digestOf(1) },
  };
  return {
    operationId: `settle:${digestOf(2)}`,
    streamId: spec.workflowId,
    capsule: {
      workflowId: spec.workflowId,
      definitionVersion: digestOf(3),
      designVersion: `design-v${spec.magnitude}`,
      capsuleVersion: spec.magnitude,
      batchId: spec.batchId,
    },
    outcome: spec.outcome,
    acceptedTasks: spec.outcome === 'settled' ? spec.tasks.map((task) => task.taskId) : [],
    findings: spec.findings,
    adjudicated: {
      claims: spec.magnitude,
      requiredResults: spec.magnitude,
      fields: spec.magnitude,
      evidence: spec.magnitude,
      deviations: spec.magnitude,
      verification: spec.magnitude,
      decisions: spec.magnitude,
    },
    requestDigest: `sha256:${digestOf(4)}`,
    tailSequence: spec.magnitude,
    verification: spec.tasks.map((task, index) => traceOf(task, index, ref)),
    bundleRefs: [ref],
    round: spec.round,
    ...(spec.pendingDeviations !== undefined ? { pendingDeviations: spec.pendingDeviations } : {}),
    ...(spec.decisions !== undefined ? { decisions: spec.decisions } : {}),
    ...(spec.designRevision !== undefined ? { designRevision: spec.designRevision } : {}),
  };
}

/** The four parts of a batch at the input bounds: both ids, the tasks and the findings. */
function maximalBatch(): Pick<ReceiptSpec, 'workflowId' | 'batchId' | 'magnitude' | 'tasks' | 'findings'> {
  const tasks = tasksOf(Array.from({ length: MAX_TASKS }, () => 'failed'), MAX_TASK_ID_LENGTH);
  return {
    workflowId: 'w'.repeat(MAX_STABLE_ID_LENGTH),
    batchId: 'b'.repeat(MAX_STABLE_ID_LENGTH),
    magnitude: Number.MAX_SAFE_INTEGER,
    tasks,
    findings: findingsOf(MAX_TASKS + MAX_DEVIATIONS_PER_BATCH, tasks),
  };
}

/** A held receipt with each input bound at its maximum: sixteen pending deviations on forty tasks. */
function maximalHeldReceipt(): WireReceipt {
  return receiptOf({
    ...maximalBatch(),
    outcome: 'deviation-pending',
    round: 0,
    pendingDeviations: pendingDeviationsOf(MAX_DEVIATIONS_PER_BATCH).map((deviation) => ({
      ...deviation,
      deviationKind: 'invalidated-assumption',
    })),
  });
}

/**
 * A decided receipt with each input bound at its maximum. It carries sixteen decisions, and its
 * design revision names all sixteen deviations.
 */
function maximalDecidedReceipt(): WireReceipt {
  const decisions = decisionsOf(MAX_DEVIATIONS_PER_BATCH).map(
    (decision): SettlementDecision => ({ ...decision, decision: 'accepted' }),
  );
  return receiptOf({
    ...maximalBatch(),
    outcome: 'rejected',
    round: 1,
    decisions,
    designRevision: {
      priorDesignVersion: Number.MAX_SAFE_INTEGER - 1,
      nextDesignVersion: Number.MAX_SAFE_INTEGER,
      deviationIds: decisions.map((decision) => decision.deviationId),
    },
  });
}

/** The core of a summary. Each field is named, so an absent field compares as undefined. */
function coreOf(summary: SettlementReceiptSummary): Record<string, unknown> {
  return {
    round: summary.round,
    pendingDeviations: summary.pendingDeviations,
    decisions: summary.decisions,
    designRevision: summary.designRevision,
  };
}

/**
 * The core that a receipt requires of its summary. It holds the round, each pending deviation by
 * id and kind, each decision by id and decision, and the design revision.
 */
function requiredCoreOf(receipt: WireReceipt): Record<string, unknown> {
  return {
    round: receipt.round,
    pendingDeviations: receipt.pendingDeviations?.map((deviation) => ({
      deviationId: deviation.deviationId,
      deviationKind: deviation.deviationKind,
    })),
    decisions: receipt.decisions?.map((decision) => ({
      deviationId: decision.deviationId,
      decision: decision.decision,
    })),
    designRevision:
      receipt.designRevision === undefined
        ? undefined
        : {
            priorDesignVersion: receipt.designRevision.priorDesignVersion,
            nextDesignVersion: receipt.designRevision.nextDesignVersion,
            deviationIds: [...receipt.designRevision.deviationIds],
          },
  };
}

/** The first page that a summary shows for a receipt, built here from the findings of the receipt. */
function firstPageOf(receipt: WireReceipt): unknown[] {
  return receipt.findings
    .slice(0, SUMMARY_FIRST_PAGE_ITEMS)
    .map((finding) => ({ kind: finding.kind, subject: finding.subject, at: finding.at }));
}

/** The success envelope of one response, after a trip through JSON as the carrier sends it. */
function wireEnvelopeOf(data: unknown): unknown {
  return JSON.parse(
    JSON.stringify({
      success: true,
      data,
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    }),
  );
}

/** The output schema that the registry declares for `settle`. A carrier parses each response against it. */
function declaredSettleOutputSchema(): NonNullable<ReturnType<typeof findActionInRegistry>>['outputSchema'] {
  const action = findActionInRegistry('exarchos_orchestrate', 'settle');
  if (action === undefined) throw new Error('the registry declares no settle action');
  return action.outputSchema;
}

/** The summary of a receipt that the dispatcher caps. The receipt must be over the budget. */
function cappedSummaryOf(receipt: WireReceipt): SettlementReceiptSummary {
  expect(estimateOutputTokens(receipt)).toBeGreaterThan(SETTLE_ECONOMY_BUDGET_TOKENS);
  return summarizeSettlementReceipt(receipt);
}

/** The first characters of a stable id, and the characters after them, as the id schema allows. */
const ID_HEAD_CHARACTERS = [...'abcXYZ019'];
const ID_BODY_CHARACTERS = [...'abcXYZ019._:-'];

/** A stable id of at most `maxLength` characters. */
function stableIdArb(maxLength: number): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...ID_HEAD_CHARACTERS),
      fc.string({ unit: fc.constantFrom(...ID_BODY_CHARACTERS), maxLength: maxLength - 1, size: 'max' }),
    )
    .map(([head, body]) => `${head}${body}`);
}

/** A text of at most 300 characters that starts with `mark`. */
function markedTextArb(mark: string): fc.Arbitrary<string> {
  return fc.string({ maxLength: 300, size: 'max' }).map((text) => `${mark} ${text}`);
}

/** The parts that both receipt forms share: the ids, the numbers, the tasks and the findings. */
const batchArb = fc.record({
  workflowId: stableIdArb(MAX_STABLE_ID_LENGTH),
  batchId: stableIdArb(MAX_STABLE_ID_LENGTH),
  magnitude: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  tasks: fc.uniqueArray(
    fc.record({
      taskId: stableIdArb(MAX_TASK_ID_LENGTH),
      outcome: fc.constantFrom<TaskOutcome>('verified', 'already-complete', 'failed'),
    }),
    { selector: (task) => task.taskId, maxLength: MAX_TASKS, size: 'max' },
  ),
  findings: fc.array(
    fc.record({
      kind: fc.constantFrom(...SETTLEMENT_FINDING_KINDS),
      subject: stableIdArb(MAX_TASK_ID_LENGTH),
      at: fc.nat({ max: MAX_TASKS }).map((index) => `claims[${index}].fields`),
      message: markedTextArb(WITHHELD_TEXT.message),
    }),
    { maxLength: 3 * SUMMARY_FIRST_PAGE_ITEMS, size: 'max' },
  ),
});

/** The receipt of a submitting round. A held batch names up to sixteen pending deviations. */
const submittingReceiptArb: fc.Arbitrary<WireReceipt> = fc
  .tuple(
    batchArb,
    fc.constantFrom<SettlementOutcome>('settled', 'rejected', 'deviation-pending'),
    fc.array(
      fc.record({
        deviationKind: fc.constantFrom(...DELEGATION_DEVIATION_KINDS),
        statement: markedTextArb(WITHHELD_TEXT.statement),
        affectedTasks: fc.uniqueArray(
          stableIdArb(MAX_TASK_ID_LENGTH - WITHHELD_TEXT.affectedTask.length).map(
            (id) => `${WITHHELD_TEXT.affectedTask}${id}`,
          ),
          { maxLength: MAX_AFFECTED_TASKS_PER_DEVIATION, size: 'max' },
        ),
      }),
      { minLength: 1, maxLength: MAX_DEVIATIONS_PER_BATCH, size: 'max' },
    ),
  )
  .map(([batch, outcome, deviations]) =>
    receiptOf({
      ...batch,
      outcome,
      round: 0,
      ...(outcome === 'deviation-pending'
        ? {
            pendingDeviations: deviations.map((deviation, index) => ({
              deviationId: deviationIdOf(index),
              deviationKind: deviation.deviationKind,
              statement: deviation.statement,
              ...(deviation.affectedTasks.length > 0 ? { affectedTasks: deviation.affectedTasks } : {}),
            })),
          }
        : {}),
    }),
  );

/**
 * The receipt of a decision round, with up to sixteen decisions. When `revises` is true and a
 * decision accepts, the receipt carries a design revision that names each accepted deviation.
 */
const decisionReceiptArb: fc.Arbitrary<WireReceipt> = fc
  .tuple(
    batchArb,
    fc.constantFrom<SettlementOutcome>('settled', 'rejected'),
    fc.array(
      fc.record({
        decision: fc.constantFrom<SettlementDecision['decision']>('accepted', 'rejected'),
        actor: markedTextArb(WITHHELD_TEXT.actor),
        rationale: markedTextArb(WITHHELD_TEXT.rationale),
      }),
      { minLength: 1, maxLength: MAX_DEVIATIONS_PER_BATCH, size: 'max' },
    ),
    fc.boolean(),
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER - 1 }),
  )
  .map(([batch, outcome, decided, revises, priorDesignVersion]) => {
    const decisions = decided.map((decision, index) => ({ deviationId: deviationIdOf(index), ...decision }));
    const accepted = decisions
      .filter((decision) => decision.decision === 'accepted')
      .map((decision) => decision.deviationId);
    return receiptOf({
      ...batch,
      outcome,
      round: 1,
      decisions,
      ...(revises && accepted.length > 0
        ? {
            designRevision: {
              priorDesignVersion,
              nextDesignVersion: priorDesignVersion + 1,
              deviationIds: accepted,
            },
          }
        : {}),
    });
  });

describe('the capped settle receipt', () => {
  /**
   * A decision answers each pending deviation by its id. Thus the summary of a held batch names
   * all sixteen, and it carries no statement, affected task or proposed change. The dispatcher
   * returns this summary as the data of the capped response.
   */
  it('SettleEconomy_ACappedHeldReceipt_NamesEveryPendingDeviationByIdAndKind', () => {
    const tasks = tasksOf(['verified', 'verified'], 6);
    const receipt = receiptOf({
      ...SMALL_BATCH,
      outcome: 'deviation-pending',
      round: 0,
      tasks,
      findings: findingsOf(2, tasks),
      pendingDeviations: pendingDeviationsOf(MAX_DEVIATIONS_PER_BATCH),
    });

    const summary = cappedSummaryOf(receipt);

    expect(summary.round).toBe(0);
    expect(summary.pendingDeviations).toHaveLength(MAX_DEVIATIONS_PER_BATCH);
    expect(summary.pendingDeviations?.[0]).toStrictEqual({
      deviationId: 'dev:000000000000000000000000',
      deviationKind: 'invalidated-assumption',
    });
    expect(summary.pendingDeviations?.[15]).toStrictEqual({
      deviationId: 'dev:00000000000000000000000f',
      deviationKind: 'missing-context',
    });
    expect(summary.pendingDeviations?.map((deviation) => deviation.deviationId)).toStrictEqual(
      receipt.pendingDeviations?.map((deviation) => deviation.deviationId),
    );
    expect(coreOf(summary)).toStrictEqual(requiredCoreOf(receipt));

    const text = JSON.stringify(summary);
    expect(JSON.stringify(receipt)).toContain(WITHHELD_TEXT.statement);
    expect(JSON.stringify(receipt)).toContain(WITHHELD_TEXT.affectedTask);
    expect(JSON.stringify(receipt)).toContain(WITHHELD_TEXT.proposedChange);
    expect(text).not.toContain(WITHHELD_TEXT.statement);
    expect(text).not.toContain(WITHHELD_TEXT.affectedTask);
    expect(text).not.toContain(WITHHELD_TEXT.proposedChange);
    expect(text).not.toContain('statement');
    expect(text).not.toContain('affectedTasks');
    expect(text).not.toContain('proposedChange');
    expect(estimateOutputTokens(summary)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);

    const dispatched = enforceResponseEconomy(
      { success: true, data: receipt },
      'exarchos_orchestrate',
      'settle',
    );
    expect(dispatched.data).toStrictEqual(summary);
  });

  /** The summary of a decision round keeps its round number and each decision, without the actor or the rationale. */
  it('SettleEconomy_ACappedDecidedReceipt_KeepsTheRoundAndEveryDecision', () => {
    const tasks = tasksOf(['verified', 'verified'], 6);
    const receipt = receiptOf({
      ...SMALL_BATCH,
      outcome: 'rejected',
      round: 1,
      tasks,
      findings: findingsOf(2, tasks),
      decisions: decisionsOf(MAX_DEVIATIONS_PER_BATCH),
    });

    const summary = cappedSummaryOf(receipt);

    expect(summary.round).toBe(1);
    expect(summary.decisions).toHaveLength(MAX_DEVIATIONS_PER_BATCH);
    expect(summary.decisions?.slice(0, 3)).toStrictEqual([
      { deviationId: 'dev:000000000000000000000000', decision: 'accepted' },
      { deviationId: 'dev:000000000000000000000001', decision: 'accepted' },
      { deviationId: 'dev:000000000000000000000002', decision: 'rejected' },
    ]);
    expect(coreOf(summary)).toStrictEqual(requiredCoreOf(receipt));

    const text = JSON.stringify(summary);
    expect(text).not.toContain(WITHHELD_TEXT.actor);
    expect(text).not.toContain(WITHHELD_TEXT.rationale);
    expect(estimateOutputTokens(summary)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);
  });

  /**
   * The summary keeps the two versions and the deviation ids of a design revision. A decision
   * round that revised nothing has no revision in its summary.
   */
  it('SettleEconomy_ACappedRevisedReceipt_KeepsTheDesignRevision', () => {
    const tasks = tasksOf(['verified', 'verified'], 6);
    const decided: ReceiptSpec = {
      ...SMALL_BATCH,
      outcome: 'settled',
      round: 1,
      tasks,
      findings: findingsOf(2, tasks),
      decisions: decisionsOf(MAX_DEVIATIONS_PER_BATCH),
    };
    const revised = receiptOf({
      ...decided,
      designRevision: {
        priorDesignVersion: 3,
        nextDesignVersion: 4,
        deviationIds: [deviationIdOf(0), deviationIdOf(1), deviationIdOf(3)],
      },
    });

    const summary = cappedSummaryOf(revised);

    expect(summary.designRevision).toStrictEqual({
      priorDesignVersion: 3,
      nextDesignVersion: 4,
      deviationIds: [
        'dev:000000000000000000000000',
        'dev:000000000000000000000001',
        'dev:000000000000000000000003',
      ],
    });
    expect(estimateOutputTokens(summary)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);

    const unrevised = cappedSummaryOf(receiptOf(decided));
    expect('designRevision' in unrevised).toBe(false);
    expect(unrevised.round).toBe(1);
  });

  /**
   * The summary lists four outcomes with the failures first. A failure keeps the operation id and
   * the leaf of its halted segment, and it drops the message and the bundle reference. The counts
   * give the outcomes that the list leaves out.
   */
  it('SettleEconomy_ACappedRejectedReceipt_KeepsTheOperationAndLeafOfItsFirstFailures', () => {
    const twoFailures = tasksOf(['verified', 'failed', 'verified', 'already-complete', 'failed', 'verified'], 6);
    const few = cappedSummaryOf(
      receiptOf({
        ...SMALL_BATCH,
        outcome: 'rejected',
        round: 0,
        tasks: twoFailures,
        findings: findingsOf(24, twoFailures),
      }),
    );

    expect(few.verification).toStrictEqual([
      { taskId: 'task-01', outcome: 'failed', operationId: verificationOperationIdOf(1), failedLeaf: FAILED_LEAF },
      { taskId: 'task-04', outcome: 'failed', operationId: verificationOperationIdOf(4), failedLeaf: FAILED_LEAF },
      { taskId: 'task-00', outcome: 'verified' },
      { taskId: 'task-02', outcome: 'verified' },
    ]);
    expect(few.counts.verification).toBe(6);
    expect(few.counts.verificationOmitted).toBe(2);
    expect(few.firstPage).toHaveLength(SUMMARY_FIRST_PAGE_ITEMS);
    expect(few.counts.findings).toBe(24);
    expect(few.counts.shown).toBe(SUMMARY_FIRST_PAGE_ITEMS);
    expect(JSON.stringify(few)).not.toContain(WITHHELD_TEXT.message);
    expect(estimateOutputTokens(few)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);

    const sixFailures = tasksOf(
      ['verified', 'failed', 'failed', 'verified', 'failed', 'failed', 'failed', 'failed'],
      6,
    );
    const many = cappedSummaryOf(
      receiptOf({
        ...SMALL_BATCH,
        outcome: 'rejected',
        round: 0,
        tasks: sixFailures,
        findings: findingsOf(24, sixFailures),
      }),
    );

    expect(many.verification).toStrictEqual([
      { taskId: 'task-01', outcome: 'failed', operationId: verificationOperationIdOf(1), failedLeaf: FAILED_LEAF },
      { taskId: 'task-02', outcome: 'failed', operationId: verificationOperationIdOf(2), failedLeaf: FAILED_LEAF },
      { taskId: 'task-04', outcome: 'failed', operationId: verificationOperationIdOf(4), failedLeaf: FAILED_LEAF },
      { taskId: 'task-05', outcome: 'failed', operationId: verificationOperationIdOf(5), failedLeaf: FAILED_LEAF },
    ]);
    expect(many.counts.verification).toBe(8);
    expect(many.counts.verificationOmitted).toBe(4);
  });

  /**
   * The first receipt fits when only its findings page is empty, so it keeps its outcomes. The
   * second receipt is at the input bounds, and it loses its outcomes too. Each summary goes over
   * the budget when the test puts the trimmed part back, and each keeps its whole core.
   */
  it('SettleEconomy_ASummaryOverTheBudget_DropsTheFindingsPageThenTheOutcomesAndNeverTheCore', () => {
    const tasks = tasksOf(Array.from({ length: 12 }, () => 'failed'), MAX_TASK_ID_LENGTH);
    const decisions = decisionsOf(MAX_DEVIATIONS_PER_BATCH);
    const smaller = receiptOf({
      ...SMALL_BATCH,
      outcome: 'rejected',
      round: 1,
      tasks,
      findings: findingsOf(12, tasks),
      decisions,
      designRevision: {
        priorDesignVersion: 3,
        nextDesignVersion: 4,
        deviationIds: decisions.map((decision) => decision.deviationId),
      },
    });

    const withoutPage = cappedSummaryOf(smaller);

    expect(withoutPage.firstPage).toStrictEqual([]);
    expect(withoutPage.counts.findings).toBe(12);
    expect(withoutPage.counts.shown).toBe(0);
    expect(withoutPage.verification).toHaveLength(OUTCOMES_SHOWN);
    expect(withoutPage.counts.verificationOmitted).toBe(8);
    expect(coreOf(withoutPage)).toStrictEqual(requiredCoreOf(smaller));
    expect(estimateOutputTokens(withoutPage)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);
    expect(estimateOutputTokens({ ...withoutPage, firstPage: firstPageOf(smaller) })).toBeGreaterThan(
      SETTLE_ECONOMY_BUDGET_TOKENS,
    );

    const larger = maximalDecidedReceipt();
    const withoutOutcomes = cappedSummaryOf(larger);

    expect(withoutOutcomes.firstPage).toStrictEqual([]);
    expect(withoutOutcomes.counts.shown).toBe(0);
    expect(withoutOutcomes.verification).toStrictEqual([]);
    expect(withoutOutcomes.counts.verification).toBe(MAX_TASKS);
    expect(withoutOutcomes.counts.verificationOmitted).toBe(MAX_TASKS);
    expect(coreOf(withoutOutcomes)).toStrictEqual(requiredCoreOf(larger));
    expect(estimateOutputTokens(withoutOutcomes)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);
    expect(
      estimateOutputTokens({ ...withoutOutcomes, verification: withoutPage.verification }),
    ).toBeGreaterThan(SETTLE_ECONOMY_BUDGET_TOKENS);
  });

  /**
   * A claim of an earlier build holds a receipt with fewer fields, so the reducer reads each field as optional.
   * The first receipt holds only the fields that each build wrote. It has no round, no verification,
   * no pending deviation, no decision and no design revision. The second holds its findings alone,
   * and the third holds no findings. Each one is over the budget.
   *
   * The reducer gives each a summary within the budget. The summary has an empty list for each list
   * that the receipt lacks, and no core field that the receipt lacks.
   */
  it('SettleEconomy_ASparseReceiptOverTheBudget_SummarisesWithoutItsAbsentFields', () => {
    const tasks = tasksOf(['verified', 'verified'], 6);
    const full = receiptOf({ ...SMALL_BATCH, outcome: 'rejected', round: 0, tasks, findings: findingsOf(24, tasks) });
    const keeping = (keys: readonly string[]): Record<string, unknown> =>
      Object.fromEntries(Object.entries(full).filter(([key]) => keys.includes(key)));
    const writtenByEachBuild = [
      'operationId',
      'streamId',
      'capsule',
      'outcome',
      'acceptedTasks',
      'findings',
      'adjudicated',
      'requestDigest',
      'tailSequence',
    ];
    const earliest = keeping(writtenByEachBuild);
    const findingsAlone = keeping(['findings']);
    const withoutFindings = {
      ...keeping(writtenByEachBuild.filter((key) => key !== 'findings')),
      acceptedTasks: Array.from({ length: 600 }, (_, index) => taskIdOf(index, 12)),
    };
    expect(Object.keys(earliest).sort()).toStrictEqual([...writtenByEachBuild].sort());

    const noOutcomes = { verification: 0, verificationOmitted: 0 };
    const expectedCounts = [
      { findings: 24, shown: SUMMARY_FIRST_PAGE_ITEMS, acceptedTasks: 0, ...noOutcomes },
      { findings: 24, shown: SUMMARY_FIRST_PAGE_ITEMS, acceptedTasks: 0, ...noOutcomes },
      { findings: 0, shown: 0, acceptedTasks: 600, ...noOutcomes },
    ];
    for (const [index, sparse] of [earliest, findingsAlone, withoutFindings].entries()) {
      expect(estimateOutputTokens(sparse), `receipt ${index}`).toBeGreaterThan(SETTLE_ECONOMY_BUDGET_TOKENS);

      const summary = summarizeSettlementReceipt(sparse);

      expect(estimateOutputTokens(summary), `receipt ${index}`).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);
      expect(summary.counts, `receipt ${index}`).toStrictEqual(expectedCounts[index]);
      expect(summary.verification).toStrictEqual([]);
      expect(summary.round).toBeUndefined();
      expect(Object.keys(summary).filter((key) => ['pendingDeviations', 'decisions', 'designRevision'].includes(key))).toEqual([]);
      expect(CappedDataSchema.safeParse(JSON.parse(JSON.stringify(summary))).success).toBe(true);
      const dispatched = enforceResponseEconomy({ success: true, data: sparse }, 'exarchos_orchestrate', 'settle');
      expect(dispatched.data).toStrictEqual(summary);
    }

    const earliestSummary = summarizeSettlementReceipt(earliest);
    expect(earliestSummary.firstPage).toStrictEqual(firstPageOf(full));
    expect(earliestSummary.summary).toBe(
      `batch '${SMALL_BATCH.batchId}' of capsule v${SMALL_BATCH.magnitude} rejected — ` +
        `0 task(s) accepted, 24 finding(s); ${SUMMARY_FIRST_PAGE_ITEMS} shown`,
    );
    expect(earliestSummary.capsule).toStrictEqual(full.capsule);
    expect(summarizeSettlementReceipt(findingsAlone).firstPage).toStrictEqual(firstPageOf(full));
    expect(summarizeSettlementReceipt(withoutFindings).firstPage).toStrictEqual([]);
  });

  /**
   * Each generated receipt is inside the input bounds: sixteen deviations, forty tasks, task ids
   * of 48 characters, and batch and workflow ids of 256 characters. The two maximal receipts hold
   * each bound at its maximum at once, and they run as explicit examples of the property.
   *
   * The summary is within the budget by the estimator of the dispatcher, and its core is whole.
   * It parses against the output schema that the registry declares. The response that the
   * dispatcher returns for the receipt is within the budget too.
   */
  it('SettleEconomy_AnyReceiptWithinTheInputBounds_SummarisesUnderTheSettleBudget', () => {
    const declared = declaredSettleOutputSchema();
    const held = maximalHeldReceipt();
    const decided = maximalDecidedReceipt();

    expect(held.pendingDeviations).toHaveLength(MAX_DEVIATIONS_PER_BATCH);
    expect(decided.decisions).toHaveLength(MAX_DEVIATIONS_PER_BATCH);
    expect(decided.designRevision?.deviationIds).toHaveLength(MAX_DEVIATIONS_PER_BATCH);
    for (const maximal of [held, decided]) {
      expect(maximal.capsule.workflowId).toHaveLength(MAX_STABLE_ID_LENGTH);
      expect(maximal.capsule.batchId).toHaveLength(MAX_STABLE_ID_LENGTH);
      expect(maximal.verification).toHaveLength(MAX_TASKS);
      expect(maximal.verification.map((trace) => trace.taskId.length)).toStrictEqual(
        Array.from({ length: MAX_TASKS }, () => MAX_TASK_ID_LENGTH),
      );
      expect(maximal.findings.length).toBeGreaterThanOrEqual(SUMMARY_FIRST_PAGE_ITEMS);
    }

    fc.assert(
      fc.property(fc.oneof(submittingReceiptArb, decisionReceiptArb), (receipt) => {
        expect(declared.safeParse(wireEnvelopeOf(receipt)).success).toBe(true);

        const summary = summarizeSettlementReceipt(receipt);
        expect(estimateOutputTokens(summary)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);
        expect(coreOf(summary)).toStrictEqual(requiredCoreOf(receipt));
        expect(Array.isArray(summary.firstPage)).toBe(true);
        expect(summary.verification.length).toBeLessThanOrEqual(OUTCOMES_SHOWN);

        const text = JSON.stringify(summary);
        expect(text).not.toContain(WITHHELD_TEXT.statement);
        expect(text).not.toContain(WITHHELD_TEXT.affectedTask);
        expect(text).not.toContain(WITHHELD_TEXT.rationale);

        expect(CappedDataSchema.safeParse(JSON.parse(text)).success).toBe(true);
        expect(declared.safeParse(wireEnvelopeOf(summary)).success).toBe(true);

        const dispatched = enforceResponseEconomy(
          { success: true, data: receipt },
          'exarchos_orchestrate',
          'settle',
        );
        expect(estimateOutputTokens(dispatched.data)).toBeLessThanOrEqual(SETTLE_ECONOMY_BUDGET_TOKENS);
      }),
      { numRuns: 300, examples: [[held], [decided]] },
    );
  });
});
