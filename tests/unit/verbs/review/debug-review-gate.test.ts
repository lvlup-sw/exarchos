// Tests the provider verdict of `handleDebugReviewGate`.
// The gate records durable evidence through the shared phase-gate runner, and these tests stub that runner down to its provider call.
// `unrunbooked-gate-evidence-dispatch.test.ts` proves the evidence over real dispatch.

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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { handleDebugReviewGate } from '../../../../src/verbs/review/debug-review-gate.js';
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
}));

const STATE_DIR = '/tmp/test-debug-review-gate';
const FEATURE_ID = 'debug-review-feature';
const eventStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
} as unknown as EventStore;

/** Cast string to satisfy execFileSync overload return type. */
function mockOutput(s: string): never {
  return s as never;
}

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const fixtureDirs: string[] = [];

/** A real temporary repository holding `files`, removed after each test. */
function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'debug-review-gate-'));
  fixtureDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
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

  it('returns passed when test files exist and tests pass', async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput('src/widget.ts\nsrc/widget.test.ts\nsrc/utils.ts\n'))
      .mockReturnValueOnce(mockOutput('Tests passed'));

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
    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput('src/widget.ts\nsrc/utils.ts\n'))
      .mockReturnValueOnce(mockOutput('Tests passed'));

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
    vi.mocked(execFileSync).mockReturnValueOnce(mockOutput(''));

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
  });

  it('returns failed when the resolved test command fails', async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput('src/widget.ts\nsrc/widget.test.ts\n'))
      .mockImplementationOnce(() => {
        throw new Error('vitest run failed');
      });

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

  /** With `skipRun`, `execFileSync` runs once for `git diff` and not for the test command. */
  it('skips test execution when skipRun is true', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce(
      mockOutput('src/widget.ts\nsrc/widget.test.ts\n'),
    );

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
    expect(execFileSync).toHaveBeenCalledTimes(1);
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
    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput(
        'src/a.test.ts\nsrc/b.spec.ts\nscripts/c.test.sh\nsrc/d.test.js\nsrc/e.spec.js\n',
      ))
      .mockReturnValueOnce(mockOutput('Tests passed'));

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

  /** A Go module resolves `go test ./...` from the toolchain registry, and that command runs within the 120 s bound. */
  it('runs the resolved test command for a Go module', async () => {
    const goRepo = fixtureRepo({ 'go.mod': 'module example.com/fixture\n' });
    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput('widget.go\nscripts/widget.test.sh\n'))
      .mockReturnValueOnce(mockOutput('ok  example.com/fixture'));

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: goRepo,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFileSync).mock.calls[1]?.slice(0, 2)).toEqual(['go', ['test', './...']]);
    expect(vi.mocked(execFileSync).mock.calls[1]?.[2]).toMatchObject({ cwd: goRepo, timeout: 120_000 });
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('- **PASS**: Tests pass (go test ./...)');
  });

  /** No project markers and no configuration: the test check fails closed. */
  it('fails the test check when no test command resolves', async () => {
    const emptyRepo = fixtureRepo({});
    vi.mocked(execFileSync).mockReturnValueOnce(mockOutput('src/widget.test.ts\n'));

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: emptyRepo,
      baseBranch: 'main',
    }, STATE_DIR, eventStore);

    expect(execFileSync).toHaveBeenCalledTimes(1);
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
});
