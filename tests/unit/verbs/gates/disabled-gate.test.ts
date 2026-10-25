// The behavioural half of the severity denominator: a gate that the project config disables, or makes warning-only.
//
// Under a disabled directive the gate runner does not call the provider. It records a skip in the evidence row.
// It appends the signal row when the runner emits it, or when the action declares it. Thus each declared `always` row exists.
// The cases drive the runner for each provider class, then the real dispatch for each runner mode, then the executor over the
// shipped task-completion runbook. The segment case runs on a stream with no prepared record, and it does not go through settle.
//
// A warning gate passes and keeps its failing record. A disabled mutation gate runs and does not block.
// A disabled static analysis refuses task_complete with a cause of its own, whose recovery names the config.

import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULTS, type ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import type { ResolvedVerificationRuntime } from '../../../../src/config/test-runtime-resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext as HandlerContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
  type DispatchContext as CorrelationContext,
  type GateSeverityDirective,
} from '../../../../src/dispatch/dispatch-context.js';
import {
  AdmissionEvidenceRecordedData,
  GateExecutedData,
  type WorkflowEvent,
} from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { ContentAddressedStore } from '../../../../src/storage/artifacts/content-addressed-store.js';
import { ACTION_HANDLERS, handleOrchestrate } from '../../../../src/verbs/composite.js';
import { handleExecuteIntent, productionExecuteDeps } from '../../../../src/verbs/execute/executor.js';
import { BUILTIN_GATE_PROVIDER_REGISTRY } from '../../../../src/verbs/gates/gate-provider-registry.js';
import {
  gateRunnerObservationSource,
  runGate,
  type GateProviderExecutor,
  type GateRunRequest,
} from '../../../../src/verbs/gates/gate-runner.js';
import { DISABLED_BY_CONFIG, SKIPPED_BY_POLICY } from '../../../../src/verbs/gates/gate-utils.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';

/** The registry held 24 provider classes when this was written. A smaller count means a broken read of the registry. */
const PROVIDER_CLASS_FLOOR = 24;

const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos'];

/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';

/** A diff whose added line the security scan flags, so the scan fails. */
const FLAGGED_DIFF = ['diff --git a/src/a.ts b/src/a.ts', '@@ -0,0 +1 @@', '+const value = eval(input);', ''].join('\n');

const DISABLED = { enabled: false, blocking: true };
const WARNING_ONLY = { enabled: true, blocking: false };

let stateDir: string;
let store: EventStore;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'disabled-gate-state-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** A scratch directory with its real path. The test removes it after each case. */
async function scratchDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

/** The project config with a gate entry for each named action. */
function configWithGates(
  gates: Readonly<Record<string, { readonly enabled: boolean; readonly blocking: boolean }>>,
): ResolvedProjectConfig {
  const entries = Object.fromEntries(
    Object.entries(gates).map(([name, gate]) => [name, { ...gate, params: {} }]),
  );
  return { ...DEFAULTS, review: { ...DEFAULTS.review, gates: { ...DEFAULTS.review.gates, ...entries } } };
}

/** A correlation context with a trusted caller identity, as the dispatch entry mints it. */
function correlation(sessionId: string): CorrelationContext {
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(deriveMcpCallerIdentity({ sessionId }), createInMemoryResolver(CAPABILITIES)),
  );
}

/** A correlation context that carries a skip directive, as the severity wrapper sets it. */
function underDirective(directive: GateSeverityDirective): CorrelationContext {
  return { ...correlation('disabled-gate-runner'), gateSeverity: directive };
}

/** One runner request for a provider class, on its own stream. */
function requestFor(gateClass: string, streamId: string): GateRunRequest {
  return {
    streamId,
    gateClass,
    phaseAttemptId: 'phase-attempt:disabled-gate',
    requirementId: `requirement:${gateClass}`,
    subject: createEvidenceSubject({ kind: 'task', taskId: 'task-disabled' }, { gateClass }),
    providerInput: { taskId: 'task-disabled' },
  };
}

/** A provider spy that fails, so a run of it shows in the verdict. */
function failingProvider(): ReturnType<typeof vi.fn<GateProviderExecutor>> {
  return vi.fn<GateProviderExecutor>(async () => ({ success: true, data: { passed: false } }));
}

