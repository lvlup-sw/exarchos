// ─── ActionId admission, as a leaf both callers can import ──────────────────
//
// The admission evaluator is a pure function of its arguments, and it has two
// callers: the dispatch path, which admits the one action a request names, and
// the bounded action executor, which admits each compiled leaf in execution
// order. Leaving it inside the dispatch module made the executor import that
// module for a value, and the composite that routes to the executor is itself
// reached from dispatch — three modules holding each other up at runtime.
//
// Extracting the evaluator and the helpers only it uses breaks that ring
// without duplicating a second policy: one evaluator still serves both call
// sites. `DispatchContext` is imported for its TYPE alone, which the compiler
// erases, so no runtime edge points back at the dispatch module.

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { AdmissionEvidenceRecordedData } from '../../events/schemas.js';
import { workflowStateProjection } from '../../projections/views/workflow-state-projection.js';
import {
  isBlockingHostObligation,
  normalizeActionContract,
  type ActionContract,
  type ActionRequirement,
} from '../../registry/action-contract.js';
import { evaluateActionAdmission } from '../../workflow/admission/action-admission.js';
import { POLICY_CAPABILITY } from '../../workflow/admission/policy-authority.js';
import { ADMISSION_EVENT_TYPES } from '../../workflow/admission/types.js';
import { capabilityNeedSatisfied } from '../../workflow/capabilities/resolver.js';
import type { CallerAuthorizationSnapshot } from '../caller-identity.js';
import type { DispatchContext } from './dispatch.js';

function registryActionId(tool: string, actionName: string): string {
  return `${tool}.${actionName}`;
}

function workflowSubjectFromArgs(
  args: Record<string, unknown>,
): { readonly featureId: string; readonly stream: string } | undefined {
  const featureId =
    typeof args.featureId === 'string' && args.featureId.length > 0
      ? args.featureId
      : undefined;
  const namedStream =
    typeof args.stream === 'string' && args.stream.length > 0
      ? args.stream
      : typeof args.streamId === 'string' && args.streamId.length > 0
        ? args.streamId
        : undefined;
  const stream = namedStream ?? featureId;
  if (featureId === undefined || stream === undefined) return undefined;
  return { featureId, stream };
}

const POLICY_CAPABILITY_IDS = new Set<string>(Object.values(POLICY_CAPABILITY));

/**
 * Admission capabilities come from the trusted caller snapshot — the same
 * grant `snapshotCallerAuthorization` already computed, including the
 * local-operator baseline. Resolver `list()` is handshake / cache-hint
 * surface, not the ActionId need set; mixing the two denied every CLI
 * doctor/merge call whose resolver only advertised `anthropic_native_caching`.
 * Policy issuer tokens are not Capability-enum members, so a local operator
 * receives them here, and an MCP resolver may add them explicitly.
 */
function admissionCapabilityIds(
  snapshot: CallerAuthorizationSnapshot | undefined,
  resolver: DispatchContext['capabilityResolver'],
): readonly string[] {
  const held = new Set<string>();
  if (snapshot !== undefined) {
    for (const capability of snapshot.capabilities) held.add(capability);
    if (
      snapshot.identity.kind === 'local-operator' ||
      snapshot.posture === 'shared-mutating'
    ) {
      held.add(POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE);
      held.add(POLICY_CAPABILITY.ISSUE_APPROVAL);
      held.add(POLICY_CAPABILITY.GRANT_WAIVER);
    }
  }
  if (resolver !== undefined) {
    for (const capability of resolver.list()) {
      if (POLICY_CAPABILITY_IDS.has(capability)) held.add(capability);
    }
  }
  return [...held];
}

