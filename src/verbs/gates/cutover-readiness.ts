// ─── #1739 — the cutover promotion verbs ─────────────────────────────────────
//
// Two actions on `exarchos_orchestrate` (INV-5d — no new visible tool):
//
//   `cutover_readiness` — READ-ONLY. Assembles the six-condition evidence from
//   ONE local store (durable sidecar fold via `evidence-reader.ts` + the
//   process-level live sink/health) and returns the full `CutoverGateReport`
//   with every unmet condition named. No side effects: no append, no write.
//
//   `cutover_decide` — OPERATOR-GATED (the T-03 pattern: the ambient
//   DispatchContext authorization must carry `role: 'operator'` with a
//   non-read-only posture; a delegated agent can never clear this bar no
//   matter what it passes). Event-sources the rollout decision:
//   `admission.rollout-decision` is ALWAYS appended (its outcome is a function
//   of the evidence via `decideRollout`), and `admission.enforcement-enabled`
//   is appended ONLY when the gate is satisfied — the gate module refuses to
//   build the fact otherwise, and that refusal surfaces here in a typed
//   `CUTOVER_GATE_NOT_SATISFIED` error naming the unmet conditions.
//
// Both facts land on the reserved `exarchos-admission` infrastructure stream:
// they describe the STORE's cutover posture, not one feature workflow. Both
// idempotency keys are natural identities (INV-8 / T-49): pure functions of
// the operation + evidence digest, never clock- or random-derived, so a
// retried append collapses onto the stored row.

import { createHash } from 'node:crypto';
import { ZodError } from 'zod';

import { ADMISSION_STREAM_ID } from '../../dispatch/core/infra-streams.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
// The two verbs' response contracts, paid down from `vacuityWaiver` to real
// `data` schemas. Held in their own module so the registry can import them
// without this file's closure (event store, dispatch context, admission
// provenance parsers) coming along.
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

// ─── Shared assembly ──────────────────────────────────────────────────────────

/**
 * Test seam for the process-level live inputs. Production dispatches never
 * pass it — the composite adapter calls the handlers with three positional
 * args, so the defaults (the real sink + health counter) always apply there.
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
 * Project the durable fold onto the summary both verbs advertise.
 *
 * The return type is the CONTRACT's inferred shape, not `Record<string,
 * unknown>`: that is what binds this construction site to
 * `DurableEvidenceSummarySchema`, so widening or renaming a field there is a
 * compile error here rather than a response the D.5 validator rejects at run
 * time.
 */
function durableSummary(durable: DurableShadowEvidence): DurableEvidenceSummary {
  return {
    featureIds: [...durable.featureIds],
    attemptCount: durable.attempts.length,
    dispositionTally: { ...durable.dispositionTally },
  };
}

// ─── cutover_readiness (read-only) ────────────────────────────────────────────

/**
 * Assemble the evidence and return the full gate report. Read-only: queries
 * the store, appends nothing, writes nothing.
 */
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

// ─── cutover_decide (operator-gated, event-sourced) ───────────────────────────

const CUTOVER_POLICY: CutoverPolicyRef = Object.freeze({
  policyId: PolicyIdSchema.parse(TRANSLATION_POLICY_ID),
  policyVersion: TRANSLATION_PROVIDER_VERSION,
  policyDigest: contentDigestOf(
    `${TRANSLATION_POLICY_ID}@${TRANSLATION_PROVIDER_VERSION}`,
  ),
  // Refined per call with the actual evidence digest — see below.
  inputDigest: contentDigestOf('cutover-decide:unbound'),
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function handleCutoverDecide(
  _args: Record<string, unknown>,
  _stateDir: string,
  eventStore: EventStore,
  deps?: CutoverVerbDeps,
): Promise<ToolResult> {
  // T-03 operator capability: taken from the SAME trust-tier mechanism that
  // produces CAPABILITY_DENIED for shared-mutating actions — the ambient
  // DispatchContext authorization, whose `identity.role` is derived by the
  // transport and can never be self-asserted. Fails closed: no dispatch
  // context (direct in-process call) ⇒ no operator.
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

    // Natural identities (INV-8 / T-49): pure functions of the deciding
    // operation and the evidence it weighed — nothing random, nothing
    // wall-clock. A same-dispatch retry recomputes the same ids/keys and its
    // appends collapse onto the stored rows.
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

    // The rollout decision is ALWAYS recorded — a `continue-shadow` verdict is
    // a governance fact no less than an approval.
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

    // The enablement fact is built by the gate module, which THROWS for an
    // unsatisfied gate — the structural guarantee that enforcement cannot be
    // event-sourced past an unmet condition. That refusal becomes the
    // typed error below, WITH the already-recorded rollout decision attached
    // (the `continue-shadow` fact stands; only the enablement is refused).
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

/** The report type, re-exported for callers of the verbs' typed results. */
export type { CutoverGateReport };