/** True for an object record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The data record of a result, or an empty record. */
function dataOf(result: ToolResult): Readonly<Record<string, unknown>> {
  return isRecord(result.data) ? result.data : {};
}

/** The evidence records of one stream. */
async function evidenceOf(streamId: string) {
  return (await store.query(streamId, { type: 'admission.evidence-recorded' })).map((row) =>
    AdmissionEvidenceRecordedData.parse(row.data),
  );
}

/** The `gate.executed` rows of one stream, parsed, with the source of each row. */
async function signalsOf(streamId: string) {
  return (await store.query(streamId, { type: 'gate.executed' })).map((row: WorkflowEvent) => ({
    source: row.source,
    ...GateExecutedData.parse(row.data),
  }));
}

/** The dispatch context of one started workflow, with the project config of the case. */
async function startedWorkflow(featureId: string, projectConfig?: ResolvedProjectConfig): Promise<HandlerContext> {
  const ctx = withTrustedCaller({
    stateDir,
    eventStore: store,
    enableTelemetry: false,
    ...(projectConfig === undefined ? {} : { projectConfig }),
  });
  const init = await dispatch('exarchos_workflow', { action: 'init', featureId, workflowType: 'feature' }, ctx);
  expect(init.success, JSON.stringify(init.error)).toBe(true);
  return ctx;
}

describe('the gate runner under a disabled directive', () => {
  /** Each provider class of the registry records the skip in its evidence row and its signal row, and its provider never runs. */
  it('RunGate_EachProviderClassUnderTheDisabledDirective_RecordsTheSkipAndDoesNotRunTheProvider', async () => {
    const providers = BUILTIN_GATE_PROVIDER_REGISTRY.list();
    expect(providers.length).toBeGreaterThanOrEqual(PROVIDER_CLASS_FLOOR);
    const artifactStore = new ContentAddressedStore(path.join(stateDir, 'artifacts'));

    for (const provider of providers) {
      const streamId = `disabled-${provider.gateClass}`;
      const executeProvider = failingProvider();
      const result = await runWithDispatchContext(
        underDirective({ action: provider.actionName, severity: 'disabled', signal: true }),
        () => runGate(requestFor(provider.gateClass, streamId), { eventStore: store, artifactStore, executeProvider }),
      );

      expect(executeProvider, provider.gateClass).not.toHaveBeenCalled();
      expect(result.success, provider.gateClass).toBe(true);
      expect(dataOf(result)).toMatchObject({ passed: true, skipped: true, discriminant: DISABLED_BY_CONFIG });
      const evidence = await evidenceOf(streamId);
      expect(evidence.map((record) => record.evidence.verdict), provider.gateClass).toEqual(['indeterminate']);
      const signals = await signalsOf(streamId);
      expect(signals.map((row) => [row.gateName, row.passed, row.details?.discriminant]), provider.gateClass).toEqual([
        [provider.gateClass, false, DISABLED_BY_CONFIG],
      ]);
    }
  });

  /**
   * A phase-gate runner emits no signal row of its own. Under the directive, a phase action that declares the row gets it from the runner.
   * The control: the same run with no directive runs the provider and appends no runner row.
   */
  it('RunGate_APhaseGateThatDeclaresTheSignal_AppendsItUnderTheDirective', async () => {
    const artifactStore = new ContentAddressedStore(path.join(stateDir, 'artifacts'));
    const executeProvider = failingProvider();

    await runWithDispatchContext(correlation('disabled-gate-phase-control'), () =>
      runGate(requestFor('security-scan', 'phase-control'), {
        eventStore: store,
        artifactStore,
        executeProvider,
        emitGateExecuted: false,
      }),
    );
    expect(executeProvider).toHaveBeenCalledTimes(1);
    expect(await signalsOf('phase-control')).toEqual([]);

    const result = await runWithDispatchContext(
      underDirective({ action: 'check_security_scan', severity: 'disabled', signal: true }),
      () =>
        runGate(requestFor('security-scan', 'phase-signal'), {
          eventStore: store,
          artifactStore,
          executeProvider,
          emitGateExecuted: false,
        }),
    );

    expect(executeProvider).toHaveBeenCalledTimes(1);
    expect(dataOf(result).discriminant).toBe(DISABLED_BY_CONFIG);
    const signals = await signalsOf('phase-signal');
    expect(signals.map((row) => [row.source, row.gateName, row.details?.skipped, row.details?.discriminant])).toEqual([
      [gateRunnerObservationSource('security-scan'), 'security-scan', true, DISABLED_BY_CONFIG],
    ]);
  });

  /** A phase action that declares no signal row gets none under the directive. Its evidence row still records the skip. */
  it('RunGate_APhaseGateThatDeclaresNoSignal_AppendsNoneUnderTheDirective', async () => {
    const artifactStore = new ContentAddressedStore(path.join(stateDir, 'artifacts'));
    const executeProvider = failingProvider();

    const result = await runWithDispatchContext(
      underDirective({ action: 'check_coverage_thresholds', severity: 'disabled', signal: false }),
      () =>
        runGate(requestFor('coverage-thresholds', 'phase-no-signal'), {
          eventStore: store,
          artifactStore,
          executeProvider,
          emitGateExecuted: false,
        }),
    );

    expect(executeProvider).not.toHaveBeenCalled();
    expect(dataOf(result).discriminant).toBe(DISABLED_BY_CONFIG);
    expect((await evidenceOf('phase-no-signal')).map((record) => record.evidence.verdict)).toEqual(['indeterminate']);
    expect(await signalsOf('phase-no-signal')).toEqual([]);
  });
});

