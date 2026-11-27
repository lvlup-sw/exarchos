/**
 * Tests for `handleWorkflowDeterminism`. These cases test the provider verdict, so the file stubs the phase-gate runner down to its provider call.
 * `gate-runner.test.ts` covers the runner against a real store. `unrunbooked-gate-evidence-dispatch.test.ts` covers the evidence over real dispatch.
 * Like the real helper, the `requireGateEvent` stub appends through `mockEmitGateEvent` and withholds the success result when that append throws.
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
/** Outside a dispatch scope, no operation exists for a retry to collapse onto. The real helper returns `undefined`, and the mock does the same. */
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

vi.mock('../../../../src/verbs/pure/workflow-determinism.js', () => ({
  checkWorkflowDeterminism: vi.fn(),
}));

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { checkWorkflowDeterminism } from '../../../../src/verbs/pure/workflow-determinism.js';
import { handleWorkflowDeterminism } from '../../../../src/verbs/gates/workflow-determinism.js';

/** The head commit of a stubbed constrained diff. */
const HEAD_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const STATE_DIR = '/tmp/test-workflow-determinism';

describe('handleWorkflowDeterminism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  describe('input validation', () => {
    it('handleWorkflowDeterminism_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  describe('clean code', () => {
    it('handleWorkflowDeterminism_CleanCode_ReturnsPassed', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; findingCount: number; report: string };
      expect(data.passed).toBe(true);
      expect(data.findingCount).toBe(0);
      expect(data.report).toContain('Result: PASS');
    });
  });

  describe('findings detected', () => {
    it('handleWorkflowDeterminism_Findings_ReturnsFailWithCount', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.test.ts b/foo.test.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'findings',
        findingCount: 3,
        findings: [
          '- **HIGH** `src/handler.test.ts:3` — Test focus/skip modifier: `describe.only(...)`',
          '- **LOW** `src/handler.test.ts:5` — Debug artifact in test file: `console.log(...)`',
          '- **MEDIUM** `src/util.test.ts:10` — Non-deterministic time without fake timers: `Date.now()`',
        ],
        passedChecks: 1,
        totalChecks: 4,
        report: '**Result: FINDINGS** (3 findings detected)',
      });

      const args = { featureId: 'feat-1' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; findingCount: number; report: string };
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(3);
      expect(data.report).toContain('FINDINGS');
    });
  });

  describe('gate event emission', () => {
    it('handleWorkflowDeterminism_EmitsGateEvent_WithD5Dimension', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });

      const args = { featureId: 'feat-1' };
      await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockEmitGateEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitGateEvent).toHaveBeenCalledWith(
        mockStore,
        'feat-1',
        'workflow-determinism',
        'quality',
        true,
        { dimension: 'D5', phase: 'review', findingCount: 0 },
        undefined,
      );
    });
  });

  describe('git diff failure', () => {
    it('handleWorkflowDeterminism_GitDiffFails_ReturnsError', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'refused', reason: 'No merge base' });

      const args = { featureId: 'feat-1' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(checkWorkflowDeterminism).not.toHaveBeenCalled();
    });
  });

  describe('gate event append failure', () => {
    /** The gate verdict stays readable on `data`. The handler withholds only the success result. */
    it('WorkflowDeterminism_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
      mockReadConstrainedDiff.mockResolvedValue({ kind: 'diff', diff: 'diff --git a/foo.ts b/foo.ts\n', head: HEAD_COMMIT });
      vi.mocked(checkWorkflowDeterminism).mockReturnValue({
        status: 'pass',
        findingCount: 0,
        findings: [],
        passedChecks: 4,
        totalChecks: 4,
        report: '**Result: PASS** (4/4 checks passed)',
      });
      mockEmitGateEvent.mockRejectedValueOnce(new Error('store unavailable'));

      const args = { featureId: 'feat-1' };
      const result = await handleWorkflowDeterminism(args, STATE_DIR, mockStore as unknown as EventStore);

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
function runGate(root: string, baseBranch: string): ReturnType<typeof handleWorkflowDeterminism> {
  return handleWorkflowDeterminism({ featureId: 'feat-1', repoRoot: root, baseBranch }, root, new EventStore(root));
}

/**
 * Negative controls of the constrained base diff. Each case runs the real constrained read in a temporary Git checkout.
 * A positive control first reads the diff from `main`, so a refusal comes from the named cause and not from the fixture.
 * A refused read gives DIFF_ERROR, runs no check and appends no gate event.
 */
describe('handleWorkflowDeterminism constrained base diff', () => {
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

  it('WorkflowDeterminism_NoMergeBase_GivesDiffErrorAndNoFindings', async () => {
    await expectDiffFromMain(root);
    const result = await runGate(root, 'unrelated');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_ERROR');
    expect(checkWorkflowDeterminism).not.toHaveBeenCalled();
    expect(mockEmitGateEvent).not.toHaveBeenCalled();
  });

  it('WorkflowDeterminism_HeadBase_GivesDiffErrorAndNoFindings', async () => {
    await expectDiffFromMain(root);
    const result = await runGate(root, 'HEAD');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_ERROR');
    expect(checkWorkflowDeterminism).not.toHaveBeenCalled();
    expect(mockEmitGateEvent).not.toHaveBeenCalled();
  });

  it('WorkflowDeterminism_NoGitPath_GivesDiffErrorAndNoFindings', async () => {
    await expectDiffFromMain(root);
    gitPathState.absent = true;
    const result = await runGate(root, 'main');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_ERROR');
    expect(result.error?.message).toContain('No usable Git executable');
    expect(checkWorkflowDeterminism).not.toHaveBeenCalled();
    expect(mockEmitGateEvent).not.toHaveBeenCalled();
  });
});
