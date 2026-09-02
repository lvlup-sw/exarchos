import { createHash } from 'node:crypto';

import type { DispatchContext as HandlerContext } from '../../src/dispatch/core/dispatch.js';
import { AdmissionEvidenceRecordedData } from '../../src/events/schemas.js';
import { ADMISSION_RUNTIME_CONTRACT_VERSION } from '../../src/workflow/admission/types.js';
import {
  deriveLocalOperatorIdentity,
  snapshotCallerAuthorization,
} from '../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../src/dispatch/dispatch-context.js';

/**
 * Stamp the local-operator identity a real transport would supply.
 *
 * `buildCli` derives `callerIdentity` from the transport rather than trusting
 * the caller to supply it — a caller cannot self-assert its own principal.
 *
 * Using the real deriver (rather than a hand-written identity literal) keeps the
 * stamp itself under test: a regression that dropped or altered the derived
 * identity still fails.
 */
export function withTrustedCaller(ctx: HandlerContext): HandlerContext {
  return { ...ctx, callerIdentity: deriveLocalOperatorIdentity(ctx.stateDir) };
}

/**
 * The DispatchContext a CLI adapter actually forwards to `dispatch`.
 *
 * Tests that assert the forwarded context must expect the TRUSTED shape, not
 * the raw context they constructed.
 */
export function expectedTrustedContext(ctx: HandlerContext): HandlerContext {
  return withTrustedCaller(ctx);
}

/**
 * Run `fn` inside the ambient trusted dispatch scope that `dispatch()` opens.
 *
 * Gates that produce durable evidence read their caller's authorization from
 * AsyncLocalStorage (`getDispatchContext().authorization`) rather than from an
 * argument, and fail closed with `TRUSTED_CALLER_REQUIRED` when it is absent —
 * the point being that a handler cannot be tricked into trusting a caller that
 * never crossed the dispatch boundary.
 *
 * Tests that invoke such a handler DIRECTLY (bypassing `dispatch`) must open the
 * same scope, or they exercise the fail-closed path instead of the behaviour
 * under test. This helper composes the exact primitives `dispatch/core/dispatch.ts` uses
 * — `snapshotCallerAuthorization` + `mintDispatchContext` +
 * `runWithDispatchContext` — so it cannot drift from production plumbing.
 *
 * Deliberately NOT a mock of `durable-gate-producer`: stubbing the producer
 * would also stub the durable-evidence append these gates are supposed to
 * perform.
 */
export function runAsTrustedCaller<T>(
  stateDir: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const authorization = snapshotCallerAuthorization(
    deriveLocalOperatorIdentity(stateDir),
    undefined,
  );
  return Promise.resolve(
    runWithDispatchContext(mintDispatchContext(undefined, authorization), fn),
  );
}

/**
 * Seed the minimum workflow a durable-evidence gate can legally run inside.
 *
 * Evidence is bound to an immutable subject, and the subject's phase-attempt
 * identity comes from persisted lifecycle data — a gate outside any phase
 * attempt has nothing to bind to and fails closed with
 * `ACTIVE_PHASE_ATTEMPT_REQUIRED`. Tests that drive a gate against a bare event
 * store therefore have to start the workflow first, exactly as a real run would.
 *
 * Returns the allocated `phaseAttemptId` so a caller can assert evidence
 * carries it.
 */
export async function seedActivePhaseAttempt(
  eventStore: SeedableEventStore,
  featureId: string,
  options: { readonly workflowType?: string; readonly phase?: string } = {},
): Promise<string> {
  const phaseAttemptId = `phase-attempt:${featureId.replace(/[^A-Za-z0-9_.:-]/g, '-')}`;
  await eventStore.append(featureId, {
    type: 'workflow.started',
    data: {
      featureId,
      workflowType: options.workflowType ?? 'feature',
      phase: options.phase ?? 'delegate',
      phaseAttemptId,
    },
  });
  return phaseAttemptId;
}

/** The slice of `EventStore` {@link seedActivePhaseAttempt} needs. */
interface SeedableEventStore {
  append(
    streamId: string,
    event: { type: string; data?: unknown },
  ): Promise<unknown>;
}

/** The slice {@link seedGateEvidence} needs — the same, plus the dedupe key. */
interface EvidenceSeedableEventStore {
  append(
    streamId: string,
    event: { type: string; timestamp?: string; data?: unknown },
    options?: { idempotencyKey?: string },
  ): Promise<unknown>;
}

/**
 * Seed passing gate evidence onto a stream — the PRIOR fact an action's
 * declared `requires` reads.
 *
 * An action whose requirement no step in its own segment produces needs the
 * fact to already be there, and seeding it by hand is how a test states the
 * precondition its caller owes. Built with the real evidence schema and keyed
 * the way the gate runner keys its own, so the admission evaluator accepts or
 * rejects it for the same reasons it would a shipped gate's.
 *
 * Returns the allocated evidence id.
 */
export async function seedGateEvidence(
  eventStore: EvidenceSeedableEventStore,
  input: {
    readonly streamId: string;
    readonly requirementId: string;
    readonly phaseAttemptId: string;
    readonly producerRef?: string;
    readonly verdict?: 'pass' | 'fail';
  },
): Promise<string> {
  const producerRef = input.producerRef ?? 'check_review_verdict';
  const invocationId = `seed:${input.requirementId}`;
  // The attempt is part of the identity because the real runner puts it there
  // (`evidenceIdFor` hashes it alongside the operation, the provider and the
  // requirement). Leaving it out made the key coarser than the thing it
  // simulates: a second attempt on the same stream reused the first attempt's
  // row, so a caller seeding two attempts got one — carrying the wrong
  // `phaseAttemptId` — while an exact repeat still dedupes as it should.
  const evidenceId = `evidence:${createHash('sha256')
    .update([invocationId, producerRef, input.phaseAttemptId].join('\0'), 'utf8')
    .digest('hex')}`;
  const createdAt = new Date().toISOString();
  const record = AdmissionEvidenceRecordedData.parse({
    eventVersion: '1.0',
    evidence: {
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      kind: 'gate',
      evidenceId,
      requirementId: input.requirementId,
      phaseAttemptId: input.phaseAttemptId,
      subject: {
        kind: 'phase-attempt',
        phaseAttemptId: input.phaseAttemptId,
        digest: { algorithm: 'sha256', value: 'd'.repeat(64) },
      },
      producer: {
        producerId: 'seed-producer',
        providerRef: producerRef,
        providerVersion: '1.0.0',
        invocationId,
      },
      policyId: 'seed-policy',
      policyDigest: { algorithm: 'sha256', value: 'e'.repeat(64) },
      contentDigest: { algorithm: 'sha256', value: 'f'.repeat(64) },
      createdAt,
      verdict: input.verdict ?? 'pass',
    },
  });
  await eventStore.append(
    input.streamId,
    { type: 'admission.evidence-recorded', timestamp: createdAt, data: record },
    { idempotencyKey: evidenceId },
  );
  return evidenceId;
}