describe('a disabled gate through dispatch', () => {
  /**
   * The three runner modes: a producer gate, a phase gate that declares the signal, and a phase gate that declares none.
   * Dispatch observes the `always` ensures of each action after the handler, so a success here means that they hold.
   * No provider runs: the static analysis scans no package, the scan of a flagged diff passes, and a missing coverage file is not read.
   */
  it('DisabledGate_ThroughDispatchForEachRunnerMode_HoldsItsAlwaysEnsures', async () => {
    const featureId = 'disabled-dispatch';
    const repoRoot = await scratchDir('disabled-gate-repo-');
    const ctx = await startedWorkflow(
      featureId,
      configWithGates({
        check_static_analysis: DISABLED,
        check_security_scan: DISABLED,
        check_coverage_thresholds: DISABLED,
      }),
    );

    const producer = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_static_analysis', featureId, taskId: 'task-disabled', repoRoot },
      ctx,
    );
    const signalPhase = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_security_scan', featureId, diffContent: FLAGGED_DIFF },
      ctx,
    );
    const silentPhase = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_coverage_thresholds', featureId, coverageFile: path.join(repoRoot, 'no-coverage.json') },
      ctx,
    );

    for (const result of [producer, signalPhase, silentPhase]) {
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(dataOf(result)).toMatchObject({ passed: true, skipped: true, discriminant: DISABLED_BY_CONFIG });
    }
    const evidence = await evidenceOf(featureId);
    expect(evidence.map((record) => [record.evidence.producer.providerRef, record.evidence.verdict])).toEqual([
      ['check_static_analysis', 'indeterminate'],
      ['check_security_scan', 'indeterminate'],
      ['check_coverage_thresholds', 'indeterminate'],
    ]);
    const signals = await signalsOf(featureId);
    expect(signals.map((row) => [row.source, row.gateName, row.details?.discriminant])).toEqual([
      [gateRunnerObservationSource('static-analysis'), 'static-analysis', DISABLED_BY_CONFIG],
      [gateRunnerObservationSource('security-scan'), 'security-scan', DISABLED_BY_CONFIG],
    ]);
  }, 60_000);

  /**
   * A warning gate passes its leaf with a warning, and its record keeps the failing verdict.
   * The control: the same scan with no gate entry fails.
   */
  it('WarningGate_AFailingPhaseGate_PassesTheLeafAndKeepsTheRecord', async () => {
    const blocking = await startedWorkflow('warning-control');
    const control = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_security_scan', featureId: 'warning-control', diffContent: FLAGGED_DIFF },
      blocking,
    );
    expect(dataOf(control).passed).toBe(false);

    const featureId = 'warning-gate';
    const ctx = await startedWorkflow(featureId, configWithGates({ check_security_scan: WARNING_ONLY }));
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_security_scan', featureId, diffContent: FLAGGED_DIFF },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(dataOf(result).passed).toBe(true);
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining("Gate 'check_security_scan' failed but is configured as warning-only")]),
    );
    expect((await evidenceOf(featureId)).map((record) => record.evidence.verdict)).toEqual(['fail']);
    expect((await signalsOf(featureId)).map((row) => [row.gateName, row.passed])).toEqual([['security-scan', false]]);
  }, 60_000);

  /**
   * The directive wins over the policy skip of the kill probe, because the runner reads it before the provider.
   * The control: the same low-tier call with no gate entry gives the policy skip.
   */
  it('DisabledGate_APolicySkip_LosesToTheDirective', async () => {
    const repoRoot = await scratchDir('disabled-gate-policy-');
    const args = {
      action: 'check_test_adequacy',
      taskId: 'task-policy',
      repoRoot,
      riskTier: 'low',
      boundaryTouching: false,
      baseBranch: 'main',
    };

    const plain = await startedWorkflow('policy-control');
    const control = await dispatch('exarchos_orchestrate', { ...args, featureId: 'policy-control' }, plain);
    expect(dataOf(control).discriminant).toBe(SKIPPED_BY_POLICY);

    const ctx = await startedWorkflow('policy-disabled', configWithGates({ check_test_adequacy: DISABLED }));
    const result = await dispatch('exarchos_orchestrate', { ...args, featureId: 'policy-disabled' }, ctx);

    expect(result.success).toBe(true);
    expect(dataOf(result)).toMatchObject({ passed: true, skipped: true, discriminant: DISABLED_BY_CONFIG });
  }, 60_000);

  /** A disabled static analysis records no pass, so task_complete refuses with the disabled-by-config cause and the config recovery. */
  it('TaskComplete_AfterADisabledStaticAnalysis_IsRefusedWithTheConfigRecovery', async () => {
    const featureId = 'disabled-static-analysis';
    const taskId = 'task-static';
    const repoRoot = await scratchDir('disabled-gate-static-');
    const ctx = await startedWorkflow(featureId, configWithGates({ check_static_analysis: DISABLED }));

    const gate = await dispatch('exarchos_orchestrate', { action: 'check_static_analysis', featureId, taskId, repoRoot }, ctx);
    expect(dataOf(gate).discriminant).toBe(DISABLED_BY_CONFIG);

    const complete = await dispatch('exarchos_orchestrate', { action: 'task_complete', taskId, streamId: featureId }, ctx);

    expect(complete.success).toBe(false);
    expect(complete.error?.code).toBe('GATE_NOT_PASSED');
    expect(complete.error?.message).toContain('is a disabled-by-config skip');
    expect(complete.error?.message).toContain('Enable check_static_analysis in the .exarchos.yml of the checkout');
    expect(await store.query(featureId, { type: 'task.completed' })).toEqual([]);
  }, 60_000);
});

