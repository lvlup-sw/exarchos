/**
 * These tests cover the `context-economy` gate handler. They stub the phase-gate
 * runner down to its provider call, because they test the provider verdict.
 * `gate-runner.test.ts` tests the runner against a real store, and
 * `unrunbooked-gate-evidence-dispatch.test.ts` tests the evidence over real
 * dispatch.
 *
 * The `requireGateEvent` stub appends through `mockEmitGateEvent` and withholds
 * the carrier when the append throws, as the real helper does. A test controls
 * the append failure through `mockEmitGateEvent`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../../../src/events/store.js';
import type { ConstrainedDiffRange, ConstrainedDiffRead } from '../../../../src/verbs/gates/gate-utils.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const mockReadConstrainedDiff = vi.fn<(gitPath: string | undefined, repoRoot: string, range: ConstrainedDiffRange) => Promise<ConstrainedDiffRead>>();
/** When `absent` is true, the process-wide observational Git path is absent, as on a machine with no Git on PATH. */
const gitPathState = vi.hoisted(() => ({ absent: false }));
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);
/** Outside a dispatch scope, the real helper returns `undefined`. The mock does the same. */
const mockSameOperationGateKey = vi.fn<(gateName: string) => string | undefined>(
  () => undefined,
);

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  readConstrainedDiff: (gitPath: string | undefined, repoRoot: string, range: ConstrainedDiffRange) =>
    mockReadConstrainedDiff(gitPath, repoRoot, range),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
  sameOperationGateKey: (gateName: string) => mockSameOperationGateKey(gateName),
  requireGateEvent: async (
    store: unknown,
    streamId: string,
    gateName: string,
    layer: string,
    passed: boolean,
    carrier: { data?: unknown },
    details?: Record<string, unknown>,
    idempotencyKey?: string,
  ) => {
    try {
      await mockEmitGateEvent(store, streamId, gateName, layer, passed, details, idempotencyKey);
      return undefined;
    } catch (err) {
      return {
        success: false,
        data: carrier.data,
        error: {
          code: 'GATE_EVENT_UNRECORDED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
}));

vi.mock('../../../../src/utils/git-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/utils/git-tree.js')>();
  return { ...actual, processObservationalGitPath: () => (gitPathState.absent ? undefined : actual.processObservationalGitPath()) };
});

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

vi.mock('../../../../src/verbs/pure/context-economy.js', () => ({
  checkContextEconomy: vi.fn(),
}));

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

const mockTelemetryState = {
  tools: {} as Record<string, unknown>,
  sessionStart: '2026-01-01T00:00:00.000Z',
  totalInvocations: 0,
  totalTokens: 0,
  windowSize: 1000,
};

