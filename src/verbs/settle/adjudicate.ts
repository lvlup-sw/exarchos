/**
 * Settlement adjudication. It judges one batch of claims against the capsule that was pinned at compile time, not against the current design.
 * The harness runs without governance calls, so it is judged by the terms it ran under.
 *
 * This module is pure: no store, no filesystem, no clock. The handler records the verdict.
 * The context supplies the facts that the module cannot compute.
 * They are whether an evidence reference resolves, how a named task stands, and which later revision names a task.
 * They are also whether the stream shows a task complete, and each task verification outcome.
 *
 * The capsule parts that decide the verdict are `contracts.taskResults`, `contracts.evidenceKinds`, `contracts.deviationEnvelope`,
 * `settlementContract.requiredResults` and `settlementContract.taskVerification`.
 * Adjudication returns every finding and does not stop at the first, so a caller can correct a rejected batch in one round trip.
 */

import type { ExarchosCapsuleV1 } from '../../contract/capsule/exarchos-capsule.js';

/** Every kind of finding adjudication can report. */
export const SETTLEMENT_FINDING_KINDS = [
  'unknown-task',
  'claim-superseded-by-revision',
  'undeclared-result-shape',
  'duplicate-claim',
  'missing-claim',
  'missing-field',
  'field-type-mismatch',
  'undeclared-field',
  'inadmissible-evidence',
  'rationale-not-delegated',
  'deviation-outside-envelope',
  'deviation-awaiting-approval',
  'deviation-rejected',
  'deviation-unknown-task',
  'deviation-names-finished-task',
  'deviation-names-claimed-task',
  'verification-failed',
  'task-failed',
  'task-blocked',
  'task-skipped',
] as const;

/** What adjudication found wrong with one claim, one task, or one deviation. */
export type SettlementFindingKind = (typeof SETTLEMENT_FINDING_KINDS)[number];

/**
 * How a finding acts on its batch.
 * `stale` means that a later revision replaced the terms of the capsule before the batch arrived.
 * `refuse` means that the request or a deviation is in error.
 * `hold` means that a deviation waits for its decision.
 * `unresolved` means that one task is not complete. The other tasks are judged apart from it.
 */
export type SettlementFindingClass = 'stale' | 'refuse' | 'hold' | 'unresolved';

/**
 * The class of each finding kind. The record is exhaustive, so a kind with no class does not compile.
 * A deviation inside the envelope is a valid answer to a wrong capsule assumption, so its finding holds the batch.
 * A failed verification leaves its task unresolved, and it does not refuse the tasks that passed.
 * A claim that reports its task as not completed also leaves the task unresolved.
 * A rationale that names a decision that the capsule does not delegate is a request error, so it refuses the batch.
 */
export const SETTLEMENT_FINDING_CLASSES: Readonly<Record<SettlementFindingKind, SettlementFindingClass>> = {
  'unknown-task': 'refuse',
  'claim-superseded-by-revision': 'stale',
  'undeclared-result-shape': 'refuse',
  'duplicate-claim': 'refuse',
  'missing-claim': 'refuse',
  'missing-field': 'refuse',
  'field-type-mismatch': 'refuse',
  'undeclared-field': 'refuse',
  'inadmissible-evidence': 'refuse',
  'rationale-not-delegated': 'refuse',
  'deviation-outside-envelope': 'refuse',
  'deviation-awaiting-approval': 'hold',
  'deviation-rejected': 'refuse',
  'deviation-unknown-task': 'refuse',
  'deviation-names-finished-task': 'refuse',
  'deviation-names-claimed-task': 'refuse',
  'verification-failed': 'unresolved',
  'task-failed': 'unresolved',
  'task-blocked': 'unresolved',
  'task-skipped': 'unresolved',
};

/** A single, path-annotated adjudication finding. */
export interface SettlementFinding {
  readonly kind: SettlementFindingKind;
  /** The task, field, evidence kind or deviation kind at fault. */
  readonly subject: string;
  /** A JSON-ish path locating the claim or term the finding is about. */
  readonly at: string;
  readonly message: string;
}

