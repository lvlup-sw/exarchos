/**
 * The review verdict action. It classifies review findings into a routing verdict (`APPROVED`,
 * `NEEDS_FIXES`, or `BLOCKED`) and builds a markdown report.
 */

import type { ToolResult } from '../../format.js';
import type { PluginFinding } from '../../review/check-catalog.js';
import type { EventStore } from '../../events/store.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { emitGateEvent, sameOperationGateKey } from '../gates/gate-utils.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from '../gates/gate-runner.js';
import {
  resolveEscalationPolicy,
  decideEscalation,
  classifyFinding,
  type FindingClass,
} from './escalation-policy.js';

interface ReviewVerdictArgs {
  readonly featureId: string;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly blockedReason?: string;
  readonly dimensionResults?: Record<string, { passed: boolean; findingCount: number }>;
  /**
   * Findings from a plugin review pass. A finding with `category === 'spec'` or
   * `intentTouching === true` is intent-touching and escalates at once.
   */
  readonly pluginFindings?: readonly (PluginFinding & {
    readonly category?: string;
    readonly intentTouching?: boolean;
  })[];
  /**
   * The resolved project config. It supplies the auto-fix bound `escalation.maxIterations` for the
   * fix loop. The `adaptWithEventStoreAndConfig` dispatch adapter injects it, and an explicit value
   * in the args wins. With no value, the policy uses its default.
   */
  readonly projectConfig?: ResolvedProjectConfig;
  /**
   * A per-loop override of the auto-fix bound, with the highest precedence in
   * {@link resolveEscalationPolicy}. A value that is not valid falls through to the config and default layers.
   */
  readonly maxFixCycles?: number;
}

interface ReviewVerdictResult {
  readonly verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED';
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly blockedReason?: string;
  readonly report: string;
  /**
   * Set on `NEEDS_FIXES` when the loop must stop: the bound is hit, a finding is intent-touching, or
   * the fix-cycle count is not available. The fix loop must then ask the user and not dispatch
   * `/delegate --fixes` again. It is absent on `APPROVED`, `BLOCKED`, and an auto-fixable `NEEDS_FIXES`.
   */
  readonly escalate?: boolean;
  /** Human-readable reason for {@link escalate}, surfaced to the user. */
  readonly escalationReason?: string;
}

/**
 * Compute the review verdict from finding counts.
 * Priority: BLOCKED > NEEDS_FIXES > APPROVED.
 *
 * - BLOCKED: blockedReason is provided
 * - NEEDS_FIXES: high > 0
 * - APPROVED: no HIGH-severity findings
 */
export function computeVerdict(args: {
  high: number;
  medium: number;
  low: number;
  blockedReason?: string | undefined;
}): 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED' {
  if (args.blockedReason) {
    return 'BLOCKED';
  }
  if (args.high > 0) {
    return 'NEEDS_FIXES';
  }
  return 'APPROVED';
}

/**
 * The escalation outcome of a `NEEDS_FIXES` verdict: auto-fix once more, or escalate to the user.
 * It also carries the bound state for the report.
 */
interface FixLoopEscalation {
  /** `escalate` stops the loop and asks the user. `auto-fix` dispatches the fixes again. */
  readonly action: 'auto-fix' | 'escalate';
  readonly reason: string;
  /** Fix cycles already run (event-sourced) — the iteration the policy decided on. */
  readonly priorFixCount: number;
  /** The resolved auto-fix bound, surfaced as remaining budget in the report. */
  readonly maxIterations: number;
  /** The class that drove the decision (intent-touching escalates immediately). */
  readonly findingClass: FindingClass;
}

/**
 * Builds the markdown verdict report. On `NEEDS_FIXES` under the bound, the report routes to
 * `/delegate --fixes` and shows the remaining budget. When the escalation action is `escalate`, the
 * report asks the user and does not start another fix loop.
 */