const mockMaterializer = {
  materialize: vi.fn(() => mockTelemetryState),
  getState: vi.fn(() => null),
  loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => mockMaterializer,
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

/**
 * The sequence that the `foldToTail` stub reports. The fixtures are the whole
 * stream, so the stub reports a sequence at or past each fixture event. A
 * lower sequence asserts a lag that this file does not set up.
 * `tests/unit/projections/fold-at-tail.test.ts` tests the real fold.
 */
const AT_TAIL = Number.MAX_SAFE_INTEGER;

vi.mock('../../../../src/projections/fold-at-tail.js', () => ({
  foldToTail: vi.fn(async () => ({ view: mockTelemetryState, sequence: AT_TAIL })),
}));

import { checkContextEconomy } from '../../../../src/verbs/pure/context-economy.js';
import { handleContextEconomy } from '../../../../src/verbs/gates/context-economy.js';

/** The head commit of a stubbed constrained diff. */
const HEAD_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const STATE_DIR = '/tmp/test-context-economy';

describe('handleContextEconomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  describe('input validation', () => {
    it('handleContextEconomy_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  describe('clean code', () => {
    it('handleContextEconomy_CleanCode_ReturnsPassed', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      const args = { featureId: 'feat-1' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.report).toContain('Result: PASS');
    });
  });

  describe('findings detected', () => {
    it('handleContextEconomy_Findings_ReturnsFailWithCount', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: false,
        checksRun: 4,
        checksPassed: 2,
        findings: [
          { severity: 'MEDIUM', message: '`src/big-file.ts` — Source file exceeds 400 lines (520 lines)' },
          { severity: 'MEDIUM', message: 'Diff breadth: 35 files changed (threshold: 30)' },
        ],
      });

      const args = { featureId: 'feat-1' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(2);
      expect(data.report).toContain('FINDINGS');
    });
  });

  describe('gate event emission', () => {
    it('handleContextEconomy_EmitsGateEvent_WithD3Dimension', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      const args = { featureId: 'feat-1' };
      await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitGateEvent).toHaveBeenCalledWith(
        mockStore,
        'feat-1',
        'context-economy',
        'quality',
        true,
        { dimension: 'D3', phase: 'review', findingCount: 0 },
        undefined,
      );
    });
  });

  describe('phase in gate event details', () => {
    it('handleContextEconomy_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      const args = { featureId: 'feat-1' };
      await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      const details = mockEmitGateEvent.mock.calls[0][5] as Record<string, unknown>;
      expect(details.phase).toBe('review');
    });
  });

  describe('git diff failure', () => {
    it('handleContextEconomy_GitDiffFails_ReturnsError', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'refused', reason: 'No merge base' });

      const args = { featureId: 'feat-1' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(checkContextEconomy).not.toHaveBeenCalled();
    });
  });

  describe('telemetry integration', () => {
    it('handleContextEconomy_WithTelemetryData_IncludesRuntimeMetricsInResult', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      mockTelemetryState.tools = {
        'exarchos_workflow': {
          invocations: 5,
          errors: 0,
          totalDurationMs: 1000,
          totalBytes: 2000,
          totalTokens: 3000,
          p50DurationMs: 200,
          p95DurationMs: 400,
          p50Bytes: 400,
          p95Bytes: 800,
          p50Tokens: 600,
          p95Tokens: 1200,
          durations: [],
          sizes: [],
          tokenEstimates: [],
        },
        'exarchos_view': {
          invocations: 5,
          errors: 0,
          totalDurationMs: 500,
          totalBytes: 1000,
          totalTokens: 2000,
          p50DurationMs: 100,
          p95DurationMs: 200,
          p50Bytes: 200,
          p95Bytes: 400,
          p50Tokens: 400,
          p95Tokens: 800,
          durations: [],
          sizes: [],
          tokenEstimates: [],
        },
      };
      mockTelemetryState.totalTokens = 5000;
      mockTelemetryState.totalInvocations = 10;

      const args = { featureId: 'feat-1' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
        runtimeMetrics: {
          sessionTokens: number;
          toolCount: number;
          totalInvocations: number;
        };
      };
      expect(data.runtimeMetrics).toBeDefined();
      expect(data.runtimeMetrics.sessionTokens).toBe(5000);
      expect(data.runtimeMetrics.toolCount).toBe(2);
      expect(data.runtimeMetrics.totalInvocations).toBe(10);
    });

    it('handleContextEconomy_WithoutTelemetryData_ReturnsZeroMetrics', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });

      mockTelemetryState.tools = {};
      mockTelemetryState.totalTokens = 0;
      mockTelemetryState.totalInvocations = 0;

      const args = { featureId: 'feat-1' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
        runtimeMetrics: {
          sessionTokens: number;
          toolCount: number;
          totalInvocations: number;
        };
      };
      expect(data.runtimeMetrics).toBeDefined();
      expect(data.runtimeMetrics.sessionTokens).toBe(0);
      expect(data.runtimeMetrics.toolCount).toBe(0);
      expect(data.runtimeMetrics.totalInvocations).toBe(0);
    });
  });

  describe('gate event append failure', () => {
    it('ContextEconomy_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkContextEconomy).mockReturnValue({
        pass: true,
        checksRun: 4,
        checksPassed: 4,
        findings: [],
      });
      mockEmitGateEvent.mockRejectedValueOnce(new Error('store unavailable'));

      const args = { featureId: 'feat-1' };
      const result = await handleContextEconomy(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
      const data = result.data as { passed: boolean; findingCount: number };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
    });
  });
});

