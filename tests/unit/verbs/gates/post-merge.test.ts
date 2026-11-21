/**
 * Tests for `handlePostMerge`. These cases test the provider verdict, so the file stubs the phase-gate runner down to its provider call.
 * `gate-runner.test.ts` covers the runner against a real store. `unrunbooked-gate-evidence-dispatch.test.ts` covers the evidence over real dispatch.
 * A call with no connector refuses before the runner, so each verdict case passes a stub connector.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';

const mockCheckPostMerge = vi.fn();

vi.mock('../../../../src/verbs/pure/post-merge.js', () => ({
  checkPostMerge: (...args: unknown[]) => mockCheckPostMerge(...args),
}));

vi.mock('../../../../src/utils/process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/utils/process.js')>()),
  spawnCommandSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', async (importOriginal) => ({
  verifierNotProvisioned: (await importOriginal<typeof import('../../../../src/verbs/gates/gate-runner.js')>()).verifierNotProvisioned,
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
  admitLifecycleLegs: vi.fn(),
  hostedPendingResult: vi.fn((error: unknown) => { throw error; }),
}));

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { handlePostMerge } from '../../../../src/verbs/gates/post-merge.js';
import { admitLifecycleLegs, runPhaseGateWithEvidence } from '../../../../src/verbs/gates/gate-runner.js';
import type { VerificationHostConnector } from '../../../../src/contract/verification/harness-verification.js';
import { spawnCommandSync } from '../../../../src/utils/process.js';

const STATE_DIR = '/tmp/test-post-merge';
const REPO_ROOT = '/repo';

/** A provisioned context with a stub client. The verdict cases mock the pure check, so the client never runs. */
const STUB_CONNECTOR: VerificationHostConnector = {
  publicKey: 'unused', gitPath: '/nonexistent/git', resourceId: 'unused', profileId: 'unused',
  client: { submit: async () => ({ kind: 'unavailable', reason: 'unused' }), retrieve: async () => ({ kind: 'unavailable', reason: 'unused' }) },
};

function makePassingResult() {
  return {
    status: 'pass' as const,
    prUrl: 'https://github.com/org/repo/pull/42',
    mergeSha: 'abc1234',
    passCount: 2,
    failCount: 0,
    results: [
      '- **PASS**: CI green (all checks SUCCESS or NEUTRAL)',
      '- **PASS**: Test suite (npm run test:run passed)',
    ],
    findings: [],
    report: '## Post-Merge Regression Report\n\n**Result: PASS** (2/2 checks passed)',
  };
}

function makeFailingResult() {
  return {
    status: 'fail' as const,
    prUrl: 'https://github.com/org/repo/pull/42',
    mergeSha: 'abc1234',
    passCount: 0,
    failCount: 2,
    results: [
      '- **FAIL**: CI green -- Failed checks: ci/build (FAILURE)',
      '- **FAIL**: Test suite -- npm run test:run failed',
    ],
    findings: [
      'FINDING [D4] [HIGH] criterion="ci-green" evidence="Failed checks: ci/build (FAILURE)"',
      'FINDING [D4] [HIGH] criterion="test-suite" evidence="npm run test:run failed (merge-sha: abc1234)"',
    ],
    report: '## Post-Merge Regression Report\n\n**Result: FAIL** (2/2 checks failed)',
  };
}

