/**
 * The cutover promotion verbs on `exarchos_orchestrate`.
 *
 * `cutover_readiness` is read-only. It assembles the evidence from the local store and the live
 * sink, and returns the full `CutoverGateReport` with each unmet condition.
 * `cutover_decide` needs an operator identity with a mutating posture. It always appends
 * `admission.rollout-decision`, and appends `admission.enforcement-enabled` only when the gate
 * is satisfied. Both facts go to the `exarchos-admission` infrastructure stream, because they
 * describe the cutover posture of the store, not one workflow.
 *
 * The response schemas are in `cutover-readiness-schema.ts`, so that the registry can import
 * them without this module.
 */

import { createHash } from 'node:crypto';
import { ZodError } from 'zod';

import { ADMISSION_STREAM_ID } from '../../dispatch/core/infra-streams.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import type { DurableEvidenceSummary } from './cutover-readiness-schema.js';
import {
  CutoverGateNotSatisfiedError,
  decideRollout,
  toEnforcementEnabledData,
  toRolloutDecisionData,
  type CutoverGateReport,
  type CutoverPolicyRef,
  type LiveShadowAttempt,
} from '../../workflow/admission/cutover-gate.js';
import {
  assessDurableCutoverReadiness,
  contentDigestOf,
  type DurableShadowEvidence,
} from '../../workflow/admission/evidence-reader.js';
import {
  TRANSLATION_POLICY_ID,
  TRANSLATION_PROVIDER_VERSION,
} from '../../workflow/admission/legacy-state-translation.js';
import {
  liveShadowHealth,
  liveShadowSink,
  type LiveShadowHealth,
} from '../../workflow/admission/live-shadow-observer.js';
import type { ShadowProvenance } from '../../workflow/admission/shadow-decision.js';
import {
  ADMISSION_EVENT_TYPES,
  AttributedPrincipalV1Schema,
  AuthorizationSnapshotV1Schema,
  OperationIdSchema,
  PolicyIdSchema,
} from '../../workflow/admission/types.js';

/**
 * Test seam for the process-level live inputs. The composite adapter passes three positional
 * arguments, so production uses the real sink and health counter.
 */
export interface CutoverVerbDeps {
  readonly liveAttempts?: () => readonly LiveShadowAttempt[];
  readonly observerHealth?: () => LiveShadowHealth;
}

function liveInputs(deps?: CutoverVerbDeps): {
  liveAttempts: readonly LiveShadowAttempt[];
  observerHealth: LiveShadowHealth;
} {
  return {
    liveAttempts: (deps?.liveAttempts ?? (() => liveShadowSink.liveAttempts()))(),
    observerHealth: (deps?.observerHealth ?? (() => liveShadowHealth.snapshot()))(),
  };
}

/**
 * Projects the durable fold onto the summary that both verbs return. The return type is
 * inferred from `DurableEvidenceSummarySchema`, so a schema change is a compile error here.
 */
function durableSummary(durable: DurableShadowEvidence): DurableEvidenceSummary {
  return {
    featureIds: [...durable.featureIds],
    attemptCount: durable.attempts.length,
    dispositionTally: { ...durable.dispositionTally },
  };
}

/** Assembles the evidence and returns the full gate report. It appends and writes nothing. */
export async function handleCutoverReadiness(
  _args: Record<string, unknown>,
  _stateDir: string,
  eventStore: EventStore,
  deps?: CutoverVerbDeps,
): Promise<ToolResult> {
  try {
    const { report, durable } = await assessDurableCutoverReadiness(
      eventStore,
      liveInputs(deps),
    );
    return {
      success: true,
      data: {
        report,
        durableEvidence: durableSummary(durable),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'ASSESSMENT_FAILED',
        message: error instanceof Error ? error.message : String(error),
        action: 'cutover_readiness',
      },
    };
  }
}

