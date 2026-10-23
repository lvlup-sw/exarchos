/**
 * The reads that decide a settlement verdict, as pure folds over the rows of a stream.
 *
 * `settlementFactsOf` takes the facts of one batch from the rows. The facts are the completed
 * tasks, the revisions after the prepared record and the records of the cited evidence.
 * `judgeSettlement` judges the batch from those facts and from the runs of its segments.
 * Both functions are synchronous, so a write transaction can fold its own rows and judge again.
 *
 * The module also holds the type of a segment run and the classes of a halt. It imports nothing
 * from the settle handler.
 */

import type { ExarchosCapsuleV1 } from '../../contract/capsule/exarchos-capsule.js';
import { canonicalJson } from '../../contract/request-context.js';
import type { AdmissionEvidenceRecorded } from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import type { TASK_COMPLETION } from '../../runbooks/definitions.js';
import type { IntentReceipt } from '../execute/types.js';
import { gateEvidenceRecordsOf, ladderRequirementId } from '../gates/durable-gate-producer.js';
import { revisedTasksAfter } from '../prepare/design-version.js';
import {
  acceptedMaterialDeviations,
  adjudicateSettlement,
  type AdjudicationContext,
  type ProposedDeviation,
  type SettlementClaim,
  type SettlementEvidence,
  type SettlementVerdict,
  type TaskStanding,
  type TaskVerificationOutcome,
  verificationRuns,
} from './adjudicate.js';
import type { SettlementVerificationTrace } from './types.js';

/** A leaf of the task-completion runbook, as the runbook names it. */
type TaskCompletionLeaf = (typeof TASK_COMPLETION)['steps'][number]['action'];

/**
 * The class of each leaf of the task-completion runbook. A `gate` leaf judges the work of the task.
 * The `completion` leaf records the result after the gates, so its halt is not a verdict about
 * the work. The record is exhaustive, so a new leaf without a class does not compile.
 */
export const TASK_COMPLETION_LEAF_CLASSES: Readonly<Record<TaskCompletionLeaf, 'gate' | 'completion'>> = {
  check_test_adequacy: 'gate',
  check_contract_drift: 'gate',
  check_mock_boundary: 'gate',
  check_static_analysis: 'gate',
  task_complete: 'completion',
};

/** Whether an action is a leaf of the task-completion runbook. */
function isTaskCompletionLeaf(action: string): action is TaskCompletionLeaf {
  return Object.hasOwn(TASK_COMPLETION_LEAF_CLASSES, action);
}

/**
 * Whether the halt of a segment is a gate verdict about the work of its task. It is a verdict
 * when a gate leaf stopped the segment and the leaf kept its contract. A halt at the completion
 * leaf, at a leaf that the runbook does not name, or on a broken contract is not a verdict.
 */
export function haltIsGateVerdict(receipt: IntentReceipt): boolean {
  if (receipt.failure?.code === 'INTENT_EMISSION_CONTRACT_VIOLATED') return false;
  const leaf = receipt.failedLeaf;
  return leaf !== undefined && isTaskCompletionLeaf(leaf) && TASK_COMPLETION_LEAF_CLASSES[leaf] === 'gate';
}

/**
 * The verification of one task. A `refused` run is not an answer about the task, so the call
 * records no verdict. `halted` says that the segment ran and halted, so the stream can hold the
 * completion of the task.
 */
export type VerificationRun =
  | {
      readonly kind: 'ran';
      readonly outcome: TaskVerificationOutcome;
      readonly trace: SettlementVerificationTrace;
    }
  | { readonly kind: 'refused'; readonly result: ToolResult; readonly halted: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tasks a stream already shows complete, read from the rows themselves. */
export function completedTaskIds(events: readonly { readonly type: string; readonly data?: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== 'task.completed' || !isRecord(event.data)) continue;
    const taskId = event.data.taskId;
    if (typeof taskId === 'string') ids.add(taskId);
  }
  return ids;
}

/**
 * The tasks that a verified round finds complete on the stream.
 * They are the required tasks of the capsule and the accepted tasks of the batch that `completed` holds.
 * The round brings the state document level for each of them.
 * A required task in the list needs no claim. The list is sorted, and it holds each task once.
 */
export function recordedCompleteTasks(
  capsule: ExarchosCapsuleV1,
  acceptedTasks: readonly string[],
  completed: ReadonlySet<string>,
): string[] {
  const candidates = new Set([...capsule.settlementContract.requiredResults, ...acceptedTasks]);
  return [...candidates].filter((taskId) => completed.has(taskId)).sort();
}

