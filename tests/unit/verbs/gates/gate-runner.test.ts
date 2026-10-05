import { mkdtemp } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentAddressedStore } from '../../../../src/storage/artifacts/content-addressed-store.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
  type DispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import {
  AdmissionEvidenceRecordedData,
  type AdmissionEvidenceRecorded,
} from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { resolveEvidenceArtifact } from '../../../../src/workflow/admission/evidence-artifact.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import type { ContentDigestV1 } from '../../../../src/workflow/admission/types.js';
import {
  runGate,
  runPhaseGateWithEvidence,
  GATE_RUNNER_GATE_LAYER,
  type GateProviderExecutor,
  type GateRunRequest,
  type GateRunnerDependencies,
} from '../../../../src/verbs/gates/gate-runner.js';
import { emitGateEvent, SKIPPED_BY_POLICY } from '../../../../src/verbs/gates/gate-utils.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import { dispatch, type DispatchContext as HandlerContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrf, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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
    await rmrfAsync(root);
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

  /**
   * The report goes to the content-addressed store, not into the event payload.
   * The durable evidence row must name the blob in `artifactRefs`.
   */
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

    const persisted = (await persistedEvidence())[0]?.evidence;
    expect(persisted?.artifactRefs).toEqual([reportArtifact]);
    await expect(resolveEvidenceArtifact(artifactStore, persisted?.artifactRefs?.[0]))
      .resolves.toBe(marker.repeat(10_000));
  });

  /**
   * Each provider run reports different bytes, so the test can see which blob
   * the retry returns. The retry must keep the first row and resolve to the bytes
   * of run one.
   */
  it('GateRunner_SameOperationRetry_ReDerivesArtifactRefFromThePersistedRow', async () => {
    const marker = 'retry-report-body';
    let providerRuns = 0;
    const reportProvider: GateProviderExecutor = async () => {
      providerRuns += 1;
      return {
        success: true,
        data: { passed: false, report: `${marker}-${providerRuns}`, summary: 'failed' },
      };
    };
    const dispatch = context('same-operation-report');

    const first = await runWithDispatchContext(dispatch, () =>
      runGate(request, dependencies(reportProvider)),
    );
    const retry = await runWithDispatchContext(dispatch, () =>
      runGate(request, dependencies(reportProvider)),
    );

    expect(await persistedEvidence()).toHaveLength(1);
    const persisted = (await persistedEvidence())[0]?.evidence;
    const firstArtifact = evidenceReferences(first)[0]?.reportArtifact;
    const retryArtifact = evidenceReferences(retry)[0]?.reportArtifact;
    expect(persisted?.artifactRefs).toEqual([firstArtifact]);
    await expect(resolveEvidenceArtifact(artifactStore, retryArtifact)).resolves.toBe(`${marker}-1`);
  });
});

interface GateExecutedRow {
  readonly gateName?: string;
  readonly layer?: string;
  readonly passed?: boolean;
  readonly details?: Record<string, unknown>;
}

/**
 * The durable runner owns the `gate.executed` signal that `task_complete` reads.
 * `runGate` mints the row from the persisted evidence record, so proof and signal
 * agree. A legacy phase-gate provider that emits its own row keeps ownership, so
 * each gate class has one producer.
 */
