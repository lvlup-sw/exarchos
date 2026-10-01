import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import type { CheckpointEnforcementConfig } from '../checkpoint.js';
import { ErrorCode } from '../schemas.js';
import { getHSMDefinition, getValidTransitions } from '../state-machine.js';
import { readStateFile } from '../state-store.js';
import * as path from 'node:path';
import { handleSet } from './set.js';

export interface TransitionInput {
  readonly featureId: string;
  readonly target: string;
}

/**
 * The canonical phase-transition handler.
 * It returns the `handleSet` success shape. A guard failure returns the envelope of {@link buildGuardFailureError}.
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
     * The `workflow.maxPlanRevisions` cap from `.exarchos.yml`, for the `revisionsExhausted` guard.
     * It goes into the ephemeral `state._maxPlanRevisions` and is stripped before persistence. A config threshold is not a fact.
     */
    maxPlanRevisions?: number;
    /**
     * The `review.mutationEnforcement` mode from `.exarchos.yml`, with the mutation threshold below.
     * For the high tier only, both go into ephemeral fields for the `allReviewsPassed` score check. They are stripped before persistence.
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * The NoCoverage budget, the second axis of the `allReviewsPassed` guard.
     * For the high tier only, a non-negative integer budget goes into the ephemeral `_maxNoCoverage`. It is stripped before persistence.
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
 * Calls `handleSet` with `phase = target`, so the CAS and HSM-guard wiring stays in one code path.
 * Then it adds the structured envelope to a guard failure.
 */
async function applyTransition(
  input: { featureId: string; target: string },
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    requiredReviews?: readonly string[];
    checkpoint?: CheckpointEnforcementConfig;
    /** See {@link handleTransition}. */
    maxPlanRevisions?: number;
    /** See {@link handleTransition}. */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /** See {@link handleTransition}. */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  const result = await handleSet(
    { featureId: input.featureId, phase: input.target },
    stateDir,
    eventStore,
    options,
  );

  if (!result.success && result.error) {
    return enrichGuardFailureError(result, input.featureId, input.target, stateDir);
  }
  return result;
}

/**
 * Adds the structured envelope to `GUARD_FAILED`, `INVALID_TRANSITION`, `CIRCUIT_OPEN` and `PHASE_BLOCKED` failures.
 * Other failures pass unchanged. The current phase comes from the state file.
 * When that read fails, default values apply, and the envelope stays valid.
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
    return result;
  }

  let currentPhase = 'unknown';
  let workflowType = 'feature';
  try {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    currentPhase = state.phase;
    workflowType = state.workflowType as string;
  } catch {
  }

  return buildGuardFailureError(result, featureId, target, currentPhase, workflowType);
}

/**
 * Builds the pure guard-failure envelope: `validTargets`, `expectedShape` and `suggestedFix`.
 * It keeps the `validTargets` of the guard when present, and otherwise queries the HSM topology.
 * `suggestedFix` names the valid target nearest by Levenshtein distance. With an empty target, that is the shortest phase.
 *
 * `expectedShape` describes the `target` input, and keeps the state shape of the guard under `requiredState`.
 * The CLI and MCP envelopes are identical. `TRANSITION_GUARD_FAILURE_FIXTURE` in the parity harness asserts it.
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

  const existingValidTargets = result.error.validTargets;
  const validTargets = existingValidTargets && existingValidTargets.length > 0
    ? existingValidTargets
    : validTargetPhases;

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

/** The Levenshtein edit distance between two strings. */
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
