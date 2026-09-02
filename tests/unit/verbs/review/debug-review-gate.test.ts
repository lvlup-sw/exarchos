// ─── Debug Review Gate Tests ─────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock node:child_process ────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// ─── Mock node:fs ───────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { handleDebugReviewGate } from '../../../../src/verbs/review/debug-review-gate.js';
import type { EventStore } from '../../../../src/events/store.js';
// The gate now records durable evidence through the shared phase-gate runner
// before any success carrier escapes. These cases are about the PROVIDER's
// verdict, so the runner is stubbed down to its provider call — the same seam
// every other migrated gate's unit test stubs. The evidence a caller actually
// gets is proven over real dispatch in
// `unrunbooked-gate-evidence-dispatch.test.ts`.
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Cast string to satisfy execFileSync overload return type. */
function mockOutput(s: string): never {
  return s as never;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleDebugReviewGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Test 1: Test files found + tests pass → passed: true ───────────────

  it('returns passed when test files exist and tests pass', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput('src/widget.ts\nsrc/widget.test.ts\nsrc/utils.ts\n'))
      .mockReturnValueOnce(mockOutput('Tests passed'));

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/repo',
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

  // ─── Test 2: No test files in diff → passed: false ─────────────────────

  it('returns failed when no test files in diff', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput('src/widget.ts\nsrc/utils.ts\n'))
      .mockReturnValueOnce(mockOutput('Tests passed'));

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/repo',
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

  // ─── Test 3: No changed files → passed: false ──────────────────────────

  it('returns failed when no changed files found', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    vi.mocked(execFileSync).mockReturnValueOnce(mockOutput(''));

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/repo',
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

  // ─── Test 4: Tests fail → passed: false ─────────────────────────────────

  it('returns failed when npm test:run fails', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput('src/widget.ts\nsrc/widget.test.ts\n'))
      .mockImplementationOnce(() => {
        throw new Error('npm run test:run failed');
      });

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/repo',
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

  // ─── Test 5: skipRun=true → skip test execution check ──────────────────

  it('skips test execution when skipRun is true', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    vi.mocked(execFileSync).mockReturnValueOnce(
      mockOutput('src/widget.ts\nsrc/widget.test.ts\n'),
    );

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/repo',
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
    // execFileSync should only be called once (git diff), not for npm test
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  // ─── Test 6: repoRoot not found → error result ─────────────────────────

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

  // ─── Test 7: Various test file extensions are detected ──────────────────

  it('detects all supported test file extensions', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    vi.mocked(execFileSync)
      .mockReturnValueOnce(mockOutput(
        'src/a.test.ts\nsrc/b.spec.ts\nscripts/c.test.sh\nsrc/d.test.js\nsrc/e.spec.js\n',
      ))
      .mockReturnValueOnce(mockOutput('Tests passed'));

    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/repo',
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

  // ─── Test 8: Missing baseBranch → error ─────────────────────────────────

  it('returns error when baseBranch is empty', async () => {
    const result = await handleDebugReviewGate({
      featureId: FEATURE_ID,
      repoRoot: '/repo',
      baseBranch: '',
    }, STATE_DIR, eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('baseBranch');
  });
});