describe('DR-1 gate-executed signal ownership', () => {
  let root: string;
  let eventStore: EventStore;
  let artifactStore: ContentAddressedStore;
  const streamId = 'dr1-signal-stream';

  const passingProvider: GateProviderExecutor = async () => ({
    success: true,
    data: { passed: true },
  });
  const failingProvider: GateProviderExecutor = async () => ({
    success: true,
    data: { passed: false, report: 'lint failed' },
  });

  function trusted(sessionId: string): DispatchContext {
    const authorization = snapshotCallerAuthorization(
      deriveMcpCallerIdentity({ sessionId }),
      createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos']),
      () => FIXED_TIME,
    );
    return mintDispatchContext(undefined, authorization);
  }

  function deps(
    executeProvider: GateProviderExecutor,
    overrides: Partial<GateRunnerDependencies> = {},
  ): GateRunnerDependencies {
    return {
      eventStore,
      artifactStore,
      executeProvider,
      clock: () => FIXED_TIME,
      ...overrides,
    };
  }

  function taskRequest(taskId: string): GateRunRequest {
    return {
      streamId,
      gateClass: 'static-analysis',
      phaseAttemptId: 'phase-attempt:dr1-001',
      requirementId: 'verification-ladder:static-analysis',
      subject: createEvidenceSubject(
        { kind: 'task', taskId },
        { gateClass: 'static-analysis' },
      ),
      providerInput: { taskId },
    };
  }

  async function gateExecutedRows(): Promise<readonly GateExecutedRow[]> {
    const events = await eventStore.query(streamId, { type: 'gate.executed' });
    return events.map((event) => (event.data ?? {}) as GateExecutedRow);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'exarchos-dr1-signal-'));
    eventStore = new EventStore(join(root, 'events'));
    await eventStore.initialize();
    artifactStore = new ContentAddressedStore(join(root, 'artifacts'));
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(root);
  });

  /**
   * The row takes `taskId` from the evidence subject, so `task_complete` can
   * scope the signal to its task. `details.evidenceId` links the row to the proof.
   */
  it('GateRunner_PassingTaskGate_EmitsTaskScopedGateExecutedSignal', async () => {
    await runWithDispatchContext(trusted('dr1-pass'), () =>
      runGate(taskRequest('task-dr1-a'), deps(passingProvider)),
    );

    const rows = await gateExecutedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gateName: 'static-analysis',
      layer: GATE_RUNNER_GATE_LAYER,
      passed: true,
    });
    expect(rows[0]?.details).toMatchObject({ taskId: 'task-dr1-a', verdict: 'pass' });
    const [evidence] = await eventStore.query(streamId, {
      type: 'admission.evidence-recorded',
    });
    expect(rows[0]?.details?.evidenceId).toBe(
      AdmissionEvidenceRecordedData.parse(evidence?.data).evidence.evidenceId,
    );
  });

  it('GateRunner_FailingVerdict_EmitsNonPassingSignal', async () => {
    await runWithDispatchContext(trusted('dr1-fail'), () =>
      runGate(taskRequest('task-dr1-b'), deps(failingProvider)),
    );

    const rows = await gateExecutedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passed).toBe(false);
    expect(rows[0]?.details).toMatchObject({ verdict: 'fail' });
  });

  it('GateRunner_IndeterminateVerdict_NeverEmitsPassingSignal', async () => {
    const crashedProvider: GateProviderExecutor = async () => ({
      success: false,
      error: { code: 'PROBE_FAILED', message: 'lint runner crashed' },
    });
    await runWithDispatchContext(trusted('dr1-indeterminate'), () =>
      runGate(taskRequest('task-dr1-c'), deps(crashedProvider)),
    );

    const rows = await gateExecutedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passed).toBe(false);
    expect(rows[0]?.details).toMatchObject({ verdict: 'indeterminate' });
  });

  /** A run with a non-task subject carries no `taskId`, which readers treat as a project-wide gate. */
  it('GateRunner_NonTaskSubject_EmitsProjectWideSignal', async () => {
    const request: GateRunRequest = {
      ...taskRequest('task-dr1-unused'),
      subject: createEvidenceSubject(
        { kind: 'commit', commitId: 'a'.repeat(40) },
        { gateClass: 'static-analysis' },
      ),
    };
    await runWithDispatchContext(trusted('dr1-project-wide'), () =>
      runGate(request, deps(passingProvider)),
    );

    const rows = await gateExecutedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details?.taskId).toBeUndefined();
    expect(rows[0]?.passed).toBe(true);
  });

  it('GateRunner_SameOperationRetry_KeepsExactlyOneSignalRow', async () => {
    const dispatchCtx = trusted('dr1-retry');
    const request = taskRequest('task-dr1-d');
    await runWithDispatchContext(dispatchCtx, () => runGate(request, deps(passingProvider)));
    await runWithDispatchContext(dispatchCtx, () => runGate(request, deps(passingProvider)));

    expect(await gateExecutedRows()).toHaveLength(1);
    expect(
      await eventStore.query(streamId, { type: 'admission.evidence-recorded' }),
    ).toHaveLength(1);
  });

  /**
   * A legacy phase-gate provider emits its own `gate.executed`, so the runner
   * must not emit a second row. The runner still records the durable proof.
   */
  it('PhaseGateAdapter_SelfEmittingProvider_RunnerDoesNotDoubleEmit', async () => {
    const featureId = 'dr1-phase-gate';
    await seedActivePhaseAttempt(eventStore, featureId);

    const result = await runWithDispatchContext(trusted('dr1-phase-gate'), () =>
      runPhaseGateWithEvidence({
        streamId: featureId,
        gateClass: 'plan-coverage',
        requirementId: 'phase-gate:plan-coverage',
        stateDir: root,
        eventStore,
        subject: (phaseAttemptId) =>
          createEvidenceSubject({ kind: 'phase-attempt', phaseAttemptId }, {
            gateClass: 'plan-coverage',
          }),
        providerInput: { featureId },
        executeProvider: async () => {
          await emitGateEvent(eventStore, featureId, 'plan-coverage', 'planning', true, {
            dimension: 'D1',
          });
          return { success: true, data: { passed: true } };
        },
      }),
    );

    expect(result.success).toBe(true);
    const rows = (await eventStore.query(featureId, { type: 'gate.executed' }))
      .map((event) => (event.data ?? {}) as GateExecutedRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('planning');
    expect(
      await eventStore.query(featureId, { type: 'admission.evidence-recorded' }),
    ).toHaveLength(1);
  });

  /**
   * A policy-skip carrier gives `indeterminate` evidence and a non-passing signal
   * that keeps `skipped`, the discriminant and the reason. The carrier returned
   * to the orchestrator stays `passed: true`, so a skipped gate does not block
   * its runbook chain.
   */
  it('AppendGateExecutedSignal_SkippedGate_PreservesSkippedAndDiscriminant', async () => {
    const policySkipProvider: GateProviderExecutor = async () => ({
      success: true,
      data: {
        passed: true,
        skipped: true,
        disposition: 'advisory-skip',
        discriminant: SKIPPED_BY_POLICY,
        reason: 'skipped by verification policy — not in the resolved sequence',
      },
    });

    await runWithDispatchContext(trusted('dr7-policy-skip'), () =>
      runGate(taskRequest('task-dr7-skip'), deps(policySkipProvider)),
    );

    const [evidence] = await eventStore.query(streamId, {
      type: 'admission.evidence-recorded',
    });
    expect(AdmissionEvidenceRecordedData.parse(evidence?.data).evidence.verdict)
      .toBe('indeterminate');

    const rows = await gateExecutedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passed).toBe(false);
    expect(rows[0]?.details).toMatchObject({
      verdict: 'indeterminate',
      skipped: true,
      discriminant: SKIPPED_BY_POLICY,
      reason: 'skipped by verification policy — not in the resolved sequence',
    });

    const carrier = await runWithDispatchContext(trusted('dr7-carrier'), () =>
      runGate(taskRequest('task-dr7-carrier'), deps(policySkipProvider)),
    );
    expect(carrier).toMatchObject({ success: true, data: { passed: true, skipped: true } });
  });

  /** A gate that ran gets no skip markers, so the log shows the difference between "did not run" and "passed". */
  it('AppendGateExecutedSignal_GateThatRan_CarriesNoSkipMarkers', async () => {
    await runWithDispatchContext(trusted('dr7-real-pass'), () =>
      runGate(taskRequest('task-dr7-ran'), deps(passingProvider)),
    );

    const rows = await gateExecutedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passed).toBe(true);
    expect(rows[0]?.details).toMatchObject({ verdict: 'pass' });
    expect(rows[0]?.details).not.toHaveProperty('skipped');
    expect(rows[0]?.details).not.toHaveProperty('discriminant');
  });
});