const CUTOVER_POLICY: CutoverPolicyRef = Object.freeze({
  policyId: PolicyIdSchema.parse(TRANSLATION_POLICY_ID),
  policyVersion: TRANSLATION_PROVIDER_VERSION,
  policyDigest: contentDigestOf(
    `${TRANSLATION_POLICY_ID}@${TRANSLATION_PROVIDER_VERSION}`,
  ),
  /** A placeholder. `handleCutoverDecide` replaces it with the evidence digest on each call. */
  inputDigest: contentDigestOf('cutover-decide:unbound'),
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Records the rollout decision, then the enablement when the gate is satisfied.
 * The operator check reads the ambient dispatch authorization, whose role the transport sets.
 * It fails closed: a call with no dispatch context has no operator.
 *
 * The ids and idempotency keys derive only from the operation id and the evidence digest.
 * Thus a retry collapses onto the stored rows. The gate module throws for an unsatisfied gate.
 * That refusal returns `CUTOVER_GATE_NOT_SATISFIED`, and the recorded rollout decision stands.
 */
export async function handleCutoverDecide(
  _args: Record<string, unknown>,
  _stateDir: string,
  eventStore: EventStore,
  deps?: CutoverVerbDeps,
): Promise<ToolResult> {
  const dispatchContext = getDispatchContext();
  const authorization = dispatchContext?.authorization;
  const hasOperatorCapability =
    dispatchContext !== undefined &&
    authorization !== undefined &&
    authorization.identity.role === 'operator' &&
    authorization.posture !== 'read-only';
  if (
    dispatchContext === undefined ||
    authorization === undefined ||
    !hasOperatorCapability
  ) {
    return {
      success: false,
      error: {
        code: 'CAPABILITY_DENIED',
        message:
          'cutover_decide requires an operator identity with a mutating ' +
          'posture; a delegated agent cannot approve enforcement.',
        action: 'cutover_decide',
      },
    };
  }

  try {
    const { report, durable } = await assessDurableCutoverReadiness(
      eventStore,
      liveInputs(deps),
    );

    const shadowEvidenceDigest = contentDigestOf(JSON.stringify(report));
    const decisionIdentity = sha256Hex(
      `${dispatchContext.operationId}:${shadowEvidenceDigest.value}`,
    );
    const rolloutDecisionId = `rollout-decision:${decisionIdentity}`;
    const enablementId = `enforcement-enabled:${decisionIdentity}`;
    const operationId = OperationIdSchema.parse(dispatchContext.operationId);
    const decidedAt = authorization.resolvedAt;
    const policy: CutoverPolicyRef = {
      ...CUTOVER_POLICY,
      inputDigest: shadowEvidenceDigest,
    };
    const capabilityIds =
      authorization.capabilities.length > 0
        ? authorization.capabilities.map((capability) => String(capability))
        : ['admission:cutover-decide'];
    const provenance: ShadowProvenance = {
      caller: AttributedPrincipalV1Schema.parse({
        principalKind: 'operator',
        principalId: authorization.identity.subjectId,
        role: authorization.identity.role,
      }),
      authorization: AuthorizationSnapshotV1Schema.parse({
        authorizationId: `${authorization.policy.id}:${dispatchContext.operationId}`,
        posture: authorization.posture,
        capabilityIds,
        resolverVersion: authorization.resolver.version,
        resolvedAt: authorization.resolvedAt,
      }),
    };

    const rolloutData = toRolloutDecisionData({
      report,
      rolloutDecisionId,
      operationId,
      policy,
      evidenceIds: [],
      shadowEvidenceDigest,
      decidedAt,
      provenance,
    });
    await eventStore.append(
      ADMISSION_STREAM_ID,
      {
        type: ADMISSION_EVENT_TYPES.ROLLOUT_DECISION,
        timestamp: decidedAt,
        source: 'cutover-decide',
        data: { ...rolloutData },
      },
      { idempotencyKey: rolloutDecisionId },
    );

    let enablementData: ReturnType<typeof toEnforcementEnabledData>;
    try {
      enablementData = toEnforcementEnabledData({
        report,
        enablementId,
        operationId,
        rolloutDecisionId,
        policy,
        enabledAt: decidedAt,
        provenance,
      });
    } catch (error) {
      if (error instanceof CutoverGateNotSatisfiedError) {
        return {
          success: false,
          data: {
            outcome: decideRollout(report),
            rolloutDecisionId,
            report,
            durableEvidence: durableSummary(durable),
          },
          error: {
            code: 'CUTOVER_GATE_NOT_SATISFIED',
            message: error.message,
            unmetGates: error.unmet,
            action: 'cutover_decide',
          },
        };
      }
      throw error;
    }
    await eventStore.append(
      ADMISSION_STREAM_ID,
      {
        type: ADMISSION_EVENT_TYPES.ENFORCEMENT_ENABLED,
        timestamp: decidedAt,
        source: 'cutover-decide',
        data: { ...enablementData },
      },
      { idempotencyKey: enablementId },
    );

    return {
      success: true,
      data: {
        outcome: decideRollout(report),
        rolloutDecisionId,
        enablementId,
        report,
        durableEvidence: durableSummary(durable),
      },
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
          action: 'cutover_decide',
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'APPEND_FAILED',
        message: error instanceof Error ? error.message : String(error),
        action: 'cutover_decide',
      },
    };
  }
}

export type { CutoverGateReport };