/** Returns the listed names as a tuple of literal types, so one list can feed each closed enum. */
function closedNames<const Names extends readonly [string, ...string[]]>(...names: Names): Names {
  return names;
}

/**
 * The statuses of a claim that reports its task as not completed.
 * `failed` means that the worker attempted the task and has no result to verify.
 * `blocked` means that the task cannot proceed until something outside the task changes.
 * `skipped` means that the task was not attempted in this run.
 */
export const INCOMPLETE_CLAIM_STATUSES = closedNames('failed', 'blocked', 'skipped');

/** A status of a claim that reports its task as not completed. */
export type IncompleteClaimStatus = (typeof INCOMPLETE_CLAIM_STATUSES)[number];

/** Each status that a request can give a claim. `completed` is the default. */
export const CLAIM_STATUSES = closedNames('completed', ...INCOMPLETE_CLAIM_STATUSES);

/**
 * One delegated choice that a completed claim records.
 * `delegatedDecision` is the id of a delegated decision of the capsule. `statement` is the choice, in the words of the worker.
 * A rationale grants nothing: settlement runs the same gates for a task with one and for a task without one.
 * It is no evidence, and it does not accept a claim that has a finding or a failed verification.
 * It changes only the outcome of a batch that has no finding.
 */
export interface ClaimRationale {
  readonly delegatedDecision: string;
  readonly statement: string;
}

/**
 * One claim in its normal form: the result that a task returned, or the reason that the task is not completed.
 * `status` is absent on a completed claim, so a claim that an earlier build recorded keeps its bytes and its request digest.
 * A claim with a status has a reason, no fields, no evidence and no rationale. The claim codec gives each claim this form.
 * Adjudication records no rationale from a claim with a status, so a stored claim outside this form grants nothing.
 * `rationale` is absent on a claim that records no delegated choice, for the same reason as `status`.
 */
export interface SettlementClaim {
  readonly taskId: string;
  readonly status?: IncompleteClaimStatus | undefined;
  readonly reason?: string | undefined;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly evidence: readonly SettlementEvidence[];
  readonly rationale?: readonly ClaimRationale[] | undefined;
}

/** One piece of evidence a claim cites, by kind and by reference. */
export interface SettlementEvidence {
  readonly kind: string;
  readonly ref: string;
}

/**
 * A deviation the worker proposes because a capsule assumption did not hold.
 * `affectedTasks` names the unfinished tasks that the deviation changes. The handler sorts the list, makes it unique, and drops an empty list.
 * `proposedChange` is the change that the worker proposes, in its words.
 */
export interface ProposedDeviation {
  readonly deviationKind: string;
  readonly statement: string;
  readonly affectedTasks?: readonly string[];
  readonly proposedChange?: string;
}

/**
 * How a task that a deviation names stands in the current plan.
 * `finished` is a task that the plan or the stream shows complete.
 * `unknown` is a task that the plan does not hold.
 * `unreadable` is the refusal of the plan reader, when the plan holds an entry for the task that the reader refused.
 */
export type TaskStanding =
  | { readonly kind: 'pending' }
  | { readonly kind: 'finished' }
  | { readonly kind: 'unknown'; readonly unreadable?: string };

/**
 * Every settlement outcome. Each closed enum of the outcome is built from this list.
 *
 * The first three names are the ones that stored rows, bundles and replayed claims carry.
 * `settled` and `deviation-pending` keep their meaning. `rejected` is narrower than in an earlier build.
 * A `rejected` row, bundle or claim of an earlier build can also record a superseded claim.
 * It can also record a failed verification, and the tasks that passed are then recorded complete.
 *
 * `recompile-required` is a batch on a capsule that a later revision replaced.
 * `corrective-capsule` is a batch with a task that is not complete, while the tasks that passed are complete.
 * `accepted-with-rationale` is a complete batch in which a claim records a delegated choice.
 */
export const SETTLEMENT_OUTCOMES = closedNames(
  'settled',
  'rejected',
  'deviation-pending',
  'recompile-required',
  'corrective-capsule',
  'accepted-with-rationale',
);

/** How a batch stands after adjudication. */
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

