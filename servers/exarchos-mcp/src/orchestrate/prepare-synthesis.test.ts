// ─── Prepare Synthesis Composite Action Tests ───────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

// ─── Mock child_process (git legs: symbolic-ref / log / diff) ──────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(), execFileSync: vi.fn() };
});

import { execSync, execFileSync } from 'node:child_process';

// ─── Mock the resolver-routed command seams (DR-26) ─────────────────────────
//
// Test/typecheck commands now resolve through `resolveTestRuntime` and run
// via `runCommandSync`. Mock ONLY those two seams (spread-real so the rest of
// each module keeps working across the wider composite graph the alias test
// loads).

vi.mock('../utils/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/process.js')>();
  return { ...actual, runCommandSync: vi.fn() };
});

vi.mock('../config/test-runtime-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/test-runtime-resolver.js')>();
  return { ...actual, resolveTestRuntime: vi.fn() };
});

import { runCommandSync } from '../utils/process.js';
import { resolveTestRuntime } from '../config/test-runtime-resolver.js';

// ─── Mock views/tools to control materializer and event store ──────────────

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: vi.fn(),
}));

import { getOrCreateMaterializer } from '../views/tools.js';

// ─── Import handler under test ─────────────────────────────────────────────

import {
  handlePrepareSynthesis,
  evaluateDocumentLeg,
  documentLegBlocks,
  type DocumentLegConfig,
} from './prepare-synthesis.js';
import { handleCheckIntegrationSuite } from './check-integration-suite.js';
import type { CommandResult } from './pure/static-analysis.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

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
    // DR-26 default: the resolver detects the node toolchain — the same
    // commands the pre-resolver hardcodes ran, so the command-leg mocks below
    // drive an unchanged path. Individual tests override per scenario.
    vi.mocked(resolveTestRuntime).mockReturnValue({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: null,
      source: 'detection',
    });
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from(''));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ─── Test 1: Missing featureId ────────────────────────────────────────────

  it('PrepareSynthesis_MissingFeatureId_ReturnsInvalidInput', async () => {
    // Arrange
    const args = {} as { featureId: string };

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
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from('Tests: 1 passed, 0 failed'));

    const result = await handlePrepareSynthesis(
      { featureId: 'f' },
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
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from('Tests: 10 passed, 0 failed'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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

    // DR-26: the suite ran the RESOLVER-routed command, not a hardcode.
    const [cmd, cmdArgs] = vi.mocked(runCommandSync).mock.calls[0]!;
    expect(cmd).toBe('npm');
    expect(cmdArgs).toEqual(['run', 'test:run']);
    expect(vi.mocked(resolveTestRuntime)).toHaveBeenCalled();
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
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    // Tests and typecheck pass (resolver-routed via runCommandSync); execSync
    // now only serves the git legs: detect default branch, then git log.
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from('Tests: 5 passed'));
    vi.mocked(execSync)
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('* abc1234 feat: add feature\n* def5678 fix: bug fix')); // git log

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    // Tests and typecheck pass (resolver-routed via runCommandSync); execSync
    // serves the git legs: detect default branch returns 'trunk', then git log.
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from('Tests: 5 passed'));
    vi.mocked(execSync)
      .mockReturnValueOnce('refs/remotes/origin/trunk\n' as unknown as Buffer) // detectDefaultBranch → trunk
      .mockReturnValueOnce(Buffer.from('* abc1234 feat: add feature')); // git log

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    // Tests pass, typecheck passes (resolver-routed); git legs: detect default
    // branch, stack healthy.
    vi.mocked(runCommandSync)
      .mockReturnValueOnce(Buffer.from('Tests: 10 passed, 0 failed')) // test suite
      .mockReturnValueOnce(Buffer.from(''));                          // typecheck
    vi.mocked(execSync)
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('main\n  feature-branch'));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from(''));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from('Tests: 5 passed, 2 failed'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    vi.mocked(runCommandSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    // runCommandSync throws on test failure (non-zero exit code)
    const testError = new Error('Tests failed') as Error & { stdout: Buffer; status: number };
    testError.stdout = Buffer.from('Tests: 3 passed, 2 failed');
    testError.status = 1;
    vi.mocked(runCommandSync)
      .mockImplementationOnce(() => { throw testError; })  // test suite fails
      .mockReturnValueOnce(Buffer.from(''));                 // typecheck passes
    vi.mocked(execSync)
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('main'));             // git log

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; tests: { passed: boolean } };
    expect(data.ready).toBe(false);
    expect(data.tests.passed).toBe(false);
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
    const typecheckError = new Error('Typecheck failed') as Error & { stdout: Buffer; status: number };
    typecheckError.stdout = Buffer.from('error TS2322: Type string not assignable\nerror TS2345: Argument mismatch');
    typecheckError.status = 1;
    vi.mocked(runCommandSync)
      .mockReturnValueOnce(Buffer.from('Tests: 5 passed'))     // test suite passes
      .mockImplementationOnce(() => { throw typecheckError; }); // typecheck fails
    vi.mocked(execSync)
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('main'));                // git log

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir, mockStore as unknown as EventStore);

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
    // git diff --name-only (execFileSync) reports a doc-bearing surface file.
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('src/registry.ts\n'));

    // Act
    const result = await handlePrepareSynthesis(
      {
        featureId: 'test-feature',
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
    // git diff --name-only (execFileSync) reports a doc-bearing surface file.
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('src/registry.ts\n'));

    const result = await handlePrepareSynthesis(
      {
        featureId: 'test-feature',
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
      ['servers/exarchos-mcp/src/registry.ts', 'docs/guide.md'],
      cfg({ surfaceGlobs: ['**/registry.ts'] }),
    );
    expect(r.evaluated).toBe(true);
    expect(r.covered).toBe(true);
  });

  it('DocumentLeg_SurfaceTouchedNoDocs_FailsWithMessage', () => {
    const r = evaluateDocumentLeg(
      ['servers/exarchos-mcp/src/registry.ts'],
      cfg({ surfaceGlobs: ['**/registry.ts'] }),
    );
    expect(r.evaluated).toBe(true);
    expect(r.covered).toBe(false);
    expect(r.surfaceFiles).toContain('servers/exarchos-mcp/src/registry.ts');
    expect(r.message).toMatch(/without a documentation update/);
  });
});

