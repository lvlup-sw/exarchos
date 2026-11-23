/**
 * Tests for `handlePrepareSynthesis`. The phase-gate runner is a stub that calls only the provider.
 * The test and typecheck legs come from a stubbed lifecycle check of the local executor, and the Git reads from a stubbed constrained observation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolResult } from '../../../../src/format.js';
import type { EventStore } from '../../../../src/events/store.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execSync, execFileSync } from 'node:child_process';

vi.mock('../../../../src/config/test-runtime-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/config/test-runtime-resolver.js')>();
  return { ...actual, resolveRunnableCommand: vi.fn(actual.resolveRunnableCommand) };
});

import { resolveRunnableCommand } from '../../../../src/config/test-runtime-resolver.js';

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/verbs/gates/gate-utils.js')>()),
  observeCurrentCheckout: vi.fn(),
}));

vi.mock('../../../../src/verbs/verification/lifecycle-check.js', () => ({
  admitLifecycleLegs: vi.fn(),
}));

vi.mock('../../../../src/utils/git-tree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/utils/git-tree.js')>()),
  processObservationalGitPath: vi.fn(() => GIT_PATH),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
  HostedAdequacyPending: class extends Error {},
  hostedPendingResult: vi.fn((error: unknown) => { throw error; }),
}));

import { getOrCreateMaterializer } from '../../../../src/projections/views/tools.js';

import {
  handlePrepareSynthesis,
  evaluateDocumentLeg,
  documentLegBlocks,
  type DocumentLegConfig,
} from '../../../../src/verbs/team/prepare-synthesis.js';
import type { ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import { runPhaseGateWithEvidence } from '../../../../src/verbs/gates/gate-runner.js';
import { admitLifecycleLegs } from '../../../../src/verbs/verification/lifecycle-check.js';
import { observeCurrentCheckout, type CurrentCheckoutRead } from '../../../../src/verbs/gates/gate-utils.js';
import { processObservationalGitPath } from '../../../../src/utils/git-tree.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STATE_DIR = '/tmp/test-state-prepare-synthesis';

/** The process-wide Git path of the stubbed observational reads. */
const GIT_PATH = '/usr/bin/git';

function mockTaskDetailView(tasks: Record<string, { status: string }>) {
  return {
    tasks: Object.fromEntries(
      Object.entries(tasks).map(([id, t]) => [
        id,
        { taskId: id, title: `Task ${id}`, status: t.status },
      ]),
    ),
  };
}

function createMockMaterializer(taskView: unknown) {
  return {
    materialize: vi.fn().mockReturnValue(taskView),
    loadFromSnapshot: vi.fn().mockResolvedValue(false),
    getState: vi.fn().mockReturnValue(undefined),
  };
}

/**
 * Convert a task-status map into the canonical event sequence the
 * workflowStateProjection folds (task.assigned + task.completed/failed). Used to
 * drive readiness through resolveWorkflowState — the same source exarchos_workflow
 * get uses (#1536) — instead of the divergent task-detail materializer.
 */
function tasksToEvents(tasks: Record<string, { status: string }>): unknown[] {
  const events: unknown[] = [];
  let seq = 0;
  for (const [id, t] of Object.entries(tasks)) {
    events.push({
      type: 'task.assigned',
      timestamp: `2026-06-17T00:00:${String(seq++).padStart(2, '0')}Z`,
      data: { taskId: id, title: `Task ${id}` },
    });
    if (t.status === 'completed' || t.status === 'complete') {
      events.push({
        type: 'task.completed',
        timestamp: `2026-06-17T00:00:${String(seq++).padStart(2, '0')}Z`,
        data: { taskId: id },
      });
    } else if (t.status === 'failed') {
      events.push({
        type: 'task.failed',
        timestamp: `2026-06-17T00:00:${String(seq++).padStart(2, '0')}Z`,
        data: { taskId: id },
      });
    }
  }
  return events;
}

function createMockEventStore(events: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue(events),
    append: vi.fn().mockImplementation(async (_streamId: string, event: Record<string, unknown>) => ({
      streamId: _streamId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      ...event,
    })),
    batchAppend: vi.fn().mockResolvedValue([]),
  };
}

/** The fixture `.exarchos.yml` resolves these programs for the test and typecheck legs. */
const FIXTURE_CONFIG = "test: 'vitest run'\ntypecheck: 'tsc --noEmit'\n";

