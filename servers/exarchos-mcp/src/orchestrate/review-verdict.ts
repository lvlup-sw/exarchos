// ─── Review Verdict Composite Action ─────────────────────────────────────────
//
// Pure TypeScript review verdict computation — classifies review findings
// into a routing verdict (APPROVED / NEEDS_FIXES / BLOCKED) and generates
// a markdown report. No bash script dependency.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { PluginFinding } from '../review/check-catalog.js';
import type { EventStore } from '../event-store/store.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { emitGateEvent } from './gate-utils.js';
import {
  resolveEscalationPolicy,
  decideEscalation,
  classifyFinding,
  type FindingClass,
} from './escalation-policy.js';

// ─── Argument & Result Types ────────────────────────────────────────────────

interface ReviewVerdictArgs {
  readonly featureId: string;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly blockedReason?: string;
  readonly dimensionResults?: Record<string, { passed: boolean; findingCount: number }>;
  /**
   * Findings from a plugin review pass. Optional `category`/`intentTouching`
   * fields (when supplied by the caller — e.g. spec-review issues carry a
   * `category: 'spec' | 'tdd' | 'coverage'`) drive the escalation
   * classification: a `category === 'spec'` (or `intentTouching === true`)
   * finding is intent-touching and escalates immediately (DR-3, #1595).
   */
  readonly pluginFindings?: readonly (PluginFinding & {
    readonly category?: string;
    readonly intentTouching?: boolean;
  })[];
  /**
   * Resolved project config — supplies the config-resolvable auto-fix bound
   * (`escalation.maxIterations`) for the spec-review fix-loop. Injected by the
   * `adaptWithEventStoreAndConfig` dispatch adapter; an explicit arg-level value
   * (e.g. from a test) wins. Absent ⇒ the policy falls through to its default.
   */
  readonly projectConfig?: ResolvedProjectConfig;
  /**
   * Per-loop override of the auto-fix bound (highest precedence in
   * {@link resolveEscalationPolicy}). Lets a single review invocation tighten or
   * loosen the bound without a config edit; a garbage value falls through to the
   * config/default layers.
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
   * Set on a `NEEDS_FIXES` verdict when the shared escalation policy says the
   * fix-loop must stop auto-fixing and ask the user — either the auto-fix bound
   * was hit OR a finding is intent-touching (DR-3). The spec-review fix-loop
   * MUST honor this instead of re-dispatching to `/delegate --fixes`. Absent on
   * APPROVED/BLOCKED and on a still-auto-fixable NEEDS_FIXES.
   */
  readonly escalate?: boolean;
  /** Human-readable reason for {@link escalate}, surfaced to the user. */
  readonly escalationReason?: string;
}

// ─── Verdict Logic ──────────────────────────────────────────────────────────

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
  blockedReason?: string;
}): 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED' {
  if (args.blockedReason) {
    return 'BLOCKED';
  }
  if (args.high > 0) {
    return 'NEEDS_FIXES';
  }
  return 'APPROVED';
}

// ─── Escalation Decision (DR-3) ─────────────────────────────────────────────

/**
 * The escalation outcome a NEEDS_FIXES verdict carries: whether the fix-loop
 * may auto-fix (re-dispatch to the implementer once more) or must escalate to
 * the user, plus the bound state the report surfaces. Resolved from the shared
 * escalation policy (DR-3, #1595).
 */
interface FixLoopEscalation {
  /** `escalate` ⇒ stop the loop and ask the user; `auto-fix` ⇒ re-dispatch. */
  readonly action: 'auto-fix' | 'escalate';
  readonly reason: string;
  /** Fix cycles already run (event-sourced) — the iteration the policy decided on. */
  readonly priorFixCount: number;
  /** The resolved auto-fix bound, surfaced as remaining budget in the report. */
  readonly maxIterations: number;
  /** The class that drove the decision (intent-touching escalates immediately). */
  readonly findingClass: FindingClass;
}

// ─── Report Generation ──────────────────────────────────────────────────────

/**
 * Generate a markdown verdict report matching the bash script's output format.
 *
 * On `NEEDS_FIXES`, an optional {@link FixLoopEscalation} shapes the routing
 * instruction (DR-3): while UNDER the bound and mechanical, the report routes to
 * `/delegate --fixes` and surfaces the remaining budget; when the bound is hit
 * OR a finding is intent-touching, the report becomes an ask-user escalation —
 * NOT another fix loop.
 */
