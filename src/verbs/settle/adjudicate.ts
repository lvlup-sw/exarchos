/**
 * Settlement adjudication. It judges one batch of claims against the capsule that was pinned at compile time, not against the current design.
 * The harness runs without governance calls, so it is judged by the terms it ran under.
 *
 * This module is pure: no store, no filesystem, no clock. The handler records the verdict.
 * The context supplies the facts that the module cannot compute.
 * They are whether an evidence reference resolves, how a named task stands, and each task verification outcome.
 *
 * The capsule parts that decide the verdict are `contracts.taskResults`, `contracts.evidenceKinds`, `contracts.deviationEnvelope`,
 * `settlementContract.requiredResults` and `settlementContract.taskVerification`.
 * Adjudication returns every finding and does not stop at the first, so a caller can correct a rejected batch in one round trip.
 */

import type { ExarchosCapsuleV1 } from '../../contract/capsule/exarchos-capsule.js';

/** Every kind of finding adjudication can report. */
export const SETTLEMENT_FINDING_KINDS = [
  'unknown-task',
  'undeclared-result-shape',
  'duplicate-claim',
  'missing-claim',
  'missing-field',
  'field-type-mismatch',
  'undeclared-field',
  'inadmissible-evidence',
  'deviation-outside-envelope',
  'deviation-awaiting-approval',
  'deviation-rejected',
  'deviation-unknown-task',
  'deviation-names-finished-task',
  'deviation-names-claimed-task',
  'verification-failed',
] as const;

/** What adjudication found wrong with one claim, one task, or one deviation. */
export type SettlementFindingKind = (typeof SETTLEMENT_FINDING_KINDS)[number];

/**
 * The findings that refuse a batch, as opposed to holding it.
 * `deviation-awaiting-approval` is absent on purpose. A deviation inside the envelope is a valid answer to a wrong capsule assumption, so it holds the batch.
 */
export const BLOCKING_SETTLEMENT_FINDING_KINDS: readonly SettlementFindingKind[] =
  SETTLEMENT_FINDING_KINDS.filter((kind) => kind !== 'deviation-awaiting-approval');

/** A single, path-annotated adjudication finding. */
export interface SettlementFinding {
  readonly kind: SettlementFindingKind;
  /** The task, field, evidence kind or deviation kind at fault. */
  readonly subject: string;
  /** A JSON-ish path locating the claim or term the finding is about. */
  readonly at: string;
  readonly message: string;
}

/** One task's returned result, with its fields and the evidence it cites. */
export interface SettlementClaim {
  readonly taskId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly evidence: readonly SettlementEvidence[];
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

/** How a batch stands after adjudication. */
export type SettlementOutcome = 'settled' | 'rejected' | 'deviation-pending';

/**
 * The verification outcome of one task, as the handler reports it.
 * `verified` is a segment that ran to its terminal leaf and committed.
 * `already-complete` is a task that the stream showed complete before the batch, so nothing ran again.
 * `failed` names the leaf where the segment halted and the message of that leaf.
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
   * The verification outcome per claimed task. It is absent on the shape pass, which decides whether verification runs.
   * On the final pass, a claim without a passing entry is not accepted.
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
 * A deviation inside the envelope can affect only a pending task that the batch does not claim.
 * Each other task that it names refuses the batch, so the batch is not held.
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

  const seen = new Set<string>();
  const accepted = new Set<string>();

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

    if (findings.length !== before) return;

    const verification = context.verification;
    if (verification === undefined) {
      accepted.add(claim.taskId);
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
    accepted.add(claim.taskId);
  });

  for (const required of capsule.settlementContract.requiredResults) {
    census.requiredResults += 1;
    if (seen.has(required)) continue;
    findings.push({
      kind: 'missing-claim',
      subject: required,
      at: 'claims',
      message: `settlement requires a result from task ${JSON.stringify(required)} and the batch carries none`,
    });
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
        if (seen.has(taskId)) {
          findings.push({
            kind: 'deviation-names-claimed-task',
            subject: taskId,
            at: taskAt,
            message:
              `${named} names task ${task} as affected, and this batch claims that task. A ` +
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

  const blocking = findings.some((finding) =>
    BLOCKING_SETTLEMENT_FINDING_KINDS.includes(finding.kind),
  );
  const outcome: SettlementOutcome = blocking
    ? 'rejected'
    : findings.length > 0
      ? 'deviation-pending'
      : 'settled';

  return {
    outcome,
    capsuleVersion: capsule.identity.capsuleVersion,
    acceptedTasks: [...accepted].sort(),
    findings,
    adjudicated: census,
  };
}