type LegStub = string | (Error & { stdout?: Buffer; status?: number });

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const MERGE_BASE = 'd'.repeat(40);

/** The answers of the stubbed constrained reads. An Error rejects that read. */
interface GitStub {
  defaultBranch: string | Error;
  log: string;
  diff: string;
  mergeBase: string | Error;
}

let git: GitStub;

/** The stubbed constrained reads of the current checkout. The spies record the arguments of each read. */
const reads = {
  originHead: vi.fn(async () => {
    if (git.defaultBranch instanceof Error) throw git.defaultBranch;
    return `refs/remotes/origin/${git.defaultBranch}\n`;
  }),
  commitRange: vi.fn(async (_gitDir: string, _checkout: string, _base: string, _head: string) => git.log),
  mergeBase: vi.fn(async () => {
    if (git.mergeBase instanceof Error) throw git.mergeBase;
    return `${git.mergeBase}\n`;
  }),
  nameOnly: vi.fn(async (_gitDir: string, _checkout: string, _base: string, _head: string) => git.diff),
};

/** The stubbed base resolution. It records each base name. */
const resolveBase = vi.fn(async (_checkout: unknown, _name: string) => ({ kind: 'observed', value: BASE }));

/** The stubbed observation of the checkout at `checkout`. */
function observedAt(checkout: string): CurrentCheckoutRead {
  return {
    kind: 'observed',
    checkout: { checkout, repository: `${checkout}/.git`, gitDir: `${checkout}/.git`, branch: 'refs/heads/task', head: HEAD },
    observer: { reads, base: resolveBase },
  } as unknown as CurrentCheckoutRead;
}

/** One observed leg run of a stub: a string exits 0 with that output, and an Error exits non-zero with its output. */
function localRun(stub: LegStub | undefined) {
  const failed = stub instanceof Error;
  const stdout = failed ? stub.stdout?.toString('utf-8') ?? '' : stub ?? '';
  const stderr = failed && stdout.length === 0 ? stub.message : '';
  return { argv: ['leg'], end: 'exited' as const, exitCode: failed ? stub.status ?? 1 : 0, stdout, stderr };
}

/** Answers the legs through the lifecycle check of the local executor, and the changed files through the constrained name-only diff. */
function stubLegs(legs: { test?: LegStub; typecheck?: LegStub; diff?: string } = {}): void {
  vi.mocked(admitLifecycleLegs).mockResolvedValue([
    { name: 'test', kind: 'command', run: localRun(legs.test) },
    { name: 'typecheck', kind: 'typecheck', run: localRun(legs.typecheck) },
  ]);
  git.diff = legs.diff ?? '';
}

/** Answers the origin HEAD read and the commit range read. */
function stubGit(stub: { defaultBranch?: string; log?: string } = {}): void {
  git.defaultBranch = stub.defaultBranch ?? 'main';
  git.log = stub.log ?? '';
}

/** The legs of one program that the lifecycle check received, with the checkout of each request. */
function runsOf(bin: string): { readonly args: readonly string[]; readonly checkout: string }[] {
  return vi.mocked(admitLifecycleLegs).mock.calls.flatMap(([input]) =>
    input.legs.filter((leg) => leg.argv[0] === bin).map((leg) => ({ args: leg.argv.slice(1), checkout: input.checkout })));
}