/** What a finding of one class does to its batch. */
interface FindingClassEffect {
  /** The place of the class in the order of precedence. The lowest number among the findings of a batch decides its outcome. */
  readonly precedence: number;
  readonly outcome: SettlementOutcome;
  /** Whether settlement still verifies the clean claims of a batch that has a finding of the class. */
  readonly verifies: boolean;
}

/**
 * The effect of each finding class. The record is exhaustive, so a class with no effect does not compile.
 * A stale, refused or held batch is stopped before verification, so nothing in it is verified.
 * An unresolved task does not stop its batch, so the other tasks of the batch can still complete.
 */
const FINDING_CLASS_EFFECTS: Readonly<Record<SettlementFindingClass, FindingClassEffect>> = {
  stale: { precedence: 0, outcome: 'recompile-required', verifies: false },
  refuse: { precedence: 1, outcome: 'rejected', verifies: false },
  hold: { precedence: 2, outcome: 'deviation-pending', verifies: false },
  unresolved: { precedence: 3, outcome: 'corrective-capsule', verifies: true },
};

/** The effect of the class of one finding. */
function effectOf(finding: SettlementFinding): FindingClassEffect {
  return FINDING_CLASS_EFFECTS[SETTLEMENT_FINDING_CLASSES[finding.kind]];
}

/**
 * The outcome that a list of findings gives: that of the class first in precedence.
 * A batch with no finding is settled. It is accepted with rationale when an accepted claim records a delegated choice.
 * A finding of any class decides the outcome before a rationale does.
 */
function outcomeOf(findings: readonly SettlementFinding[], recordsChoice: boolean): SettlementOutcome {
  let decided: FindingClassEffect | undefined;
  for (const finding of findings) {
    const effect = effectOf(finding);
    if (decided === undefined || effect.precedence < decided.precedence) decided = effect;
  }
  if (decided !== undefined) return decided.outcome;
  return recordsChoice ? 'accepted-with-rationale' : 'settled';
}

/** One task that a batch leaves unresolved. `cause` is the kind of the finding against the task. */
export interface UnresolvedTask {
  readonly taskId: string;
  readonly cause: SettlementFindingKind;
}

/**
 * The tasks that a list of findings leaves unresolved, sorted by task id.
 * The subject of a finding of the `unresolved` class is the id of its task.
 * A task is in the list once, with the kind of its first finding.
 */
function unresolvedTasksOf(findings: readonly SettlementFinding[]): UnresolvedTask[] {
  const causes = new Map<string, SettlementFindingKind>();
  for (const finding of findings) {
    if (SETTLEMENT_FINDING_CLASSES[finding.kind] !== 'unresolved' || causes.has(finding.subject)) continue;
    causes.set(finding.subject, finding.kind);
  }
  return [...causes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([taskId, cause]) => ({ taskId, cause }));
}

/** One delegated choice as the settlement record names it: the task, and the id of the delegated decision. */
export interface RecordedRationale {
  readonly taskId: string;
  readonly delegatedDecision: string;
}

/** The pairs in the order of the settlement record: by task id, then by decision id, and each pair once. */
function sortedOnce(pairs: readonly RecordedRationale[]): RecordedRationale[] {
  const once = new Map<string, RecordedRationale>();
  for (const pair of pairs) once.set(JSON.stringify([pair.taskId, pair.delegatedDecision]), pair);
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...once.values()].sort(
    (a, b) => order(a.taskId, b.taskId) || order(a.delegatedDecision, b.delegatedDecision),
  );
}

/**
 * The ids of the decisions that a capsule delegates. A rationale names a delegated decision by its id.
 * The id of a capsule statement is optional, and a statement with no id cannot be named.
 */
function delegatedDecisionIds(capsule: ExarchosCapsuleV1): Set<string> {
  const ids = new Set<string>();
  for (const decision of capsule.authority.delegatedDecisions) {
    if (decision.id !== undefined) ids.add(decision.id);
  }
  return ids;
}

/**
 * The finding for a rationale entry that names a decision that the capsule does not delegate.
 * The subject is the id that the entry gives. The message lists the ids that the capsule delegates.
 */
