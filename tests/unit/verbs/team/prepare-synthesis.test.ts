// ─── Prepare Synthesis Composite Action Tests ───────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolResult } from '../../../../src/format.js';
import type { EventStore } from '../../../../src/events/store.js';

// ─── Mock child_process ────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execSync, execFileSync } from 'node:child_process';

// ─── Mock views/tools to control materializer and event store ──────────────

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: vi.fn(),
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
}));

import { getOrCreateMaterializer } from '../../../../src/projections/views/tools.js';

// ─── Import handler under test ─────────────────────────────────────────────

import {
  handlePrepareSynthesis,
  evaluateDocumentLeg,
  documentLegBlocks,
  type DocumentLegConfig,
} from '../../../../src/verbs/team/prepare-synthesis.js';
import type { ResolvedProjectConfig } from '../../../../src/config/resolve.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

const STATE_DIR = '/tmp/test-state-prepare-synthesis';

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

/**
 * `execFileSync` behaviour for the two resolved command legs: the leg whose
 * script name is in `failing` throws the way a non-zero exit does, everything
 * else succeeds. The legs are told apart by argv, not by call order, so the
 * assertion does not silently move when a leg is added or reordered.
 */
function legRunner(failing: Record<string, string> = {}) {
  return ((_program: string, argv?: readonly string[]) => {
    const script = (argv ?? []).join(' ');
    for (const [name, output] of Object.entries(failing)) {
      if (script.includes(name)) {
        const err = new Error(`${name} failed`) as Error & { stdout: Buffer; status: number };
        err.stdout = Buffer.from(output);
        err.status = 1;
        throw err;
      }
    }
    return Buffer.from('Tests: 10 passed, 0 failed');
  }) as unknown as typeof execFileSync;
}

/**
 * `execSync` behaviour for the git legs, dispatched on the command rather than
 * on call order. Resolving the toolchain adds its own `git rev-parse` probe, so
 * an ordinal mock queue silently shifts under a leg that is not even the
 * subject of the test.
 */
