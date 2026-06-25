// ─── Shared Escalation Policy (DR-3, #1595) ─────────────────────────────────
//
// One escalation policy, consumed by the three fix-loops of the ship-gate
// methodology: review and the shepherd loop (tasks
// 016–019 are the consumers). The policy is two primitives:
//
//   1. A bounded `maxIterations` per loop — how many times a loop may auto-fix
//      a mechanical finding before it must escalate to the user.
//   2. An explicit ask-user escalation when the bound is hit OR a finding is
//      INTENT-TOUCHING (a spec/intent finding the loop must not silently
//      "fix" — it changes what was asked for, so a human decides).
//
// Defaults are config-resolvable (mirror the `synthesis` precedent, task 003):
// a uniform default of `5` with a per-loop override. Consumers read
// `projectConfig.escalation.maxIterations` and pass it as `configMaxIterations`.
//
// Every function here is pure and total — the load-bearing testable unit is
// `decideEscalation`. `classifyFinding` and `countShepherdIterations` are the
// thin, explicit feeders around it.

/**
 * Uniform default auto-fix bound for every fix-loop. A loop may auto-fix a
 * mechanical finding while `iteration < maxIterations`; on hitting the bound it
 * escalates to the user. Overridable per-loop and via config.
 */
export const DEFAULT_MAX_ITERATIONS = 5;

/**
 * The durable, machine-checkable mirror of the Workflow SDK (#1258) combinator
 * semantics that this interim escalation policy is authored to lower onto. The
 * prose source-of-truth is `docs/designs/2026-06-23-ship-gate-sdk-migration.md`
 * ("SDK-contract values"); this constant is the anchor that the DR-6 divergence
 * guard test asserts the live policy against, so the as-shipped defaults and
 * the documented SDK semantics cannot silently fork before consolidation.
 *
 * On consolidation each interim symbol is a rename of a call site, not a
 * re-derivation: the bounded auto-fix becomes
 * `repeatUntil(cond, body, { maxIterations })` and the ask-user escalation
 * becomes `awaitApproval(approver)`.
 */
export const SDK_MIGRATION_CONTRACT = {
  /** The interim bound re-uses the SDK `repeatUntil(cond, body, { maxIterations })` option name verbatim. */
  repeatUntilOption: 'maxIterations',
  /** The default bound the SDK `repeatUntil({ maxIterations })` body inherits on consolidation. */
  defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
  /** The ask-user escalation maps onto the SDK `awaitApproval(...)` combinator. */
  approvalCombinator: 'awaitApproval',
  /** decideEscalation escalates in EXACTLY these cases (awaitApproval triggers): bound reached OR an intent-touching finding. */
  escalationTriggers: ['bound-reached', 'intent-touching'],
} as const;

/** A fully-resolved escalation policy for a single fix-loop. */
export interface EscalationPolicy {
  readonly maxIterations: number;
}

/**
 * Resolves an {@link EscalationPolicy}, applying precedence
 * `perLoopOverride > configMaxIterations > DEFAULT_MAX_ITERATIONS`. At each
 * layer a value that is not a positive integer (non-positive, non-integer, or
 * `undefined`) is ignored and resolution falls through to the next layer — so a
 * garbage override can never weaken the bound below the resolvable default.
 */
export function resolveEscalationPolicy(opts?: {
  readonly configMaxIterations?: number;
  readonly perLoopOverride?: number;
}): EscalationPolicy {
  const layers = [opts?.perLoopOverride, opts?.configMaxIterations, DEFAULT_MAX_ITERATIONS];
  for (const candidate of layers) {
    if (isPositiveInteger(candidate)) {
      return { maxIterations: candidate };
    }
  }
  // DEFAULT_MAX_ITERATIONS is a positive integer, so the loop above always
  // returns; this is unreachable and exists only to satisfy totality.
  return { maxIterations: DEFAULT_MAX_ITERATIONS };
}

/**
 * Whether a finding can be auto-fixed by the loop (`mechanical` — lint, format,
 * style, coverage) or must be escalated to the user (`intent-touching` —
 * spec/intent findings that change what was asked for).
 */
export type FindingClass = 'mechanical' | 'intent-touching';

/** The decision a fix-loop takes for a finding at a given iteration. */
export interface EscalationDecision {
  readonly action: 'auto-fix' | 'escalate';
  readonly reason: string;
}

/**
 * Decides whether a fix-loop should auto-fix a finding or escalate to the user.
 * Pure and total:
 *   - An `intent-touching` finding ALWAYS escalates immediately, regardless of
 *     iteration — the loop never silently "fixes" something that changes intent.
 *   - A `mechanical` finding is auto-fixed while `iteration < maxIterations`;
 *     once `iteration >= maxIterations` the auto-fix bound is hit and the loop
 *     escalates.
 */
export function decideEscalation(args: {
  readonly findingClass: FindingClass;
  readonly iteration: number;
  readonly policy: EscalationPolicy;
}): EscalationDecision {
  if (args.findingClass === 'intent-touching') {
    return { action: 'escalate', reason: 'intent-touching finding — escalate immediately' };
  }
  if (args.iteration >= args.policy.maxIterations) {
    return { action: 'escalate', reason: `auto-fix bound (${args.policy.maxIterations}) reached` };
  }
  return { action: 'auto-fix', reason: 'mechanical finding within auto-fix bound' };
}

/**
 * Classifies a review finding into a {@link FindingClass}. Minimal and
 * explicit: a finding is `intent-touching` when it is flagged as such
 * (`intentTouching === true`) OR it is a spec finding (`category === 'spec'`) —
 * both change what was asked for and need a human. Everything else (lint,
 * format, style, coverage, …) is `mechanical` and may be auto-fixed within the
 * bound. The load-bearing decision lives in {@link decideEscalation}; this is
 * just the feeder that maps a finding's shape onto its class.
 */
export function classifyFinding(finding: {
  readonly intentTouching?: boolean;
  readonly category?: string;
}): FindingClass {
  if (finding.intentTouching === true || finding.category === 'spec') {
    return 'intent-touching';
  }
  return 'mechanical';
}

/**
 * The SINGLE event-sourced iteration-count authority: the number of
 * `shepherd.iteration` events in a stream. Task 017 reconciles BOTH the
 * `assess_stack` loop and the shepherd-status view onto THIS rule so they can
 * never disagree about how many iterations a loop has run. Pure and total over
 * any event array — only the `type` discriminant is read.
 */
export function countShepherdIterations(
  events: ReadonlyArray<{ readonly type: string }>,
): number {
  let count = 0;
  for (const event of events) {
    if (event.type === 'shepherd.iteration') count++;
  }
  return count;
}

/** A positive integer is a valid bound at any resolution layer. */
function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
