import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  staticStatus: 'pass' as 'pass' | 'fail' | 'skip',
  probePassed: true,
  probeDiscriminant: undefined as string | undefined,
  contractPassed: true,
  contractSkipped: false,
  mockFindings: [] as Array<{
    file: string;
    line: number;
    identifier: string;
    mockedTarget: string;
    unowned: boolean;
  }>,
  mockSeverity: 'warning' as 'warning' | 'blocking',
}));

vi.mock('../../../src/verbs/pure/static-analysis.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/verbs/pure/static-analysis.js')>();
  return {
    ...actual,
    runStaticAnalysis: () =>
      controls.staticStatus === 'skip'
        ? {
            status: 'skip',
            output: 'static skipped',
            skipReason: 'no-toolchain',
            passCount: 0,
            failCount: 0,
            // T-09 / DR-6: `skipCount` is part of the StaticAnalysisResult
            // contract — the handler destructures it, so a double that omits
            // it drifts from the real pure module.
            skipCount: 0,
          }
        : {
            status: controls.staticStatus,
            output: `static ${controls.staticStatus}`,
            passCount: controls.staticStatus === 'pass' ? 2 : 1,
            failCount: controls.staticStatus === 'pass' ? 0 : 1,
            skipCount: 0,
          },
  };
});

vi.mock('../../../src/verbs/gates/test-adequacy.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/verbs/gates/test-adequacy.js')>();
  return {
    ...actual,
    runProbe: async () => ({
      passed: controls.probePassed,
      redObserved: controls.probePassed,
      restoredClean: true,
      probedTests: ['src/example.test.ts'],
      ...(controls.probeDiscriminant
        ? { discriminant: controls.probeDiscriminant }
        : {}),
      report: 'adequacy report',
    }),
  };
});

vi.mock('../../../src/verbs/gates/contract-drift.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/verbs/gates/contract-drift.js')>();
  return {
    ...actual,
    runContractDrift: async () => ({
      passed: controls.contractPassed,
      drift: !controls.contractPassed,
      breaking: controls.contractPassed ? [] : ['removed field'],
      report: 'contract report',
      ...(controls.contractSkipped ? { skipped: true } : {}),
    }),
  };
});

vi.mock('../../../src/verbs/gates/mock-boundary.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/verbs/gates/mock-boundary.js')>();
  return {
    ...actual,
    detectMockFindings: () => controls.mockFindings,
  };
});

vi.mock('../../../src/verbs/gates/gate-severity.js', () => ({
  resolveGateSeverity: () => controls.mockSeverity,
}));

import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../../src/events/store.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { ToolResult } from '../../../src/format.js';
import { handleCheckIntegrationSuite } from '../../../src/verbs/gates/check-integration-suite.js';
import { handleContractDrift } from '../../../src/verbs/gates/contract-drift-handler.js';
import { handleMockBoundary } from '../../../src/verbs/gates/mock-boundary-handler.js';
import { handleStaticAnalysis } from '../../../src/verbs/gates/static-analysis.js';
import { handleTestAdequacy } from '../../../src/verbs/gates/test-adequacy-handler.js';

type GateName =
  | 'static-analysis'
  | 'test-adequacy'
  | 'integration-suite'
  | 'contract-drift'
  | 'mock-boundary';

class RecordingStore {
  readonly events: WorkflowEvent[] = [];
  failAppend = false;

  constructor(readonly featureId: string, readonly phaseAttemptId: string) {
    this.events.push({
      id: 'seed-event',
      streamId: featureId,
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2026-07-21T22:00:00.000Z',
      data: {
        featureId,
        workflowType: 'feature',
        phaseAttemptId,
      },
    } as WorkflowEvent);
  }

  async query(
    streamId: string,
    filters?: { readonly type?: string },
  ): Promise<WorkflowEvent[]> {
    return this.events.filter(
      (event) =>
        event.streamId === streamId &&
        (filters?.type === undefined || event.type === filters.type),
    );
  }

  async append(
    streamId: string,
    event: Omit<WorkflowEvent, 'id' | 'streamId' | 'sequence'>,
  ): Promise<WorkflowEvent> {
    if (this.failAppend) throw new Error('append unavailable');
    const persisted = {
      ...event,
      id: `event-${this.events.length + 1}`,
      streamId,
      sequence: this.events.length + 1,
      timestamp: event.timestamp ?? '2026-07-21T22:01:00.000Z',
    } as WorkflowEvent;
    this.events.push(persisted);
    return persisted;
  }
}

function trustedContext(sessionId: string) {
  const identity = deriveMcpCallerIdentity({ sessionId });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(
      identity,
      createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec']),
    ),
  );
}

