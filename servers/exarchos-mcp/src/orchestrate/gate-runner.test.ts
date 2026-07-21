import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentAddressedStore } from '../artifacts/content-addressed-store.js';
import { createInMemoryResolver } from '../capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
  type DispatchContext,
} from '../dispatch/dispatch-context.js';
import {
  AdmissionEvidenceRecordedData,
  type AdmissionEvidenceRecorded,
} from '../event-store/schemas.js';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import { resolveEvidenceArtifact } from '../workflow/admission/evidence-artifact.js';
import { createEvidenceSubject } from '../workflow/admission/evidence-subject.js';
import type { ContentDigestV1 } from '../workflow/admission/types.js';
import {
  runGate,
  type GateProviderExecutor,
  type GateRunRequest,
  type GateRunnerDependencies,
} from './gate-runner.js';

const FIXED_TIME = '2026-07-21T22:30:00.000Z';
const POLICY_DIGEST: ContentDigestV1 = {
  algorithm: 'sha256',
  value: '1'.repeat(64),
};

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Readonly<Record<string, unknown>>;
}

function evidenceReferences(result: ToolResult): readonly Readonly<Record<string, unknown>>[] {
  const references = asRecord(result.data).evidenceReferences;
  expect(Array.isArray(references)).toBe(true);
  return references as readonly Readonly<Record<string, unknown>>[];
}

