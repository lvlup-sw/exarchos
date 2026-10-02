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
 * Stamps the local-operator identity that a real transport supplies. `buildCli` derives
 * `callerIdentity` from the transport, so a caller cannot assert its own principal. The real
 * deriver keeps the stamp under test: a regression that drops or alters the identity fails.
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
 * Runs `fn` inside the ambient trusted dispatch scope that `dispatch()` opens. Gates that produce
 * durable evidence read the caller authorization from `getDispatchContext().authorization`. They
 * fail closed with `TRUSTED_CALLER_REQUIRED` when it is absent. A test that calls such a handler
 * directly must open the same scope. This helper composes the primitives of
 * `dispatch/core/dispatch.ts`, so it cannot drift from production. It does not mock
 * `durable-gate-producer`, because a stub also removes the durable-evidence append.
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
 * Seeds the minimum workflow that a durable-evidence gate can run inside. Evidence binds to an
 * immutable subject, and the phase-attempt identity of the subject comes from persisted lifecycle
 * data. A gate outside a phase attempt fails closed with `ACTIVE_PHASE_ATTEMPT_REQUIRED`. So a
 * test against a bare event store starts the workflow first. Returns the allocated `phaseAttemptId`.
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
 * Seeds gate evidence, by default passing, onto a stream: the prior fact that the declared
 * `requires` of an action reads. A test seeds it when no step in the segment of the action
 * produces it. The record uses the real evidence schema and the key shape of the gate runner, so
 * the admission evaluator judges it as shipped gate evidence. The id hashes the invocation, the
 * producer and the phase attempt, so two attempts give two rows. Returns the evidence id.
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