describe('handlePrepareSynthesis', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReset();
    vi.mocked(execFileSync).mockReset();
    git = { defaultBranch: 'main', log: '', diff: '', mergeBase: MERGE_BASE };
    vi.mocked(observeCurrentCheckout).mockImplementation(async (_gitPath, repoRoot) => observedAt(repoRoot));
    stubGit();
    stubLegs();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-synthesis-'));
    await fs.writeFile(path.join(tmpDir, '.exarchos.yml'), FIXTURE_CONFIG);
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir).catch(() => {});
  });

  it('PrepareSynthesis_MissingFeatureId_ReturnsInvalidInput', async () => {
    const args = {} as { featureId: string; repoRoot: string };

    const result = await handlePrepareSynthesis(args, STATE_DIR, createMockEventStore() as unknown as EventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  /** The event log completes `t1` and only assigns `t2` and `t3`, so `t2` and `t3` block synthesis. */
  it('PrepareSynthesis_TasksIncomplete_ReturnsBlockers', async () => {
    const mockStore = createMockEventStore(
      tasksToEvents({
        t1: { status: 'completed' },
        t2: { status: 'in-progress' },
        t3: { status: 'assigned' },
      }),
    );

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; blockers: string[] };
    expect(data.ready).toBe(false);
    expect(data.blockers).toBeDefined();
    expect(data.blockers.length).toBeGreaterThan(0);
    expect(data.blockers.some((b: string) => b.includes('t2'))).toBe(true);
    expect(data.blockers.some((b: string) => b.includes('t3'))).toBe(true);
  });

  /**
   * The task-detail materializer reports task `024` in progress, but the event log
   * completes it. Readiness reads the event log through `resolveWorkflowState`, so no
   * blocker names `024`.
   */
  it('PrepareSynthesis_MaterializerDisagreesWithEventLog_NoPhantomBlocker', async () => {
    const phantomView = mockTaskDetailView({ '024': { status: 'in-progress' } });
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      createMockMaterializer(phantomView) as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    const mockStore = createMockEventStore(tasksToEvents({ '024': { status: 'completed' } }));
    stubLegs({ test: 'Tests: 1 passed, 0 failed' });

    const result = await handlePrepareSynthesis(
      { featureId: 'f', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    const data = result.data as { blockers?: string[] };
    expect((data.blockers ?? []).some((b: string) => b.includes('024'))).toBe(false);
  });

  it('PrepareSynthesis_TestsRun_EmitsTestResultEvent', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs({ test: 'Tests: 10 passed, 0 failed' });

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const appendCalls = mockStore.append.mock.calls;
    const testGateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'test-suite';
      },
    );
    expect(testGateCall).toBeDefined();
    const testEvent = testGateCall![1] as { data: { passed: boolean; layer: string } };
    expect(testEvent.data.passed).toBe(true);
    expect(testEvent.data.layer).toBe('CI');
  });

  it('PrepareSynthesis_TypecheckRun_EmitsTypecheckEvent', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs();

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const appendCalls = mockStore.append.mock.calls;
    const typecheckGateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'typecheck';
      },
    );
    expect(typecheckGateCall).toBeDefined();
    const typecheckEvent = typecheckGateCall![1] as { data: { passed: boolean; layer: string } };
    expect(typecheckEvent.data.passed).toBe(true);
    expect(typecheckEvent.data.layer).toBe('CI');
  });

  it('PrepareSynthesis_TestSuiteGateEvent_IncludesPhaseInDetails', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs({ test: 'Tests: 10 passed, 0 failed' });

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const appendCalls = mockStore.append.mock.calls;
    const testGateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'test-suite';
      },
    );
    expect(testGateCall).toBeDefined();
    const testEvent = testGateCall![1] as { data: { details: Record<string, unknown> } };
    expect(testEvent.data.details.phase).toBe('synthesize');
  });

  it('PrepareSynthesis_TypecheckGateEvent_IncludesPhaseInDetails', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs();

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const appendCalls = mockStore.append.mock.calls;
    const typecheckGateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'typecheck';
      },
    );
    expect(typecheckGateCall).toBeDefined();
    const typecheckEvent = typecheckGateCall![1] as { data: { details: Record<string, unknown> } };
    expect(typecheckEvent.data.details.phase).toBe('synthesize');
  });

  it('verifyStack_UsesGitLog_NotGtLog', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs({ test: 'Tests: 5 passed' });
    stubGit({ log: '* abc1234 feat: add feature\n* def5678 fix: bug fix' });

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(reads.commitRange).toHaveBeenCalledWith(`${tmpDir}/.git`, tmpDir, BASE, HEAD);
    expect(execSync).not.toHaveBeenCalled();

    const data = result.data as { stack: { healthy: boolean; branches: string[] } };
    expect(data.stack).toBeDefined();
    expect(data.stack.healthy).toBe(true);
    expect(data.stack.branches).toBeDefined();
  });

  it('verifyStack_NonMainDefaultBranch_UsesDetectedBranch', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs({ test: 'Tests: 5 passed' });
    stubGit({ defaultBranch: 'trunk', log: '* abc1234 feat: add feature' });

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(resolveBase.mock.calls.map((call) => call[1])).toEqual(['trunk']);
    expect(reads.commitRange).toHaveBeenCalledWith(`${tmpDir}/.git`, tmpDir, BASE, HEAD);
  });

  it('PrepareSynthesis_AllGreen_ReturnsReady', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
      't2': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs({ test: 'Tests: 10 passed, 0 failed' });
    stubGit({ log: 'main\n  feature-branch' });

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      tests: { passed: boolean };
      typecheck: { passed: boolean };
      stack: { healthy: boolean };
    };
    expect(data.ready).toBe(true);
    expect(data.tests.passed).toBe(true);
    expect(data.typecheck.passed).toBe(true);
    expect(data.stack.healthy).toBe(true);
  });

  it('PrepareSynthesis_ValidInput_ReturnsReadiness', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs();

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      readiness: { tasksComplete: boolean; testsPass: boolean; typecheckPass: boolean; stackHealthy: boolean };
      tests: { passed: boolean; passCount: number; failCount: number };
      typecheck: { passed: boolean; errorCount: number };
      stack: { healthy: boolean };
    };
    expect(data.readiness).toBeDefined();
    expect(data.tests).toBeDefined();
    expect(data.typecheck).toBeDefined();
    expect(data.stack).toBeDefined();
  });

  /** The `gate.executed` event for the test suite feeds `CodeQualityView`. */
  it('PrepareSynthesis_TestsRun_EmitsGateExecutedEvent', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs({ test: 'Tests: 5 passed, 2 failed' });

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const appendCalls = mockStore.append.mock.calls;
    const gateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string; layer: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'test-suite' && event.data.layer === 'CI';
      },
    );
    expect(gateCall).toBeDefined();
  });

  /** The `gate.executed` event for the typecheck feeds `CodeQualityView`. */
  it('PrepareSynthesis_TypecheckRun_EmitsGateExecutedEvent', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    stubLegs();

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const appendCalls = mockStore.append.mock.calls;
    const gateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string; layer: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'typecheck' && event.data.layer === 'CI';
      },
    );
    expect(gateCall).toBeDefined();
  });

  it('PrepareSynthesis_TestsFail_ReturnsNotReady', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    const testError = new Error('Tests failed') as Error & { stdout: Buffer; status: number };
    testError.stdout = Buffer.from('Tests: 3 passed, 2 failed');
    testError.status = 1;
    stubLegs({ test: testError });
    stubGit({ log: 'main' });

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; tests: { passed: boolean } };
    expect(data.ready).toBe(false);
    expect(data.tests.passed).toBe(false);
  });

  it('PrepareSynthesis_TypecheckFails_ReturnsNotReady', async () => {
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    const typecheckError = new Error('Typecheck failed') as Error & { stdout: Buffer; status: number };
    typecheckError.stdout = Buffer.from('error TS2322: Type string not assignable\nerror TS2345: Argument mismatch');
    typecheckError.status = 1;
    stubLegs({ test: 'Tests: 5 passed', typecheck: typecheckError });
    stubGit({ log: 'main' });

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; typecheck: { passed: boolean; errorCount: number } };
    expect(data.ready).toBe(false);
    expect(data.typecheck.passed).toBe(false);
    expect(data.typecheck.errorCount).toBeGreaterThan(0);
  });

  /** A Go module resolves `go test ./...` from the toolchain registry. Go declares no typecheck. */
  it('PrepareSynthesis_GoModule_RunsTheResolvedTestCommand', async () => {
    await fs.rm(path.join(tmpDir, '.exarchos.yml'));
    await fs.writeFile(path.join(tmpDir, 'go.mod'), 'module example.com/fixture\n');
    stubGit({ log: '* abc1234 feat: add feature' });
    const mockStore = createMockEventStore();

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const goRuns = runsOf('go');
    expect(goRuns).toHaveLength(1);
    expect(goRuns[0]?.args).toEqual(['test', './...']);
    expect(goRuns[0]?.checkout).toBe(tmpDir);
    expect(runsOf('vitest')).toEqual([]);
    const data = result.data as {
      ready: boolean;
      tests: { passed: boolean; command: string | null };
      typecheck: { passed: boolean; command: string | null };
    };
    expect(data.tests).toMatchObject({ passed: true, command: 'go test ./...' });
    expect(data.typecheck).toMatchObject({ passed: true, command: null });
    expect(data.ready).toBe(true);
    const gateNames = mockStore.append.mock.calls
      .map((call: unknown[]) => call[1] as { type: string; data: { gateName: string } })
      .filter((event) => event.type === 'gate.executed')
      .map((event) => event.data.gateName);
    expect(gateNames).toContain('test-suite');
    expect(gateNames).not.toContain('typecheck');
  });

  it('PrepareSynthesis_ConfiguredCommands_RunInArgumentForm', async () => {
    await fs.writeFile(path.join(tmpDir, '.exarchos.yml'), "test: 'pytest -q'\ntypecheck: 'mypy src'\n");
    const mockStore = createMockEventStore();

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(runsOf('pytest').map((run) => run.args)).toEqual([['-q']]);
    expect(runsOf('mypy').map((run) => run.args)).toEqual([['src']]);
    expect(execFileSync).not.toHaveBeenCalled();
    const data = result.data as { tests: { command: string | null }; typecheck: { command: string | null } };
    expect(data.tests.command).toBe('pytest -q');
    expect(data.typecheck.command).toBe('mypy src');
  });

  /** With no verifier provisioning, both legs run in one lifecycle check of the local executor, and the handler starts no command of its own. */
  it('PrepareSynthesis_LocalRoute_RunsBothLegsInOneLifecycleCheck', async () => {
    await fs.writeFile(path.join(tmpDir, '.exarchos.yml'), "test: 'pytest -q'\ntypecheck: 'mypy src'\n");
    const mockStore = createMockEventStore();
    const run = (exitCode: number, stdout: string) => ({ argv: ['leg'], end: 'exited' as const, exitCode, stdout, stderr: '' });
    vi.mocked(admitLifecycleLegs).mockResolvedValue([
      { name: 'test', kind: 'command', run: run(0, '3 passed') },
      { name: 'typecheck', kind: 'typecheck', run: run(2, 'src/a.py: error TS1 found') },
    ]);
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(execFileSync).not.toHaveBeenCalled();
    expect(admitLifecycleLegs).toHaveBeenCalledTimes(1);
    expect(admitLifecycleLegs).toHaveBeenCalledWith(expect.objectContaining({
      eventStore: mockStore, checkout: tmpDir, streamId: 'test-feature',
      legs: [{ kind: 'command', argv: ['pytest', '-q'] }, { kind: 'typecheck', argv: ['mypy', 'src'] }],
    }));
    expect(vi.mocked(admitLifecycleLegs).mock.calls[0]?.[0].stopAfterTestFailure).toBeUndefined();
    const data = result.data as { tests: { passed: boolean; passCount: number }; typecheck: { passed: boolean; command: string | null } };
    expect(data.tests).toMatchObject({ passed: true, passCount: 3 });
    expect(data.typecheck).toMatchObject({ passed: false, command: 'mypy src' });
  });

  /**
   * A call reads each command once. A test command that resolves only on a later read is not in the approved plan.
   * So it never runs, and the call asks the executor for no check.
   */
  it('PrepareSynthesis_CommandThatResolvesOnlyOnALaterRead_NeverRuns', async () => {
    await fs.writeFile(path.join(tmpDir, '.exarchos.yml'), "test: 'pytest -q'\n");
    const mockStore = createMockEventStore();
    vi.mocked(resolveRunnableCommand)
      .mockReturnValueOnce({ kind: 'unresolved', reason: 'not yet configured' })
      .mockReturnValueOnce({ kind: 'unresolved', reason: 'not yet configured' });
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(execFileSync).not.toHaveBeenCalled();
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(vi.mocked(resolveRunnableCommand).mock.calls.map((call) => call[1])).toEqual(['test', 'typecheck']);
    expect(result.success).toBe(true);
    expect((result.data as { tests: { passed: boolean; command: string | null } }).tests).toMatchObject({ passed: false, command: null });
  });

  /** No project markers and no configuration: the test leg fails closed and names the remediation. */
  it('PrepareSynthesis_NoTestCommandResolves_IsNotReady', async () => {
    await fs.rm(path.join(tmpDir, '.exarchos.yml'));
    stubGit({ log: '* abc1234 feat: add feature' });
    const mockStore = createMockEventStore();

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const data = result.data as {
      ready: boolean;
      blockers: string[];
      tests: { passed: boolean; command: string | null; reason?: string };
    };
    expect(data.ready).toBe(false);
    expect(data.tests).toMatchObject({ passed: false, command: null });
    expect(data.tests.reason).toMatch(/No project markers detected/);
    expect(data.blockers.some((b) => b.startsWith('Test suite not run'))).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    const testGate = mockStore.append.mock.calls
      .map((call: unknown[]) => call[1] as { type: string; data: { gateName: string; passed: boolean } })
      .find((event) => event.type === 'gate.executed' && event.data.gateName === 'test-suite');
    expect(testGate?.data.passed).toBe(false);
  });

  /** A typecheck command that resolves but cannot be parsed fails the leg. It is not skipped. */
  it('PrepareSynthesis_UnparseableTypecheckCommand_IsNotReady', async () => {
    await fs.writeFile(path.join(tmpDir, '.exarchos.yml'), "test: 'vitest run'\ntypecheck: 'tsc \"--noEmit'\n");
    stubGit({ log: '* abc1234 feat: add feature' });
    const mockStore = createMockEventStore();

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    const data = result.data as {
      ready: boolean;
      blockers: string[];
      typecheck: { passed: boolean; command: string | null };
    };
    expect(data.typecheck).toMatchObject({ passed: false, command: null });
    expect(data.blockers.some((b) => b.startsWith('Typecheck not run'))).toBe(true);
    expect(runsOf('tsc')).toEqual([]);
    expect(data.ready).toBe(false);
  });

  /**
   * The diff holds a source file on a doc-bearing surface and no doc change, and the
   * leg is blocking. The test also passes `projectConfig` to the handler as the adapter does.
   */
  it('PrepareSynthesis_DocBearingSurfaceNoDocChange_FailsDocumentLeg', async () => {
    const mockMaterializer = createMockMaterializer(mockTaskDetailView({ t1: { status: 'completed' } }));
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    stubLegs({ diff: 'src/registry.ts\n' });

    const result = await handlePrepareSynthesis(
      {
        featureId: 'test-feature',
        repoRoot: tmpDir,
        projectConfig: {
          synthesis: {
            documentLeg: { severity: 'blocking', surfaceGlobs: ['**/*.ts'], docGlobs: ['docs/**'] },
          },
        } as unknown as ResolvedProjectConfig,
      },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    const docGate = mockStore.append.mock.calls.find((call: unknown[]) => {
      const e = call[1] as { type: string; data: { gateName: string } };
      return e.type === 'gate.executed' && e.data.gateName === 'document-coverage';
    });
    expect(docGate).toBeDefined();
    expect((docGate![1] as { data: { passed: boolean; layer: string } }).data.passed).toBe(false);
    expect((docGate![1] as { data: { layer: string } }).data.layer).toBe('synthesize');
    const data = result.data as { ready: boolean; readiness: { documentReady: boolean } };
    expect(data.readiness.documentReady).toBe(false);
    expect(data.ready).toBe(false);
  });

  /** The advisory severity is the default. The gate records `passed: false`, but `documentReady` stays true. */
  it('PrepareSynthesis_AdvisoryUncoveredDoc_EmitsGateButDoesNotBlock', async () => {
    const mockMaterializer = createMockMaterializer(mockTaskDetailView({ t1: { status: 'completed' } }));
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    stubLegs({ diff: 'src/registry.ts\n' });

    const result = await handlePrepareSynthesis(
      {
        featureId: 'test-feature',
        repoRoot: tmpDir,
        projectConfig: {
          synthesis: {
            documentLeg: { severity: 'advisory', surfaceGlobs: ['**/*.ts'], docGlobs: ['docs/**'] },
          },
        } as unknown as ResolvedProjectConfig,
      },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    const docGate = mockStore.append.mock.calls.find((call: unknown[]) => {
      const e = call[1] as { type: string; data: { gateName: string } };
      return e.type === 'gate.executed' && e.data.gateName === 'document-coverage';
    });
    expect((docGate![1] as { data: { passed: boolean } }).data.passed).toBe(false);
    const data = result.data as { readiness: { documentReady: boolean } };
    expect(data.readiness.documentReady).toBe(true);
  });

  /** Every leg and every Git read uses `repoRoot`, which differs from `process.cwd()`. */
  it('PrepareSynthesis_RepoRootDiffersFromCwd_LegsRunAgainstRepoRoot', async () => {
    expect(tmpDir).not.toBe(process.cwd());
    const taskView = mockTaskDetailView({ t1: { status: 'completed' } });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    stubLegs({ test: 'Tests: 1 passed, 0 failed', diff: 'src/foo.ts\n' });

    await handlePrepareSynthesis(
      { featureId: 'test-feature', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    expect(vi.mocked(observeCurrentCheckout).mock.calls).toEqual([[GIT_PATH, tmpDir]]);
    const checkouts = vi.mocked(admitLifecycleLegs).mock.calls.map(([input]) => input.checkout);
    expect(checkouts).toEqual([tmpDir]);
    expect(reads.nameOnly).toHaveBeenCalledWith(`${tmpDir}/.git`, tmpDir, MERGE_BASE, HEAD);
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** A caller can reach the handler without `repoRoot` through an unchecked cast. The handler refuses it and runs no leg. */
  it('PrepareSynthesis_RepoRootMissingAfterTasksComplete_RefusesRatherThanDefaultingToCwd', async () => {
    const taskView = mockTaskDetailView({ t1: { status: 'completed' } });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );

    const result = await handlePrepareSynthesis(
      { featureId: 'test-feature' } as unknown as Parameters<typeof handlePrepareSynthesis>[0],
      tmpDir,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('repoRoot');
    expect(observeCurrentCheckout).not.toHaveBeenCalled();
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
  });

  /**
   * A relative `repoRoot` resolves against the server cwd, so the handler refuses it.
   * A non-string `repoRoot` also gets `INVALID_INPUT`, even when its string form looks absolute.
   * No refusal reads Git or asks the executor for a leg. An absolute path
   * still passes the check.
   */
  it('PrepareSynthesis_RelativeRepoRoot_IsRefusedLikeAMissingOne', async () => {
    const taskView = mockTaskDetailView({ t1: { status: 'completed' } });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );

    for (const relative of ['.', '..', 'some/repo', './repo']) {
      vi.mocked(observeCurrentCheckout).mockClear();
      vi.mocked(admitLifecycleLegs).mockClear();
      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: relative },
        tmpDir,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('absolute');
      expect(observeCurrentCheckout).not.toHaveBeenCalled();
      expect(admitLifecycleLegs).not.toHaveBeenCalled();
    }

    for (const nonString of [['/repo'], 42, { path: '/repo' }, true]) {
      vi.mocked(observeCurrentCheckout).mockClear();
      vi.mocked(admitLifecycleLegs).mockClear();
      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: nonString } as unknown as Parameters<
          typeof handlePrepareSynthesis
        >[0],
        tmpDir,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(observeCurrentCheckout).not.toHaveBeenCalled();
      expect(admitLifecycleLegs).not.toHaveBeenCalled();
    }

    vi.mocked(execSync).mockClear();
    const accepted = await handlePrepareSynthesis(
      { featureId: 'test-feature', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );
    expect(accepted.error?.message ?? '').not.toContain('absolute');
    expect(accepted.error?.code).not.toBe('INVALID_INPUT');
  });

  /** A refusal of the local executor returns as the gate result, before any gate event, Git read or stack leg. */
  it('PrepareSynthesis_LocalRefusal_ReturnsTheRefusalBeforeAnyGateEvent', async () => {
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(admitLifecycleLegs).mockResolvedValue({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: 'refused' } });

    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(result).toEqual({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: 'refused' } });
    expect(runPhaseGateWithEvidence).toHaveBeenCalledTimes(1);
    expect(mockStore.append).not.toHaveBeenCalled();
    expect(observeCurrentCheckout).not.toHaveBeenCalled();
  });

  /**
   * The base name is the origin HEAD target with no `refs/remotes/origin/` prefix. When that read fails, the name is `main`.
   * The changed files diff from the merge base of the resolved base and HEAD, and the stack reads the base-to-head range.
   */
  it('PrepareSynthesis_BaseName_OriginHeadTargetThenMainFallback', async () => {
    const mockStore = createMockEventStore();
    stubGit({ defaultBranch: 'develop', log: '* abc1234 feat' });

    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);
    git.defaultBranch = new Error('no origin HEAD');
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    expect(resolveBase.mock.calls.map((call) => call[1])).toEqual(['develop', 'main']);
    expect(reads.mergeBase).toHaveBeenCalledWith(`${tmpDir}/.git`, tmpDir, BASE, HEAD);
    expect(reads.nameOnly).toHaveBeenCalledWith(`${tmpDir}/.git`, tmpDir, MERGE_BASE, HEAD);
    expect(observeCurrentCheckout).toHaveBeenCalledTimes(2);
  });

  /**
   * A refused observation and no usable Git both refuse the stack and changed-file legs.
   * The call still succeeds with an unhealthy stack and an uncovered document leg. No merge base gives the same uncovered document leg, never a two-dot diff.
   */
  it('PrepareSynthesis_RefusedObservationOrNoMergeBase_FailsClosed', async () => {
    const mockStore = createMockEventStore();
    const blocking = {
      synthesis: { documentLeg: { severity: 'blocking', surfaceGlobs: ['**/*.ts'], docGlobs: ['docs/**'] } },
    } as unknown as ResolvedProjectConfig;
    vi.mocked(observeCurrentCheckout).mockResolvedValueOnce({ kind: 'refused', reason: 'Git executable must be an operator-selected absolute path' });

    const refused = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir, projectConfig: blocking }, tmpDir, mockStore as unknown as EventStore);
    git.mergeBase = new Error('no merge base');
    stubLegs({ diff: 'src/registry.ts\n' });
    const unrelated = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir, projectConfig: blocking }, tmpDir, mockStore as unknown as EventStore);

    expect(refused.success).toBe(true);
    const refusedData = refused.data as { stack: { healthy: boolean; error?: string }; readiness: { documentReady: boolean }; document: { message?: string } };
    expect(refusedData.stack.healthy).toBe(false);
    expect(refusedData.stack.error).toContain('absolute path');
    expect(refusedData.readiness.documentReady).toBe(false);
    expect(refusedData.document.message).toContain('Changed-file detection failed');
    const unrelatedData = unrelated.data as { readiness: { documentReady: boolean }; document: { surfaceFiles: readonly string[] } };
    expect(unrelatedData.readiness.documentReady).toBe(false);
    expect(unrelatedData.document.surfaceFiles).toEqual([]);
    expect(reads.nameOnly).not.toHaveBeenCalled();

    vi.mocked(processObservationalGitPath).mockReturnValueOnce(undefined);
    vi.mocked(observeCurrentCheckout).mockClear();
    const noGit = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir, projectConfig: blocking }, tmpDir, mockStore as unknown as EventStore);
    expect(noGit).toMatchObject({ success: true, data: { stack: { healthy: false }, readiness: { documentReady: false } } });
    expect(observeCurrentCheckout).not.toHaveBeenCalled();
  });
});

