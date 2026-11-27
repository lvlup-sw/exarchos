/**
 * The integration attempts of a compiler 8-vcs settlement. One attempt runs the integration suite of one observed tip in the local check executor.
 *
 * The attempt identity derives from the outer operation, the full ref, the tip, the profile and the sorted accepted heads.
 * The complete attempt request goes into the bundle store, and a zero-row segment binding holds its digest reference before the executor runs.
 * The binding operation id starts with `settle-integration:`, so it never collides with a task segment or a gate binding.
 *
 * The executor claims the attempt before the suite starts and stores the terminal observation.
 * A later call of the same attempt replays that observation with no new run.
 * An attempt with a claim and no observation is incomplete, and the next call records it and runs the suite again.
 * A moved tip gives another identity, so it needs a fresh attempt. Each attempt read of the stream and of the binding table stays in this module.
 */

import { z } from 'zod';

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import type { CapsuleScope } from '../../contract/capsule/exarchos-capsule.js';
import { canonicalJson } from '../../contract/request-context.js';
import { checkPlanDigest, verificationValueDigest } from '../../contract/verification/harness-verification.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { ContentDigestV1Schema } from '../../workflow/admission/types.js';
import type { VerificationProfile } from '../../workflow/verification/profile.js';
import { integrationSuitePlan } from '../gates/check-integration-suite.js';
import { HostedAdequacyPending, hostedPendingResult } from '../gates/gate-runner.js';
import { NO_EXIT_STATUS, interpretReducedIntegration, runIntegrationSuite, type RunIntegrationSuiteResult } from '../pure/integration-suite.js';
import { resolveWorkflowState } from '../resolve-state.js';
import { resolveActivePhaseAttemptId } from '../tasks/active-phase-attempt.js';
import { commandResultOf, refusedCheckResult, runApprovedCheck, type ApprovedCheckOutcome, type CheckExecutor } from '../verification/check-executor.js';

/** The error code of an integration gate that refuses before or after its suite for a reason in the integration terms. Nothing is recorded. */
const INTEGRATION_REFUSED = 'INTEGRATION_REFUSED';

/** The failed result of an integration refusal. */
export function integrationRefusal(message: string): ToolResult {
  return { success: false, error: { code: INTEGRATION_REFUSED, message } };
}

/** The prefix of each attempt binding operation id. It keeps the ids apart from task segments and gate bindings. */
const ATTEMPT_PREFIX = 'settle-integration:';

/** One full commit id. */
const CommitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** One sha-256 digest in hex. */
const HexDigest = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The request of one local attempt. It names the stream, the phase attempt, the outer operation, the ref, the tip and the sorted accepted heads.
 * It also names the prepared capsule, the config, the profile, the suite plan and the integration checkout of the capsule scope.
 */
export const IntegrationAttemptRequestV1Schema = z.object({
  version: z.literal(1),
  operation: z.literal('integration-suite'),
  streamId: z.string().min(1),
  phaseAttemptId: z.string().min(1),
  outerOperationId: z.string().min(1),
  ref: z.string().regex(/^refs\/heads\/[^\x00-\x20\x7f]+$/),
  tip: CommitId,
  acceptedHeads: z.array(CommitId).max(64).refine(heads => heads.every((head, index) => index === 0 || (heads[index - 1] ?? '') < head)),
  preparedDigest: HexDigest,
  configDigest: HexDigest,
  profileDigest: HexDigest,
  planDigest: HexDigest,
  checkout: z.string().min(1),
  repository: z.string().min(1),
}).strict();
export type IntegrationAttemptRequestV1 = z.infer<typeof IntegrationAttemptRequestV1Schema>;

/** The stored payload of one attempt binding: the bundle-store digest of the complete canonical request. */
export const IntegrationAttemptBindingV1Schema = z
  .object({ version: z.literal(1), kind: z.literal('settle-integration'), request: ContentDigestV1Schema })
  .strict();

/** The terms of one integration attempt. `heads` are the sorted unique accepted heads. A test passes its own `executor`. */
export interface IntegrationAttemptTerms {
  readonly eventStore: EventStore;
  readonly bundles: RunBundleStore;
  readonly streamId: string;
  readonly outerOperationId: string;
  readonly ref: string;
  readonly tip: string;
  readonly heads: readonly string[];
  readonly preparedDigest: string;
  readonly scope: CapsuleScope;
  readonly profile: VerificationProfile;
  readonly executor?: CheckExecutor;
}

/**
 * The outcome of one attempt. `passed` and `failed` come only from the terminal observation of the bound attempt.
 * `evidenceDigest` is the digest of that stored observation.
 * `refused` is a refusal of the executor or a binding that differs. `pending` is a running or interrupted attempt. Neither of them commits.
 */
export type IntegrationAttemptOutcome =
  | { readonly kind: 'passed'; readonly attemptBinding: string; readonly evidenceDigest: string }
  | { readonly kind: 'failed'; readonly attemptBinding: string; readonly evidenceDigest: string; readonly message: string }
  | { readonly kind: 'refused'; readonly result: ToolResult }
  | { readonly kind: 'pending'; readonly result: ToolResult };

/**
 * The binding operation id of one attempt identity: the outer operation, the full ref, the tip, the profile and the sorted heads.
 * The route term keeps a local attempt apart from an attempt that the retired verifier bound.
 */