/**
 * End-to-end through the real `dispatch()`: `check_static_analysis` produces the
 * signal and `task_complete` consumes it. Each half alone can pass while the
 * composition fails. The tests seed no `gate.executed` row and pass no `evidence`
 * field. They start the workflow through the real `init` action.
 *
 * The temp repo runs real npm scripts. It declares `lint`, `typecheck` and
 * `quality-check`, because static analysis counts an undeclared script as a skip
 * and degrades the result. Only the `lint` exit code changes between tests.
 */
describe('DR-1 acceptance: check_static_analysis → task_complete', () => {
  const cleanups: Array<() => void> = [];
  const stores: EventStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  function nodeRepo(prefix: string, exitCode: number): string {
    const repoRoot = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmrf(repoRoot));
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'dr1-fixture',
          version: '1.0.0',
          private: true,
          scripts: {
            lint: `node -e "process.exit(${exitCode})"`,
            typecheck: 'node -e ""',
            'quality-check': 'node -e ""',
          },
        },
        null,
        2,
      ),
    );
    return repoRoot;
  }

  async function startedWorkflow(featureId: string): Promise<HandlerContext> {
    const stateDir = mkdtempSync(join(tmpdir(), 'dr1-accept-state-'));
    cleanups.push(() => rmrf(stateDir));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    stores.push(eventStore);
    const ctx = withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as HandlerContext);
    const init = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx,
    );
    expect(init.success).toBe(true);
    return ctx;
  }

  it('TaskComplete_StaticAnalysisPassed_SucceedsWithoutSeededEvent', async () => {
    const featureId = 'dr1-green';
    const taskId = 'DR1-GREEN-1';
    const repoRoot = nodeRepo('dr1-green-repo-', 0);
    const ctx = await startedWorkflow(featureId);

    const gate = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_static_analysis', featureId, taskId, repoRoot },
      ctx,
    );
    expect(gate.success).toBe(true);
    expect((gate.data as { passed?: boolean }).passed).toBe(true);

    const complete = await dispatch(
      'exarchos_orchestrate',
      { action: 'task_complete', taskId, streamId: featureId },
      ctx,
    );

    expect(complete.error).toBeUndefined();
    expect(complete.success).toBe(true);
    expect(
      await ctx.eventStore.query(featureId, { type: 'task.completed' }),
    ).toHaveLength(1);
  }, 180_000);

  /** A red lint still blocks `task_complete` with `GATE_NOT_PASSED`. */
  it('TaskComplete_StaticAnalysisRed_ReturnsGateNotPassed', async () => {
    const featureId = 'dr1-red';
    const taskId = 'DR1-RED-1';
    const repoRoot = nodeRepo('dr1-red-repo-', 1);
    const ctx = await startedWorkflow(featureId);

    const gate = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_static_analysis', featureId, taskId, repoRoot },
      ctx,
    );
    expect(gate.success).toBe(true);
    expect((gate.data as { passed?: boolean }).passed).toBe(false);

    const complete = await dispatch(
      'exarchos_orchestrate',
      { action: 'task_complete', taskId, streamId: featureId },
      ctx,
    );

    expect(complete.success).toBe(false);
    expect(complete.error?.code).toBe('GATE_NOT_PASSED');
    expect(complete.error?.unmetGates).toContain('static-analysis');
    expect(
      await ctx.eventStore.query(featureId, { type: 'task.completed' }),
    ).toHaveLength(0);
  }, 180_000);
});