export function generateVerdictReport(
  verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED',
  args: { high: number; medium: number; low: number; blockedReason?: string },
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
      // Bound hit OR intent-touching — escalate to the user, do NOT loop.
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
      // Under the bound with mechanical findings — re-dispatch as today, with budget.
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

// ─── Fix-cycle counting (event-sourced) ──────────────────────────────────────

/**
 * The SINGLE event-sourced source of how many fix cycles a spec review has
 * already run: the count of prior `review-verdict` `gate.executed` events whose
 * recorded verdict was `NEEDS_FIXES` (DR-3, #1595). Each NEEDS_FIXES pass emits
 * exactly one such event before re-dispatching, so this is the iteration the
 * escalation policy decides on — there is NO parallel counter. Pure over any
 * event array; only the `gateName` + `details.verdict` discriminants are read.
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
 * Classify a NEEDS_FIXES finding SET into a single {@link FindingClass} via the
 * shared {@link classifyFinding} feeder (DR-3). The set is `intent-touching`
 * (escalate immediately) if ANY finding is intent-touching — a spec-category or
 * explicitly-flagged finding must not be silently looped on, regardless of how
 * many mechanical findings accompany it. With no findings carrying a class
 * signal it defaults to `mechanical` (the bound, not immediate escalation,
 * governs).
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

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleReviewVerdict(
  args: ReviewVerdictArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Input validation
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

  // Merge plugin finding counts into native counts
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

  // Compute verdict in pure TypeScript using merged counts
  const mergedCounts = { high: mergedHigh, medium: mergedMedium, low: mergedLow, blockedReason: args.blockedReason };
  const verdict = computeVerdict(mergedCounts);

  // ── Bound the fix-loop via the shared escalation policy (DR-3, #1595) ──────
  //
  // Only NEEDS_FIXES routes back to the implementer; APPROVED/BLOCKED are
  // terminal here. For a NEEDS_FIXES verdict, resolve the auto-fix bound, read
  // the event-sourced prior fix-cycle count, classify the findings, and decide
  // whether the loop may auto-fix once more or must escalate to the user.
  // Fail-CLOSED: if the prior-cycle count can't be read we can't prove the loop
  // is within bounds, so we pin to maxIterations and force escalation rather
  // than reset to 0 (which would let a flaky store silently disable the bound).
  // No `workflowType` branch (INV-6).
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
      // Fail CLOSED: if the event-sourced cycle count can't be read we cannot
      // prove the loop is within bounds. Silently resetting to 0 would, on a
      // persistently failing store, let the loop auto-fix forever — disabling
      // the DR-3 bound. Pin the count to the bound and force escalation instead.
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

  // Emit per-dimension gate events (fire-and-forget)
  if (args.dimensionResults) {
    for (const [key, entry] of Object.entries(args.dimensionResults)) {
      try {
        const store = eventStore;
        await emitGateEvent(store, args.featureId, `review-${key}`, 'review', entry.passed, {
          dimension: key,
          phase: 'review',
          findingCount: entry.findingCount,
        });
      } catch { /* fire-and-forget */ }
    }
  }

  // Emit summary gate event (fire-and-forget)
  const pluginSources = args.pluginFindings?.length
    ? [...new Set(args.pluginFindings.map(f => f.source))]
    : undefined;

  try {
    const store = eventStore;
    await emitGateEvent(store, args.featureId, 'review-verdict', 'review', verdict === 'APPROVED', {
      verdict,
      phase: 'review',
      high: mergedHigh,
      medium: mergedMedium,
      low: mergedLow,
      ...(pluginSources ? { pluginSources } : {}),
    });
  } catch { /* fire-and-forget */ }

  // Emit a structured escalation gate event (DR-3) so the ask-user escalation is
  // event-sourced and surfaceable — distinct from the `review-verdict` summary
  // above (which `countPriorFixCycles` reads). Only on an actual escalate
  // decision; a still-auto-fixable NEEDS_FIXES emits no extra row. The gate is
  // recorded as FAILED (passed:false) — escalation means the bounded loop could
  // not converge unattended. Fire-and-forget like its siblings.
  if (escalation?.action === 'escalate') {
    try {
      const store = eventStore;
      await emitGateEvent(store, args.featureId, 'review-escalation', 'review', false, {
        phase: 'review',
        reason: escalation.reason,
        findingClass: escalation.findingClass,
        priorFixCount: escalation.priorFixCount,
        maxIterations: escalation.maxIterations,
      });
    } catch { /* fire-and-forget */ }
  }

  return { success: true, data: result };
}