export function generateVerdictReport(
  verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED',
  args: { high: number; medium: number; low: number; blockedReason?: string | undefined },
  escalation?: FixLoopEscalation,
): string {
  const lines: string[] = [];
  const total = args.high + args.medium + args.low;

  if (verdict === 'BLOCKED') {
    lines.push(
      '## Review Verdict: BLOCKED',
      '',
      `**Reason:** ${args.blockedReason ?? 'Unknown'}`,
      '',
      'Return to design phase. Route to `/ideate --redesign`.',
    );
  } else if (verdict === 'NEEDS_FIXES') {
    if (escalation?.action === 'escalate') {
      lines.push(
        '## Review Verdict: NEEDS_FIXES (escalating to user)',
        '',
        `Found ${args.high} HIGH-severity findings, but the fix-loop must escalate: ${escalation.reason}.`,
        '',
        'Do NOT re-dispatch `/delegate --fixes`. Surface these findings to the user',
        'and ask how to proceed (accept, redesign, or adjust scope).',
        '',
        `**Fix cycles run:** ${escalation.priorFixCount}/${escalation.maxIterations}`,
        '',
        `**Finding summary:** ${args.high} high, ${args.medium} medium, ${args.low} low (${total} total)`,
      );
    } else {
      const budgetSuffix = escalation
        ? ` (fix cycle ${escalation.priorFixCount + 1}/${escalation.maxIterations})`
        : '';
      lines.push(
        '## Review Verdict: NEEDS_FIXES',
        '',
        `Found ${args.high} HIGH-severity findings. Route to \`/delegate --fixes\`${budgetSuffix}.`,
        '',
        `**Finding summary:** ${args.high} high, ${args.medium} medium, ${args.low} low (${total} total)`,
      );
    }
  } else {
    lines.push(
      '## Review Verdict: APPROVED',
      '',
      'No HIGH-severity findings. Proceed to synthesis.',
      '',
      `**Finding summary:** ${args.high} high, ${args.medium} medium, ${args.low} low (${total} total)`,
    );
  }

  return lines.join('\n');
}

/**
 * Counts the fix cycles that a review already ran: the prior `review-verdict` gate events with the
 * verdict `NEEDS_FIXES`. Each `NEEDS_FIXES` pass records one such event, so no other counter exists.
 * It reads only `gateName` and `details.verdict`.
 */
function countPriorFixCycles(
  events: ReadonlyArray<{ readonly data?: unknown }>,
): number {
  let count = 0;
  for (const event of events) {
    const data = event.data as
      | { gateName?: unknown; details?: { verdict?: unknown } }
      | undefined;
    if (data?.gateName === 'review-verdict' && data.details?.verdict === 'NEEDS_FIXES') {
      count++;
    }
  }
  return count;
}

/**
 * Classifies a finding set with {@link classifyFinding}. The set is `intent-touching` when any finding
 * is intent-touching, whatever the number of mechanical findings. Otherwise it is `mechanical`, and the bound decides.
 */
function classifyFindings(
  findings: readonly { readonly category?: string; readonly intentTouching?: boolean }[]
    | undefined,
): FindingClass {
  if (findings?.some((f) => classifyFinding(f) === 'intent-touching')) {
    return 'intent-touching';
  }
  return 'mechanical';
}

/**
 * Validates the finding counts and runs the verdict through the shared phase-gate runner, which
 * records durable gate evidence.
 */
export async function handleReviewVerdict(
  args: ReviewVerdictArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }
  if (
    !Number.isFinite(args.high) || args.high < 0
    || !Number.isFinite(args.medium) || args.medium < 0
    || !Number.isFinite(args.low) || args.low < 0
  ) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'high, medium, and low must be non-negative finite numbers' },
    };
  }

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'review-verdict',
    requirementId: 'requirement:review-verdict',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) => createEvidenceSubject(
      { kind: 'phase-attempt', phaseAttemptId },
      {
        gate: 'review-verdict',
        high: args.high,
        medium: args.medium,
        low: args.low,
        blockedReason: args.blockedReason ?? null,
        dimensionResults: args.dimensionResults ?? null,
      },
    ),
    providerInput: args,
    executeProvider: async () => executeReviewVerdict(args, stateDir, eventStore),
  });
}