function integrationJson(passed: boolean): string {
  return JSON.stringify({
    numTotalTestSuites: 1,
    numFailedTestSuites: passed ? 0 : 1,
    numTotalTests: 1,
    numFailedTests: passed ? 0 : 1,
    success: passed,
    testResults: passed
      ? []
      : [{ name: 'broken.test.ts', status: 'failed', assertionResults: [{}] }],
  });
}

describe('migrated ladder gate durable evidence', () => {
  const roots: string[] = [];
  let root: string;
  let store: RecordingStore;
  const featureId = 'feature-evidence';
  const taskId = 'task-008';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ladder-evidence-'));
    roots.push(root);
    store = new RecordingStore(featureId, 'phase-attempt:implement-008');
    controls.staticStatus = 'pass';
    controls.probePassed = true;
    controls.probeDiscriminant = undefined;
    controls.contractPassed = true;
    controls.contractSkipped = false;
    controls.mockFindings = [];
    controls.mockSeverity = 'warning';
  });

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function invoke(
    gate: GateName,
    outcome: 'pass' | 'fail' | 'advisory' = 'pass',
  ): Promise<ToolResult> {
    controls.staticStatus =
      outcome === 'fail' ? 'fail' : outcome === 'advisory' ? 'skip' : 'pass';
    controls.probePassed = outcome !== 'fail';
    controls.probeDiscriminant = outcome === 'advisory' ? 'no-new-tests' : undefined;
    controls.contractPassed = outcome !== 'fail';
    controls.contractSkipped = outcome === 'advisory';
    controls.mockFindings =
      outcome === 'pass'
        ? []
        : [{
            file: 'src/example.test.ts',
            line: 1,
            identifier: 'mock',
            mockedTarget: 'axios',
            unowned: true,
          }];
    controls.mockSeverity = outcome === 'fail' ? 'blocking' : 'warning';

    const eventStore = store as unknown as EventStore;
    const common = {
      featureId,
      taskId,
      branch: 'feature/task-008',
      baseBranch: 'integration',
      repoRoot: root,
    };
    const run = () => {
      switch (gate) {
        case 'static-analysis':
          return handleStaticAnalysis(common, root, eventStore);
        case 'test-adequacy':
          return handleTestAdequacy({
            ...common,
            gitExec: () => ({ stdout: '', exitCode: 0 }),
            runTests: async () => ({ passed: true, output: '' }),
          }, root, eventStore);
        case 'integration-suite':
          // `testScript` is not decoration: this gate resolves its command from
          // the repository, and `root` is a bare temp directory, so without a
          // named script nothing resolves and the stub runner is never reached.
          // These cases are about the durable-evidence plumbing every ladder gate
          // shares — command resolution has its own suite — so the fixture names
          // the script rather than growing a Node project around it.
          return handleCheckIntegrationSuite(
            { ...common, testScript: 'test:run' },
            root,
            eventStore,
            () => ({
              exitCode: outcome === 'fail' ? 1 : 0,
              stdout: integrationJson(outcome !== 'fail'),
              stderr: '',
            }),
          );
        case 'contract-drift':
          return handleContractDrift({
            ...common,
            gitExec: () => ({ stdout: '', exitCode: 0 }),
            runCommand: async () => ({ exitCode: 0, stdout: '' }),
          }, root, eventStore);
        case 'mock-boundary':
          return handleMockBoundary({
            ...common,
            gitExec: () => ({ stdout: '', exitCode: 0 }),
            loadConfig: () => null,
          }, root, eventStore);
      }
    };
    return runWithDispatchContext(trustedContext(`${gate}-${outcome}`), run);
  }

  function evidenceEvents() {
    return store.events.filter(
      (event) => event.type === 'admission.evidence-recorded',
    );
  }

  it.each<GateName>([
    'static-analysis',
    'test-adequacy',
    'integration-suite',
    'contract-drift',
    'mock-boundary',
  ])('LadderGate_TaskSubject_EmitsEvidence [%s]', async (gate) => {
    const result = await invoke(gate);

    expect(result).toMatchObject({
      success: true,
      data: {
        passed: true,
        evidenceReferences: [
          { subject: { kind: 'task', taskId } },
        ],
      },
    });
    expect(evidenceEvents()).toHaveLength(1);
    expect(evidenceEvents()[0]?.data).toMatchObject({
      evidence: {
        phaseAttemptId: 'phase-attempt:implement-008',
        subject: { kind: 'task', taskId },
        verdict: 'pass',
      },
    });
    expect(evidenceEvents().some((event) => event.type === 'gate.executed'))
      .toBe(false);
  });

  it.each<GateName>([
    'static-analysis',
    'test-adequacy',
    'integration-suite',
    'contract-drift',
    'mock-boundary',
  ])('LadderGate_FailureCarrier_PersistsFailEvidence [%s]', async (gate) => {
    const result = await invoke(gate, 'fail');

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(false);
    expect(evidenceEvents()[0]?.data).toMatchObject({
      evidence: { verdict: 'fail' },
    });
  });

  it.each<GateName>([
    'static-analysis',
    'test-adequacy',
    'integration-suite',
    'contract-drift',
    'mock-boundary',
  ])('LadderGate_AppendFailure_CannotReturnSuccess [%s]', async (gate) => {
    store.failAppend = true;
    const result = await invoke(gate);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'EVIDENCE_APPEND_FAILED', message: 'append unavailable' },
    });
    expect(evidenceEvents()).toHaveLength(0);
  });

  it.each<GateName>([
    'static-analysis',
    'test-adequacy',
    'contract-drift',
    'mock-boundary',
  ])('LadderGate_AdvisoryOutcome_PreservesCarrierAndEvidence [%s]', async (gate) => {
    const result = await invoke(gate, 'advisory');
    const data = result.data as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(data.evidenceReferences).toEqual([expect.any(Object)]);
    if (gate === 'static-analysis') {
      expect(data).toMatchObject({ passed: false, skipped: true, passCount: 0 });
    } else if (gate === 'test-adequacy') {
      expect(data).toMatchObject({
        passed: true,
        discriminant: 'no-new-tests',
        restoredClean: true,
      });
    } else if (gate === 'contract-drift') {
      expect(data).toMatchObject({ passed: true, skipped: true, breaking: [] });
    } else {
      expect(data).toMatchObject({
        passed: true,
        severity: 'warning',
        findings: [expect.any(Object)],
      });
    }
    expect(evidenceEvents()).toHaveLength(1);
  });

  it('IntegrationSuite_CannotResolveACommand_RecordsIndeterminateNotPass', async () => {
    // The arm the shared table above cannot express: this gate is the only one
    // whose carrier omits `passed` entirely. What it must NOT do is record proof.
    // Nothing downstream turns this verdict into a stop for this gate class, so
    // the evidence row saying `indeterminate` and the report saying the rung is
    // not cleared are the whole of what the system has — which is exactly why
    // they are pinned here rather than assumed.
    const eventStore = store as unknown as EventStore;
    const result = await runWithDispatchContext(
      trustedContext('integration-suite-indeterminate'),
      () =>
        handleCheckIntegrationSuite(
          { featureId, taskId, branch: 'feature/task-008', repoRoot: root },
          root,
          eventStore,
          () => {
            throw new Error('the runner must never be reached');
          },
        ),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.skipped).toBe(true);
    expect(data.skipReason).toBe('no-toolchain');
    expect(data).not.toHaveProperty('passed');
    expect(String(data.report)).toContain('NOT cleared');
    expect(evidenceEvents()[0]?.data).toMatchObject({
      evidence: { verdict: 'indeterminate' },
    });
  });

  it('LadderGate_SameOperationIsIdempotent_NewOperationSupersedes', async () => {
    const context = trustedContext('idempotent-operation');
    const eventStore = store as unknown as EventStore;
    const args = {
      featureId,
      taskId,
      branch: 'feature/task-008',
      repoRoot: root,
    };
    const first = await runWithDispatchContext(context, () =>
      handleStaticAnalysis(args, root, eventStore));
    const retry = await runWithDispatchContext(context, () =>
      handleStaticAnalysis(args, root, eventStore));
    const rerun = await runWithDispatchContext(trustedContext('rerun'), () =>
      handleStaticAnalysis(args, root, eventStore));

    const firstRef = (first.data as { evidenceReferences: Array<{ evidenceId: string }> })
      .evidenceReferences[0]!;
    const retryRef = (retry.data as { evidenceReferences: Array<{ evidenceId: string }> })
      .evidenceReferences[0]!;
    const rerunRef = (rerun.data as {
      evidenceReferences: Array<{
        evidenceId: string;
        supersedesEvidenceId: string;
      }>;
    }).evidenceReferences[0]!;
    expect(retryRef.evidenceId).toBe(firstRef.evidenceId);
    expect(rerunRef.supersedesEvidenceId).toBe(firstRef.evidenceId);
    expect(evidenceEvents()).toHaveLength(2);
  });

  it('LadderGate_UntrustedDirectCall_IsRejectedBeforeProviderExecution', async () => {
    const result = await handleStaticAnalysis(
      { featureId, taskId, repoRoot: root },
      root,
      store as unknown as EventStore,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'TRUSTED_CALLER_REQUIRED' },
    });
    expect(evidenceEvents()).toHaveLength(0);
  });
});