/** A temporary Git checkout on branch `feature`, forked from `main`, with a branch `unrelated` that shares no history. */
async function checkoutWithUnrelatedBranch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gate-base-diff-'));
  const git = (...args: string[]): Promise<string> => execFileAsync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await git('add', 'seed.txt');
  await git('commit', '-q', '-m', 'seed');
  await git('checkout', '-q', '--orphan', 'unrelated');
  await git('commit', '-q', '-m', 'unrelated');
  await git('checkout', '-q', 'main');
  await git('checkout', '-q', '-b', 'feature');
  await writeFile(join(dir, 'feature.txt'), 'feature\n');
  await git('add', 'feature.txt');
  await git('commit', '-q', '-m', 'feature');
  return dir;
}

/** The actual gate utilities, with the real constrained read. */
function actualGateUtils(): Promise<typeof import('../../../../src/verbs/gates/gate-utils.js')> {
  return vi.importActual<typeof import('../../../../src/verbs/gates/gate-utils.js')>('../../../../src/verbs/gates/gate-utils.js');
}

/** The positive control: the real constrained read through the process-wide path gives the diff from `main`. */
async function expectDiffFromMain(root: string): Promise<void> {
  const { readConstrainedDiff } = await actualGateUtils();
  expect((await readConstrainedDiff(undefined, root, { kind: 'base', base: 'main' })).kind).toBe('diff');
}

/** Run the gate in the temporary checkout with a real store. A refused read uses no store method. */
function runGate(root: string, baseBranch: string): ReturnType<typeof handleContextEconomy> {
  return handleContextEconomy({ featureId: 'feat-1', repoRoot: root, baseBranch }, root, new EventStore(root));
}

/**
 * Negative controls of the constrained base diff. Each case runs the real constrained read in a temporary Git checkout.
 * A positive control first reads the diff from `main`, so a refusal comes from the named cause and not from the fixture.
 * A refused read gives DIFF_ERROR, runs no check and appends no gate event.
 */
describe('handleContextEconomy constrained base diff', () => {
  let root = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    gitPathState.absent = false;
    mockReadConstrainedDiff.mockImplementation((await actualGateUtils()).readConstrainedDiff);
    root = await checkoutWithUnrelatedBranch();
  });

  afterEach(async () => {
    gitPathState.absent = false;
    await rmrfAsync(root);
  });

  it('ContextEconomy_NoMergeBase_GivesDiffErrorAndNoFindings', async () => {
    await expectDiffFromMain(root);
    const result = await runGate(root, 'unrelated');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_ERROR');
    expect(checkContextEconomy).not.toHaveBeenCalled();
    expect(mockEmitGateEvent).not.toHaveBeenCalled();
  });

  it('ContextEconomy_HeadBase_GivesDiffErrorAndNoFindings', async () => {
    await expectDiffFromMain(root);
    const result = await runGate(root, 'HEAD');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_ERROR');
    expect(checkContextEconomy).not.toHaveBeenCalled();
    expect(mockEmitGateEvent).not.toHaveBeenCalled();
  });

  it('ContextEconomy_NoGitPath_GivesDiffErrorAndNoFindings', async () => {
    await expectDiffFromMain(root);
    gitPathState.absent = true;
    const result = await runGate(root, 'main');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_ERROR');
    expect(result.error?.message).toContain('No usable Git executable');
    expect(checkContextEconomy).not.toHaveBeenCalled();
    expect(mockEmitGateEvent).not.toHaveBeenCalled();
  });
});