/** The evidence key of a citation: the kind and the reference together. */
function evidenceKey(evidence: SettlementEvidence): string {
  return `${evidence.kind}\u0000${evidence.ref}`;
}

/** The record of one cited evidence reference. `key` is the evidence key of the citation. */
export interface CitedRecord {
  readonly key: string;
  readonly record: AdmissionEvidenceRecorded;
}

/**
 * The blob check of one cited record, as the call made it before it judged. `record` is the record
 * that the check read. `intact` says that each blob that the record names resolves.
 */
export interface EvidenceCheck {
  readonly record: AdmissionEvidenceRecorded;
  readonly intact: boolean;
}

/** The facts of one batch that the fold takes from the rows of its stream. */
export interface SettlementFacts {
  /** The tasks that a `task.completed` row names. */
  readonly completed: ReadonlySet<string>;
  /** Each task that a revision after the prepared record names, with the next version of the latest such revision. */
  readonly revisions: ReadonlyMap<string, number>;
  /**
   * The record of each cited reference, by evidence key. A reference has a record when a gate row holds its
   * evidence id under the ladder requirement of the cited kind. The rows that no claim cites are not facts.
   */
  readonly cited: ReadonlyMap<string, CitedRecord>;
}

/**
 * The facts of one batch, folded from the rows of its stream. `rows` is the whole stream in commit
 * order, after the event migration, and it can hold rows of any type.
 *
 * `pinnedSequence` is the sequence of the prepared record of the capsule. `cited` holds the evidence
 * references that the claims carry. A revision row that its schema refuses throws.
 */
export function settlementFactsOf(
  rows: readonly { readonly type: string; readonly sequence: number; readonly data?: unknown }[],
  reads: { readonly pinnedSequence: number; readonly cited: readonly SettlementEvidence[] },
): SettlementFacts {
  const completed = completedTaskIds(rows);
  const revisions = revisedTasksAfter(rows, reads.pinnedSequence);
  const cited = new Map<string, CitedRecord>();
  if (reads.cited.length > 0) {
    const recorded = gateEvidenceRecordsOf(rows);
    for (const evidence of reads.cited) {
      const record = recorded.get(evidence.ref);
      if (record === undefined || record.evidence.requirementId !== ladderRequirementId(evidence.kind)) continue;
      const key = evidenceKey(evidence);
      cited.set(key, { key, record });
    }
  }
  return { completed, revisions, cited };
}

/** What stays fixed for one attempt of a settlement call. */
export interface SettlementInputs {
  readonly capsule: ExarchosCapsuleV1;
  readonly claims: readonly SettlementClaim[];
  readonly deviations: readonly ProposedDeviation[];
  /** The decision for each deviation. It returns undefined for a deviation that no decision answers. */
  readonly decided: NonNullable<AdjudicationContext['decided']>;
  /** The round of the call: 0 for the round that submits the batch, 1 for the decision round. */
  readonly round: number;
  /**
   * How a task stands in the plan, read before the commit. It applies on the round that submits the batch only.
   * A task that the facts show complete is finished, whatever the plan says.
   */
  readonly planStanding?: (taskId: string) => TaskStanding;
  /** The blob checks of the cited records, by evidence key. */
  readonly evidenceChecks: ReadonlyMap<string, EvidenceCheck>;
}

/** The judgement of one batch from one read of its stream. */
export interface SettlementJudgement {
  /** The final verdict when verification runs, and the verdict of the shape pass when it does not. */
  readonly verdict: SettlementVerdict;
  /** Whether the shape pass lets verification run. */
  readonly verifies: boolean;
  /** The verification outcome of each task that the final pass reads. It is empty when verification does not run. */
  readonly outcomes: ReadonlyMap<string, TaskVerificationOutcome>;
  /**
   * The traces in the order of the receipt. First come the complete tasks with no run, sorted. Then
   * come the runs in their order. It is empty when verification does not run.
   */
  readonly traces: readonly SettlementVerificationTrace[];
  /** The tasks that the judgement settles as already complete, sorted. */
  readonly alreadyComplete: readonly string[];
  /** The accepted tasks with no run and no completion row, in the order of the accepted tasks. Each needs a segment. */
  readonly needsSegment: readonly string[];
  /** The cited records whose blob check is not in the inputs, or that changed after the check. */
  readonly needsEvidenceCheck: readonly CitedRecord[];
  /** The accepted material deviations. A decision round records one design revision for them. */
  readonly revising: readonly ProposedDeviation[];
  /** The result of the first refused run, in run order, whose task the facts do not show complete. */
  readonly refusal?: ToolResult;
}

