/**
 * The escalation policy that the review loop and the shepherd loop share.
 * A loop auto-fixes a mechanical finding until it reaches `maxIterations`, and then asks the user.
 * An intent-touching finding goes to the user at once, because it changes what the user asked for.
 * The default bound is 5. A caller passes `projectConfig.escalation.maxIterations` as `configMaxIterations`, and a loop can override it.
 * Each function here is pure and total.
 */

/**
 * The default auto-fix bound for each fix loop. A loop auto-fixes a mechanical finding while `iteration < maxIterations`.
 */
export const DEFAULT_MAX_ITERATIONS = 5;

/**
 * The Workflow SDK combinator semantics that this interim policy maps onto.
 * A divergence test compares the live policy with this constant, so the policy and the SDK semantics cannot fork.
 * The bounded auto-fix becomes `repeatUntil(cond, body, { maxIterations })`, and the escalation becomes `awaitApproval(approver)`.
 */
export const SDK_MIGRATION_CONTRACT = {
  /** The interim bound re-uses the SDK `repeatUntil(cond, body, { maxIterations })` option name verbatim. */
  repeatUntilOption: 'maxIterations',
  /** The default bound the SDK `repeatUntil({ maxIterations })` body inherits on consolidation. */
  defaultMaxIterations: DEFAULT_MAX_ITERATIONS,
  /** The ask-user escalation maps onto the SDK `awaitApproval(...)` combinator. */
  approvalCombinator: 'awaitApproval',
  /** The two cases in which `decideEscalation` escalates: the bound is reached, or a finding is intent-touching. */
  escalationTriggers: ['bound-reached', 'intent-touching'],
} as const;

/** A fully-resolved escalation policy for a single fix-loop. */
export interface EscalationPolicy {
  readonly maxIterations: number;
}

/**
 * Resolves an {@link EscalationPolicy} with the precedence `perLoopOverride > configMaxIterations > DEFAULT_MAX_ITERATIONS`.
 * A layer that does not hold a positive integer is skipped.
 * The last return is unreachable and keeps the function total.
 */
export function resolveEscalationPolicy(opts?: {
  readonly configMaxIterations?: number | undefined;
  readonly perLoopOverride?: number | undefined;
}): EscalationPolicy {
  const layers = [opts?.perLoopOverride, opts?.configMaxIterations, DEFAULT_MAX_ITERATIONS];
  for (const candidate of layers) {
    if (isPositiveInteger(candidate)) {
      return { maxIterations: candidate };
    }
  }
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
 * Decides whether a fix loop auto-fixes a finding or escalates it to the user.
 * An `intent-touching` finding escalates at once, at any iteration.
 * A `mechanical` finding escalates when `iteration >= maxIterations`.
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
 * Classifies a review finding into a {@link FindingClass}.
 * A finding is `intent-touching` when `intentTouching === true` or `category === 'spec'`. Each other finding is `mechanical`.
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
 * The iteration count of a loop: the number of `shepherd.iteration` events in a stream.
 * The `assess_stack` loop and the shepherd-status view count by this rule, so they agree.
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
