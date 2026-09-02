import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// ─── DR-1: the durable runner owns the gate-executed signal ─────────────────
//
// CHARACTERIZATION OF THE OLD BEHAVIOUR (what these tests replace).
//
// The migrated ladder producers (check_static_analysis and siblings) route
// through `runDurableGateProducer` → `runGate`, which appended ONLY
// `admission.evidence-recorded`. `task_complete` (tasks/tools.ts) has always
// gated on `gate.executed`. So the gate-execution signal was split across two
// event types with NO producer on the side the consumer reads: a real
// `check_static_analysis` run followed by `task_complete` returned
// GATE_NOT_PASSED against its own fresh evidence.
//
// The fix keeps `gate.executed` as THE signal and gives it exactly one producer
// per gate class. For every class the durable runner owns, that producer is
// `runGate` — minting the row from the same persisted evidence record, so the
// proof and the signal cannot disagree. Legacy phase-gate providers that still
// emit their own row keep ownership (the adapter opts the runner out), so no
// gate class ever has two producers.
// ────────────────────────────────────────────────────────────────────────────

interface GateExecutedRow {
  readonly gateName?: string;
  readonly layer?: string;
  readonly passed?: boolean;
  readonly details?: Record<string, unknown>;
}

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
    await rm(root, { recursive: true, force: true });
  });

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
    // The task binding comes from the evidence SUBJECT, so the per-task reader
    // in task_complete can scope the signal to the task it is completing.
    expect(rows[0]?.details).toMatchObject({ taskId: 'task-dr1-a', verdict: 'pass' });
    // The signal is derived from — and traceable to — the durable proof.
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
    // Fail-closed: "the gate could not decide" must never read as a pass.
    expect(rows[0]?.passed).toBe(false);
    expect(rows[0]?.details).toMatchObject({ verdict: 'indeterminate' });
  });

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
    // A cumulative (non-task) run carries no taskId, which the documented
    // tolerant reader (#1189) treats as a project-wide gate.
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

  it('PhaseGateAdapter_SelfEmittingProvider_RunnerDoesNotDoubleEmit', async () => {
    // Single-producer rule, held from the other side: the legacy phase-gate
    // providers still emit their own `gate.executed`, so the runner must stay
    // silent for them. Two rows here would mean the class has two producers.
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
    // The durable proof is still produced by the runner — only the signal is
    // left to the legacy owner.
    expect(
      await eventStore.query(featureId, { type: 'admission.evidence-recorded' }),
    ).toHaveLength(1);
  });

  // ── DR-7 (task 078): a gate that did not run is distinguishable from one
  //    that passed, in BOTH durable rows, against a real event store.

  it('AppendGateExecutedSignal_SkippedGate_PreservesSkippedAndDiscriminant', async () => {
    // The carrier the three migrated ladder gates emit on a policy skip.
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

    // 1. The durable PROOF records that nothing was proven.
    const [evidence] = await eventStore.query(streamId, {
      type: 'admission.evidence-recorded',
    });
    expect(AdmissionEvidenceRecordedData.parse(evidence?.data).evidence.verdict)
      .toBe('indeterminate');

    // 2. The SIGNAL agrees, and says WHY — the observability half the retired
    //    `emitPolicySkipIfNeeded` carried and the runner had dropped.
    const rows = await gateExecutedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passed).toBe(false);
    expect(rows[0]?.details).toMatchObject({
      verdict: 'indeterminate',
      skipped: true,
      discriminant: SKIPPED_BY_POLICY,
      reason: 'skipped by verification policy — not in the resolved sequence',
    });

    // 3. The carrier the orchestrator reads is untouched, so a policy-skipped
    //    gate still does not BLOCK its runbook chain. Only the proof changed.
    const carrier = await runWithDispatchContext(trusted('dr7-carrier'), () =>
      runGate(taskRequest('task-dr7-carrier'), deps(policySkipProvider)),
    );
    expect(carrier).toMatchObject({ success: true, data: { passed: true, skipped: true } });
  });

  it('AppendGateExecutedSignal_GateThatRan_CarriesNoSkipMarkers', async () => {
    // The discriminating counterpart: a real pass must NOT acquire skip
    // markers, or `details.skipped` would be noise instead of a signal. This is
    // what makes "did not run" and "passed" distinguishable in the log.
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

// ─── DR-1 acceptance: the gate→task seam, end to end ────────────────────────
//
// These two go through the REAL `dispatch()` composition —
//
//   exarchos_orchestrate(check_static_analysis)
//     → dispatch()  (per-action Zod validation, trusted caller, ambient scope)
//     → handleOrchestrate → adaptLadderGate → handleStaticAnalysis
//     → runDurableGateProducer → runGate            [signal producer]
//   exarchos_orchestrate(task_complete)
//     → dispatch() → handleTaskComplete             [signal consumer]
//
// — against a real npm toolchain in a real temp repo, with NO hand-seeded
// `gate.executed` and NO `evidence` field on task_complete. A unit-isolated
// version of this pair could not have caught the defect: both halves were
// individually correct, and only their composition was broken.
// ────────────────────────────────────────────────────────────────────────────

describe('DR-1 acceptance: check_static_analysis → task_complete', () => {
  const cleanups: Array<() => void> = [];
  const stores: EventStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  /**
   * A real Node repo whose `lint`/`typecheck` scripts are genuine npm scripts.
   * A hermetic fixture, not a stub: the gate shells out to the real npm the
   * production path uses, so the pass/fail edge under test is the real one.
   */
  function nodeRepo(prefix: string, exitCode: number): string {
    const repoRoot = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'dr1-fixture',
          version: '1.0.0',
          private: true,
          // DR-6 (T-09): static analysis tallies SKIP first-class, so an
          // undeclared constituent degrades the dimension and can never report
          // PASS. All three must be declared or the aggregate is DEGRADED for a
          // reason that has nothing to do with the seam under test. `lint`
          // carries the parameterised exit code; the other two are deterministic
          // green legs so the lint result is the only variable.
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
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    stores.push(eventStore);
    const ctx = withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as HandlerContext);
    // The workflow itself is started through the real action, so nothing in
    // either test hand-writes an event into the stream.
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

    // No `evidence` field: the completion is carried purely by the gate the
    // agent actually ran.
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

    // The negative twin: unifying the producer must NOT weaken enforcement —
    // a red static analysis still blocks, and it blocks because the signal it
    // produced says `passed:false`, not because the signal is missing.
    expect(complete.success).toBe(false);
    expect(complete.error?.code).toBe('GATE_NOT_PASSED');
    expect(complete.error?.unmetGates).toContain('static-analysis');
    expect(
      await ctx.eventStore.query(featureId, { type: 'task.completed' }),
    ).toHaveLength(0);
  }, 180_000);
});
