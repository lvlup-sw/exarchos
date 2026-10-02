/**
 * ActionId admission as a leaf module. Two callers share one evaluator: the dispatch path admits
 * the action that a request names, and the bounded action executor admits each compiled leaf.
 * A separate module breaks the runtime import cycle between dispatch, the executor and the composite
 * that routes to it. The import of `DispatchContext` is type-only, so the compiler erases it.
 */

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
 * The admission capabilities come from the trusted caller snapshot. A local operator or a
 * `shared-mutating` caller also gets the policy issuer tokens, which are not Capability enum members.
 * From the resolver `list()`, only policy issuer tokens count. The rest of that list is handshake and
 * cache-hint data, not the ActionId need set.
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
 * True when every declared requirement is an approval. A reasoned `none` returns false, because an
 * empty set must not satisfy a predicate about its members. A true result for `none` sends an
 * action to the obligation short-circuit, so its handler never runs.
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
 * Reads an action's declared contract, or `undefined` when it has none or the contract does not
 * normalize. The dispatch path also uses it for its read-only abstention and ensures checks.
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
 * Evaluates ActionId admission against store-trusted state before the handler or a dispatch effect runs.
 * The snapshot holds the ActionId, the feature and stream, stored evidence, authorization and HSM facts.
 * It excludes the request payload and the wall clock.
 *
 * A missing or invalid contract, a capability failure, or declared requires with no stored subject,
 * HSM facts or evidence deny. An action with no requires is admitted from its needs alone.
 * A blocking host obligation, or a host obligation whose requires are all approvals, returns the
 * obligation when the needs pass. An `agent-spawn` action with no requires runs its handler, because
 * the host discharges the obligation with the handler output. Any host obligation that passes the
 * requires check returns the obligation, and its handler does not run.
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