describe('handlePostMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  it('handlePostMerge_CIPassing_ReturnsPassed', async () => {
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      STUB_CONNECTOR,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prUrl: string; mergeSha: string; findings: string[]; report: string };
    expect(data.passed).toBe(true);
    expect(data.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(data.mergeSha).toBe('abc1234');
    expect(data.findings).toEqual([]);
    expect(data.report).toContain('PASS');
  });

  it('handlePostMerge_Regression_ReturnsFailWithFindings', async () => {
    mockCheckPostMerge.mockReturnValue(makeFailingResult());

    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      STUB_CONNECTOR,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; findings: string[]; report: string };
    expect(data.passed).toBe(false);
    expect(data.findings).toHaveLength(2);
    expect(data.findings[0]).toContain('ci-green');
    expect(data.findings[1]).toContain('test-suite');
    expect(data.report).toContain('FAIL');
  });

  it('handlePostMerge_EmitsGateExecutedEvent', async () => {
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      STUB_CONNECTOR,
    );

    expect(mockStore.append).toHaveBeenCalledTimes(1);
    const [streamId, event] = mockStore.append.mock.calls[0] as [string, { type: string; data: Record<string, unknown> }];
    expect(streamId).toBe('feat-123');
    expect(event.type).toBe('gate.executed');
    expect(event.data.gateName).toBe('post-merge');
    expect(event.data.layer).toBe('post-merge');
    expect(event.data.passed).toBe(true);
    const details = event.data.details as { dimension: string; prUrl: string; mergeSha: string; findings: string[] };
    expect(details.dimension).toBe('D4');
    expect(details.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(details.mergeSha).toBe('abc1234');
    expect(details.findings).toEqual([]);
  });

  it('handlePostMerge_EmitsGateEvent_IncludesPhaseInDetails', async () => {
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      STUB_CONNECTOR,
    );

    expect(mockStore.append).toHaveBeenCalledTimes(1);
    const [, event] = mockStore.append.mock.calls[0] as [string, { type: string; data: Record<string, unknown> }];
    const details = event.data.details as Record<string, unknown>;
    expect(details.phase).toBe('synthesize');
  });

  it('handlePostMerge_MissingPrUrl_ReturnsError', async () => {
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: '', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('prUrl');
  });

  it('handlePostMerge_MissingMergeSha_ReturnsError', async () => {
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: '', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('mergeSha');
  });

  it('handlePostMerge_MissingFeatureId_ReturnsError', async () => {
    const result = await handlePostMerge(
      { featureId: '', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  /** The handler gives the pure check only the hosted test runner, so the pure check never reaches a local runner. */
  it('handlePostMerge_PassesOnlyTheHostedTestRunner', async () => {
    mockCheckPostMerge.mockReturnValue(makePassingResult());

    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      STUB_CONNECTOR,
    );

    expect(mockCheckPostMerge).toHaveBeenCalledTimes(1);
    const callArgs = mockCheckPostMerge.mock.calls[0][0] as {
      prUrl: string;
      mergeSha: string;
      repoRoot: string;
      runCommand: unknown;
      hostedTestRun: unknown;
    };
    expect(callArgs.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(callArgs.mergeSha).toBe('abc1234');
    expect(callArgs.repoRoot).toBe(REPO_ROOT);
    expect(callArgs.runCommand).toBeUndefined();
    expect(typeof callArgs.hostedTestRun).toBe('function');
  });

  /** The hosted runner asks the verifier for the command that checkPostMerge resolved, in the named repository. */
  it('handlePostMerge_HostedTestRunner_RunsInRepoRoot', async () => {
    mockCheckPostMerge.mockReturnValue(makePassingResult());
    vi.mocked(admitLifecycleLegs).mockResolvedValue([
      { name: 'test', kind: 'command', run: { end: 'exited', exitCode: 0, stdout: '', stderr: '', outputDigest: 'a'.repeat(64) } },
    ]);

    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      STUB_CONNECTOR,
    );
    const { hostedTestRun } = mockCheckPostMerge.mock.calls[0][0] as {
      hostedTestRun: (cmd: string, args: readonly string[]) => Promise<unknown>;
    };
    await hostedTestRun('go', ['test', './...']);

    expect(admitLifecycleLegs).toHaveBeenCalledWith(expect.objectContaining({
      checkout: REPO_ROOT, legs: [{ kind: 'command', argv: ['go', 'test', './...'] }],
    }));
    expect(vi.mocked(spawnCommandSync)).not.toHaveBeenCalled();
  });

  /** With no connector, the gate refuses after argument validation, before the runner, the pure check, any event and any process. */
  it('handlePostMerge_NoConnector_RefusesWithVerifierNotProvisioned', async () => {
    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VERIFIER_NOT_PROVISIONED');
    expect(result.error?.message).toContain('Provision the verifier');
    expect(runPhaseGateWithEvidence).not.toHaveBeenCalled();
    expect(mockCheckPostMerge).not.toHaveBeenCalled();
    expect(mockStore.append).not.toHaveBeenCalled();
    expect(spawnCommandSync).not.toHaveBeenCalled();
  });

  /** Without a repository to test there is no verdict: the check never falls back to the server's directory. */
  it('handlePostMerge_MissingOrRelativeRepoRoot_ReturnsErrorWithoutRunning', async () => {
    for (const repoRoot of [undefined, '', '.', 'some/repo']) {
      const result = await handlePostMerge(
        { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot } as unknown as Parameters<
          typeof handlePostMerge
        >[0],
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(result.success, String(repoRoot)).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('repoRoot');
    }
    expect(mockCheckPostMerge).not.toHaveBeenCalled();
  });

  it('PostMerge_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
    mockCheckPostMerge.mockReturnValue(makePassingResult());
    mockStore.append.mockRejectedValueOnce(new Error('store unavailable'));

    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      STUB_CONNECTOR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
    const data = result.data as { passed: boolean; prUrl: string };
    expect(data.passed).toBe(true);
    expect(data.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  /** A provisioned route gives the pure check a hosted test runner. Its signed exit code reads as the suite result, and no local runner starts. */
  it('handlePostMerge_Provisioned_RunsTheSuiteOnlyInTheVerifier', async () => {
    const run = { end: 'exited' as const, exitCode: 1, stdout: 'red', stderr: '', outputDigest: 'a'.repeat(64) };
    vi.mocked(admitLifecycleLegs).mockResolvedValue([{ name: 'test', kind: 'command', run }]);
    let observed: unknown;
    mockCheckPostMerge.mockImplementation(async (options: { hostedTestRun?: (bin: string, args: readonly string[]) => Promise<unknown> }) => {
      observed = await options.hostedTestRun?.('node', ['test.cjs']);
      return makeFailingResult();
    });
    const connector = STUB_CONNECTOR;

    const result = await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      connector,
    );

    expect(result.success).toBe(true);
    expect(observed).toEqual({ exitCode: 1, stdout: 'red', stderr: '' });
    expect(admitLifecycleLegs).toHaveBeenCalledWith(expect.objectContaining({
      connector, checkout: REPO_ROOT, streamId: 'feat-123', legs: [{ kind: 'command', argv: ['node', 'test.cjs'] }],
    }));
    expect(spawnCommandSync).not.toHaveBeenCalled();
  });

  /** A hosted result with no test leg gives no verdict. It never reads as a red suite. */
  it('handlePostMerge_Provisioned_MissingSignedLeg_GivesNoVerdict', async () => {
    vi.mocked(admitLifecycleLegs).mockResolvedValue([]);
    let failure: unknown;
    mockCheckPostMerge.mockImplementation(async (options: { hostedTestRun?: (bin: string, args: readonly string[]) => Promise<unknown> }) => {
      failure = await options.hostedTestRun?.('node', ['test.cjs']).catch((error: unknown) => error);
      return makePassingResult();
    });
    const connector = STUB_CONNECTOR;

    await handlePostMerge(
      { featureId: 'feat-123', prUrl: 'https://github.com/org/repo/pull/42', mergeSha: 'abc1234', repoRoot: REPO_ROOT },
      STATE_DIR,
      mockStore as unknown as EventStore,
      connector,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('no verdict');
    expect(spawnCommandSync).not.toHaveBeenCalled();
  });
});