/** A Stryker report with one killed and two surviving mutants: a score of one third, under the default threshold. */
const LOW_SCORE_REPORT = JSON.stringify({
  schemaVersion: '1',
  files: {
    'src/calc.ts': {
      language: 'typescript',
      mutants: ['Killed', 'Survived', 'Survived'].map((status, index) => ({
        id: `m${index}`,
        mutatorName: 'ArithmeticOperator',
        status,
        location: { start: { line: index + 1, column: 1 }, end: { line: index + 1, column: 9 } },
      })),
    },
  },
});

/** The mutation command resolves, so the handler reaches its injected runner. */
const RUNTIME: ResolvedVerificationRuntime = {
  test: 'npm test',
  typecheck: null,
  install: null,
  source: 'detection',
  mutation: 'npx stryker run',
  lint: null,
  contract: null,
};

describe('a disabled mutation gate', () => {
  /** The mutation gate appends its own rows, so `disabled` acts as `warning`: the handler runs and its low score does not block. */
  it('DisabledGate_MutationAdequacy_RunsAndDoesNotBlock', async () => {
    const runMutation = vi.fn(() => ({ ok: true, report: LOW_SCORE_REPORT }));
    const ctx: HandlerContext = {
      stateDir,
      eventStore: store,
      enableTelemetry: false,
      projectConfig: configWithGates({ 'mutation-adequacy': DISABLED }),
    };

    const result = await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'disabled-mutation',
        base: 'main',
        resolve: () => RUNTIME,
        detectToolchainId: () => 'node',
        runDiff: (): readonly string[] => [],
        runMutation,
      },
      ctx,
    );

    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(dataOf(result).passed).toBe(true);
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining("Gate 'mutation-adequacy' failed but is configured as warning-only")]),
    );
  });
});

