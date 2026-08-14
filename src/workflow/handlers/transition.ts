import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import type { CheckpointEnforcementConfig } from '../checkpoint.js';
import { ErrorCode } from '../schemas.js';
import { getHSMDefinition, getValidTransitions } from '../state-machine.js';
import { readStateFile } from '../state-store.js';
import * as path from 'node:path';
import { handleSet } from './set.js';

// ─── handleTransition ───────────────────────────────────────────────────────
//
// T36/T37/DR-4: `workflow.transition({target})` is the canonical phase-mutation
// action after the HSM API single-path consolidation. The deprecated
// `workflow.set({phase})` action delegates here through the shared
// `applyTransition()` helper so both handlers emit byte-equivalent
// `workflow.transition` events from the same code path — eliminating the
// "second phase-write surface" the v2.9 substrate carried.
//
// T42/DR-5: guard-failure responses are shaped through `buildGuardFailureError()`
// so the structured envelope (`validTargets`, `expectedShape`, `suggestedFix`)
// is identical regardless of whether the failure surfaced via the canonical
// or deprecated entry point.

export interface TransitionInput {
  readonly featureId: string;
  readonly target: string;
}

/**
 * Canonical phase-transition handler. Routes through the shared
 * `applyTransition()` helper which is also consumed by `handleSet({phase})`.
 *
 * Returns the same `ToolResult` shape as `handleSet({phase})`'s success
 * branch; on failure, returns the structured guard-failure envelope
 * (DR-5) populated via `buildGuardFailureError()`.
 */
export async function handleTransition(
  input: TransitionInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    requiredReviews?: readonly string[];
    checkpoint?: CheckpointEnforcementConfig;
    /**
     * DR-1: resolved `.exarchos.yml workflow.maxPlanRevisions` cap. Injected
     * into the reserved ephemeral `state._maxPlanRevisions` for the pure
     * `revisionsExhausted` guard, then stripped before persistence — never
     * event-sourced (INV-1: a config threshold is not a fact).
     */
    maxPlanRevisions?: number;
    /**
     * DR-3: resolved `.exarchos.yml review.mutationEnforcement` mode and the
     * resolved mutation threshold. Injected (HIGH tier only) into
     * `_mutationEnforcement` / `_mutationThreshold` for the pure `allReviewsPassed`
     * score check, then stripped before persistence — never event-sourced (INV-1).
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * DR-6: resolved NoCoverage budget for the pure `allReviewsPassed` guard's
     * SECOND, orthogonal axis. Injected (HIGH tier only) into `_maxNoCoverage`,
     * then stripped before persistence — never event-sourced (INV-1). Config
     * plumbing beside `_mutationThreshold`, not a facade fork: the pass-decision
     * lives in the guard, both facades reach it through this same injector.
     */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  return applyTransition(
    { featureId: input.featureId, target: input.target },
    stateDir,
    eventStore,
    options,
  );
}

/**
 * Shared private helper consumed by both `handleTransition` (canonical)
 * and `handleSet({phase})` (deprecated). The body delegates to `handleSet`
 * with `phase = target` so the existing CAS / HSM-guard wiring stays in a
 * single code path; on guard-failure outcomes the response is enriched
 * with the structured DR-5 envelope.
 *
 * Keeping this as a thin pass-through (rather than re-implementing the
 * CAS loop) honors INV-2 facade equivalence — the substrate-level guard
 * primitive is the canonical core, and both action surfaces route through
 * it. The DR-5 enrichment lives here so it cannot be bypassed by callers
 * that reach for `handleSet` directly.
 */
async function applyTransition(
  input: { featureId: string; target: string },
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    requiredReviews?: readonly string[];
    checkpoint?: CheckpointEnforcementConfig;
    /**
     * DR-1: resolved `.exarchos.yml workflow.maxPlanRevisions` cap. Injected
     * into the reserved ephemeral `state._maxPlanRevisions` for the pure
     * `revisionsExhausted` guard, then stripped before persistence — never
     * event-sourced (INV-1: a config threshold is not a fact).
     */
    maxPlanRevisions?: number;
    /**
     * DR-3: resolved `.exarchos.yml review.mutationEnforcement` mode and the
     * resolved mutation threshold. Injected (HIGH tier only) into
     * `_mutationEnforcement` / `_mutationThreshold` for the pure `allReviewsPassed`
     * score check, then stripped before persistence — never event-sourced (INV-1).
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * DR-6: resolved NoCoverage budget for the pure `allReviewsPassed` guard's
     * SECOND, orthogonal axis. Injected (HIGH tier only) into `_maxNoCoverage`,
     * then stripped before persistence — never event-sourced (INV-1). Config
     * plumbing beside `_mutationThreshold`, not a facade fork: the pass-decision
     * lives in the guard, both facades reach it through this same injector.
     */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  const result = await handleSet(
    { featureId: input.featureId, phase: input.target },
    stateDir,
    eventStore,
    options,
  );

  // Enrich guard-failure responses with the structured DR-5 envelope.
  if (!result.success && result.error) {
    return enrichGuardFailureError(result, input.featureId, input.target, stateDir);
  }
  return result;
}

