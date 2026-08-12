// ─── Integration Suite Gate Tests (#1329) ────────────────────────────────────
//
// The #1329 trap: vitest counts a file that fails at IMPORT as
// "1 failed test suite / 0 failed tests". Per-task gates therefore see a
// green test count while the integration tip cascades (125 files failing to
// LOAD, ~1899 tests never collected). This gate runs the FULL suite against
// the integration tip and folds load-failures into the failure count so a
// load cascade cannot pass silently.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../events/store.js';
import type { CommandResult } from '../pure/static-analysis.js';

vi.mock('./durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<unknown>,
  ) => executeProvider(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

import { handleCheckIntegrationSuite, isSpawnFailure } from './check-integration-suite.js';
import {
  parseVitestResult,
  runIntegrationSuite,
  resolveIntegrationCommand,
  LOAD_FAILURE_LIST_CAP,
} from '../pure/integration-suite.js';
import type { Toolchain } from '../../config/toolchains.js';

const STATE_DIR = '/tmp/test-integration-suite';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * A vitest JSON result where ONE file fails to LOAD at import time:
 *   - numFailedTestSuites: 1  (the file failed to load)
 *   - numFailedTests:      0  (no test even got to run inside it)
 * This is the exact silent-load-failure shape from #1329.
 */
function vitestLoadFailureJson(): string {
  return JSON.stringify({
    numTotalTestSuites: 10,
    numPassedTestSuites: 9,
    numFailedTestSuites: 1,
    numTotalTests: 50,
    numPassedTests: 50,
    numFailedTests: 0,
    success: false,
    testResults: [
      {
        name: '/repo/src/broken.test.ts',
        status: 'failed',
        message:
          'Error: Failed to load url ./missing.js (resolved id: ./missing.js). Does the file exist?',
        assertionResults: [],
      },
    ],
  });
}

/** A runner stub that returns the given vitest JSON on stdout with a non-zero exit. */
function stubRunnerReturning(json: string, exitCode = 1) {
  return vi.fn(
    (_cmd: string, _args: readonly string[], _opts?: { cwd?: string }): CommandResult => ({
      exitCode,
      stdout: json,
      stderr: '',
    }),
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleCheckIntegrationSuite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  it('CheckIntegrationSuite_FileFailsToLoad_ReturnsFailedAndCountsIt', async () => {
    // Arrange — runner emits the #1329 shape: 1 failed SUITE, 0 failed TESTS.
    const runner = stubRunnerReturning(vitestLoadFailureJson());

    const args = { featureId: 'feat-1', repoRoot: '/repo' };

    // Act
    const result = await handleCheckIntegrationSuite(
      args,
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    // Assert — the load failure must NOT be silently green.
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      failCount: number;
      loadFailures: number;
    };
    expect(data.passed).toBe(false);
    expect(data.loadFailures).toBeGreaterThanOrEqual(1);
    // The load failure is folded into the overall failure count.
    expect(data.failCount).toBeGreaterThanOrEqual(1);
  });

  it('CheckIntegrationSuite_AllGreen_ReturnsPassed', async () => {
    // Arrange — a clean run: zero failed suites, zero failed tests.
    const cleanJson = JSON.stringify({
      numTotalTestSuites: 10,
      numFailedTestSuites: 0,
      numTotalTests: 50,
      numFailedTests: 0,
      success: true,
      testResults: [],
    });
    const runner = stubRunnerReturning(cleanJson, 0);

    // Act
    const result = await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    // Assert
    const data = result.data as { passed: boolean; failCount: number; loadFailures: number };
    expect(data.passed).toBe(true);
    expect(data.failCount).toBe(0);
    expect(data.loadFailures).toBe(0);
  });

  it('CheckIntegrationSuite_DoesNotEmitLegacyGateExecutedEvent', async () => {
    // Arrange
    const runner = stubRunnerReturning(vitestLoadFailureJson());

    // Act
    await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    expect(mockStore.append).not.toHaveBeenCalled();
  });

  it('CheckIntegrationSuite_RunsAgainstResolvedRepoRoot', async () => {
    // Arrange — assert the runner is invoked with cwd === the literal repoRoot.
    const runner = stubRunnerReturning(vitestLoadFailureJson());

    // Act
    await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/worktrees/agent-x' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    // Assert
    expect(runner).toHaveBeenCalledTimes(1);
    const opts = runner.mock.calls[0][2];
    expect(opts?.cwd).toBe('/worktrees/agent-x');
  });

  it('CheckIntegrationSuite_UnparseableOutputWithZeroExit_FailsClosed', async () => {
    // Arrange — the runner emits garbage on stdout but exits 0. A zero exit is
    // NOT trustworthy evidence the suite passed (a crashed/garbled reporter can
    // still exit clean), so the gate must fail closed rather than green-light an
    // unknown state.
    const runner = stubRunnerReturning('this is not vitest json', 0);

    // Act
    const result = await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    // Assert
    const data = result.data as { passed: boolean; failCount: number; parseError: boolean };
    expect(data.passed).toBe(false);
    expect(data.failCount).toBeGreaterThanOrEqual(1);
    expect(data.parseError).toBe(true);
  });

  it('CheckIntegrationSuite_MissingFeatureId_ReturnsError', async () => {
    const runner = stubRunnerReturning(vitestLoadFailureJson());
    const result = await handleCheckIntegrationSuite(
      { featureId: '' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  // ─── DR-7: counts-not-transcripts cap on the load-failure list ─────────────

  it('checkIntegrationSuite_LoadFailureCascade_CapsListWithCount', async () => {
    // Arrange — a load CASCADE: far more files fail to import than the fixed
    // cap. Each is a suite that failed with zero assertion results (the #1329
    // silent-load shape), so all count as load failures.
    const total = LOAD_FAILURE_LIST_CAP + 30;
    const cascadeJson = JSON.stringify({
      numTotalTestSuites: total,
      numPassedTestSuites: 0,
      numFailedTestSuites: total,
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      success: false,
      testResults: Array.from({ length: total }, (_, i) => ({
        name: `/repo/src/broken-${i}.test.ts`,
        status: 'failed',
        message: 'Error: Failed to load url ./missing.js',
        assertionResults: [],
      })),
    });
    const runner = stubRunnerReturning(cascadeJson);

    // Act
    const result = await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    // Assert — verdict logic is UNCHANGED: every load failure is still folded
    // into the counts.
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      failCount: number;
      loadFailures: number;
      report: string;
    };
    expect(data.passed).toBe(false);
    expect(data.loadFailures).toBe(total);
    expect(data.failCount).toBe(total);

    // The enumerated list is CAPPED: file-entry lines begin with "- `" (the
    // steering line begins with "- …").
    const enumerated = data.report
      .split('\n')
      .filter((l) => l.startsWith('- `'));
    expect(enumerated).toHaveLength(LOAD_FAILURE_LIST_CAP);

    // First N survive; the (N+1)th and a much later one are folded into the count.
    expect(data.report).toContain('broken-0.test.ts');
    expect(data.report).toContain(`broken-${LOAD_FAILURE_LIST_CAP - 1}.test.ts`);
    expect(data.report).not.toContain(`broken-${LOAD_FAILURE_LIST_CAP}.test.ts`);
    expect(data.report).not.toContain(`broken-${total - 1}.test.ts`);

    // Total count is surfaced with a steer to the uncapped escape hatch.
    const remaining = total - LOAD_FAILURE_LIST_CAP;
    expect(data.report).toContain(`…and ${remaining} more (${total} load failures total)`);
    expect(data.report.toLowerCase()).toContain('re-run the suite');
  });
});

// ─── Pure Parser (kept separately testable per REFACTOR) ─────────────────────

describe('parseVitestResult', () => {
  it('folds a load failure (failed suite, 0 failed tests) into failCount', () => {
    const parse = parseVitestResult(
      JSON.stringify({ numFailedTestSuites: 1, numFailedTests: 0, numTotalTests: 50 }),
    );
    expect(parse).not.toBeNull();
    expect(parse!.loadFailures).toBe(1);
    expect(parse!.failCount).toBe(1);
    expect(parse!.passed).toBe(false);
  });

  it('counts a real failed test without inflating loadFailures', () => {
    const parse = parseVitestResult(
      JSON.stringify({
        numFailedTestSuites: 1,
        numFailedTests: 2,
        numTotalTests: 50,
        testResults: [
          { name: 'a.test.ts', status: 'failed', assertionResults: [{}, {}] },
        ],
      }),
    );
    expect(parse!.failedTests).toBe(2);
    expect(parse!.loadFailures).toBe(0);
    expect(parse!.failCount).toBe(2);
  });

  it('separates a real failure from a load failure when both occur', () => {
    const parse = parseVitestResult(
      JSON.stringify({
        numFailedTestSuites: 2,
        numFailedTests: 1,
        numTotalTests: 50,
        testResults: [
          { name: 'a.test.ts', status: 'failed', assertionResults: [{}] },
          { name: 'b.test.ts', status: 'failed', assertionResults: [] },
        ],
      }),
    );
    expect(parse!.failedTests).toBe(1);
    expect(parse!.loadFailures).toBe(1);
    expect(parse!.loadFailureFiles).toContain('b.test.ts');
    expect(parse!.failCount).toBe(2);
  });

  it('returns passed for a clean run', () => {
    const parse = parseVitestResult(
      JSON.stringify({ numFailedTestSuites: 0, numFailedTests: 0, numTotalTests: 50 }),
    );
    expect(parse!.passed).toBe(true);
    expect(parse!.failCount).toBe(0);
  });

  it('returns null on unparseable output', () => {
    expect(parseVitestResult('not json')).toBeNull();
    expect(parseVitestResult('42')).toBeNull();
  });

  it('rejects malformed object/array payloads instead of reading them as green', () => {
    // A bare `{}` or `[]` is parseable JSON but carries no vitest summary
    // counters. Normalizing it to zero failures would fail OPEN — a false
    // green whenever the runner emits an unexpected shape.
    expect(parseVitestResult('{}')).toBeNull();
    expect(parseVitestResult('[]')).toBeNull();
    expect(parseVitestResult('null')).toBeNull();
    expect(parseVitestResult('"a string"')).toBeNull();
    expect(parseVitestResult(JSON.stringify({ unrelated: 'field' }))).toBeNull();
  });
});

// ─── #1537 / DR-15: toolchain-resolved command + spawn-vs-shape failure ──────

describe('isSpawnFailure spawn-vs-shape classification (#1537)', () => {
  it('classifies recognized OS-level errnos with no numeric status as spawn failures', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOMEM']) {
      expect(isSpawnFailure({ code })).toBe(true);
    }
  });

  it('does NOT classify a process that ran (numeric exit status) as a spawn failure', () => {
    // The suite ran and exited non-zero — a real test failure, not a spawn fault.
    expect(isSpawnFailure({ status: 1, code: 'ENOENT' })).toBe(false);
    expect(isSpawnFailure({ status: 0 })).toBe(false);
  });

  it('does NOT classify a ran-but-overflowed process as a spawn failure', () => {
    // execFileSync surfaces a maxBuffer overflow with a string `code` and no
    // numeric `status` even though the child ran to completion. Pre-fix the
    // broad `typeof code === 'string'` check mislabeled this as a spawn failure;
    // it must stay a shape-mismatch.
    expect(isSpawnFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toBe(false);
    // ETIMEDOUT: the child was spawned then killed by the timeout — not a spawn
    // failure either.
    expect(isSpawnFailure({ code: 'ETIMEDOUT' })).toBe(false);
  });

  it('does NOT classify an error with no code as a spawn failure', () => {
    expect(isSpawnFailure({})).toBe(false);
  });
});

describe('check_integration_suite command resolution (#1537, DR-15)', () => {
  function stubToolchain(test: string | null): Toolchain {
    return {
      id: 'stub',
      projectType: 'Stub',
      markers: [],
      commands: { test, typecheck: null, install: null, mutation: null, lint: null, contract: null },
    };
  }

  const passingVitestJson = JSON.stringify({
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numTotalTests: 42,
    testResults: [],
  });

  it('checkIntegrationSuite_ResolvesCommandViaToolchain', () => {
    const seen: Array<{ cmd: string; args: readonly string[] }> = [];
    runIntegrationSuite({
      repoRoot: '/repo',
      runCommand: (cmd, args): CommandResult => {
        seen.push({ cmd, args });
        return { exitCode: 0, stdout: passingVitestJson, stderr: '' };
      },
      detectToolchain: () => stubToolchain('npm run ws:test'),
    });
    // The command comes from the toolchain resolver, not a hardcoded test:run.
    expect(seen).toHaveLength(1);
    expect(seen[0].cmd).toBe('npm');
    expect(seen[0].args).toContain('ws:test');
    expect(seen[0].args).toContain('--reporter=json');
  });

  it('checkIntegrationSuite_TestScriptOverride_HonorsExplicit', () => {
    const seen: Array<{ cmd: string; args: readonly string[] }> = [];
    runIntegrationSuite({
      repoRoot: '/repo',
      testScript: 'test:ci',
      runCommand: (cmd, args): CommandResult => {
        seen.push({ cmd, args });
        return { exitCode: 0, stdout: passingVitestJson, stderr: '' };
      },
      detectToolchain: () => stubToolchain('npm run should-not-be-used'),
    });
    expect(seen[0].args).toContain('test:ci');
    expect(seen[0].args).not.toContain('should-not-be-used');
  });

  it('checkIntegrationSuite_MonorepoRoot_ResolvesCommandAndParses', () => {
    // The #1537 false-fail: a green suite at the monorepo root must parse, not
    // fail closed with "no parseable vitest JSON".
    const result = runIntegrationSuite({
      repoRoot: '/monorepo',
      runCommand: (): CommandResult => ({ exitCode: 0, stdout: passingVitestJson, stderr: '' }),
      detectToolchain: () => stubToolchain('npm run test:run'),
    });
    expect(result.parseError).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.totalTests).toBe(42);
  });

  it('checkIntegrationSuite_RunnerSpawnFailure_DistinctFromJsonShapeMismatch', () => {
    const spawn = runIntegrationSuite({
      repoRoot: '/repo',
      runCommand: (): CommandResult => ({
        exitCode: 127,
        stdout: '',
        stderr: 'command not found',
        spawnError: 'ENOENT',
      }),
      detectToolchain: () => stubToolchain('npm run test:run'),
    });
    const shape = runIntegrationSuite({
      repoRoot: '/repo',
      runCommand: (): CommandResult => ({ exitCode: 0, stdout: 'not json at all', stderr: '' }),
      detectToolchain: () => stubToolchain('npm run test:run'),
    });

    // Both fail closed — counts are non-authoritative either way.
    expect(spawn.passed).toBe(false);
    expect(shape.passed).toBe(false);
    // ...but the failure KIND is distinct and surfaced in the report (#1537).
    expect(spawn.parseFailureKind).toBe('spawn-failure');
    expect(shape.parseFailureKind).toBe('shape-mismatch');
    expect(spawn.report).not.toBe(shape.report);
    expect(spawn.report.toLowerCase()).toContain('spawn');
  });

  it('resolveIntegrationCommand_ExplicitScript_TakesPrecedence', () => {
    const r = resolveIntegrationCommand('/repo', 'my:test', () => stubToolchain('cargo test'));
    expect(r.cmd).toBe('npm');
    expect(r.args).toEqual(['run', 'my:test', '--', '--reporter=json']);
  });

  it('resolveIntegrationCommand_ThisRepo_ResolvesNodeVitestCommand', () => {
    // #1537 regression against THIS repo: resolving at the real exarchos-mcp
    // package root (a node toolchain) yields a runnable vitest-JSON command. We
    // resolve+assert the command rather than recursively spawning the full
    // suite from inside a test (which would re-enter vitest).
    const r = resolveIntegrationCommand(process.cwd(), undefined);
    expect(r.cmd).toBe('npm');
    expect(r.args).toEqual(['run', 'test:run', '--', '--reporter=json']);
  });
});