/** A task branch that changes the source and ships a test that never reads it. The kill probe blocks on it when it runs. */
async function vacuousTaskWorktree(): Promise<string> {
  const dir = await scratchDir('disabled-gate-worktree-');
  const git = async (args: readonly string[]): Promise<void> => {
    await execFileAsync('git', args, { cwd: dir, timeout: 30_000 });
  };
  const scripts = { 'test:run': 'node --test', lint: OK, typecheck: OK, 'quality-check': OK };
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'disabled-gate-segment', version: '1.0.0', private: true, scripts }, null, 2),
    'utf-8',
  );
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'answer.mjs'), 'export const answer = 41;\n', 'utf-8');
  await git(['init', '--initial-branch=main', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'base']);
  await git(['checkout', '-q', '-b', 'task/vacuous']);
  await writeFile(path.join(dir, 'src', 'answer.mjs'), 'export const answer = 42;\n', 'utf-8');
  await writeFile(
    path.join(dir, 'src', 'answer.test.mjs'),
    "import { test } from 'node:test';\n\ntest('runs', () => {});\n",
    'utf-8',
  );
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'ship the change with a test that does not read it']);
  return dir;
}

/** The action and the status of each leaf of an executor receipt. */
function leavesOf(result: ToolResult): string[][] {
  const leaves = dataOf(result).leaves;
  return Array.isArray(leaves)
    ? leaves.flatMap((leaf: unknown) =>
        isRecord(leaf) && typeof leaf.action === 'string' && typeof leaf.status === 'string'
          ? [[leaf.action, leaf.status]]
          : [],
      )
    : [];
}

describe('a disabled kill probe in the task-completion segment', () => {
  /**
   * The config disables the kill probe. The leaf skips, the segment does not halt, and the task completes on its static-analysis pass.
   * The args carry no `capsuleVersion`, and the stream holds no prepared record. The task is not boundary-touching,
   * so the policy skips contract drift and mock boundary.
   */
  it('DisabledGate_AKillProbeInTheSegment_SkipsAndTheTaskCompletes', async () => {
    const streamId = 'disabled-segment';
    const taskId = 'task-segment';
    const worktreePath = await vacuousTaskWorktree();
    await seedActivePhaseAttempt(store, streamId);
    const ctx: HandlerContext = {
      stateDir,
      eventStore: store,
      enableTelemetry: false,
      projectConfig: configWithGates({ check_test_adequacy: DISABLED }),
    };

    const result = await runWithDispatchContext(correlation('disabled-gate-segment'), () =>
      handleExecuteIntent(
        {
          intent: 'task-completion',
          streamId,
          args: {
            taskId,
            worktreePath,
            riskTier: 'medium',
            boundaryTouching: false,
            baseRef: 'main',
            result: { worktreePath },
          },
        },
        stateDir,
        ctx,
        productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(leavesOf(result)).toEqual([
      ['check_test_adequacy', 'passed'],
      ['check_contract_drift', 'passed'],
      ['check_mock_boundary', 'passed'],
      ['check_static_analysis', 'passed'],
      ['task_complete', 'passed'],
    ]);
    const killProbe = (await signalsOf(streamId)).filter((row) => row.gateName === 'test-adequacy');
    expect(killProbe.map((row) => [row.passed, row.details?.discriminant])).toEqual([[false, DISABLED_BY_CONFIG]]);
    expect(await store.query(streamId, { type: 'task.completed' })).toHaveLength(1);
  }, 120_000);
});