function rationaleNotDelegated(
  taskId: string,
  delegatedDecision: string,
  delegated: ReadonlySet<string>,
  at: string,
): SettlementFinding {
  const ids = [...delegated].sort().map((id) => JSON.stringify(id));
  return {
    kind: 'rationale-not-delegated',
    subject: delegatedDecision,
    at,
    message:
      `the claim for task ${JSON.stringify(taskId)} records a choice under ${JSON.stringify(delegatedDecision)}, ` +
      'and the capsule delegates no decision with that id. ' +
      (ids.length > 0
        ? `The ids of its delegated decisions are ${ids.join(', ')}. `
        : 'It gives no id to a delegated decision, so no rationale can name one. ') +
      'A choice outside the delegated decisions is a deviation, and it goes in `deviations`',
  };
}

/**
 * Whether verification runs after the shape pass that gave these findings.
 * It runs when no finding is stale, refuses the batch, or holds it. A finding that leaves a task unresolved does not stop it.
 */
export function verificationRuns(findings: readonly SettlementFinding[]): boolean {
  return findings.every((finding) => effectOf(finding).verifies);
}

/**
 * Whether a batch with this outcome reached verification. Under such an outcome, the tasks that passed are recorded complete.
 * An outcome did not reach it when it is the outcome of a finding class that stops verification.
 */
export function outcomeVerifies(outcome: SettlementOutcome): boolean {
  return !Object.values(FINDING_CLASS_EFFECTS).some((effect) => effect.outcome === outcome && !effect.verifies);
}

/**
 * The verification outcome of one task, as the handler reports it.
 * `verified` is a segment that ran to its terminal leaf and committed.
 * `already-complete` is a task that the stream showed complete before the batch, so nothing ran again.
 * It is also a task whose segment halted after the stream recorded its completion.
 * `failed` names the gate leaf whose verdict halted the segment, and the message of that leaf.
 */
export type TaskVerificationOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'already-complete' }
  | { readonly kind: 'failed'; readonly failedLeaf: string; readonly message: string };

/** What adjudication needs beyond the capsule and the batch. */
export interface AdjudicationContext {
  /**
   * Whether a cited evidence reference resolves: a recorded row of the cited kind exists on the stream, and every blob it names is intact.
   * It has no default, because a default of yes lets a claim cite anything.
   */
  readonly evidenceResolves: (evidence: SettlementEvidence) => boolean;
  /**
   * The decision for a proposed deviation on the round that decides a held batch.
   * `accepted` admits the deviation, and `rejected` refuses the batch.
   * It returns undefined for an undecided deviation. The round that proposes the deviations has no `decided` function.
   */
  readonly decided?: (deviation: ProposedDeviation) => 'accepted' | 'rejected' | undefined;
  /**
   * How a task that a deviation names stands. The handler supplies it only on the first submission of a batch whose deviations name tasks.
   * Without it, the affected tasks get no check. Thus a decision still settles after a later plan drops an affected task.
   */
  readonly taskStanding?: (taskId: string) => TaskStanding;
  /**
   * The design version of the latest revision that names a task, among the revisions that the stream recorded after the capsule.
   * It returns undefined for a task that no such revision names. Without the function, no task gets the check.
   */
  readonly supersedingDesignVersion?: (taskId: string) => number | undefined;
  /**
   * Whether the stream shows a task complete. A required task that it shows complete needs no claim.
   * A claim that reports such a task as not completed gets no finding, and the task keeps its recorded completion.
   * Without the function, each required task needs a claim.
   */
  readonly taskComplete?: (taskId: string) => boolean;
  /**
   * The verification outcome per task. It is absent on the shape pass, which decides whether verification runs.
   * On the final pass, a claim without a passing entry is not accepted.
   * It also holds the outcome of each required task that the stream shows complete and the batch does not claim.
   */
  readonly verification?: ReadonlyMap<string, TaskVerificationOutcome>;
}

