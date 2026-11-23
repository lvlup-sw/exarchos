// Tests the provider verdict of `handleDebugReviewGate`.
// The gate records durable evidence through the shared phase-gate runner, and these tests stub that runner down to its provider call.
// `unrunbooked-gate-evidence-dispatch.test.ts` proves the evidence over real dispatch.
// The changed files come from a stubbed constrained observation, and the test leg from a stubbed lifecycle check of the local executor.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock('../../../../src/verbs/gates/gate-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/verbs/gates/gate-utils.js')>()),
  observeCurrentCheckout: vi.fn(),
}));

vi.mock('../../../../src/utils/git-tree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/utils/git-tree.js')>()),
  processObservationalGitPath: vi.fn(() => '/usr/bin/git'),
}));

vi.mock('../../../../src/verbs/verification/lifecycle-check.js', () => ({
  admitLifecycleLegs: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { handleDebugReviewGate } from '../../../../src/verbs/review/debug-review-gate.js';
import { runPhaseGateWithEvidence } from '../../../../src/verbs/gates/gate-runner.js';
import { admitLifecycleLegs } from '../../../../src/verbs/verification/lifecycle-check.js';
import { observeCurrentCheckout, type CurrentCheckoutRead } from '../../../../src/verbs/gates/gate-utils.js';
import { processObservationalGitPath } from '../../../../src/utils/git-tree.js';
import type { EventStore } from '../../../../src/events/store.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
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
  hostedPendingResult: vi.fn((error: unknown) => { throw error; }),
}));

const STATE_DIR = '/tmp/test-debug-review-gate';
const FEATURE_ID = 'debug-review-feature';
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const MERGE_BASE = 'd'.repeat(40);
const eventStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
} as unknown as EventStore;

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const fixtureDirs: string[] = [];

/** A real temporary repository holding `files`, removed after each test. */
function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'debug-review-gate-'));
  fixtureDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** The stubbed constrained reads of one observed checkout. A read given as an Error rejects. */
interface ObservedReads {
  readonly mergeBase?: string | Error;
  readonly threeDot?: string | Error;
  readonly twoDot?: string | Error;
  readonly base?: 'refused';
}

/** Stub the observation of the checkout at `checkout` with the given reads, and return the read spies. */
function observe(checkout: string, reads: ObservedReads) {
  const value = (read: string | Error | undefined) => async () => {
    if (read instanceof Error) throw read;
    return read ?? '';
  };
  const mergeBase = vi.fn(value(reads.mergeBase ?? `${MERGE_BASE}\n`));
  const nameOnly = vi.fn(async (_gitDir: string, _checkout: string, base: string) => value(base === MERGE_BASE ? reads.threeDot : reads.twoDot)());
  const base = vi.fn(async () => reads.base === 'refused' ? { kind: 'refused', reason: 'A full local branch ref is required' } : { kind: 'observed', value: BASE });
  const read = {
    kind: 'observed',
    checkout: { checkout, repository: `${checkout}/.git`, gitDir: `${checkout}/.git`, branch: 'refs/heads/fix', head: HEAD },
    observer: { reads: { mergeBase, nameOnly }, base },
  } as unknown as CurrentCheckoutRead;
  vi.mocked(observeCurrentCheckout).mockResolvedValue(read);
  return { mergeBase, nameOnly, base };
}

/** Stub the test leg of the local executor with an exit code. */
function localExit(exitCode: number): void {
  const run = { argv: ['test'], end: 'exited' as const, exitCode, stdout: '', stderr: '' };
  vi.mocked(admitLifecycleLegs).mockResolvedValue([{ name: 'test', kind: 'command', run }]);
}

