// ─── Prepare Synthesis Composite Action Tests ───────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolResult } from '../format.js';

// ─── Mock child_process ────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';

// ─── Mock views/tools to control materializer and event store ──────────────

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: vi.fn(),
  getOrCreateEventStore: vi.fn(),
}));

import { getOrCreateMaterializer, getOrCreateEventStore } from '../views/tools.js';

// ─── Import handler under test ─────────────────────────────────────────────

import { handlePrepareSynthesis } from './prepare-synthesis.js';

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
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ─── Test 1: Missing featureId ────────────────────────────────────────────

  it('PrepareSynthesis_MissingFeatureId_ReturnsInvalidInput', async () => {
    // Arrange
    const args = {} as { featureId: string };

    // Act
    const result = await handlePrepareSynthesis(args, STATE_DIR);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  // ─── Test 2: Tasks incomplete returns blockers ────────────────────────────

  it('PrepareSynthesis_TasksIncomplete_ReturnsBlockers', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
      't2': { status: 'in-progress' },
      't3': { status: 'assigned' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; blockers: string[] };
    expect(data.ready).toBe(false);
    expect(data.blockers).toBeDefined();
    expect(data.blockers.length).toBeGreaterThan(0);
    expect(data.blockers.some((b: string) => b.includes('t2'))).toBe(true);
    expect(data.blockers.some((b: string) => b.includes('t3'))).toBe(true);
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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    vi.mocked(execSync).mockReturnValue(Buffer.from('Tests: 10 passed, 0 failed'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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

  // ─── Test 5: Stack checked uses git log, not gt log ─────────────────────

  it('verifyStack_UsesGitLog_NotGtLog', async () => {
    // Arrange
    const taskView = mockTaskDetailView({
      't1': { status: 'completed' },
    });
    const mockMaterializer = createMockMaterializer(taskView);
    const mockStore = createMockEventStore();
    vi.mocked(getOrCreateMaterializer).mockReturnValue(mockMaterializer as unknown as ReturnType<typeof getOrCreateMaterializer>);
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    // Tests and typecheck pass, detect default branch, then git log returns commit info
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('Tests: 5 passed'))      // test suite
      .mockReturnValueOnce(Buffer.from(''))                       // typecheck
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('* abc1234 feat: add feature\n* def5678 fix: bug fix')); // git log

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    // Tests pass, typecheck passes, detect default branch, stack healthy
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('Tests: 10 passed, 0 failed'))
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('main\n  feature-branch'));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    vi.mocked(execSync).mockReturnValue(Buffer.from('Tests: 5 passed, 2 failed'));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    // Act
    await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    // execSync throws on test failure (non-zero exit code)
    const testError = new Error('Tests failed') as Error & { stdout: Buffer; status: number };
    testError.stdout = Buffer.from('Tests: 3 passed, 2 failed');
    testError.status = 1;
    vi.mocked(execSync)
      .mockImplementationOnce(() => { throw testError; })  // test suite fails
      .mockReturnValueOnce(Buffer.from(''))                  // typecheck passes
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('main'));             // git log

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

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
    vi.mocked(getOrCreateEventStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getOrCreateEventStore>);
    const typecheckError = new Error('Typecheck failed') as Error & { stdout: Buffer; status: number };
    typecheckError.stdout = Buffer.from('error TS2322: Type string not assignable\nerror TS2345: Argument mismatch');
    typecheckError.status = 1;
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('Tests: 5 passed'))     // test suite passes
      .mockImplementationOnce(() => { throw typecheckError; })  // typecheck fails
      .mockReturnValueOnce('refs/remotes/origin/main\n' as unknown as Buffer) // detectDefaultBranch
      .mockReturnValueOnce(Buffer.from('main'));                // git log

    // Act
    const result = await handlePrepareSynthesis({ featureId: 'test-feature' }, tmpDir);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { ready: boolean; typecheck: { passed: boolean; errorCount: number } };
    expect(data.ready).toBe(false);
    expect(data.typecheck.passed).toBe(false);
    expect(data.typecheck.errorCount).toBeGreaterThan(0);
  });
});