/** The batch verdict: the outcome, every finding, and what was adjudicated. */
export interface SettlementVerdict {
  readonly outcome: SettlementOutcome;
  readonly capsuleVersion: number;
  /** Task ids whose claims were adjudicated with no finding against them. */
  readonly acceptedTasks: readonly string[];
  readonly findings: readonly SettlementFinding[];
  /**
   * The tasks to correct, sorted by task id. The list has entries only when an unresolved task decides the outcome.
   * Under each outcome that stops verification nothing was verified, so the findings of the batch are not the list of work to do.
   */
  readonly unresolved: readonly UnresolvedTask[];
  /**
   * The delegated choices that the accepted claims record, sorted by task id and then by decision id.
   * The list has entries only under an outcome that reaches verification. The statement of each choice stays on its claim.
   */
  readonly rationales: readonly RecordedRationale[];
  /**
   * The counts of what the pass read.
   * An empty pass and a full clean pass both report zero findings, and only these counts tell them apart.
   */
  readonly adjudicated: SettlementCensus;
}

/** What the pass actually looked at. */
export interface SettlementCensus {
  readonly claims: number;
  readonly requiredResults: number;
  readonly fields: number;
  readonly evidence: number;
  readonly deviations: number;
  /** Verification outcomes read. It is zero on a pass that ran none. */
  readonly verification: number;
  /** Decisions read for proposed deviations. It is zero on a round with no decisions. */
  readonly decisions: number;
}

/**
 * The stale finding for a task that a later revision names. `met` says how the batch meets the task.
 * The message names the design version of the revision and the next call.
 */
function supersededByRevision(
  capsule: ExarchosCapsuleV1,
  taskId: string,
  revisedTo: number,
  at: string,
  met: string,
): SettlementFinding {
  return {
    kind: 'claim-superseded-by-revision',
    subject: taskId,
    at,
    message:
      `${met} is named by the revision to design version ${revisedTo}, ` +
      `which the stream recorded after capsule v${capsule.identity.capsuleVersion} was compiled. This ` +
      'capsule holds the earlier terms of the task: prepare again, and settle the batch under the new capsule',
  };
}

/**
 * The finding for a required task that the batch does not claim, or undefined when the task needs no claim.
 * A task that the stream shows complete needs no claim, because the recorded completion is its result.
 * An incomplete task that a later revision names is stale, so its capsule can settle no new batch.
 * Each other task is a missing claim.
 */
function unclaimedRequirementFinding(
  capsule: ExarchosCapsuleV1,
  required: string,
  context: AdjudicationContext,
): SettlementFinding | undefined {
  if (context.taskComplete?.(required) === true) return undefined;
  const revisedTo = context.supersedingDesignVersion?.(required);
  if (revisedTo !== undefined) {
    return supersededByRevision(
      capsule,
      required,
      revisedTo,
      'claims',
      `settlement requires a result from task ${JSON.stringify(required)} and the batch carries none, and the task`,
    );
  }
  return {
    kind: 'missing-claim',
    subject: required,
    at: 'claims',
    message: `settlement requires a result from task ${JSON.stringify(required)} and the batch carries none`,
  };
}

/** The finding kind for each status of a claim that reports its task as not completed, and what the status says. */
const INCOMPLETE_CLAIM_FINDINGS: Readonly<
  Record<IncompleteClaimStatus, { readonly kind: SettlementFindingKind; readonly says: string }>
> = {
  failed: { kind: 'task-failed', says: 'was attempted and has no result to verify' },
  blocked: { kind: 'task-blocked', says: 'cannot proceed until something outside the task changes' },
  skipped: { kind: 'task-skipped', says: 'was not attempted in this run' },
};

/**
 * The finding for a claim that reports its task as not completed. The subject is the task id, so the task is unresolved.
 * Settlement runs no verification for such a claim and records no completion from it. The message gives the reason of the worker.
 * A claim for a task that the stream shows complete gets no such finding, because the recorded completion is the result of the task.
 */
function incompleteClaimFinding(
  taskId: string,
  status: IncompleteClaimStatus,
  reason: string | undefined,
  at: string,
): SettlementFinding {
  const { kind, says } = INCOMPLETE_CLAIM_FINDINGS[status];
  return {
    kind,
    subject: taskId,
    at,
    message:
      `the claim reports that task ${JSON.stringify(taskId)} ${says}` +
      `${reason === undefined ? '' : `: ${JSON.stringify(reason)}`}. ` +
      'Nothing was verified for the task, and it is not complete',
  };
}

