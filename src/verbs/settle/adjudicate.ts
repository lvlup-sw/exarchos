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
  'deviation-outside-envelope': 'refuse',
  'deviation-awaiting-approval': 'hold',
  'deviation-rejected': 'refuse',
  'deviation-unknown-task': 'refuse',
  'deviation-names-finished-task': 'refuse',
  'deviation-names-claimed-task': 'refuse',
  'verification-failed': 'unresolved',
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

/** Returns the listed names as a tuple of literal types, so one list can feed each closed enum. */
function outcomeNames<const Names extends readonly [string, ...string[]]>(...names: Names): Names {
  return names;
}

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
export const SETTLEMENT_OUTCOMES = outcomeNames(
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

/** The outcome that a list of findings gives: that of the class first in precedence. No finding gives `settled`. */
function outcomeOf(findings: readonly SettlementFinding[]): SettlementOutcome {
  let decided: FindingClassEffect | undefined;
  for (const finding of findings) {
    const effect = effectOf(finding);
    if (decided === undefined || effect.precedence < decided.precedence) decided = effect;
  }
  return decided === undefined ? 'settled' : decided.outcome;
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
   * The design version of the latest revision that names a task, among the revisions that the stream recorded after the capsule.
   * It returns undefined for a task that no such revision names. Without the function, no task gets the check.
   */
  readonly supersedingDesignVersion?: (taskId: string) => number | undefined;
  /**
   * Whether the stream shows a task complete. A required task that it shows complete needs no claim.
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

    const revisedTo = context.supersedingDesignVersion?.(claim.taskId);
    if (revisedTo !== undefined) {
      findings.push(
        supersededByRevision(capsule, claim.taskId, revisedTo, `${at}.taskId`, `task ${JSON.stringify(claim.taskId)}`),
      );
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

  const outcome = outcomeOf(findings);
  return {
    outcome,
    capsuleVersion: capsule.identity.capsuleVersion,
    acceptedTasks: [...accepted].sort(),
    findings,
    unresolved: outcome === FINDING_CLASS_EFFECTS.unresolved.outcome ? unresolvedTasksOf(findings) : [],
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