/**
 * Adds the plugin finding counts to the native counts and computes the verdict. On `NEEDS_FIXES`,
 * the escalation policy decides between one more auto-fix and an escalation to the user.
 * When the event store cannot give the prior fix-cycle count, the verdict escalates. A count of 0
 * on a failing store lets the loop auto-fix with no limit.
 *
 * It records the per-dimension events, a `review-verdict` summary event, and a failed
 * `review-escalation` event on an escalation. An append failure goes to the runner as a failure carrier.
 * The summary event has a same-operation key, so a retry does not add to the fix-cycle count.
 */
async function executeReviewVerdict(
  args: ReviewVerdictArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (
    !Number.isFinite(args.high) || args.high < 0
    || !Number.isFinite(args.medium) || args.medium < 0
    || !Number.isFinite(args.low) || args.low < 0
  ) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'high, medium, and low must be non-negative finite numbers' },
    };
  }

  let mergedHigh = args.high;
  let mergedMedium = args.medium;
  let mergedLow = args.low;

  if (args.pluginFindings?.length) {
    for (const finding of args.pluginFindings) {
      switch (finding.severity) {
        case 'HIGH': mergedHigh++; break;
        case 'MEDIUM': mergedMedium++; break;
        case 'LOW': mergedLow++; break;
      }
    }
  }

  const mergedCounts = { high: mergedHigh, medium: mergedMedium, low: mergedLow, blockedReason: args.blockedReason };
  const verdict = computeVerdict(mergedCounts);

  let escalation: FixLoopEscalation | undefined;
  if (verdict === 'NEEDS_FIXES') {
    const policy = resolveEscalationPolicy({
      configMaxIterations: args.projectConfig?.escalation?.maxIterations,
      perLoopOverride: args.maxFixCycles,
    });

    let priorFixCount = 0;
    let countUnavailable = false;
    try {
      const priorGateEvents = await eventStore.query(args.featureId, { type: 'gate.executed' });
      priorFixCount = countPriorFixCycles(priorGateEvents);
    } catch {
      countUnavailable = true;
      priorFixCount = policy.maxIterations;
    }

    const findingClass = classifyFindings(args.pluginFindings);
    const decision = countUnavailable
      ? {
          action: 'escalate' as const,
          reason:
            'Fix-cycle count unavailable (event-store query failed); escalating to '
            + 'preserve the bounded-loop guarantee.',
        }
      : decideEscalation({ findingClass, iteration: priorFixCount, policy });
    escalation = {
      action: decision.action,
      reason: decision.reason,
      priorFixCount,
      maxIterations: policy.maxIterations,
      findingClass,
    };
  }

  const report = generateVerdictReport(verdict, mergedCounts, escalation);

  const result: ReviewVerdictResult = {
    verdict,
    high: mergedHigh,
    medium: mergedMedium,
    low: mergedLow,
    ...(args.blockedReason ? { blockedReason: args.blockedReason } : {}),
    report,
    ...(escalation?.action === 'escalate'
      ? { escalate: true, escalationReason: escalation.reason }
      : {}),
  };

  if (args.dimensionResults) {
    for (const [key, entry] of Object.entries(args.dimensionResults)) {
      await emitGateEvent(
        eventStore,
        args.featureId,
        `review-${key}`,
        'review',
        entry.passed,
        {
          dimension: key,
          phase: 'review',
          findingCount: entry.findingCount,
        },
        sameOperationGateKey(`review-${key}`),
      );
    }
  }

  const pluginSources = args.pluginFindings?.length
    ? [...new Set(args.pluginFindings.map(f => f.source))]
    : undefined;

  await emitGateEvent(
    eventStore,
    args.featureId,
    'review-verdict',
    'review',
    verdict === 'APPROVED',
    {
      verdict,
      phase: 'review',
      high: mergedHigh,
      medium: mergedMedium,
      low: mergedLow,
      ...(pluginSources ? { pluginSources } : {}),
    },
    sameOperationGateKey('review-verdict'),
  );

  if (escalation?.action === 'escalate') {
    await emitGateEvent(
      eventStore,
      args.featureId,
      'review-escalation',
      'review',
      false,
      {
        phase: 'review',
        reason: escalation.reason,
        findingClass: escalation.findingClass,
        priorFixCount: escalation.priorFixCount,
        maxIterations: escalation.maxIterations,
      },
      sameOperationGateKey('review-escalation'),
    );
  }

  return { success: true, data: result };
}