describe('canonical evidence-producing gate runner', () => {
  let root: string;
  let eventStore: EventStore;
  let artifactStore: ContentAddressedStore;
  let request: GateRunRequest;

  const passingProvider: GateProviderExecutor = async (provider, input) => ({
    success: true,
    data: {
      passed: true,
      providerAction: provider.actionName,
      input,
      legacyField: 'preserved',
    },
    warnings: ['legacy warning'],
  });

  function context(sessionId: string): DispatchContext {
    const identity = deriveMcpCallerIdentity({ sessionId });
    const authorization = snapshotCallerAuthorization(
      identity,
      createInMemoryResolver([
        'fs:read',
        'fs:write',
        'shell:exec',
        'isolation:worktree',
        'mcp:exarchos',
      ]),
      () => FIXED_TIME,
    );
    return mintDispatchContext(undefined, authorization);
  }

  function dependencies(
    executeProvider: GateProviderExecutor = passingProvider,
  ): GateRunnerDependencies {
    return {
      eventStore,
      artifactStore,
      executeProvider,
      providerVersion: 'test-provider-7',
      clock: () => FIXED_TIME,
    };
  }

  async function persistedEvidence(): Promise<AdmissionEvidenceRecorded[]> {
    const events = await eventStore.query(request.streamId, {
      type: 'admission.evidence-recorded',
    });
    return events.map((event) => AdmissionEvidenceRecordedData.parse(event.data));
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exarchos-gate-runner-'));
    eventStore = new EventStore(join(root, 'events'));
    await eventStore.initialize();
    artifactStore = new ContentAddressedStore(join(root, 'artifacts'));
    request = {
      streamId: 'gate-runner-tests',
      gateClass: 'test-adequacy',
      phaseAttemptId: 'phase-attempt:test-006',
      requirementId: 'requirement:test-adequacy',
      subject: createEvidenceSubject(
        { kind: 'task', taskId: 'task-006' },
        { commit: 'abc123', diff: 'task-006-diff' },
      ),
      providerInput: { taskId: 'task-006' },
      policy: {
        policyId: 'verification-ladder',
        policyDigest: POLICY_DIGEST,
      },
    };
  });

  afterEach(async () => {
    eventStore.close();
    await rm(root, { recursive: true, force: true });
  });

  it('GateRunner_Success_PersistsBeforeReturningCompatibleCarrier', async () => {
    const dispatch = context('success');
    const result = await runWithDispatchContext(dispatch, () =>
      runGate(request, dependencies()),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        passed: true,
        legacyField: 'preserved',
        evidenceReferences: [expect.objectContaining({ subject: request.subject })],
      },
      warnings: ['legacy warning'],
    });
    const [record] = await persistedEvidence();
    expect(record).toMatchObject({
      evidence: {
        kind: 'gate',
        verdict: 'pass',
        requirementId: request.requirementId,
        phaseAttemptId: request.phaseAttemptId,
        subject: request.subject,
        policyId: 'verification-ladder',
        policyDigest: POLICY_DIGEST,
      },
    });
  });

  it('GateRunner_AppendFailure_ReturnsFailure', async () => {
    const failingStore: Pick<EventStore, 'append' | 'query'> = {
      query: eventStore.query.bind(eventStore),
      append: async () => {
        throw new Error('durable store unavailable');
      },
    };
    const result = await runWithDispatchContext(context('append-failure'), () =>
      runGate(request, {
        ...dependencies(),
        eventStore: failingStore,
      }),
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'EVIDENCE_APPEND_FAILED',
        message: 'durable store unavailable',
        action: 'runGate',
      },
    });
    expect(result.data).toBeUndefined();
    expect(await persistedEvidence()).toEqual([]);
  });

  it('GateRunner_SameOperationRetry_UsesOneCanonicalEvidenceRecord', async () => {
    const dispatch = context('same-operation');
    const first = await runWithDispatchContext(dispatch, () =>
      runGate(request, dependencies()),
    );
    const retry = await runWithDispatchContext(dispatch, () =>
      runGate(request, dependencies()),
    );

    expect(evidenceReferences(retry)[0]?.evidenceId)
      .toBe(evidenceReferences(first)[0]?.evidenceId);
    expect(await persistedEvidence()).toHaveLength(1);
  });

  it('GateRunner_NewOperation_SupersedesCanonicalPredecessor', async () => {
    const first = await runWithDispatchContext(context('first-operation'), () =>
      runGate(request, dependencies()),
    );
    const second = await runWithDispatchContext(context('new-operation'), () =>
      runGate(request, dependencies()),
    );

    const firstId = evidenceReferences(first)[0]?.evidenceId;
    const secondRef = evidenceReferences(second)[0];
    expect(secondRef?.evidenceId).not.toBe(firstId);
    expect(secondRef?.supersedesEvidenceId).toBe(firstId);
    const records = await persistedEvidence();
    expect(records).toHaveLength(2);
    expect(records[1]?.supersedesEvidenceId).toBe(firstId);
  });

  it('GateRunner_PhaseAttempt_IsStampedOnEvidence', async () => {
    request = {
      ...request,
      phaseAttemptId: 'phase-attempt:review-17',
    };
    await runWithDispatchContext(context('phase-attempt'), () =>
      runGate(request, dependencies()),
    );

    expect((await persistedEvidence())[0]?.evidence.phaseAttemptId)
      .toBe('phase-attempt:review-17');
  });

  it('GateRunner_TrustedIdentity_StampsProducerAndInvocation', async () => {
    const dispatch = context('trusted-caller');
    await runWithDispatchContext(dispatch, () =>
      runGate(request, dependencies()),
    );

    const [record] = await persistedEvidence();
    expect(record?.evidence.producer).toEqual({
      producerId: dispatch.authorization?.identity.subjectId,
      providerRef: 'check_test_adequacy',
      providerVersion: 'test-provider-7',
      invocationId: dispatch.operationId,
    });
    const [event] = await eventStore.query(request.streamId, {
      type: 'admission.evidence-recorded',
    });
    expect(event?.operationId).toBe(dispatch.operationId);
  });

  it('GateRunner_ProviderFailure_PersistsIndeterminateAndReturnsFailure', async () => {
    const providerFailure: GateProviderExecutor = async () => ({
      success: false,
      error: { code: 'PROBE_FAILED', message: 'probe process crashed' },
    });
    const result = await runWithDispatchContext(context('provider-failure'), () =>
      runGate(request, dependencies(providerFailure)),
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'PROBE_FAILED', message: 'probe process crashed' },
      data: { evidenceReferences: [expect.any(Object)] },
    });
    expect((await persistedEvidence())[0]?.evidence).toMatchObject({
      kind: 'gate',
      verdict: 'indeterminate',
    });
  });

  it('GateRunner_Report_IsContentAddressedAndExcludedFromEventPayload', async () => {
    const marker = 'large-sensitive-gate-report';
    const reportProvider: GateProviderExecutor = async () => ({
      success: true,
      data: {
        passed: false,
        report: marker.repeat(10_000),
        summary: 'failed',
      },
    });
    const result = await runWithDispatchContext(context('report'), () =>
      runGate(request, dependencies(reportProvider)),
    );

    const reportArtifact = evidenceReferences(result)[0]?.reportArtifact;
    expect(reportArtifact).toBeDefined();
    expect(JSON.stringify((await eventStore.query(request.streamId))[0]))
      .not.toContain(marker);
    await expect(resolveEvidenceArtifact(artifactStore, reportArtifact))
      .resolves.toBe(marker.repeat(10_000));
    expect(result).toMatchObject({
      success: true,
      data: { passed: false, report: marker.repeat(10_000), summary: 'failed' },
    });
  });
});
