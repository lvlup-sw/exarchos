/**
 * The integration attempts of a compiler 8-vcs settlement. One attempt runs the integration suite of one observed tip in the verifier.
 *
 * The attempt identity derives from the outer operation, the full ref, the tip, the profile and the sorted task heads.
 * The complete request goes into the bundle store, and a zero-row segment binding holds its digest reference before the first submit.
 * The binding operation id starts with `settle-integration:`, so it never collides with a task segment or a gate binding.
 *
 * A later call finds an attempt only when it computes the same identity again. Thus a retry at the same tip submits the bound request again.
 * Settle keeps no pointer and no list of earlier attempts. The verifier decides when a request for a new tip can start.
 * Each attempt read of the stream and of the binding table stays in this module.
 */

import { z } from 'zod';

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import type { CapsuleScope } from '../../contract/capsule/exarchos-capsule.js';
import { canonicalJson } from '../../contract/request-context.js';
import {
  VerificationRequest,
  checkPlanDigest,
  exchangeHostedVerification,
  verificationJson,
  verificationKey,
  verificationValueDigest,
  type HostedCheckoutIdentity,
  type VerificationHostConnector,
  type VerificationRequestTerms,
} from '../../contract/verification/harness-verification.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { ContentDigestV1Schema } from '../../workflow/admission/types.js';
import type { VerificationProfile } from '../../workflow/verification/profile.js';
import { integrationSuitePlan } from '../gates/check-integration-suite.js';
import { HostedAdequacyPending, admitHostedExchange, hostedCommandResult, hostedPendingResult, hostedRefusal } from '../gates/gate-runner.js';
import { NO_EXIT_STATUS, interpretReducedIntegration } from '../pure/integration-suite.js';
import { resolveWorkflowState } from '../resolve-state.js';
import { resolveActivePhaseAttemptId } from '../tasks/active-phase-attempt.js';

/** The prefix of each attempt binding operation id. It keeps the ids apart from task segments and gate bindings. */
const ATTEMPT_PREFIX = 'settle-integration:';

/** The stored payload of one attempt binding: the bundle-store digest of the complete canonical request. */
export const IntegrationAttemptBindingV1Schema = z
  .object({ version: z.literal(1), kind: z.literal('settle-integration'), request: ContentDigestV1Schema })
  .strict();

/** The terms of one integration attempt. `heads` are the sorted unique accepted heads. */
export interface IntegrationAttemptTerms {
  readonly eventStore: EventStore;
  readonly bundles: RunBundleStore;
  readonly connector: VerificationHostConnector;
  readonly identity: HostedCheckoutIdentity;
  readonly streamId: string;
  readonly outerOperationId: string;
  readonly ref: string;
  readonly tip: string;
  readonly heads: readonly string[];
  readonly preparedDigest: string;
  readonly scope: CapsuleScope;
  readonly profile: VerificationProfile;
}

/**
 * The outcome of one attempt. `passed` and `failed` come only from a signed terminal reply of the original request.
 * `refused` is a verifier refusal or a key conflict. `pending` is a busy, incomplete, pending or transport outcome. Neither of them commits.
 */
export type IntegrationAttemptOutcome =
  | { readonly kind: 'passed'; readonly attemptBinding: string; readonly evidenceDigest: string }
  | { readonly kind: 'failed'; readonly attemptBinding: string; readonly evidenceDigest: string; readonly message: string }
  | { readonly kind: 'refused'; readonly result: ToolResult }
  | { readonly kind: 'pending'; readonly result: ToolResult };

/** The binding operation id of one attempt identity: the outer operation, the full ref, the tip, the profile and the sorted heads. */
export function integrationAttemptId(terms: Pick<IntegrationAttemptTerms, 'outerOperationId' | 'ref' | 'tip' | 'heads' | 'profile'>): string {
  return ATTEMPT_PREFIX + verificationValueDigest({
    outerOperationId: terms.outerOperationId, ref: terms.ref, tip: terms.tip,
    profileDigest: contentDigest(terms.profile), heads: [...terms.heads],
  });
}

/**
 * The finding message of a suite that is not configured or not resolved. The suite did not run, so the message keeps the `profile-unresolved` reason.
 * It reads the verdict as the per-task gate does for an unresolved term, and it builds no request.
 */
export function unresolvedIntegrationMessage(scope: CapsuleScope, profile: VerificationProfile): string {
  const verdict = interpretReducedIntegration({
    repoRoot: scope.checkout, integration: profile.integration, run: { exitCode: NO_EXIT_STATUS, stdout: '', stderr: '' }, report: null,
  });
  return `the integration suite did not run (${verdict.discriminant ?? 'profile-unresolved'}): ${verdict.reason ?? 'the term is not resolved'}`;
}

/** The current phase attempt of the stream. A stream with no stamp gets the derived legacy id, as the gate producers do. */
async function activePhaseAttempt(eventStore: EventStore, streamId: string): Promise<string> {
  const resolved = await resolveWorkflowState({ featureId: streamId, eventStore });
  if ('error' in resolved) throw new HostedAdequacyPending('The workflow state of the integration attempt is unavailable.');
  return resolveActivePhaseAttemptId(streamId, resolved.state);
}

/** The complete request of a new attempt. Its subject binds each term, and its key binds the resource and the command digest. */
async function proposedRequest(terms: IntegrationAttemptTerms): Promise<VerificationRequest> {
  const request: Extract<VerificationRequestTerms, { operation: 'integration-suite' }> = {
    version: 1, operation: 'integration-suite', resourceId: terms.identity.resourceId, profileId: terms.identity.profileId,
    commandDigest: checkPlanDigest(integrationSuitePlan(terms.profile.integration)),
    subject: {
      scope: 'integration', streamId: terms.streamId, phaseAttemptId: await activePhaseAttempt(terms.eventStore, terms.streamId),
      outerOperationId: terms.outerOperationId, ref: terms.ref, headCommit: terms.tip, preparedDigest: terms.preparedDigest,
      configDigest: terms.scope.configDigest, profileDigest: contentDigest(terms.profile), acceptedHeads: [...terms.heads],
    },
  };
  return VerificationRequest.parse({ ...request, key: verificationKey(request) });
}