describe('evaluateDocumentLeg (DR-2)', () => {
  const cfg = (over: Partial<DocumentLegConfig> = {}): DocumentLegConfig => ({
    severity: 'advisory',
    surfaceGlobs: [],
    docGlobs: ['docs/**', '**/*.md'],
    ...over,
  });

  it('DocumentLeg_NoSurfaceTouched_AutoWaives', () => {
    const r = evaluateDocumentLeg(['src/foo.ts'], cfg({ surfaceGlobs: ['commands/**'] }));
    expect(r.evaluated).toBe(false);
    expect(r.covered).toBe(true);
  });

  it('DocumentLeg_SurfaceTouchedDocsChanged_Covered', () => {
    const r = evaluateDocumentLeg(
      ['src/registry.ts', 'docs/guide.md'],
      cfg({ surfaceGlobs: ['**/registry.ts'] }),
    );
    expect(r.evaluated).toBe(true);
    expect(r.covered).toBe(true);
  });

  it('DocumentLeg_SurfaceTouchedNoDocs_FailsWithMessage', () => {
    const r = evaluateDocumentLeg(
      ['src/registry.ts'],
      cfg({ surfaceGlobs: ['**/registry.ts'] }),
    );
    expect(r.evaluated).toBe(true);
    expect(r.covered).toBe(false);
    expect(r.surfaceFiles).toContain('src/registry.ts');
    expect(r.message).toMatch(/without a documentation update/);
  });
});

describe('documentLegBlocks (DR-2)', () => {
  it('DocumentLeg_DefaultSeverity_IsAdvisory', () => {
    const r = evaluateDocumentLeg(['src/registry.ts'], {
      severity: 'advisory',
      surfaceGlobs: ['**/*.ts'],
      docGlobs: ['docs/**'],
    });
    expect(r.covered).toBe(false);
    expect(documentLegBlocks(r)).toBe(false);
  });

  it('DocumentLeg_SeverityConfig_ResolvesAdvisoryToBlocking', () => {
    const r = evaluateDocumentLeg(['src/registry.ts'], {
      severity: 'blocking',
      surfaceGlobs: ['**/*.ts'],
      docGlobs: ['docs/**'],
    });
    expect(r.covered).toBe(false);
    expect(documentLegBlocks(r)).toBe(true);
  });

  it('DocumentLegBlocks_CoveredLeg_NeverBlocks', () => {
    const r = evaluateDocumentLeg(['src/registry.ts', 'docs/x.md'], {
      severity: 'blocking',
      surfaceGlobs: ['**/*.ts'],
      docGlobs: ['docs/**'],
    });
    expect(documentLegBlocks(r)).toBe(false);
  });
});