/**
 * Augment a guard-failure ToolResult with the DR-5 structured envelope:
 * `validTargets[]` enumerated from the HSM topology, `expectedShape`
 * describing the action's `target` field, and a `suggestedFix` referencing
 * the closest valid transition (Levenshtein-nearest among the declared
 * targets). The closest-target heuristic gives operators a one-step
 * correction path; falls back to the first valid target when the input
 * is empty or no targets exist.
 */
async function enrichGuardFailureError(
  result: ToolResult,
  featureId: string,
  target: string,
  stateDir: string,
): Promise<ToolResult> {
  if (result.success || !result.error) return result;
  const code = result.error.code;
  if (
    code !== ErrorCode.GUARD_FAILED &&
    code !== ErrorCode.INVALID_TRANSITION &&
    code !== ErrorCode.CIRCUIT_OPEN &&
    code !== ErrorCode.PHASE_BLOCKED
  ) {
    // Non-guard failures (STATE_NOT_FOUND, EVENT_APPEND_FAILED, etc.)
    // pass through unchanged. PHASE_BLOCKED is a transition-boundary fault, so
    // it gets the same validTargets enrichment as the other guard failures.
    return result;
  }

  // Read the current phase from the state file so `validTargets` is computed
  // against the actual `from` phase. Best-effort: a missing state file is
  // already a separate error path (STATE_NOT_FOUND) and would have been
  // caught upstream.
  let currentPhase = 'unknown';
  let workflowType = 'feature';
  try {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    currentPhase = state.phase;
    workflowType = state.workflowType as string;
  } catch {
    // Fall through with defaults; the structured envelope still carries
    // the (possibly empty) validTargets list and a generic suggestedFix.
  }

  return buildGuardFailureError(result, featureId, target, currentPhase, workflowType);
}

/**
 * Build the DR-5 structured guard-failure envelope. Pure function: given a
 * failed ToolResult and the topology-relative context, return a result with
 * `validTargets[]`, `expectedShape`, and `suggestedFix` populated. Existing
 * `validTargets` (from HSMTransitionGuard) is preserved when present; the
 * `suggestedFix` heuristic prefers the Levenshtein-closest valid target.
 *
 * Identical envelope shape across CLI and MCP carriers (T42 / DR-5): the
 * `parity-harness.TRANSITION_GUARD_FAILURE_FIXTURE` test asserts byte
 * equivalence so any drift in the failure-path serialization is caught at
 * compile-time review rather than at runtime in client code.
 */
function buildGuardFailureError(
  result: ToolResult,
  featureId: string,
  target: string,
  currentPhase: string,
  workflowType: string,
): ToolResult {
  if (result.success || !result.error) return result;

  let validTargetPhases: string[] = [];
  try {
    const hsm = getHSMDefinition(workflowType);
    const targets = getValidTransitions(hsm, currentPhase);
    validTargetPhases = targets.map((t) => t.phase);
  } catch {
    validTargetPhases = [];
  }

  // Prefer the validTargets the guard primitive already surfaced; otherwise
  // fall back to the topology query above.
  const existingValidTargets = result.error.validTargets;
  const validTargets = existingValidTargets && existingValidTargets.length > 0
    ? existingValidTargets
    : validTargetPhases;

  // Closest-by-Levenshtein heuristic. With an empty target string, the
  // first valid target "wins" (string-distance from empty is the length
  // of the candidate, so any non-empty list returns the shortest).
  const candidatePhases = validTargets.map((t) =>
    typeof t === 'string' ? t : t.phase,
  );
  const closest = candidatePhases.length > 0
    ? candidatePhases.reduce((best, candidate) =>
        levenshtein(candidate, target) < levenshtein(best, target)
          ? candidate
          : best,
      )
    : undefined;

  const suggestedFix = closest
    ? {
        tool: 'exarchos_workflow',
        params: {
          action: 'transition',
          featureId,
          target: closest,
        },
      }
    : undefined;

  // DR-5 surfaces a target-shape `expectedShape` describing the action's
  // input (`target`), not the guarded-state shape the HSM primitive may
  // already have populated. Both are valuable: the state-shape tells the
  // caller what's missing, the input-shape tells them how to reformulate
  // the call. Keep the inner state-shape (when present) under
  // `requiredState` so neither signal is lost.
  const targetExpectedShape: Record<string, unknown> = {
    target: candidatePhases.length > 0
      ? candidatePhases.join(' | ')
      : '<valid HSM phase>',
  };
  if (result.error.expectedShape && Object.keys(result.error.expectedShape).length > 0) {
    targetExpectedShape.requiredState = result.error.expectedShape;
  }

  return {
    ...result,
    error: {
      ...result.error,
      validTargets,
      expectedShape: targetExpectedShape,
      ...(suggestedFix ? { suggestedFix } : {}),
    },
  };
}

/** Levenshtein edit distance — shared closest-valid-target heuristic. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