export function integrationAttemptId(terms: Pick<IntegrationAttemptTerms, 'outerOperationId' | 'ref' | 'tip' | 'heads' | 'profile'>): string {
  return ATTEMPT_PREFIX + verificationValueDigest({
    route: 'local', outerOperationId: terms.outerOperationId, ref: terms.ref, tip: terms.tip,
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

/** The complete request of a new attempt. It binds each term of the attempt and the integration checkout of the capsule scope. */
async function proposedRequest(terms: IntegrationAttemptTerms): Promise<IntegrationAttemptRequestV1> {
  return IntegrationAttemptRequestV1Schema.parse({
    version: 1, operation: 'integration-suite', streamId: terms.streamId, phaseAttemptId: await activePhaseAttempt(terms.eventStore, terms.streamId),
    outerOperationId: terms.outerOperationId, ref: terms.ref, tip: terms.tip, acceptedHeads: [...terms.heads], preparedDigest: terms.preparedDigest,
    configDigest: terms.scope.configDigest, profileDigest: contentDigest(terms.profile),
    planDigest: checkPlanDigest(integrationSuitePlan(terms.profile.integration)), checkout: terms.scope.checkout, repository: terms.scope.repository,
  });
}

/** Read the request that one binding names, and require canonical bytes. */
async function boundRequest(bundles: RunBundleStore, payload: string): Promise<IntegrationAttemptRequestV1> {
  const binding = IntegrationAttemptBindingV1Schema.parse(JSON.parse(payload));
  const original = (await bundles.resolve(binding.request)).toString('utf8');
  const checked = IntegrationAttemptRequestV1Schema.parse(JSON.parse(original));
  if (canonicalJson(checked) !== original) throw new Error('The bound integration request bytes are not canonical');
  return checked;
}

/**
 * Bind the request of one attempt before the executor runs, or read the request that an earlier call bound.
 * The bound request must name the same tip, ref, heads, stream, outer operation and integration checkout, or the attempt refuses.
 */
async function bindAttempt(terms: IntegrationAttemptTerms, attemptId: string): Promise<IntegrationAttemptRequestV1> {
  const backend = terms.eventStore.getAppender().ensureSqliteBackendSync();
  let payload = backend.lookupSegmentInput(attemptId);
  if (payload === undefined) {
    const proposed = await proposedRequest(terms);
    const reference = await terms.bundles.put(Buffer.from(canonicalJson(proposed), 'utf8'));
    payload = backend.bindSegmentInput(attemptId, canonicalJson(IntegrationAttemptBindingV1Schema.parse({
      version: 1, kind: 'settle-integration', request: reference,
    })));
  }
  const request = await boundRequest(terms.bundles, payload);
  if (request.tip !== terms.tip || request.ref !== terms.ref || request.streamId !== terms.streamId
    || request.outerOperationId !== terms.outerOperationId || canonicalJson(request.acceptedHeads) !== canonicalJson(terms.heads)
    || request.checkout !== terms.scope.checkout || request.repository !== terms.scope.repository) {
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
  try { return canonicalJson(await boundRequest(bundles, payload)) === request; }
  catch { return false; }
}

/** The finding message of a terminal suite result that does not pass. */
function failureMessage(tip: string, verdict: RunIntegrationSuiteResult): string {
  const cause = verdict.reason ?? verdict.noVerdictCause ?? `${verdict.failCount} failure(s)`;
  return `the integration suite at ${tip} gave the verdict ${verdict.verdict}: ${cause}`;
}

/** The binding and the request of one admitted attempt, which settle reads again before the commit. */
export interface IntegrationAttemptBinding {
  readonly attemptId: string;
  readonly request: string;
}

/**
 * Run one attempt. It binds the request first, then runs the suite in the local executor in the integration checkout of the capsule scope.
 * The executor confines the run to that checkout on the integration ref at the tip, with no connector and no operator identity.
 * The verdict comes from the stored run, read with the rules of the per-task gate.
 */
export async function runIntegrationAttempt(terms: IntegrationAttemptTerms): Promise<{ readonly outcome: IntegrationAttemptOutcome; readonly binding?: IntegrationAttemptBinding }> {
  const attemptId = integrationAttemptId(terms);
  let request: IntegrationAttemptRequestV1;
  try { request = await bindAttempt(terms, attemptId); }
  catch (error) {
    if (error instanceof HostedAdequacyPending) return { outcome: { kind: 'pending', result: hostedPendingResult(error) } };
    return { outcome: { kind: 'refused', result: integrationRefusal(error instanceof Error ? error.message : String(error)) } };
  }
  const binding = { attemptId, request: canonicalJson(request) };
  const integration = terms.profile.integration;
  const executor = terms.executor ?? runApprovedCheck;
  let ran: ApprovedCheckOutcome<RunIntegrationSuiteResult>;
  try {
    ran = await executor({
      eventStore: terms.eventStore, operation: 'integration-suite', streamId: terms.streamId, plan: integrationSuitePlan(integration),
      profileDigest: contentDigest(terms.profile), checkout: terms.scope.checkout, workspace: 'checkout',
      integration: { ref: terms.ref, tip: terms.tip, attempt: attemptId },
    }, async (session) => {
      const run = commandResultOf(await session.run({ leg: 0 }));
      return runIntegrationSuite({ repoRoot: terms.scope.checkout, integration, runCommand: () => run });
    });
  } catch (error) {
    if (error instanceof HostedAdequacyPending) return { outcome: { kind: 'pending', result: hostedPendingResult(error) }, binding };
    throw error;
  }
  if (ran.kind === 'refused') return { outcome: { kind: 'refused', result: refusedCheckResult(`The integration suite did not run: ${ran.reason}`) }, binding };
  const verdict = ran.value;
  const outcome: IntegrationAttemptOutcome = verdict.passed && verdict.verdict === 'pass'
    ? { kind: 'passed', attemptBinding: attemptId, evidenceDigest: ran.observation }
    : { kind: 'failed', attemptBinding: attemptId, evidenceDigest: ran.observation, message: failureMessage(terms.tip, verdict) };
  return { outcome, binding };
}