// ─── DR-26: phase gates route through the toolchain resolver ─────────────────

describe('DR-26: phase-gate toolchain routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveTestRuntime).mockReturnValue({
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: null,
      source: 'detection',
    });
  });

  /** Recursively collect non-test .ts sources under a directory. */
  async function collectTsSources(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTsSources(full)));
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
    return files;
  }

  /** Strip block + line comments so prose mentioning a command can't false-positive. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('//');
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join('\n');
  }

  it('PhaseGates_NoHardcodedCommands_GrepAsserted', async () => {
    // DR-26 acceptance: no gate in orchestrate/ holds an independent toolchain
    // command literal — i.e. no direct process invocation whose command token
    // is a hardcoded package MANAGER (`npm run test:run`-class, the defect the
    // DR names). Commands must flow from the layered resolver
    // (`resolveTestRuntime` / `detectToolchain`), where a package manager may
    // legitimately appear as REGISTRY data, never as an inline invocation at a
    // gate call site. (Single-file runner invocations — e.g.
    // spec_coverage_check's per-file `npx vitest run <file>` — are a separate
    // class: the resolver has no per-file surface to route them through.)
    const orchestrateDir = path.dirname(fileURLToPath(import.meta.url));
    const files = await collectTsSources(orchestrateDir);
    expect(files.length).toBeGreaterThan(0);

    const HARDCODED_INVOCATION =
      /(execSync|execFileSync|runCommandSync|spawnCommandSync|spawnSync)\(\s*[`'"](npm|pnpm|yarn|bun)\b/;

    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(await fs.readFile(file, 'utf-8'));
      if (HARDCODED_INVOCATION.test(src)) {
        offenders.push(path.relative(orchestrateDir, file));
      }
    }
    expect(
      offenders,
      `gates must resolve toolchain commands via resolveTestRuntime — hardcoded invocation found in: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('MonorepoRoot_GreenSuites_IntegrationGatePasses', async () => {
    // #1537 repro: check_integration_suite at a MONOREPO ROOT (workspaces
    // layout). The gate resolves the test command through the toolchain
    // registry against the monorepo root and a green-suite vitest JSON run
    // parses to PASS — no hardcoded command, no vitest-JSON fail-closed.
    const monoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'monorepo-root-1537-'));
    try {
      await fs.writeFile(
        path.join(monoRoot, 'package.json'),
        JSON.stringify({
          name: 'mono-root',
          private: true,
          workspaces: ['packages/*'],
          scripts: { 'test:run': 'vitest run' },
        }),
        'utf-8',
      );
      await fs.mkdir(path.join(monoRoot, 'packages', 'a'), { recursive: true });

      const greenJson = JSON.stringify({
        numTotalTestSuites: 12,
        numFailedTestSuites: 0,
        numTotalTests: 84,
        numFailedTests: 0,
        success: true,
        testResults: [],
      });
      const invocations: Array<{ cmd: string; args: readonly string[]; cwd?: string }> = [];
      const runner = (
        cmd: string,
        args: readonly string[],
        options?: { cwd?: string },
      ): CommandResult => {
        invocations.push({ cmd, args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
        return { exitCode: 0, stdout: greenJson, stderr: '' };
      };

      const mockStore = createMockEventStore();
      const result = await handleCheckIntegrationSuite(
        { featureId: 'feat-1537', repoRoot: monoRoot },
        '/tmp/test-state-dr26',
        mockStore as unknown as EventStore,
        runner,
      );

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; failCount: number; parseError: boolean };
      expect(data.passed).toBe(true);
      expect(data.failCount).toBe(0);
      expect(data.parseError).toBe(false);

      // The command was RESOLVED at the monorepo root (node toolchain from the
      // registry) and executed there — resolver-routed, not inlined.
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.cwd).toBe(monoRoot);
      expect(invocations[0]!.cmd).toBe('npm');
      expect(invocations[0]!.args).toEqual(['run', 'test:run', '--', '--reporter=json']);
    } finally {
      await fs.rm(monoRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('SynthesisChecks_MergedAction_DeprecationAliasWorks', async () => {
    // DR-26: prepare_synthesis / pre_synthesis_check are merged behind ONE
    // handler. Dispatching the DEPRECATED alias routes to the merged handler
    // (same data shape, plus an alias-compat `passed` mirror) and stamps the
    // typed `_meta.deprecation` notice naming the canonical replacement.
    const { handleOrchestrate } = await import('./composite.js');
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'in-progress' } }));
    const ctx = {
      stateDir: '/tmp/test-state-dr26',
      eventStore: mockStore,
      enableTelemetry: false,
    } as unknown as DispatchContext;

    const result = await handleOrchestrate(
      { action: 'pre_synthesis_check', featureId: 'feat-alias' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; passed: boolean; blockers?: string[] };
    // Merged handler shape (tasks incomplete → not ready)…
    expect(data.ready).toBe(false);
    expect(data.blockers?.some((b) => b.includes('t1'))).toBe(true);
    // …with the alias-compat mirror for legacy `passed` consumers.
    expect(data.passed).toBe(false);

    const meta = result._meta as Record<string, unknown>;
    const deprecation = meta['deprecation'] as {
      since: string;
      removeIn: string;
      replacement: string;
    };
    expect(deprecation).toBeDefined();
    expect(deprecation.replacement).toBe('prepare_synthesis');
    expect(deprecation.since).toBe('2.12.0');
    expect(deprecation.removeIn).toBe('2.13.0');
    expect(result.warnings?.some((w) => w.includes('deprecated'))).toBe(true);

    // The CANONICAL action returns the same merged shape with NO deprecation
    // stamp — the notice is alias-only.
    const canonical = await handleOrchestrate(
      { action: 'prepare_synthesis', featureId: 'feat-alias' },
      ctx,
    );
    expect(canonical.success).toBe(true);
    expect((canonical._meta as Record<string, unknown>)['deprecation']).toBeUndefined();
    expect((canonical.data as { ready: boolean }).ready).toBe(false);
  });

  it('PrepareSynthesis_SkipFlags_SkipLegsWithoutGateEmission', async () => {
    // Alias-compat surface on the merged handler: skipTests skips BOTH command
    // legs (no resolver call, no command run, no fake-green gate.executed) and
    // skipStack skips the stack probe; skipped legs never block readiness.
    const mockStore = createMockEventStore(tasksToEvents({ t1: { status: 'completed' } }));
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('')); // git diff: no changes

    const result = await handlePrepareSynthesis(
      { featureId: 'feat-skip', skipTests: true, skipStack: true },
      '/tmp/test-state-dr26',
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      ready: boolean;
      tests: { passed: boolean; skipped?: boolean };
      typecheck: { passed: boolean; skipped?: boolean };
      stack: { healthy: boolean; skipped?: boolean };
    };
    expect(data.tests.skipped).toBe(true);
    expect(data.typecheck.skipped).toBe(true);
    expect(data.stack.skipped).toBe(true);
    expect(data.ready).toBe(true);

    // No command ran and no test-suite/typecheck gate was emitted.
    expect(vi.mocked(runCommandSync)).not.toHaveBeenCalled();
    const gateNames = mockStore.append.mock.calls
      .map((call: unknown[]) => (call[1] as { type: string; data: { gateName?: string } }))
      .filter((e) => e.type === 'gate.executed')
      .map((e) => e.data.gateName);
    expect(gateNames).not.toContain('test-suite');
    expect(gateNames).not.toContain('typecheck');
    // The structural document leg still records its gate (featureId present).
    expect(gateNames).toContain('document-coverage');
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