/**
 * The tasks that a batch claims as completed. A deviation of the batch cannot name one of them.
 * It affects work that is still to do, and not a result that the batch returns.
 * A claim that reports its task as failed, blocked or skipped returns no result, so a deviation can name its task.
 */
function tasksClaimedAsCompleted(claims: readonly SettlementClaim[]): Set<string> {
  return new Set(claims.filter((claim) => claim.status === undefined).map((claim) => claim.taskId));
}

/** The capsule's own field-type vocabulary, as a runtime test over a value. */
function typeOfValue(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  const primitive = typeof value;
  if (primitive === 'string' || primitive === 'number' || primitive === 'boolean') {
    return primitive;
  }
  if (primitive === 'object') return 'object';
  return primitive;
}

/**
 * Adjudicates one batch of claims against a pinned capsule.
 * The capsule must be valid already: the caller parses it with `ExarchosCapsuleV1Schema` and resolves its references.
 *
 * A second claim for the same task is refused whole, and its fields get no findings.
 * An evidence reference that does not resolve to an intact recorded row is inadmissible, whatever its kind.
 * On the final pass, a claim is accepted only when its verification passed.
 * A rejected deviation refuses the batch, because the decision is made and the next batch is a correction.
 * A deviation inside the envelope can affect only a pending task that the batch does not claim as completed.
 * Each other task that it names refuses the batch, so the batch is not held.
 *
 * A claim for a task that a later revision names is refused whole, because the capsule holds the earlier terms of the task.
 * The finding is stale, so the whole batch waits for the capsule that the next preparation compiles.
 */
