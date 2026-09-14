// ─── Settlement adjudication ─────────────────────────────────────────────────
//
// One batch of claims, judged against the capsule that was pinned when the work
// was compiled — never against whatever the design says now. That is the whole
// point of a capsule: the harness runs without calling back for governance, so
// the terms it ran under have to be the terms it is judged by.
//
// PURE. No store, no filesystem, no clock. The handler is what turns a verdict
// into a durable record; this module only decides. Keeping the decision
// separable is what lets the adjudicator be tested against a table of capsules
// and claims rather than against a running event store. The two facts it
// cannot compute for itself — whether a cited evidence reference resolves on
// the stream, and how a task's verification came out — are handed in through
// the context, so the decision stays one function over its inputs.
//
// What a capsule supplies, and what each part decides here:
//
//   `contracts.taskResults`          the declared shape a claim is read against
//   `contracts.evidenceKinds`        which evidence a claim may cite; the
//                                    reference beside a kind must resolve
//   `contracts.deviationEnvelope`    what a worker may propose when the
//                                    capsule's assumptions turn out wrong
//   `settlementContract.requiredResults`
//                                    which tasks must report for the batch to
//                                    settle at all
//   `settlementContract.taskVerification`
//                                    the terms the handler runs each task's
//                                    verification under; its outcome per task
//                                    arrives here and decides acceptance
//
// Findings are returned in full rather than short-circuited. A caller fixing a
// rejected batch needs every reason at once — reporting the first one turns one
// round trip into as many round trips as there are defects, which is precisely
// the interaction cost this plane exists to remove.

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
  'verification-failed',
] as const;

/** What adjudication found wrong with one claim, one task, or one deviation. */
export type SettlementFindingKind = (typeof SETTLEMENT_FINDING_KINDS)[number];

/**
 * The findings that REFUSE a batch, as opposed to holding it.
 *
 * `deviation-awaiting-approval` is deliberately absent: a deviation inside the
 * envelope is a legitimate answer to a capsule whose assumptions turned out
 * wrong, and refusing it would push the worker toward silently complying with
 * a premise it has already disproved. It holds the batch instead.
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

/** One field of one task's returned result. */
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

/** A deviation the worker proposes because a capsule assumption did not hold. */
export interface ProposedDeviation {
  readonly deviationKind: string;
  readonly statement: string;
}

/** How a batch stands after adjudication. */
export type SettlementOutcome = 'settled' | 'rejected' | 'deviation-pending';

/**
 * How one task's verification came out, as the handler reports it back.
 *
 * `verified` is a segment that ran to its terminal leaf and committed;
 * `already-complete` is a task the stream showed complete before the batch
 * arrived, so nothing was re-run; `failed` names the leaf the segment halted
 * on and what that leaf said.
 */
export type TaskVerificationOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'already-complete' }
  | { readonly kind: 'failed'; readonly failedLeaf: string; readonly message: string };

/** What adjudication needs beyond the capsule and the batch. */
export interface AdjudicationContext {
  /**
   * Whether a cited evidence reference resolves: a recorded row of the cited
   * kind exists on the stream and every blob it names is intact. Required
   * rather than defaulted, because a reference nobody checked is not
   * evidence, and a default that answered yes would let a claim cite anything.
   */
  readonly evidenceResolves: (evidence: SettlementEvidence) => boolean;
  /**
   * The verification the handler ran per claimed task, when it ran any.
   * Absent on the shape pass, which decides whether verification runs at all;
   * present on the final pass, where a claim with no passing entry is not
   * accepted — a task nothing verified is not a complete one.
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
   * The denominator, carried in the verdict rather than left implicit.
   *
   * A settlement that adjudicated nothing and a settlement that adjudicated
   * everything both report zero findings. A reader — and the guard over this
   * module — can tell them apart only if the counts travel with the verdict.
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
  /** Verification outcomes read; zero on a pass that ran none. */
  readonly verification: number;
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
 * Adjudicate one batch of claims against a pinned capsule.
 *
 * The capsule is taken as an ALREADY-VALID document: the caller parses it
 * through `ExarchosCapsuleV1Schema` and resolves its references before getting
 * here. Re-deciding structure inside adjudication would put two answers to the
 * same question in the tree, and the one here would be the weaker of the two.
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
      // The second claim is refused whole. Adjudicating its fields too would
      // report defects against a claim that was never going to be considered.
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
      // A reference is a claim about the stream. One that names no intact
      // recorded row of its kind is not evidence of anything, whatever the
      // kind — the same rule the durable-evidence ensure applies to a row
      // whose blob is gone.
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

    // A claim with no finding against it is accepted on the shape pass. On the
    // final pass it is accepted only if its verification passed: a task whose
    // segment halted, or that no segment ran for, is not a complete one.
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
    if (!capsule.contracts.deviationEnvelope.requiresApproval) return;
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