function gitRunner(defaultBranch: string, log: string) {
  return ((command: string) => {
    if (command.includes('symbolic-ref')) {
      return `refs/remotes/origin/${defaultBranch}\n` as unknown as Buffer;
    }
    if (command.includes('git log')) return Buffer.from(log);
    return Buffer.from('');
  }) as unknown as typeof execSync;
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

describe('handlePrepareSynthesis', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-synthesis-'));
    // The tests and typecheck legs resolve their commands from the governed
    // repository's toolchain, so the fixture tree has to be a repository the
    // resolver recognizes. Without this the gate has nothing to run and says so
    // — which is exactly what `UnresolvedRuntime_YieldsIndeterminate_NotFail`
    // exercises, on a tree deliberately left bare.
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ─── Test 1: Missing featureId ────────────────────────────────────────────

  it('PrepareSynthesis_MissingFeatureId_ReturnsInvalidInput', async () => {
    // Arrange
    const args = {} as { featureId: string; repoRoot: string };

    // Act
    const result = await handlePrepareSynthesis(args, STATE_DIR, createMockEventStore() as unknown as EventStore);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  // ─── Test 2: Tasks incomplete returns blockers ────────────────────────────

  it('PrepareSynthesis_TasksIncomplete_ReturnsBlockers', async () => {
    // Arrange — drive task status through the canonical event log (#1536):
    // t1 completed, t2/t3 only assigned (pending) → t2/t3 block synthesis.
    const mockStore = createMockEventStore(
      tasksToEvents({
        t1: { status: 'completed' },
        t2: { status: 'in-progress' },
        t3: { status: 'assigned' },
      }),
    );

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; blockers: string[] };
    expect(data.ready).toBe(false);
    expect(data.blockers).toBeDefined();
    expect(data.blockers.length).toBeGreaterThan(0);
    expect(data.blockers.some((b: string) => b.includes('t2'))).toBe(true);
    expect(data.blockers.some((b: string) => b.includes('t3'))).toBe(true);
  });

  // ─── #1536: readiness derives from the canonical event log, not materializer ─
  it('PrepareSynthesis_MaterializerDisagreesWithEventLog_NoPhantomBlocker', async () => {
    // #1536: the task-detail materializer reported tasks in-progress while the
    // canonical event log (resolveWorkflowState — what exarchos_workflow get
    // reads) showed them complete. Synthesis phantom-blocked. Readiness MUST
    // derive from the canonical source, so the phantom must not appear.
    const phantomView = mockTaskDetailView({ '024': { status: 'in-progress' } });
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      createMockMaterializer(phantomView) as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    // Canonical event log: task 024 assigned then completed.
    const mockStore = createMockEventStore(tasksToEvents({ '024': { status: 'completed' } }));
    vi.mocked(execSync).mockReturnValue(Buffer.from('Tests: 1 passed, 0 failed'));

    const result = await handlePrepareSynthesis(
      { featureId: 'f', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    const data = result.data as { blockers?: string[] };
    expect((data.blockers ?? []).some((b: string) => b.includes('024'))).toBe(false);
  });

  // ─── Test 3: Tests run and emit test result event ─────────────────────────

  it('PrepareSynthesis_TestsRun_EmitsTestResultEvent', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execSync).mockReturnValue(Buffer.from('Tests: 10 passed, 0 failed'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — verify gate.executed event emitted for test-suite
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

  // ─── Test 4: Typecheck run and emit typecheck event ───────────────────────

  it('PrepareSynthesis_TypecheckRun_EmitsTypecheckEvent', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — verify gate.executed event emitted for typecheck
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

  // ─── Test 4b: Test-suite gate event includes phase ──────────────────────

  it('PrepareSynthesis_TestSuiteGateEvent_IncludesPhaseInDetails', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execSync).mockReturnValue(Buffer.from('Tests: 10 passed, 0 failed'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — test-suite gate event includes phase: 'synthesize'
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

  // ─── Test 4c: Typecheck gate event includes phase ─────────────────────

  it('PrepareSynthesis_TypecheckGateEvent_IncludesPhaseInDetails', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — typecheck gate event includes phase: 'synthesize'
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

  // ─── Test 5: Stack checked uses git log, not gt log ─────────────────────

  it('verifyStack_UsesGitLog_NotGtLog', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    // Tests and typecheck are resolved commands (execFileSync); the two legs
    // still on execSync are the git ones.
    vi.mocked(execFileSync).mockImplementation(legRunner());
    vi.mocked(execSync).mockImplementation(
      gitRunner('main', '* abc1234 feat: add feature\n* def5678 fix: bug fix'),
    );

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — verify git log was called (not gt log)
    const execCalls = vi.mocked(execSync).mock.calls;
    const stackCall = execCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('log'),
    );
    expect(stackCall).toBeDefined();
    expect(stackCall![0]).toContain('git log');
    expect(stackCall![0]).not.toContain('gt log');

    // Stack result should still be healthy
    const data = result.data as { stack: { healthy: boolean; branches: string[] } };
    expect(data.stack).toBeDefined();
    expect(data.stack.healthy).toBe(true);
    expect(data.stack.branches).toBeDefined();
  });

  // ─── Test 5b: Non-main default branch propagates to git log command ──────

  it('verifyStack_NonMainDefaultBranch_UsesDetectedBranch', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    // Detect default branch returns 'trunk', then git log
    vi.mocked(execFileSync).mockImplementation(legRunner());
    vi.mocked(execSync).mockImplementation(gitRunner('trunk', '* abc1234 feat: add feature'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — git log command uses 'trunk' not 'main'
    const execCalls = vi.mocked(execSync).mock.calls;
    const gitLogCall = execCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('git log'),
    );
    expect(gitLogCall).toBeDefined();
    expect(gitLogCall![0]).toContain('trunk..HEAD');
    expect(gitLogCall![0]).not.toContain('main..HEAD');
  });

  // ─── Test 6: All green returns ready ──────────────────────────────────────

  it('PrepareSynthesis_AllGreen_ReturnsReady', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
      't2': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    // Tests pass, typecheck passes, detect default branch, stack healthy
    vi.mocked(execFileSync).mockImplementation(legRunner());
    vi.mocked(execSync).mockImplementation(gitRunner('main', 'main\n  feature-branch'));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert
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

  // ─── Test 7: Valid input returns readiness state ──────────────────────────

  it('PrepareSynthesis_ValidInput_ReturnsReadiness', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert
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

  // ─── Test 8: Tests run emits gate.executed for flywheel ───────────────────

  it('PrepareSynthesis_TestsRun_EmitsGateExecutedEvent', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execSync).mockReturnValue(Buffer.from('Tests: 5 passed, 2 failed'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — gate.executed event for test-suite feeds CodeQualityView flywheel
    const appendCalls = mockStore.append.mock.calls;
    const gateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string; layer: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'test-suite' && event.data.layer === 'CI';
      },
    );
    expect(gateCall).toBeDefined();
  });

  // ─── Test 9: Typecheck run emits gate.executed for flywheel ───────────────

  it('PrepareSynthesis_TypecheckRun_EmitsGateExecutedEvent', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert — gate.executed event for typecheck feeds CodeQualityView flywheel
    const appendCalls = mockStore.append.mock.calls;
    const gateCall = appendCalls.find(
      (call: unknown[]) => {
        const event = call[1] as { type: string; data: { gateName: string; layer: string } };
        return event.type === 'gate.executed' && event.data.gateName === 'typecheck' && event.data.layer === 'CI';
      },
    );
    expect(gateCall).toBeDefined();
  });

  // ─── Test 10: Test failure sets passed=false ──────────────────────────────

  it('PrepareSynthesis_TestsFail_ReturnsNotReady', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    // The resolved test command exits non-zero; typecheck still passes.
    vi.mocked(execFileSync).mockImplementation(
      legRunner({ 'test:run': 'Tests: 3 passed, 2 failed' }),
    );
    vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      tests: { passed: boolean; failCount?: number };
      skipped?: true;
    };
    expect(data.ready).toBe(false);
    expect(data.tests.passed).toBe(false);
    // A failure is a measurement, not an absence of one.
    expect(data.skipped).toBeUndefined();
    expect(data.tests.failCount).toBe(2);
  });

  // ─── Test 11: Typecheck failure sets passed=false ─────────────────────────

  it('PrepareSynthesis_TypecheckFails_ReturnsNotReady', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(execFileSync).mockImplementation(
      legRunner({
        typecheck:
          'error TS2322: Type string not assignable\nerror TS2345: Argument mismatch',
      }),
    );
    vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature', repoRoot: tmpDir }, tmpDir, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; typecheck: { passed: boolean; errorCount: number } };
    expect(data.ready).toBe(false);
    expect(data.typecheck.passed).toBe(false);
    expect(data.typecheck.errorCount).toBeGreaterThan(0);
  });

  // ─── DR-2 (#1594): document-readiness leg ─────────────────────────────────

  it('PrepareSynthesis_DocBearingSurfaceNoDocChange_FailsDocumentLeg', async () => {
    // Arrange — tasks complete; git diff returns a doc-bearing source file with
    // no doc change; config marks **/*.ts a surface, severity blocking. Also
    // exercises the adapter-equivalent projectConfig threading at the handler.
    const mockMaterializer = createMockMaterializer(mockTaskDetailView({ t1: { status: 'completed' } }));
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
    // The changed-file leg is the `git diff` argv call; the command legs are
    // the resolved test/typecheck ones and must not be answered with a diff.
    vi.mocked(execFileSync).mockImplementation(((program: string) =>
      program === 'git'
        ? Buffer.from('src/registry.ts')
        : Buffer.from('Tests: 1 passed, 0 failed')) as unknown as typeof execFileSync);

    // Act
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

    // Assert — document-coverage gate emitted passed:false; synthesis blocked.
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

  it('PrepareSynthesis_AdvisoryUncoveredDoc_EmitsGateButDoesNotBlock', async () => {
    // Same surface gap, but advisory severity (the default) ⇒ gate records
    // passed:false (visible) yet documentReady stays true (warns, never blocks).
    const mockMaterializer = createMockMaterializer(mockTaskDetailView({ t1: { status: 'completed' } }));
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
    // The changed-file leg is the `git diff` argv call; the command legs are
    // the resolved test/typecheck ones and must not be answered with a diff.
    vi.mocked(execFileSync).mockImplementation(((program: string) =>
      program === 'git'
        ? Buffer.from('src/registry.ts')
        : Buffer.from('Tests: 1 passed, 0 failed')) as unknown as typeof execFileSync);

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

  // ─── The two command legs come from the toolchain, not from a literal ────

  it('TestsLeg_UsesResolvedCommand', async () => {
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      createMockMaterializer(
        mockTaskDetailView({ t1: { status: 'completed' } }),
      ) as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
    vi.mocked(execFileSync).mockImplementation(legRunner());

    await handlePrepareSynthesis(
      { featureId: 'test-feature', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    const spawned = vi
      .mocked(execFileSync)
      .mock.calls.map((c) => [String(c[0]), ...((c[1] ?? []) as readonly string[])].join(' '));
    // The resolver's npm profile for the fixture repo. No literal is spelled in
    // the module: change the fixture's manifest and this command changes with it.
    expect(spawned).toContain('npm run test:run');
  });

  it('TypecheckLeg_UsesResolvedCommand', async () => {
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      createMockMaterializer(
        mockTaskDetailView({ t1: { status: 'completed' } }),
      ) as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
    vi.mocked(execFileSync).mockImplementation(legRunner());

    await handlePrepareSynthesis(
      { featureId: 'test-feature', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    const spawned = vi
      .mocked(execFileSync)
      .mock.calls.map((c) => [String(c[0]), ...((c[1] ?? []) as readonly string[])].join(' '));
    expect(spawned).toContain('npm run typecheck');
  });

  it('ExitCodeOnlyCarrier_ReportsNoCounts_AndTypecheckIsUnmeasured', async () => {
    // A Go worktree. Its runner resolves and its exit code is a complete
    // verdict, but it prints no summary this parse understands — so the counts
    // are absent rather than scraped out of another runner's grammar, even
    // though the output here would satisfy the pattern.
    //
    // Go resolves NO typecheck command, and that is the resolver's own
    // 'unresolved' answer, not the project withdrawing the obligation. So the
    // leg is indeterminate: it does not pass, and it does not invent a command.
    const goRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-synthesis-go-'));
    try {
      await fs.writeFile(path.join(goRepo, 'go.mod'), 'module example.com/thing\n');
      const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
      vi.mocked(getOrCreateMaterializer).mockReturnValue(
        createMockMaterializer(
          mockTaskDetailView({ t1: { status: 'completed' } }),
        ) as unknown as ReturnType<typeof getOrCreateMaterializer>,
      );
      vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
      vi.mocked(execFileSync).mockImplementation(legRunner());

      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: goRepo },
        goRepo,
        mockStore as unknown as EventStore,
      );

      const data = result.data as {
        skipped?: true;
        reason?: string;
        blockers?: string[];
        tests: { passed: boolean; passCount?: number; failCount?: number };
        typecheck: { passed: boolean; indeterminate?: true; reason?: string };
        readiness: { typecheckPass: boolean };
      };
      const spawned = vi
        .mocked(execFileSync)
        .mock.calls.map((c) => [String(c[0]), ...((c[1] ?? []) as readonly string[])].join(' '));
      expect(spawned).toContain('go test ./...');
      expect(data.tests.passed).toBe(true);
      expect(data.tests.passCount).toBeUndefined();
      expect(data.tests.failCount).toBeUndefined();
      // The leg the resolver could not answer for is unmeasured, NOT green.
      expect(data.typecheck.indeterminate).toBe(true);
      expect(data.typecheck.passed).toBe(false);
      expect(data.readiness.typecheckPass).toBe(false);
      expect(data.typecheck.reason).toContain('typecheck');
      // Tests passed and nothing failed, so the whole carrier is unconcluded
      // rather than reporting a failure nobody observed.
      expect(data.skipped).toBe(true);
      expect(data.reason).toContain('Typecheck');
      expect(data.blockers?.some((b) => b.includes('Typecheck could not be run'))).toBe(true);
      // No `go typecheck` was invented for a toolchain that has none.
      expect(spawned.some((c) => c.includes('typecheck'))).toBe(false);
    } finally {
      await fs.rm(goRepo, { recursive: true, force: true });
    }
  });

  it('TypecheckLeg_ObservedFailureElsewhere_IsNotSoftenedToSkipped', async () => {
    // Discriminating twin: the same Go worktree, but the suite genuinely
    // FAILS. A gate that observed a failure has produced a finding, so it must
    // not declare itself skipped — that would erase the one thing it measured.
    const goRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-synthesis-go-fail-'));
    try {
      await fs.writeFile(path.join(goRepo, 'go.mod'), 'module example.com/thing\n');
      const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
      vi.mocked(getOrCreateMaterializer).mockReturnValue(
        createMockMaterializer(
          mockTaskDetailView({ t1: { status: 'completed' } }),
        ) as unknown as ReturnType<typeof getOrCreateMaterializer>,
      );
      vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
      // `go test ./...` exits non-zero: a real, observed suite failure.
      vi.mocked(execFileSync).mockImplementation(legRunner({ test: 'FAIL' }));

      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: goRepo },
        goRepo,
        mockStore as unknown as EventStore,
      );

      const data = result.data as {
        skipped?: true;
        tests: { passed: boolean; indeterminate?: true };
        typecheck: { indeterminate?: true };
      };
      expect(data.tests.passed).toBe(false);
      expect(data.tests.indeterminate).toBeUndefined();
      expect(data.typecheck.indeterminate).toBe(true);
      expect(data.skipped).toBeUndefined();
    } finally {
      await fs.rm(goRepo, { recursive: true, force: true });
    }
  });

  it('TestLeg_RunnerNeverStarts_IsIndeterminate_NotAFailingSuite', async () => {
    // ENOENT carries no numeric exit status: nothing observed the suite. The
    // leg is unmeasured rather than failing, and no counts are reported.
    const goRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-synthesis-enoent-'));
    try {
      await fs.writeFile(path.join(goRepo, 'go.mod'), 'module example.com/thing\n');
      const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
      vi.mocked(getOrCreateMaterializer).mockReturnValue(
        createMockMaterializer(
          mockTaskDetailView({ t1: { status: 'completed' } }),
        ) as unknown as ReturnType<typeof getOrCreateMaterializer>,
      );
      vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
      vi.mocked(execFileSync).mockImplementation(((program: string) => {
        if (String(program) === 'go') {
          // No numeric `status`: the process was never created.
          throw Object.assign(new Error('spawnSync go ENOENT'), { code: 'ENOENT' });
        }
        return Buffer.from('');
      }) as unknown as typeof execFileSync);

      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: goRepo },
        goRepo,
        mockStore as unknown as EventStore,
      );

      const data = result.data as {
        skipped?: true;
        reason?: string;
        tests: { passed: boolean; indeterminate?: true; reason?: string; passCount?: number };
      };
      expect(data.tests.indeterminate).toBe(true);
      expect(data.tests.passed).toBe(false);
      expect(data.tests.reason).toContain('ENOENT');
      expect(data.tests.passCount).toBeUndefined();
      expect(data.skipped).toBe(true);
      expect(data.reason).toContain('Test suite');
    } finally {
      await fs.rm(goRepo, { recursive: true, force: true });
    }
  });

  it('UnresolvedRuntime_YieldsIndeterminate_NotFail', async () => {
    // A governed repository with no resolvable test runtime — the case a
    // literal `npm run test:run` could only ever answer with a spurious red.
    const bareRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-synthesis-bare-'));
    try {
      const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
      vi.mocked(getOrCreateMaterializer).mockReturnValue(
        createMockMaterializer(
          mockTaskDetailView({ t1: { status: 'completed' } }),
        ) as unknown as ReturnType<typeof getOrCreateMaterializer>,
      );
      vi.mocked(execSync).mockImplementation(gitRunner('main', 'main'));
      vi.mocked(execFileSync).mockImplementation(legRunner());

      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: bareRepo },
        bareRepo,
        mockStore as unknown as EventStore,
      );

      const data = result.data as {
        ready: boolean;
        skipped?: true;
        reason?: string;
        blockers?: string[];
        tests: { passed: boolean; indeterminate?: true; reason?: string };
        typecheck: { passed: boolean; indeterminate?: true };
      };
      // Nothing was spawned against the bare tree.
      const spawned = vi
        .mocked(execFileSync)
        .mock.calls.filter((c) => String(c[0]) !== 'git');
      expect(spawned).toHaveLength(0);
      // Neither a pass nor a failure: the carrier declares it could not run,
      // which is what the shared verdict normalizer reads as indeterminate.
      expect(data.skipped).toBe(true);
      expect(data.reason).toBeTruthy();
      expect(data.tests.indeterminate).toBe(true);
      expect(data.typecheck.indeterminate).toBe(true);
      expect(data.ready).toBe(false);
      expect(data.blockers?.some((b) => b.includes('could not be run'))).toBe(true);

      // The durable row says the same thing the carrier does.
      const testGate = mockStore.append.mock.calls.find((call: unknown[]) => {
        const e = call[1] as { type: string; data: { gateName: string } };
        return e.type === 'gate.executed' && e.data.gateName === 'test-suite';
      });
      expect(
        (testGate![1] as { data: { details?: Record<string, unknown> } }).data.details
          ?.['indeterminate'],
      ).toBe(true);
    } finally {
      await fs.rm(bareRepo, { recursive: true, force: true });
    }
  });

  it('NoNpmLiteral_RemainsInModule', async () => {
    // The property, asserted on the source itself: a package-manager literal in
    // this module is a command the governed repository never chose. The
    // resolver is the only thing allowed to name one.
    const source = await fs.readFile(
      path.join(process.cwd(), 'src/verbs/team/prepare-synthesis.ts'),
      'utf-8',
    );
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
    for (const literal of ['npm ', 'pnpm ', 'yarn ', 'npx ', 'bun ', 'test:run']) {
      expect(code).not.toContain(literal);
    }
  });

  // ─── DR-8 (#1756): repoRoot is threaded to every subprocess leg ───────────

  it('PrepareSynthesis_RepoRootDiffersFromCwd_LegsRunAgainstRepoRoot', async () => {
    // Arrange — a repo root that provably differs from process.cwd(): the
    // suite runs from inside servers/exarchos-mcp, but the gate is told to
    // judge an unrelated temp tree. Before the fix every leg below ran with
    // no `cwd` at all — i.e. against process.cwd() — so this assertion fails
    // on the pre-change code (no leg's options carry a `cwd` key).
    expect(tmpDir).not.toBe(process.cwd());
    const taskView = mockTaskDetailView({ t1: { status: 'completed' } });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );
    vi.mocked(execSync).mockImplementation(((command: string) =>
      typeof command === 'string' && command.includes('symbolic-ref')
        ? Buffer.from('refs/remotes/origin/main')
        : Buffer.from('Tests: 1 passed, 0 failed')) as unknown as typeof execSync);
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('src/foo.ts\n'));

    // Act
    await handlePrepareSynthesis(
      { featureId: 'test-feature', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );

    // Assert — every execSync leg (test suite, typecheck, default-branch
    // detection, `git log` stack check) and the execFileSync `git diff` leg
    // all received `cwd: tmpDir`; none fell back to the ambient process.cwd().
    const execCalls = vi.mocked(execSync).mock.calls;
    expect(execCalls.length).toBeGreaterThan(0);
    for (const call of execCalls) {
      const options = call[1] as { cwd?: string } | undefined;
      expect(options?.cwd).toBe(tmpDir);
    }

    const execFileCalls = vi.mocked(execFileSync).mock.calls;
    expect(execFileCalls.length).toBeGreaterThan(0);
    for (const call of execFileCalls) {
      const options = call[2] as { cwd?: string } | undefined;
      expect(options?.cwd).toBe(tmpDir);
    }
  });

  it('PrepareSynthesis_RepoRootMissingAfterTasksComplete_RefusesRatherThanDefaultingToCwd', async () => {
    // A caller that reaches the handler without repoRoot — e.g. through an
    // unchecked cast, since TypeScript alone can't stop every runtime path
    // (composite.ts's action dispatch casts `args as unknown as T`) — must be
    // refused outright, never silently answered for process.cwd().
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
    // No leg ran — a missing repoRoot must not silently produce a verdict.
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it('PrepareSynthesis_RelativeRepoRoot_IsRefusedLikeAMissingOne', async () => {
    // `repoRoot: '.'` satisfies the presence check and is still the ambient-cwd
    // fallback wearing a value: a relative path handed to a subprocess as `cwd`
    // resolves against the SERVER, so the legs would measure whatever tree the
    // server sits in while reporting a verdict about the caller's feature.
    const taskView = mockTaskDetailView({ t1: { status: 'completed' } });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(
      mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>,
    );

    for (const relative of ['.', '..', 'some/repo', './repo']) {
      vi.mocked(execSync).mockClear();
      // Both spawn surfaces, not just the shell one: the changed-files leg
      // shells out through execFileSync, so a regression that reached IT
      // before returning would slip past an execSync-only oracle.
      vi.mocked(execFileSync).mockClear();
      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: relative },
        tmpDir,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('absolute');
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    }

    // `RegExp.test()` stringifies, so a non-string that LOOKS absolute once
    // coerced (`['/repo']` → `/repo`) used to clear the shape check and reach a
    // subprocess as a non-string `cwd`, returning PREPARE_SYNTHESIS_FAILED —
    // a run-failure code for what is really malformed caller input.
    for (const nonString of [['/repo'], 42, { path: '/repo' }, true]) {
      vi.mocked(execSync).mockClear();
      vi.mocked(execFileSync).mockClear();
      const result = await handlePrepareSynthesis(
        { featureId: 'test-feature', repoRoot: nonString } as unknown as Parameters<
          typeof handlePrepareSynthesis
        >[0],
        tmpDir,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(vi.mocked(execSync)).not.toHaveBeenCalled();
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    }

    // The negative twin: an absolute path is still accepted, so the guard is
    // rejecting relativeness rather than rejecting everything. Asserting the
    // CODE (not just the absence of a word in the message) keeps this from
    // passing when the fixture fails validation for some unrelated reason.
    vi.mocked(execSync).mockClear();
    const accepted = await handlePrepareSynthesis(
      { featureId: 'test-feature', repoRoot: tmpDir },
      tmpDir,
      mockStore as unknown as EventStore,
    );
    expect(accepted.error?.message ?? '').not.toContain('absolute');
    expect(accepted.error?.code).not.toBe('INVALID_INPUT');
  });
});

// ─── DR-2 (#1594): document-leg pure evaluation ─────────────────────────────

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