export function adjudicateSettlement(
  capsule: ExarchosCapsuleV1,
  claims: readonly SettlementClaim[],
  deviations: readonly ProposedDeviation[],
  context: AdjudicationContext,
): SettlementVerdict {
  const findings: SettlementFinding[] = [];
  const census = {
    claims: claims.length,
    requiredResults: 0,
    fields: 0,
    evidence: 0,
    deviations: deviations.length,
    verification: 0,
    decisions: 0,
  };

  const taskIds = new Set(capsule.graph.tasks.map((task) => task.taskId));
  const admissibleEvidence = new Set(capsule.contracts.evidenceKinds);
  const allowedDeviations = new Set(capsule.contracts.deviationEnvelope.allowedDeviationKinds);
  const delegated = delegatedDecisionIds(capsule);

  const seen = new Set<string>();
  const claimedAsCompleted = tasksClaimedAsCompleted(claims);
  const accepted = new Set<string>();
  const recorded: RecordedRationale[] = [];
  const accept = (claim: SettlementClaim): void => {
    accepted.add(claim.taskId);
    if (claim.status !== undefined) return;
    for (const entry of claim.rationale ?? []) {
      recorded.push({ taskId: claim.taskId, delegatedDecision: entry.delegatedDecision });
    }
  };

  claims.forEach((claim, i) => {
    const at = `claims[${i}]`;
    const before = findings.length;

    if (seen.has(claim.taskId)) {
      findings.push({
        kind: 'duplicate-claim',
        subject: claim.taskId,
        at: `${at}.taskId`,
        message: `two claims for task ${JSON.stringify(claim.taskId)} — settlement cannot adjudicate a task twice`,
      });
      return;
    }
    seen.add(claim.taskId);

    if (!taskIds.has(claim.taskId)) {
      findings.push({
        kind: 'unknown-task',
        subject: claim.taskId,
        at: `${at}.taskId`,
        message: `the capsule's graph declares no task ${JSON.stringify(claim.taskId)}`,
      });
      return;
    }

    const revisedTo = context.supersedingDesignVersion?.(claim.taskId);
    if (revisedTo !== undefined) {
      findings.push(
        supersededByRevision(capsule, claim.taskId, revisedTo, `${at}.taskId`, `task ${JSON.stringify(claim.taskId)}`),
      );
      return;
    }

    if (claim.status !== undefined) {
      if (context.taskComplete?.(claim.taskId) !== true) {
        findings.push(incompleteClaimFinding(claim.taskId, claim.status, claim.reason, at));
        return;
      }
    } else {
      const declared = capsule.contracts.taskResults[claim.taskId];
      if (declared === undefined) {
        findings.push({
          kind: 'undeclared-result-shape',
          subject: claim.taskId,
          at: `${at}.fields`,
          message:
            `task ${JSON.stringify(claim.taskId)} returned a result and the capsule declares no ` +
            'shape for it, so there is nothing to adjudicate the result against',
        });
        return;
      }

      const declaredByName = new Map(declared.map((field) => [field.name, field]));
      for (const field of declared) {
        census.fields += 1;
        const present = Object.prototype.hasOwnProperty.call(claim.fields, field.name);
        if (!present) {
          if (field.required) {
            findings.push({
              kind: 'missing-field',
              subject: field.name,
              at: `${at}.fields`,
              message: `task ${JSON.stringify(claim.taskId)} must return ${JSON.stringify(field.name)}`,
            });
          }
          continue;
        }
        const actual = typeOfValue(claim.fields[field.name]);
        if (actual === field.type) continue;
        findings.push({
          kind: 'field-type-mismatch',
          subject: field.name,
          at: `${at}.fields.${field.name}`,
          message: `${JSON.stringify(field.name)} is declared ${field.type} and arrived as ${actual}`,
        });
      }

      for (const name of Object.keys(claim.fields)) {
        if (declaredByName.has(name)) continue;
        findings.push({
          kind: 'undeclared-field',
          subject: name,
          at: `${at}.fields.${name}`,
          message:
            `task ${JSON.stringify(claim.taskId)} returned ${JSON.stringify(name)}, which its ` +
            'result contract does not declare',
        });
      }

      claim.evidence.forEach((evidence, j) => {
        census.evidence += 1;
        if (!admissibleEvidence.has(evidence.kind)) {
          findings.push({
            kind: 'inadmissible-evidence',
            subject: evidence.kind,
            at: `${at}.evidence[${j}].kind`,
            message: `the capsule admits no evidence of kind ${JSON.stringify(evidence.kind)}`,
          });
          return;
        }
        if (context.evidenceResolves(evidence)) return;
        findings.push({
          kind: 'inadmissible-evidence',
          subject: evidence.ref,
          at: `${at}.evidence[${j}].ref`,
          message:
            `the cited ${evidence.kind} evidence ${JSON.stringify(evidence.ref)} does not resolve ` +
            'to an intact recorded row on the stream',
        });
      });

      (claim.rationale ?? []).forEach((entry, j) => {
        if (delegated.has(entry.delegatedDecision)) return;
        findings.push(
          rationaleNotDelegated(claim.taskId, entry.delegatedDecision, delegated, `${at}.rationale[${j}].delegatedDecision`),
        );
      });

      if (findings.length !== before) return;
    }

    const verification = context.verification;
    if (verification === undefined) {
      accept(claim);
      return;
    }
    const outcome = verification.get(claim.taskId);
    if (outcome !== undefined) census.verification += 1;
    if (outcome === undefined) {
      findings.push({
        kind: 'verification-failed',
        subject: claim.taskId,
        at,
        message: `no verification ran for task ${JSON.stringify(claim.taskId)}, so its claim cannot be accepted`,
      });
      return;
    }
    if (outcome.kind === 'failed') {
      findings.push({
        kind: 'verification-failed',
        subject: claim.taskId,
        at,
        message:
          `verification of task ${JSON.stringify(claim.taskId)} halted on ` +
          `'${outcome.failedLeaf}': ${outcome.message}`,
      });
      return;
    }
    accept(claim);
  });

  for (const required of capsule.settlementContract.requiredResults) {
    census.requiredResults += 1;
    if (seen.has(required)) continue;
    const finding = unclaimedRequirementFinding(capsule, required, context);
    if (finding !== undefined) {
      findings.push(finding);
      continue;
    }
    if (context.verification?.has(required) === true) census.verification += 1;
  }

  deviations.forEach((deviation, i) => {
    const at = `deviations[${i}].deviationKind`;
    if (!allowedDeviations.has(deviation.deviationKind)) {
      findings.push({
        kind: 'deviation-outside-envelope',
        subject: deviation.deviationKind,
        at,
        message:
          `the capsule's deviation envelope does not admit ${JSON.stringify(deviation.deviationKind)}` +
          ' — this is an escalation, not a deviation',
      });
      return;
    }
    const standingOf = context.taskStanding;
    if (standingOf !== undefined) {
      const before = findings.length;
      const named = JSON.stringify(deviation.deviationKind);
      (deviation.affectedTasks ?? []).forEach((taskId, j) => {
        const taskAt = `deviations[${i}].affectedTasks[${j}]`;
        const task = JSON.stringify(taskId);
        const standing = standingOf(taskId);
        if (standing.kind === 'unknown') {
          findings.push({
            kind: 'deviation-unknown-task',
            subject: taskId,
            at: taskAt,
            message:
              standing.unreadable === undefined
                ? `${named} names task ${task} as affected, and the current plan holds no such task`
                : `${named} names task ${task} as affected, and the plan entry for that task could ` +
                  `not be read: ${standing.unreadable}`,
          });
        }
        if (standing.kind === 'finished') {
          findings.push({
            kind: 'deviation-names-finished-task',
            subject: taskId,
            at: taskAt,
            message:
              `${named} names task ${task} as affected, and that task is finished. A finished ` +
              'task is not reopened: plan the rework as a new task, and name the new task',
          });
        }
        if (claimedAsCompleted.has(taskId)) {
          findings.push({
            kind: 'deviation-names-claimed-task',
            subject: taskId,
            at: taskAt,
            message:
              `${named} names task ${task} as affected, and this batch claims that task as completed. A ` +
              'deviation affects work that is still to do, not a result that the batch returns',
          });
        }
      });
      if (findings.length !== before) return;
    }
    if (!capsule.contracts.deviationEnvelope.requiresApproval) return;
    const decision = context.decided?.(deviation);
    if (decision !== undefined) census.decisions += 1;
    if (decision === 'accepted') return;
    if (decision === 'rejected') {
      findings.push({
        kind: 'deviation-rejected',
        subject: deviation.deviationKind,
        at,
        message:
          `${JSON.stringify(deviation.deviationKind)} was proposed and the decision refused it, ` +
          'so the batch is rejected: the work that stood on the deviation is not accepted',
      });
      return;
    }
    findings.push({
      kind: 'deviation-awaiting-approval',
      subject: deviation.deviationKind,
      at,
      message:
        `${JSON.stringify(deviation.deviationKind)} is inside the envelope and the envelope ` +
        'requires approval, so the batch is held rather than settled',
    });
  });

  const outcome = outcomeOf(findings, recorded.length > 0);
  return {
    outcome,
    capsuleVersion: capsule.identity.capsuleVersion,
    acceptedTasks: [...accepted].sort(),
    findings,
    unresolved: outcome === FINDING_CLASS_EFFECTS.unresolved.outcome ? unresolvedTasksOf(findings) : [],
    rationales: outcomeVerifies(outcome) ? sortedOnce(recorded) : [],
    adjudicated: census,
  };
}

/**
 * The deviations of a round that revise the design, in the order of the round.
 * A deviation is in the list when the decision accepted it and the pinned capsule lists its kind as material.
 * A capsule with no list of material kinds selects none, so a capsule stored without the list keeps its meaning.
 * The kinds come from the capsule that judges the batch, never from the current compiler.
 */
export function acceptedMaterialDeviations(
  capsule: ExarchosCapsuleV1,
  deviations: readonly ProposedDeviation[],
  decided: NonNullable<AdjudicationContext['decided']>,
): ProposedDeviation[] {
  const material = new Set(capsule.contracts.deviationEnvelope.materialDeviationKinds ?? []);
  return deviations.filter(
    (deviation) => material.has(deviation.deviationKind) && decided(deviation) === 'accepted',
  );
}