/** Read the request that one binding names, and require canonical bytes. */
async function boundRequest(bundles: RunBundleStore, payload: string): Promise<VerificationRequest> {
  const binding = IntegrationAttemptBindingV1Schema.parse(JSON.parse(payload));
  const original = (await bundles.resolve(binding.request)).toString('utf8');
  const checked = VerificationRequest.parse(JSON.parse(original));
  if (verificationJson(checked) !== original) throw new Error('The bound integration request bytes are not canonical');
  return checked;
}

/**
 * Bind the request of one attempt before its first submit, or read the request that an earlier call bound.
 * The bound request must name the same tip, ref, heads, stream and outer operation, or the attempt refuses.
 */
async function bindAttempt(terms: IntegrationAttemptTerms, attemptId: string): Promise<VerificationRequest> {
  const backend = terms.eventStore.getAppender().ensureSqliteBackendSync();
  let payload = backend.lookupSegmentInput(attemptId);
  if (payload === undefined) {
    const proposed = await proposedRequest(terms);
    const reference = await terms.bundles.put(Buffer.from(verificationJson(proposed)));
    payload = backend.bindSegmentInput(attemptId, canonicalJson(IntegrationAttemptBindingV1Schema.parse({
      version: 1, kind: 'settle-integration', request: reference,
    })));
  }
  const request = await boundRequest(terms.bundles, payload);
  const { subject } = request;
  if (request.operation !== 'integration-suite' || !('scope' in subject) || subject.scope !== 'integration'
    || subject.headCommit !== terms.tip || subject.ref !== terms.ref || subject.streamId !== terms.streamId
    || subject.outerOperationId !== terms.outerOperationId || verificationJson(subject.acceptedHeads) !== verificationJson(terms.heads)) {
    throw new Error('The bound integration request differs from its attempt identity');
  }
  return request;
}

/**
 * True when the binding of one attempt still names the same canonical request. Settle reads it again right before the commit.
 * A missing or changed binding gives false, and settle then commits nothing and starts a fresh attempt.
 */
export async function integrationAttemptIntact(eventStore: EventStore, bundles: RunBundleStore, attemptId: string, request: string): Promise<boolean> {
  const payload = eventStore.getAppender().ensureSqliteBackendSync().lookupSegmentInput(attemptId);
  if (payload === undefined) return false;
  try { return verificationJson(await boundRequest(bundles, payload)) === request; }
  catch { return false; }
}

/** The finding message of a terminal suite result that does not pass. */
function failureMessage(tip: string, verdict: ReturnType<typeof interpretReducedIntegration>): string {
  const cause = verdict.reason ?? verdict.noVerdictCause ?? `${verdict.failCount} failure(s)`;
  return `the integration suite at ${tip} gave the verdict ${verdict.verdict}: ${cause}`;
}

/** The binding and the request of one admitted attempt, which settle reads again before the commit. */
export interface IntegrationAttemptBinding {
  readonly attemptId: string;
  readonly request: string;
}

/**
 * Run one attempt. It binds the request first, then exchanges it with the verifier and admits only the authenticated original evidence.
 * The verdict comes from the reduced suite report, read with the rules of the per-task gate.
 */
export async function runIntegrationAttempt(terms: IntegrationAttemptTerms): Promise<{ readonly outcome: IntegrationAttemptOutcome; readonly binding?: IntegrationAttemptBinding }> {
  const attemptId = integrationAttemptId(terms);
  let request: VerificationRequest;
  try { request = await bindAttempt(terms, attemptId); }
  catch (error) {
    if (error instanceof HostedAdequacyPending) return { outcome: { kind: 'pending', result: hostedPendingResult(error) } };
    return { outcome: { kind: 'refused', result: hostedRefusal(error instanceof Error ? error.message : String(error)) } };
  }
  const binding = { attemptId, request: verificationJson(request) };
  let exchange: Awaited<ReturnType<typeof exchangeHostedVerification>>;
  try { exchange = await exchangeHostedVerification(terms.connector, request); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { outcome: { kind: 'pending', result: hostedPendingResult(new HostedAdequacyPending(`The verifier transport failed: ${reason}`)) }, binding };
  }
  try {
    const admitted = await admitHostedExchange(exchange, request, terms.scope.checkout, terms.scope.repository);
    if (admitted.kind === 'refused') return { outcome: { kind: 'refused', result: admitted.result }, binding };
    if (admitted.facts.operation !== 'integration-suite') throw new HostedAdequacyPending('The hosted facts name another operation.');
    const verdict = interpretReducedIntegration({
      repoRoot: terms.scope.checkout, integration: terms.profile.integration,
      run: hostedCommandResult(admitted.facts.run), report: admitted.facts.report,
    });
    const evidenceDigest = verificationValueDigest(admitted.signed);
    const outcome: IntegrationAttemptOutcome = verdict.passed && verdict.verdict === 'pass'
      ? { kind: 'passed', attemptBinding: attemptId, evidenceDigest }
      : { kind: 'failed', attemptBinding: attemptId, evidenceDigest, message: failureMessage(terms.tip, verdict) };
    return { outcome, binding };
  } catch (error) {
    if (error instanceof HostedAdequacyPending) return { outcome: { kind: 'pending', result: hostedPendingResult(error) }, binding };
    throw error;
  }
}