function admissionAuthorizationFromCaller(
  snapshot: CallerAuthorizationSnapshot | undefined,
  resolver: DispatchContext['capabilityResolver'],
): {
  readonly authorizationId: string;
  readonly posture: 'read-only' | 'task-isolated' | 'shared-mutating';
  readonly capabilityIds: readonly string[];
  readonly resolverVersion: string;
  readonly resolvedAt: string;
} {
  return {
    authorizationId: snapshot?.identity.subjectId ?? 'anonymous',
    posture: snapshot?.posture ?? 'read-only',
    capabilityIds: admissionCapabilityIds(snapshot, resolver),
    resolverVersion: snapshot?.resolver.version ?? 'none',
    resolvedAt: snapshot?.resolvedAt ?? '1970-01-01T00:00:00.000Z',
  };
}

function contractNeedsSatisfied(
  contract: ActionContract,
  capabilityIds: readonly string[],
): boolean {
  if (contract.needs.kind === 'none') return true;
  const held = new Set(capabilityIds);
  return contract.needs.values.every((capability) =>
    capabilityNeedSatisfied(held, capability),
  );
}

/**
 * Every declared requirement is an approval.
 *
 * A reasoned `none` is NOT "only approvals" — it is no requirement at all, and
 * answering true for it made an empty set satisfy a predicate about the set's
 * members. That vacuity is what routed `agent_spec` and `prepare_review` into
 * the obligation short-circuit and stopped their handlers from ever running.
 */
function requiresOnlyApprovals(requires: ActionContract['requires']): boolean {
  if (requires.kind === 'none') return false;
  return requires.values.every(
    (requirement: ActionRequirement) =>
      'kind' in requirement && requirement.kind === 'approvals',
  );
}

async function readTrustedHsmFacts(
  eventStore: EventStore,
  featureId: string,
): Promise<{ readonly phase: string; readonly phaseAttemptId?: string } | undefined> {
  try {
    const events = await eventStore.query(featureId);
    let view = workflowStateProjection.init();
    for (const event of events) {
      view = workflowStateProjection.apply(view, event);
    }
    if (typeof view.featureId !== 'string' || view.featureId.length === 0) {
      return undefined;
    }
    if (typeof view.phase !== 'string' || view.phase.length === 0) return undefined;
    const phaseAttemptId =
      typeof view.phaseAttemptId === 'string' && view.phaseAttemptId.length > 0
        ? view.phaseAttemptId
        : undefined;
    return phaseAttemptId === undefined
      ? { phase: view.phase }
      : { phase: view.phase, phaseAttemptId };
  } catch {
    return undefined;
  }
}

async function readTrustedAdmissionEvidence(
  eventStore: EventStore,
  streamId: string,
): Promise<readonly unknown[] | undefined> {
  try {
    const rows = await eventStore.query(streamId, {
      type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
    });
    const evidence: unknown[] = [];
    for (const row of rows) {
      const parsed = AdmissionEvidenceRecordedData.safeParse(row.data);
      if (!parsed.success) continue;
      evidence.push(parsed.data.evidence);
    }
    return evidence;
  } catch {
    return undefined;
  }
}

/**
 * Read an action's declared contract, or `undefined` when it carries none or
 * carries one that does not normalize. Exported because the dispatch path
 * reads the same declaration for its read-only abstention and ensures checks.
 */
export function readActionContract(action: object): ActionContract | undefined {
  if (!('actionContract' in action)) return undefined;
  try {
    return normalizeActionContract(Reflect.get(action, 'actionContract'));
  } catch {
    return undefined;
  }
}

function hostObligationOf(contract: ActionContract | undefined): string | undefined {
  const authority = contract?.executionAuthority;
  if (authority === undefined || authority.kind !== 'host') return undefined;
  return authority.obligation;
}

function admissionDeniedResult(
  tool: string,
  actionName: string,
  digestValue: string,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'ADMISSION_DENIED',
      message: `Action "${actionName}" on tool "${tool}" is not admitted against the current trusted workflow subject.`,
      tool,
      action: actionName,
      expectedShape: { digest: { algorithm: 'sha256', value: digestValue } },
    },
  };
}

