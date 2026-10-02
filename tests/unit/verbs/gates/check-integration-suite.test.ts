/**
 * Vitest counts a file that fails at import as one failed suite with zero
 * failed tests. These tests check that the integration suite gate adds load
 * failures to its failure count, so a load failure cannot pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';
import type { CommandResult } from '../../../../src/verbs/pure/static-analysis.js';

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<unknown>,
  ) => executeProvider(),
}));

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

import { handleCheckIntegrationSuite, isSpawnFailure } from '../../../../src/verbs/gates/check-integration-suite.js';
import {
  parseVitestResult,
  runIntegrationSuite,
  resolveIntegrationCommand,
  LOAD_FAILURE_LIST_CAP,
} from '../../../../src/verbs/pure/integration-suite.js';
import type { Toolchain } from '../../../../src/config/toolchains.js';

const STATE_DIR = '/tmp/test-integration-suite';

/**
 * A vitest JSON result in which one file fails at import: one failed suite and
 * zero failed tests.
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

describe('handleCheckIntegrationSuite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  it('CheckIntegrationSuite_FileFailsToLoad_ReturnsFailedAndCountsIt', async () => {
    const runner = stubRunnerReturning(vitestLoadFailureJson());

    const args = { featureId: 'feat-1', repoRoot: '/repo' };

    const result = await handleCheckIntegrationSuite(
      args,
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      failCount: number;
      loadFailures: number;
    };
    expect(data.passed).toBe(false);
    expect(data.loadFailures).toBeGreaterThanOrEqual(1);
    expect(data.failCount).toBeGreaterThanOrEqual(1);
  });

  it('CheckIntegrationSuite_AllGreen_ReturnsPassed', async () => {
    const cleanJson = JSON.stringify({
      numTotalTestSuites: 10,
      numFailedTestSuites: 0,
      numTotalTests: 50,
      numFailedTests: 0,
      success: true,
      testResults: [],
    });
    const runner = stubRunnerReturning(cleanJson, 0);

    const result = await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    const data = result.data as { passed: boolean; failCount: number; loadFailures: number };
    expect(data.passed).toBe(true);
    expect(data.failCount).toBe(0);
    expect(data.loadFailures).toBe(0);
  });

  it('CheckIntegrationSuite_DoesNotEmitLegacyGateExecutedEvent', async () => {
    const runner = stubRunnerReturning(vitestLoadFailureJson());

    await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    expect(mockStore.append).not.toHaveBeenCalled();
  });

  it('CheckIntegrationSuite_RunsAgainstResolvedRepoRoot', async () => {
    const runner = stubRunnerReturning(vitestLoadFailureJson());

    await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/worktrees/agent-x' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

    expect(runner).toHaveBeenCalledTimes(1);
    const opts = runner.mock.calls[0][2];
    expect(opts?.cwd).toBe('/worktrees/agent-x');
  });

  /**
   * A zero exit does not prove that the suite passed, because a crashed
   * reporter can also exit 0. The gate must fail closed on output that it
   * cannot parse.
   */
  it('CheckIntegrationSuite_UnparseableOutputWithZeroExit_FailsClosed', async () => {
    const runner = stubRunnerReturning('this is not vitest json', 0);

    const result = await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

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

  /**
   * More files fail at import than the list cap. The counts still include each
   * load failure, but the report lists only the first `LOAD_FAILURE_LIST_CAP`
   * files. A file entry line starts with "- `", and the steering line does not.
   */
  it('checkIntegrationSuite_LoadFailureCascade_CapsListWithCount', async () => {
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

    const result = await handleCheckIntegrationSuite(
      { featureId: 'feat-1', repoRoot: '/repo' },
      STATE_DIR,
      mockStore as unknown as EventStore,
      runner,
    );

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

    const enumerated = data.report
      .split('\n')
      .filter((l) => l.startsWith('- `'));
    expect(enumerated).toHaveLength(LOAD_FAILURE_LIST_CAP);

    expect(data.report).toContain('broken-0.test.ts');
    expect(data.report).toContain(`broken-${LOAD_FAILURE_LIST_CAP - 1}.test.ts`);
    expect(data.report).not.toContain(`broken-${LOAD_FAILURE_LIST_CAP}.test.ts`);
    expect(data.report).not.toContain(`broken-${total - 1}.test.ts`);

    const remaining = total - LOAD_FAILURE_LIST_CAP;
    expect(data.report).toContain(`…and ${remaining} more (${total} load failures total)`);
    expect(data.report.toLowerCase()).toContain('re-run the suite');
  });
});

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

  /**
   * Valid JSON with no vitest summary counters returns null. To read it as zero
   * failures makes the gate fail open.
   */
  it('rejects malformed object/array payloads instead of reading them as green', () => {
    expect(parseVitestResult('{}')).toBeNull();
    expect(parseVitestResult('[]')).toBeNull();
    expect(parseVitestResult('null')).toBeNull();
    expect(parseVitestResult('"a string"')).toBeNull();
    expect(parseVitestResult(JSON.stringify({ unrelated: 'field' }))).toBeNull();
  });
});

describe('isSpawnFailure spawn-vs-shape classification (#1537)', () => {
  it('classifies recognized OS-level errnos with no numeric status as spawn failures', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOMEM']) {
      expect(isSpawnFailure({ code })).toBe(true);
    }
  });

  it('does NOT classify a process that ran (numeric exit status) as a spawn failure', () => {
    expect(isSpawnFailure({ status: 1, code: 'ENOENT' })).toBe(false);
    expect(isSpawnFailure({ status: 0 })).toBe(false);
  });

  /**
   * `execFileSync` reports a `maxBuffer` overflow with a string `code` and no
   * numeric `status`, although the child ran. `ETIMEDOUT` means that the
   * timeout stopped a child that started. Neither is a spawn failure.
   */
  it('does NOT classify a ran-but-overflowed process as a spawn failure', () => {
    expect(isSpawnFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toBe(false);
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

  /** A green suite at the monorepo root must parse and must not fail closed. */
  it('checkIntegrationSuite_MonorepoRoot_ResolvesCommandAndParses', () => {
    const result = runIntegrationSuite({
      repoRoot: '/monorepo',
      runCommand: (): CommandResult => ({ exitCode: 0, stdout: passingVitestJson, stderr: '' }),
      detectToolchain: () => stubToolchain('npm run test:run'),
    });
    expect(result.parseError).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.totalTests).toBe(42);
  });

  /**
   * A spawn failure and a JSON shape mismatch both fail closed. The report
   * names a different failure kind for each.
   */
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

    expect(spawn.passed).toBe(false);
    expect(shape.passed).toBe(false);
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

  /**
   * Resolves the command in the current working directory, which is this
   * repository and a node toolchain. The test does not run the command,
   * because a run starts vitest again inside vitest.
   */
  it('resolveIntegrationCommand_ThisRepo_ResolvesNodeVitestCommand', () => {
    const r = resolveIntegrationCommand(process.cwd(), undefined);
    expect(r.cmd).toBe('npm');
    expect(r.args).toEqual(['run', 'test:run', '--', '--reporter=json']);
  });
});