describe('handleDebugReviewGate', () => {
  let repoRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockImplementation(realFs.existsSync);
    repoRoot = fixtureRepo({ '.exarchos.yml': "test: 'vitest run'\n" });
  });

  afterEach(() => {
    for (const dir of fixtureDirs.splice(0)) rmrf(dir);
  });

  /** With no verifier provisioning, the resolved test command runs in the local executor. The diff reads go through the constrained reader with the process-wide Git path. */
  it('runs the tests in the local executor with no verifier provisioning', async () => {
    observe(repoRoot, { threeDot: 'src/widget.ts\nsrc/widget.test.ts\n' });
    localExit(0);

    const result = await handleDebugReviewGate({ featureId: FEATURE_ID, repoRoot, baseBranch: 'main' }, STATE_DIR, eventStore);

    expect(execFileSync).not.toHaveBeenCalled();
    expect(observeCurrentCheckout).toHaveBeenCalledWith('/usr/bin/git', repoRoot);
    expect(admitLifecycleLegs).toHaveBeenCalledWith(expect.objectContaining({
      eventStore, checkout: repoRoot, streamId: FEATURE_ID, legs: [{ kind: 'command', argv: ['vitest', 'run'] }],
    }));
    expect((result.data as { report: string }).report).toContain('**PASS**: Tests pass (vitest run)');
  });

  it('returns passed when test files exist and tests pass', async () => {
    observe(repoRoot, { threeDot: 'src/widget.ts\nsrc/widget.test.ts\nsrc/utils.ts\n' });
    localExit(0);

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      report: string;
      checks: { pass: number; fail: number; skip: number };
    };
    expect(data.passed).toBe(true);
    expect(data.checks.pass).toBe(2);
    expect(data.checks.fail).toBe(0);
    expect(data.checks.skip).toBe(0);
    expect(data.report).toContain('PASS');
  });

  it('returns failed when no test files in diff', async () => {
    observe(repoRoot, { threeDot: 'src/widget.ts\nsrc/utils.ts\n' });
    localExit(0);

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      report: string;
      checks: { pass: number; fail: number; skip: number };
    };
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('FAIL');
  });

  it('returns failed when no changed files found', async () => {
    observe(repoRoot, { threeDot: '' });

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      report: string;
      checks: { pass: number; fail: number; skip: number };
    };
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('No changed files');
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
  });

  it('returns failed when the resolved test command fails', async () => {
    observe(repoRoot, { threeDot: 'src/widget.ts\nsrc/widget.test.ts\n' });
    localExit(1);

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      report: string;
      checks: { pass: number; fail: number; skip: number };
    };
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('FAIL');
  });

  /** With `skipRun`, the gate reads the diff and asks the executor for no test run. */
  it('skips test execution when skipRun is true', async () => {
    observe(repoRoot, { threeDot: 'src/widget.ts\nsrc/widget.test.ts\n' });

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot,
      baseBranch: 'main',
      skipRun: true,
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      report: string;
      checks: { pass: number; fail: number; skip: number };
    };
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBe(1);
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('returns error when repoRoot does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/nonexistent',
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('/nonexistent');
  });

  it('detects all supported test file extensions', async () => {
    observe(repoRoot, { threeDot: 'src/a.test.ts\nsrc/b.spec.ts\nscripts/c.test.sh\nsrc/d.test.js\nsrc/e.spec.js\n' });
    localExit(0);

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      checks: { pass: number; fail: number; skip: number };
      report: string;
    };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('5 test file(s)');
  });

  /** A Go module resolves `go test ./...` from the toolchain registry, and the executor runs that command in the module. */
  it('runs the resolved test command for a Go module', async () => {
    const goRepo = fixtureRepo({ 'go.mod': 'module example.com/fixture\n' });
    observe(goRepo, { threeDot: 'widget.go\nscripts/widget.test.sh\n' });
    localExit(0);

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: goRepo,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(admitLifecycleLegs).toHaveBeenCalledTimes(1);
    expect(admitLifecycleLegs).toHaveBeenCalledWith(expect.objectContaining({
      checkout: goRepo, legs: [{ kind: 'command', argv: ['go', 'test', './...'] }],
    }));
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('- **PASS**: Tests pass (go test ./...)');
  });

  /** No project markers and no configuration: the test check fails closed and asks the executor for nothing. */
  it('fails the test check when no test command resolves', async () => {
    const emptyRepo = fixtureRepo({});
    observe(emptyRepo, { threeDot: 'src/widget.test.ts\n' });

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: emptyRepo,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    const data = result.data as { passed: boolean; report: string; checks: { fail: number; skip: number } };
    expect(data.passed).toBe(false);
    expect(data.checks.skip).toBe(0);
    expect(data.report).toMatch(/- \*\*FAIL\*\*: Tests pass — no test command resolved: No project markers detected/);
  });

  it('returns error when baseBranch is empty', async () => {
    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot,
      baseBranch: '',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('baseBranch');
  });

  /** A refusal of the local executor returns as the gate result. With no usable Git, the diff read fails closed and no test runs. */
  it('DebugReviewGate_LocalRefusalAndNoGit_FailClosed', async () => {
    observe(repoRoot, { threeDot: 'src/widget.test.ts\n' });
    vi.mocked(admitLifecycleLegs).mockResolvedValue({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: 'refused' } });
    const refused = await handleDebugReviewGate({ featureId: FEATURE_ID, repoRoot, baseBranch: 'main' }, STATE_DIR, eventStore);
    expect(refused).toEqual({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: 'refused' } });
    expect(runPhaseGateWithEvidence).toHaveBeenCalledTimes(1);

    vi.mocked(admitLifecycleLegs).mockClear();
    vi.mocked(processObservationalGitPath).mockReturnValueOnce(undefined);
    const noGit = await handleDebugReviewGate({ featureId: FEATURE_ID, repoRoot, baseBranch: 'main' }, STATE_DIR, eventStore);
    expect(noGit.error?.code).toBe('DIFF_FAILED');
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** The first read diffs from the merge base. When it fails, the second read diffs the base and the head, and only when both fail does the gate give DIFF_FAILED. */
  it('DebugReviewGate_ConstrainedDiff_ThreeDotThenTwoDotThenDiffFailed', async () => {
    const fallback = observe(repoRoot, { mergeBase: new Error('no merge base'), twoDot: 'src/widget.test.ts\n' });
    localExit(0);
    const fellBack = await handleDebugReviewGate({ featureId: FEATURE_ID, repoRoot, baseBranch: 'main' }, STATE_DIR, eventStore);
    expect((fellBack.data as { passed: boolean }).passed).toBe(true);
    expect(fallback.nameOnly).toHaveBeenCalledWith(`${repoRoot}/.git`, repoRoot, BASE, HEAD);

    observe(repoRoot, { threeDot: new Error('diff failed'), twoDot: new Error('diff failed') });
    const failed = await handleDebugReviewGate({ featureId: FEATURE_ID, repoRoot, baseBranch: 'main' }, STATE_DIR, eventStore);
    expect(failed.error?.code).toBe('DIFF_FAILED');

    observe(repoRoot, { base: 'refused', threeDot: 'src/widget.test.ts\n' });
    const refusedBase = await handleDebugReviewGate({ featureId: FEATURE_ID, repoRoot, baseBranch: 'v1..main' }, STATE_DIR, eventStore);
    expect(refusedBase.error?.code).toBe('DIFF_FAILED');

    vi.mocked(observeCurrentCheckout).mockResolvedValue({ kind: 'refused', reason: 'The checkout HEAD is detached' });
    const detached = await handleDebugReviewGate({ featureId: FEATURE_ID, repoRoot, baseBranch: 'main' }, STATE_DIR, eventStore);
    expect(detached.error?.code).toBe('DIFF_FAILED');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