function trustedCallerRequiredResult(tool: string, actionName: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'TRUSTED_CALLER_REQUIRED',
      message: `Action "${actionName}" requires trusted dispatch caller identity.`,
      tool,
      action: actionName,
    },
  };
}

function hostOwnedObligationResult(obligation: string): ToolResult {
  return {
    success: true,
    data: { obligation },
  };
}

/**
 * Re-evaluate registry ActionId admission against store-trusted state before
 * the handler or any dispatch effect runs. The snapshot is the same
 * workflow-scoped subject used to advertise: ActionId, feature/stream,
 * persisted evidence, authorization, and HSM facts. Request payload (including
 * a transition target) and a fresh wall-clock are not snapshot members.
 *
 * Missing or invalid contracts deny. Capability failure denies. Declared
 * requires without a store-backed subject or HSM fold deny — they never
 * skip and they never invent a fake unscoped snapshot. Actions that
 * abstain from requires are admitted from needs alone. Host-owned
 * actions whose only requires are approvals return the obligation after
 * needs pass: the approval is the host's job, not a prior local fact.
 * Transition remains one ActionId; its request target is still decided
 * by the HSM transition guard after this gate.
 *
 * Exported because the bounded action executor admits each compiled leaf in
 * execution order and must reach the same verdict the dispatch path does. It is
 * a pure function of its arguments, so one evaluator serving two call sites is
 * the whole of the sharing — there is no second policy to keep in step.
 */
export async function evaluateDispatchAdmission(input: {
  readonly tool: string;
  readonly actionName: string;
  readonly action: object;
  readonly args: Record<string, unknown>;
  readonly ctx: DispatchContext;
  readonly authorization: CallerAuthorizationSnapshot | undefined;
}): Promise<ToolResult | null> {
  const contract = readActionContract(input.action);
  const actionId = registryActionId(input.tool, input.actionName);
  if (contract === undefined) {
    return admissionDeniedResult(input.tool, input.actionName, 'missing-or-invalid-contract');
  }

  const authorization = admissionAuthorizationFromCaller(
    input.authorization,
    input.ctx.capabilityResolver,
  );
  if (!contractNeedsSatisfied(contract, authorization.capabilityIds)) {
    if (input.authorization === undefined) {
      return trustedCallerRequiredResult(input.tool, input.actionName);
    }
    return admissionDeniedResult(input.tool, input.actionName, 'missing-capabilities');
  }

  // A host obligation short-circuits only when the host must discharge it
  // BEFORE the handler could do anything — an approval, an interactive login,
  // a host-UI prompt. `agent-spawn` is discharged USING the handler's output,
  // so those actions run and return it.
  const obligation = hostObligationOf(contract);
  if (
    obligation !== undefined &&
    (isBlockingHostObligation(obligation) || requiresOnlyApprovals(contract.requires))
  ) {
    return hostOwnedObligationResult(obligation);
  }
  if (contract.requires.kind === 'none') return null;

  const subject = workflowSubjectFromArgs(input.args);
  const hsmFacts =
    subject === undefined
      ? undefined
      : await readTrustedHsmFacts(input.ctx.eventStore, subject.featureId);
  if (subject === undefined || hsmFacts === undefined) {
    return admissionDeniedResult(input.tool, input.actionName, 'missing-trusted-inputs');
  }

  const evidence = await readTrustedAdmissionEvidence(input.ctx.eventStore, subject.stream);
  if (evidence === undefined) {
    return admissionDeniedResult(input.tool, input.actionName, 'missing-trusted-inputs');
  }
  const decision = evaluateActionAdmission(
    actionId,
    {
      actionId,
      subject,
      evidence,
      authorization,
      hsmFacts,
    },
    contract,
  );
  if (decision.verdict !== 'allow') {
    return admissionDeniedResult(input.tool, input.actionName, decision.digest.value);
  }
  return obligation === undefined ? null : hostOwnedObligationResult(obligation);
}