/** Whether a run halted: a refused run that ran and halted, or a run whose gate verdict failed. */
function runHalted(run: VerificationRun): boolean {
  return run.kind === 'refused' ? run.halted : run.outcome.kind === 'failed';
}

/**
 * Judges one batch from the facts of one read and from the runs of its segments. The function is
 * pure, so each read of the stream gets the same judgement from the same facts.
 *
 * A run that verified keeps `verified`, also when another writer stored the completion. A task whose
 * run halted or failed is already complete when the facts show it complete. So is a task whose claim
 * reports a status, because adjudication accepts such a claim when the task is complete.
 * A judgement that names a needed segment or a needed evidence check is not final.
 */
export function judgeSettlement(
  inputs: SettlementInputs,
  facts: SettlementFacts,
  runs: ReadonlyMap<string, VerificationRun>,
): SettlementJudgement {
  const { capsule, claims, deviations, decided } = inputs;
  const checkedIntact = (cited: CitedRecord): boolean | undefined => {
    const check = inputs.evidenceChecks.get(cited.key);
    if (check === undefined || canonicalJson(check.record) !== canonicalJson(cited.record)) return undefined;
    return check.intact;
  };
  const planStanding = inputs.round === 0 ? inputs.planStanding : undefined;
  const context: AdjudicationContext = {
    evidenceResolves: (evidence) => {
      const cited = facts.cited.get(evidenceKey(evidence));
      return cited !== undefined && checkedIntact(cited) === true;
    },
    decided,
    supersedingDesignVersion: (taskId) => facts.revisions.get(taskId),
    taskComplete: (taskId) => facts.completed.has(taskId),
    ...(planStanding !== undefined
      ? {
          taskStanding: (taskId: string): TaskStanding =>
            facts.completed.has(taskId) ? { kind: 'finished' } : planStanding(taskId),
        }
      : {}),
  };

  const needsEvidenceCheck = [...facts.cited.values()].filter((cited) => checkedIntact(cited) === undefined);
  const revising = acceptedMaterialDeviations(capsule, deviations, decided);
  let refusal: ToolResult | undefined;
  for (const [taskId, run] of runs) {
    if (run.kind === 'refused' && !(run.halted && facts.completed.has(taskId))) {
      refusal = run.result;
      break;
    }
  }
  const refused = refusal !== undefined ? { refusal } : {};

  const shape = adjudicateSettlement(capsule, claims, deviations, context);
  if (!verificationRuns(shape.findings)) {
    return {
      verdict: shape,
      verifies: false,
      outcomes: new Map(),
      traces: [],
      alreadyComplete: [],
      needsSegment: [],
      needsEvidenceCheck,
      revising,
      ...refused,
    };
  }

  const outcomes = new Map<string, TaskVerificationOutcome>();
  const traces: SettlementVerificationTrace[] = [];
  const alreadyComplete: string[] = [];
  const settleComplete = (taskId: string): void => {
    outcomes.set(taskId, { kind: 'already-complete' });
    traces.push({ taskId, outcome: 'already-complete' });
    alreadyComplete.push(taskId);
  };
  for (const taskId of recordedCompleteTasks(capsule, shape.acceptedTasks, facts.completed)) {
    if (!runs.has(taskId)) settleComplete(taskId);
  }
  for (const [taskId, run] of runs) {
    if (runHalted(run) && facts.completed.has(taskId)) {
      settleComplete(taskId);
      continue;
    }
    if (run.kind === 'refused') continue;
    outcomes.set(taskId, run.outcome);
    traces.push(run.trace);
  }

  const terms = capsule.settlementContract.taskVerification ?? {};
  const needsSegment = shape.acceptedTasks.filter(
    (taskId) => !runs.has(taskId) && !facts.completed.has(taskId) && terms[taskId] !== undefined,
  );
  return {
    verdict: adjudicateSettlement(capsule, claims, deviations, { ...context, verification: outcomes }),
    verifies: true,
    outcomes,
    traces,
    alreadyComplete: [...alreadyComplete].sort(),
    needsSegment,
    needsEvidenceCheck,
    revising,
    ...refused,
  };
}
