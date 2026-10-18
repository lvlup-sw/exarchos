// Tests for the static-analysis gate: the `handleStaticAnalysis` handler, the boundary lint and taint
// legs, and the skip-degrade rule of `runStaticAnalysis`.
// The module mock replaces only `runStaticAnalysis`, so the handler tests inject canned results.
// The other exports, `runBoundaryLint` included, pass through `importActual` and run for real.
// The durable gate producer is a stub that calls only the provider. `ladder-gate-evidence.test.ts`
// tests the durable evidence against the real runner.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../../../../src/format.js';
import type { EventStore } from '../../../../src/events/store.js';
import {
  runBoundaryLint,
  runRawIoTaint,
  type BoundaryLintResult,
  type RawIoTaintResult,
  type RunCommandFn,
  type StaticAnalysisInput,
  type StaticAnalysisResult,
} from '../../../../src/verbs/pure/static-analysis.js';

/**
 * The real `runStaticAnalysis` for the integration tests. The module mock replaces the imported
 * binding, so each `beforeAll` loads the real function with `importActual`.
 */
let realRunStaticAnalysis: (input: StaticAnalysisInput) => StaticAnalysisResult;

const mockRunStaticAnalysis = vi.fn();

vi.mock('../../../../src/verbs/pure/static-analysis.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/verbs/pure/static-analysis.js')>();
  return {
    ...actual,
    runStaticAnalysis: (...args: unknown[]) => mockRunStaticAnalysis(...args),
  };
});

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<ToolResult>,
  ) => executeProvider(),
}));

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { execCommandRunner, handleStaticAnalysis } from '../../../../src/verbs/gates/static-analysis.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const STATE_DIR = '/tmp/test-static-analysis';

function makePassingResult() {
  return {
    status: 'pass' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/project`',
      '',
      '- **PASS**: Lint',
      '- **PASS**: Typecheck',
      '',
      '---',
      '',
      '**Result: PASS** (2/2 checks passed)',
    ].join('\n'),
    passCount: 2,
    failCount: 0,
  };
}

function makeFailingResult() {
  return {
    status: 'fail' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/project`',
      '',
      '- **PASS**: Lint',
      '- **FAIL**: Typecheck — npm run typecheck failed',
      '',
      '---',
      '',
      '**Result: FAIL** (1/2 checks failed)',
    ].join('\n'),
    passCount: 1,
    failCount: 1,
  };
}

function makeErrorResult() {
  return {
    status: 'error' as const,
    output: '',
    error: 'No package.json found at /nonexistent',
    passCount: 0,
    failCount: 0,
  };
}

function makeSkipResult() {
  return {
    status: 'skip' as const,
    output: [
      '## Static Analysis Report',
      '',
      '**Repository:** `/home/user/empty-repo`',
      '',
      '- **SKIP**: No recognized project type (no package.json, *.csproj, go.mod, or Cargo.toml)',
      '',
      '---',
      '',
      '**Result: SKIP** (no applicable toolchain detected)',
    ].join('\n'),
    skipReason: 'no-toolchain' as const,
    passCount: 0,
    failCount: 0,
  };
}

describe('handleStaticAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  describe('input validation', () => {
    it('handleStaticAnalysis_MissingFeatureId_ReturnsError', async () => {
      const args = { featureId: '' };

      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  describe('all checks passing', () => {
    it('handleStaticAnalysis_AllChecksPassing_ReturnsPassed', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(true);
      expect(data.passCount).toBe(2);
      expect(data.failCount).toBe(0);
      expect(data.report).toContain('Static Analysis Report');
    });
  });

  describe('errors found', () => {
    it('handleStaticAnalysis_ErrorsFound_ReturnsFailWithFindings', async () => {
      mockRunStaticAnalysis.mockReturnValue(makeFailingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.passCount).toBe(1);
      expect(data.failCount).toBe(1);
      expect(data.report).toContain('FAIL');
      expect(data.report).toContain('Typecheck');
    });
  });

  describe('gate event emission', () => {
    it('handleStaticAnalysis_DoesNotEmitLegacyGateExecutedEvent', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockStore.append).not.toHaveBeenCalled();
    });
  });

  describe('error status from analysis', () => {
    it('handleStaticAnalysis_ErrorStatus_ReturnsScriptError', async () => {
      mockRunStaticAnalysis.mockReturnValue(makeErrorResult());

      const args = { featureId: 'feat-1', repoRoot: '/nonexistent' };

      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('No package.json found');
    });
  });

  describe('skip status from analysis', () => {
    it('handleStaticAnalysis_SkipStatus_EmitsEventWithSkippedTrue', async () => {
      mockRunStaticAnalysis.mockReturnValue(makeSkipResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/empty-repo' };

      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        skipped: boolean;
        skipReason?: string;
        passCount: number;
        failCount: number;
        report: string;
      };
      expect(data.passed).toBe(false);
      expect(data.skipped).toBe(true);
      expect(data.skipReason).toBe('no-toolchain');
      expect(data.passCount).toBe(0);
      expect(data.failCount).toBe(0);
      expect(data.report).toContain('Result: SKIP');

      expect(mockStore.append).not.toHaveBeenCalled();
    });
  });

  describe('skip flags', () => {
    it('handleStaticAnalysis_SkipFlags_PassedToFunction', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = {
        featureId: 'feat-1',
        repoRoot: '/home/user/project',
        skipLint: true,
        skipTypecheck: true,
      };

      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as {
        repoRoot: string;
        skipLint: boolean;
        skipTypecheck: boolean;
        runCommand: unknown;
      };
      expect(callArgs.repoRoot).toBe('/home/user/project');
      expect(callArgs.skipLint).toBe(true);
      expect(callArgs.skipTypecheck).toBe(true);
      expect(callArgs.runCommand).toBeDefined();
    });
  });

  describe('worktree-aware repoRoot resolution', () => {
    /**
     * The diff of the agent is in a worktree, not in `process.cwd()`. The gate must pass that path as
     * `repoRoot`, which the pure analysis uses as the `runCommand` cwd.
     */
    it('CheckStaticAnalysis_DiffOnlyInWorktree_RunsTscAgainstWorktree', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-feat-1';
      expect(worktreePath).not.toBe(process.cwd());

      const args = { featureId: 'feat-1', repoRoot: worktreePath };

      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    it('CheckStaticAnalysis_RepoRootAuto_ResolvesWorktreePathArg', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-feat-1';

      const args = {
        featureId: 'feat-1',
        repoRoot: 'auto' as const,
        worktreePath,
      };

      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    /** Without a `worktreePath` argument, 'auto' uses the `worktree.created` event of the task. */
    it('CheckStaticAnalysis_RepoRootAuto_ResolvesFromWorktreeCreatedEvent', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-task-9';
      mockStore.query.mockResolvedValue([
        { type: 'worktree.created', data: { taskId: 'task-9', path: worktreePath } },
      ]);

      const args = {
        featureId: 'feat-1',
        repoRoot: 'auto' as const,
        taskId: 'task-9',
      };

      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    /**
     * Without a `worktreePath` argument and a `worktree.created` event, 'auto' must fail. A silent
     * fallback to `process.cwd()` checks a tree that does not hold the changes of the agent.
     */
    it('CheckStaticAnalysis_RepoRootAuto_Unresolvable_ReturnsError', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      mockStore.query.mockResolvedValue([]);

      const args = { featureId: 'feat-1', repoRoot: 'auto' as const, taskId: 'task-9' };

      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(mockRunStaticAnalysis).not.toHaveBeenCalled();
    });

    /** Without `repoRoot`, the gate keeps the `process.cwd()` default for callers outside delegation. */
    it('CheckStaticAnalysis_NoRepoRoot_DefaultsToProcessCwd', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1' };

      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(process.cwd());
    });
  });

  describe('runCommand adapter', () => {
    it('handleStaticAnalysis_PassesRunCommandAdapter', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as {
        runCommand: unknown;
      };
      expect(typeof callArgs.runCommand).toBe('function');
    });
  });

  describe('advisory skips and first-party globs', () => {
    let configDir: string;

    beforeEach(() => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-analysis-config-'));
    });

    afterEach(() => {
      rmrf(configDir);
    });

    /**
     * An advisory check that gave no verdict marks the carrier degraded, but the carrier is not a skip.
     * The proof verdict is `pass`, so the `gate.executed` row says passed, and the report names the skip.
     */
    it('handleStaticAnalysis_AdvisorySkip_PassedAndDegradedButNotSkipped', async () => {
      const { normalizeGateVerdict } = await import('../../../../src/verbs/gates/gate-utils.js');
      const advisorySkips = [
        { name: 'Import boundaries', detail: 'dependency-cruiser gave no verdict: it ran out of memory' },
      ];
      mockRunStaticAnalysis.mockReturnValue({
        ...makePassingResult(),
        skipCount: 0,
        output: '- **SKIP**: Import boundaries — dependency-cruiser gave no verdict: it ran out of memory',
        advisorySkips,
      });

      const result = await handleStaticAnalysis(
        { featureId: 'feat-1', repoRoot: '/home/user/project' },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ passed: true, degraded: true, advisorySkips });
      expect(result.data).not.toHaveProperty('skipped');
      expect(result.data).not.toHaveProperty('skipReason');
      expect((result.data as { report: string }).report).toContain('Import boundaries');
      expect(normalizeGateVerdict(result)).toBe('pass');
    });

    /** The handler reads `ownership.firstParty` from the `.exarchos.yml` of the analyzed tree. */
    it('handleStaticAnalysis_ProjectConfig_PassesItsFirstPartyGlobs', async () => {
      fs.writeFileSync(
        path.join(configDir, '.exarchos.yml'),
        'ownership:\n  firstParty:\n    - lib/**\n    - packages/*/src/**\n',
        'utf-8',
      );
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      await handleStaticAnalysis(
        { featureId: 'feat-1', repoRoot: configDir },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      const callArgs = mockRunStaticAnalysis.mock.calls[0]?.[0] as { firstPartyGlobs?: readonly string[] };
      expect(callArgs.firstPartyGlobs).toEqual(['lib/**', 'packages/*/src/**']);
    });

    /** Without a project config, the handler passes no globs, and the boundary leg uses the schema default. */
    it('handleStaticAnalysis_NoProjectConfig_PassesNoGlobs', async () => {
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      await handleStaticAnalysis(
        { featureId: 'feat-1', repoRoot: configDir },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      const callArgs = mockRunStaticAnalysis.mock.calls[0]?.[0] as { firstPartyGlobs?: readonly string[] };
      expect(callArgs.firstPartyGlobs).toBeUndefined();
    });
  });
});

/**
 * Runs real processes through the production runner of the static-analysis legs. The legs read
 * `exitCode`, `signal` and `spawnError` from it, so each field must have the value that the process
 * really gave.
 */
describe('execCommandRunner — the production runner of the static-analysis legs', () => {
  function runNode(script: string) {
    return execCommandRunner(process.execPath, ['-e', script], { cwd: process.cwd() });
  }

  /** A non-zero exit keeps its status and output and carries no signal and no runner error. */
  it('ExecCommandRunner_NonZeroExit_KeepsTheStatusAndTheOutput', () => {
    const result = runNode('process.stdout.write("out"); process.stderr.write("err"); process.exit(3);');

    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
  });

  it('ExecCommandRunner_CleanExit_GivesExitZeroAndTheOutput', () => {
    expect(runNode('process.stdout.write("ok")')).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
  });

  /** A process that a signal stopped has no exit status. The runner gives exit 1 and the signal. */
  it.skipIf(process.platform === 'win32')('ExecCommandRunner_SignalDeath_CarriesTheSignal', () => {
    const result = runNode('process.kill(process.pid, "SIGKILL")');

    expect(result.exitCode).toBe(1);
    expect(result.signal).toBe('SIGKILL');
    expect(result.spawnError).toBeUndefined();
  });

  it('ExecCommandRunner_MissingCommand_CarriesTheSpawnError', () => {
    const result = execCommandRunner('exarchos-no-such-command-for-this-test', [], { cwd: process.cwd() });

    expect(result.exitCode).toBe(1);
    expect(result.spawnError).toBe('ENOENT');
  });

  /**
   * The boundary JSON report of this repository is about 2 MB. The default output limit of 1 MiB
   * stops such a run with ENOBUFS, so the runner raises the limit.
   */
  it('ExecCommandRunner_ReportOfSeveralMegabytes_IsReadInFull', () => {
    const bytes = 8 * 1024 * 1024;

    const result = runNode(`process.stdout.write("x".repeat(${bytes}))`);

    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(bytes);
  });

  /** Output past the raised limit is a runner error with the name ENOBUFS, not a clean run. */
  it('ExecCommandRunner_OutputPastTheLimit_CarriesENOBUFS', () => {
    const bytes = 65 * 1024 * 1024;

    const result = runNode(`process.stdout.write("x".repeat(${bytes}))`);

    expect(result.spawnError).toBe('ENOBUFS');
    expect(result.exitCode).toBe(1);
  });
});

/**
 * Runs the real `runBoundaryLint` against temp fixtures on disk with an injected runner. The leg runs
 * `npx depcruise --validate --output-type json` over the first-party roots and reads `summary.error`.
 * Without `.dependency-cruiser.cjs` the leg skips, like the gate skips a missing lint script. The
 * fixture config forbids imports from `domain-core` to `io-adapters`.
 */
describe('runBoundaryLint — import-boundary leg (SIV-3 Layer A, task 027)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../../../src/verbs/gates/pure/static-analysis.js')>(
      '../../../../src/verbs/pure/static-analysis.js',
    );
    realRunStaticAnalysis = actual.runStaticAnalysis;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-lint-test-'));
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  function makeBoundaryFixture(opts: { withConfig: boolean; withViolation: boolean }): string {
    const repoRoot = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'src', 'domain-core'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src', 'io-adapters'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'io-adapters', 'db.js'),
      'export const db = {};\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'domain-core', 'order.js'),
      opts.withViolation
        ? "import { db } from '../io-adapters/db.js';\nexport const order = db;\n"
        : 'export const order = {};\n',
      'utf-8',
    );

    if (opts.withConfig) {
      fs.writeFileSync(
        path.join(repoRoot, '.dependency-cruiser.cjs'),
        [
          'module.exports = {',
          '  forbidden: [',
          '    {',
          "      name: 'no-core-to-io',",
          "      severity: 'error',",
          "      from: { path: '^src/domain-core' },",
          "      to: { path: '^src/io-adapters' },",
          '    },',
          '  ],',
          '};',
          '',
        ].join('\n'),
        'utf-8',
      );
    }
    return repoRoot;
  }

  function cruiseReport(errors: number): string {
    const violation = (name: string, severity: string) => ({
      type: 'dependency',
      from: 'src/domain-core/order.js',
      to: 'src/io-adapters/db.js',
      rule: { name, severity },
    });
    return JSON.stringify({
      modules: [],
      summary: {
        violations: [
          ...Array.from({ length: errors }, (_, index) => violation(`no-core-to-io-${index}`, 'error')),
          violation('cycle-advice', 'warn'),
        ],
        error: errors,
        warn: 1,
        info: 0,
        totalCruised: 2,
      },
    });
  }

  function depcruiseArgs(runner: RunCommandFn): string[] {
    const calls = vi.mocked(runner).mock.calls;
    expect(calls.length).toBe(1);
    const [cmd, cmdArgs] = calls[0] ?? [];
    expect(cmd).toBe('npx');
    return [...(cmdArgs ?? [])];
  }

  /** An `error` violation in the JSON report fails the leg and names the broken rule. */
  it('StaticAnalysis_CoreImportsIOAdapter_BoundaryRuleFails', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(1), stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('no-core-to-io-0');
    expect(result.detail ?? '').toContain('1 violation of error severity');
    expect(result.detail ?? '').not.toContain('cycle-advice');
    expect(result.degraded).toBeUndefined();
    const cmdArgs = depcruiseArgs(runner);
    expect(cmdArgs.slice(0, 5)).toEqual([
      'depcruise',
      '--validate',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
    ]);
  });

  /**
   * The JSON reporter exits 0 even with violations. The text reporter exits with the error count, and
   * 256 errors wrap to exit 0. The leg reads `summary.error`, so 256 errors still fail it.
   */
  it('BoundaryLint_ErrorCountInReport_FailsWhateverTheExitCode', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(256), stderr: '' }));

    const result = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('256 violations of error severity');
  });

  /** A report with zero `error` violations passes, also with a `warn` violation and a non-zero exit. */
  it('BoundaryLint_ZeroErrorsInReport_PassesEvenWithANonZeroExit', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 1, stdout: cruiseReport(0), stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result).toEqual({ status: 'PASS' });
  });

  it('StaticAnalysis_CompliantImports_Passes', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('PASS');
    expect(vi.mocked(runner).mock.calls.length).toBe(1);
  });

  /** A missing config is an advisory skip, not a failure, and depcruise does not run. */
  it('StaticAnalysis_NoBoundaryConfig_LegSkippedAdvisory', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: false, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBeUndefined();
    expect(vi.mocked(runner).mock.calls.length).toBe(0);
  });

  /**
   * Each outcome that is not a complete report is an infra fault. The leg gives a degraded SKIP that
   * names the cause, and never a FAIL. The cases hold the shapes that the production runner gives.
   */
  it.each<[string, { exitCode: number; stdout: string; stderr: string; signal?: string; spawnError?: string }, RegExp]>([
    [
      'heap exhaustion through npx',
      {
        exitCode: 134,
        stdout: '',
        stderr: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n',
      },
      /ran out of memory/,
    ],
    ['a report cut short', { exitCode: 137, stdout: cruiseReport(0).slice(0, 40), stderr: '' }, /no JSON report \(exit 137, .*signal 9\)/],
    ['output that is not JSON', { exitCode: 1, stdout: '', stderr: "ERROR: Can't open 'src' for reading.\n" }, /no JSON report \(exit 1\): ERROR: Can't open/],
    ['a JSON value with no summary', { exitCode: 0, stdout: '{"modules":[]}', stderr: '' }, /no JSON report \(exit 0\)/],
    ['a signal, even with a complete report', { exitCode: 1, stdout: cruiseReport(1), stderr: '', signal: 'SIGKILL' }, /stopped by SIGKILL/],
    ['a command that did not start', { exitCode: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }, /runner reported ENOENT/],
    ['a report larger than the output limit', { exitCode: 1, stdout: cruiseReport(0).slice(0, 40), stderr: '', signal: 'SIGTERM', spawnError: 'ENOBUFS' }, /output limit of the runner \(ENOBUFS\)/],
  ])('BoundaryLint_NoVerdict_DegradedSkipNotFail [%s]', (_label, commandResult, cause) => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => commandResult);

    const result = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toMatch(/^dependency-cruiser gave no verdict: /);
    expect(result.detail ?? '').toMatch(cause);
  });

  it('BoundaryLint_RunnerThrows_DegradedSkipNotFail', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => {
      throw new Error('npx: command not found');
    });

    const result = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toContain('not available');
  });

  /**
   * The scan gets the existing roots of the `ownership.firstParty` globs, not `.`. A nested worktree,
   * build output and a root that does not exist stay out of the scan.
   */
  it('BoundaryLint_DefaultGlobs_ScanOnlyTheExistingFirstPartyRoots', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    for (const dir of ['servers/api/src', 'servers/docs', 'dist', '.claude/worktrees/other/src']) {
      fs.mkdirSync(path.join(repoRoot, dir), { recursive: true });
    }
    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    runBoundaryLint({ repoRoot, runCommand: runner });

    expect(depcruiseArgs(runner).slice(5)).toEqual(['servers/api/src', 'src']);
  });

  it('BoundaryLint_ConfiguredGlobs_ScanTheirRootsWithoutNestedDuplicates', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.mkdirSync(path.join(repoRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'index.js'), 'export {};\n', 'utf-8');
    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    runBoundaryLint({
      repoRoot,
      runCommand: runner,
      firstPartyGlobs: ['src/domain-core/**', 'lib/**', 'src/**/*.js', 'missing/**', 'index.js', '!lib/x/**'],
    });

    expect(depcruiseArgs(runner).slice(5)).toEqual(['index.js', 'lib', 'src']);
  });

  /** With no first-party root on disk, the leg has nothing to scan. It gives a degraded skip, and depcruise does not run. */
  it('BoundaryLint_NoFirstPartyRootExists_DegradedSkipWithoutARun', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    const result = runBoundaryLint({ repoRoot, runCommand: runner, firstPartyGlobs: ['packages/*/src/**'] });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toContain('no ownership.firstParty source root exists (packages/*/src/**)');
    expect(vi.mocked(runner).mock.calls.length).toBe(0);
  });

  /**
   * Runs the real dependency-cruiser of this repository through the production runner. The JSON report
   * of a violating fixture fails the leg, and the report of a clean fixture passes it.
   */
  it('BoundaryLint_RealDependencyCruiser_ReadsTheVerdictFromTheJsonReport', () => {
    const depcruiseBin = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
    );
    const realRunner: RunCommandFn = (_cmd, args, options) =>
      execCommandRunner(process.execPath, [depcruiseBin, ...args.slice(1)], options);

    const violating = runBoundaryLint({
      repoRoot: makeBoundaryFixture({ withConfig: true, withViolation: true }),
      runCommand: realRunner,
    });
    rmrf(path.join(tmpDir, 'repo'));
    const clean = runBoundaryLint({
      repoRoot: makeBoundaryFixture({ withConfig: true, withViolation: false }),
      runCommand: realRunner,
    });

    expect(violating.status).toBe('FAIL');
    expect(violating.detail ?? '').toContain(
      'error no-core-to-io: src/domain-core/order.js → src/io-adapters/db.js',
    );
    expect(clean).toEqual({ status: 'PASS' });
  });

  /**
   * Runs the real `runStaticAnalysis`, which the handler suite mocks. The fixture declares all three
   * npm scripts, because a skipped constituent moves the aggregate off PASS.
   */
  it('StaticAnalysis_BoundaryConfigPresent_FoldsLegIntoFullReport', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );

    const runner: RunCommandFn = vi.fn((_cmd: string, args: readonly string[]) => ({
      exitCode: 0,
      stdout: args.includes('depcruise') ? cruiseReport(0) : '',
      stderr: '',
    }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(4);
    expect(result.advisorySkips).toBeUndefined();
    expect(result.output).toContain('- **PASS**: Import boundaries');
    expect(result.output).toContain('**Result: PASS** (4/4 checks passed)');
  });

  /**
   * A boundary scan that gives no verdict stays visible. The report lists it and marks the result
   * degraded, and the status stays `pass`, so the gate does not fail on an infra fault.
   */
  it('StaticAnalysis_BoundaryGaveNoVerdict_PassesWithAVisibleDegradedSkip', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );

    const runner: RunCommandFn = vi.fn((_cmd: string, args: readonly string[]) =>
      args.includes('depcruise')
        ? { exitCode: 134, stdout: '', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.skipCount).toBe(0);
    expect(result.passCount).toBe(3);
    expect(result.advisorySkips).toEqual([
      { name: 'Import boundaries', detail: 'dependency-cruiser gave no verdict: it ran out of memory' },
    ]);
    expect(result.output).toContain(
      '- **SKIP**: Import boundaries — dependency-cruiser gave no verdict: it ran out of memory',
    );
    expect(result.output).toContain(
      '**Result: PASS** (3/3 checks passed, degraded: 1 advisory check gave no verdict)',
    );
  });

  /** A boundary FAIL from the report fails the whole result. */
  it('StaticAnalysis_BoundaryViolationInReport_FailsTheResult', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );

    const runner: RunCommandFn = vi.fn((_cmd: string, args: readonly string[]) => ({
      exitCode: 0,
      stdout: args.includes('depcruise') ? cruiseReport(2) : '',
      stderr: '',
    }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
    expect(result.output).toContain('- **FAIL**: Import boundaries — dependency-cruiser found 2 violations');
  });
});

/** Runs the semgrep arguments through the production runner with a command name that is on no PATH. */
const missingSemgrepRunner: RunCommandFn = (_cmd, args, options) =>
  execCommandRunner('exarchos-no-such-semgrep-for-this-test', args, options);

/**
 * Runs the real `runRawIoTaint` and `runStaticAnalysis` against temp fixtures on disk with an injected
 * runner. The taint check is a dataflow rule that dependency-cruiser cannot express, so it runs Semgrep.
 * The leg runs only when the repo commits `.semgrep/no-raw-io-into-core.yml`. A missing ruleset gives a
 * silent SKIP. An absent engine or an engine error gives a degraded SKIP that the report lists, not a
 * FAIL. The exit code of the runner decides the verdict, so the fixture ruleset only has to exist on disk.
 */
describe('runRawIoTaint — boundary-parse taint leg (SIV-3 Layer B, #1529)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../../../src/verbs/gates/pure/static-analysis.js')>(
      '../../../../src/verbs/pure/static-analysis.js',
    );
    realRunStaticAnalysis = actual.runStaticAnalysis;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-leg-test-'));
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  function makeTaintFixture(opts: { withRuleset: boolean }): string {
    const repoRoot = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src', 'parse'), { recursive: true });

    if (opts.withRuleset) {
      fs.mkdirSync(path.join(repoRoot, '.semgrep'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, '.semgrep', 'no-raw-io-into-core.yml'),
        [
          'rules:',
          '  - id: no-raw-io-into-core',
          '    languages: [typescript]',
          '    severity: ERROR',
          '    message: raw IO must cross a registered parser (src/parse/**) before entering the core',
          '    paths: { include: ["src/dispatch/core/**"] }',
          '    pattern-either:',
          '      - pattern: JSON.parse(...)',
          '      - pattern: $RES.json()',
          '      - pattern: $REQ.body',
          '      - pattern: fs.read$ANY(...)',
          '  - id: no-out-of-band-brand-cast',
          '    languages: [typescript]',
          '    severity: ERROR',
          '    message: out-of-band cast forges a branded type; route through a registered parser',
          '    paths: { include: ["src/dispatch/core/**"] }',
          '    pattern-either:',
          '      - pattern: $X as any',
          '      - pattern: $X as $T & { __brand: $B }',
          '',
        ].join('\n'),
        'utf-8',
      );
    }
    return repoRoot;
  }

  it('RawIoTaint_UnparsedRawIoIntoCore_Flags', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: 'src/dispatch/core/order.ts:3 no-raw-io-into-core: JSON.parse not crossing a parser\n',
      stderr: '',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('no-raw-io-into-core');
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const [cmd, cmdArgs] = calls[0] as [string, string[]];
    expect(cmd).toBe('semgrep');
    expect(cmdArgs).toContain('--config');
    expect(cmdArgs).toContain('.semgrep/no-raw-io-into-core.yml');
  });

  /**
   * The same ruleset holds the brand-cast rule, so its finding fails the leg the same way. The runner
   * stands in for Semgrep.
   */
  it('RawIoTaint_DownstreamBrandCast_Flags', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: 'src/dispatch/core/order.ts:7 no-out-of-band-brand-cast: `x as any` forges a branded type\n',
      stderr: '',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('no-out-of-band-brand-cast');
  });

  it('RawIoTaint_AllInputsCrossRegisteredParser_Passes', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('PASS');
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  /** A repo without the ruleset is not subject to the leg, so the engine does not run. */
  it('RawIoTaint_NoRuleset_LegSkippedAdvisory', () => {
    const repoRoot = makeTaintFixture({ withRuleset: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBeUndefined();
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('RawIoTaint_EngineAbsent_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => {
      throw new Error('semgrep: command not found');
    });

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toContain('not available');
  });

  /**
   * Exit 2 is an engine or ruleset error. The result is inconclusive, so the leg skips, and the skip
   * detail is the stderr of the engine.
   */
  it('RawIoTaint_EngineConfigError_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 2,
      stdout: '',
      stderr: 'semgrep: invalid rule schema\n',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toContain('invalid rule schema');
  });

  /**
   * The production runner gives exit 1 and the signal for an engine that a signal stopped. Exit 1 alone
   * is a finding, so the leg reads the signal first and skips.
   */
  it('RawIoTaint_SignalDeath_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      signal: 'SIGKILL',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toContain('stopped by SIGKILL');
  });

  /** Only exit 1 fails the leg. Another exit code with an empty stderr skips with a generic label. */
  it('RawIoTaint_EngineErrorWithoutStderr_SkipsWithTheExitStatus', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 2, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toMatch(/inconclusive \(exit 2\)/);
  });

  /**
   * The runner can report an engine that does not start with `spawnError`. That check takes precedence
   * over a coincidental `exitCode: 1`, so the leg skips.
   */
  it('RawIoTaint_RunnerReportsSpawnError_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      spawnError: 'ENOENT: semgrep not found on PATH',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.degraded).toBe(true);
    expect(result.detail ?? '').toContain('ENOENT');
  });

  /**
   * The production runner gives exit 1, `SIGTERM` and `ENOBUFS` for output past its limit. The runner
   * error takes precedence over exit 1, so the leg skips and names the limit.
   */
  it('RawIoTaint_OutputPastTheRunnerLimit_DegradedSkipNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: 'x',
      stderr: '',
      signal: 'SIGTERM',
      spawnError: 'ENOBUFS',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result).toEqual({
      status: 'SKIP',
      degraded: true,
      detail: 'semgrep output passed the output limit of the runner (ENOBUFS)',
    });
  });

  /**
   * An engine that is not on the PATH goes through the production runner, which gives exit 1 and
   * `ENOENT`. Exit 1 alone is a finding, so the leg reads the runner error first and skips.
   */
  it('RawIoTaint_MissingEngineThroughTheProductionRunner_DegradedSkipNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const result = runRawIoTaint({ repoRoot, runCommand: missingSemgrepRunner });

    expect(result).toEqual({
      status: 'SKIP',
      degraded: true,
      detail: 'semgrep gave no verdict: the runner reported ENOENT',
    });
  });

  /**
   * Runs the real `runStaticAnalysis`. The runner exits 0 for every command, so the suite passes and the
   * taint leg is a counted check. The fixture declares all three npm scripts, so no constituent skips.
   */
  it('StaticAnalysis_TaintRulesetPresent_FoldsLegIntoFullReport', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.output).toContain('Boundary IO taint');
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => c[0] === 'semgrep')).toBe(true);
  });

  /**
   * A taint engine that did not start stays visible. The report lists the skip and marks the result
   * degraded, and the status stays `pass`, so the gate does not fail on an infra fault.
   */
  it('StaticAnalysis_TaintEngineDidNotStart_PassesWithAVisibleDegradedSkip', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );

    const runner: RunCommandFn = (cmd, args, options) =>
      cmd === 'semgrep' ? missingSemgrepRunner(cmd, args, options) : { exitCode: 0, stdout: '', stderr: '' };

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(3);
    expect(result.advisorySkips).toEqual([
      { name: 'Boundary IO taint', detail: 'semgrep gave no verdict: the runner reported ENOENT' },
    ]);
    expect(result.output).toContain(
      '- **SKIP**: Boundary IO taint — semgrep gave no verdict: the runner reported ENOENT',
    );
    expect(result.output).toContain(
      '**Result: PASS** (3/3 checks passed, degraded: 1 advisory check gave no verdict)',
    );
  });
});

/**
 * A skipped constituent check must not render as PASS. `runStaticAnalysis` counts SKIP, and the order
 * of precedence is FAIL, then DEGRADED, then PASS. A skipped constituent without a failure gives
 * `status: 'skip'`, `skipReason: 'constituent-skipped'` and a `**Result: DEGRADED**` line.
 */
describe('DR-6 — a skipped constituent renders DEGRADED, never PASS', () => {
  let tmpDir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../../../src/verbs/gates/pure/static-analysis.js')>(
      '../../../../src/verbs/pure/static-analysis.js',
    );
    realRunStaticAnalysis = actual.runStaticAnalysis;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr6-static-analysis-'));
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  function nodeFixture(scripts: Record<string, string>): string {
    const repoRoot = path.join(tmpDir, 'repo-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'dr6-fixture', scripts }, null, 2),
      'utf-8',
    );
    return repoRoot;
  }

  const ALL_SCRIPTS = {
    lint: 'eslint .',
    typecheck: 'tsc --noEmit',
    'quality-check': 'npm run qc',
  };

  function passRunner(): RunCommandFn {
    return vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));
  }

  /** Without `lint` and `quality-check` scripts, a passing `typecheck` alone must not report PASS. */
  it('StaticAnalysis_LintScriptAbsent_DegradesAndCannotReportPass', () => {
    const repoRoot = nodeFixture({ typecheck: 'tsc --noEmit' });

    const result = realRunStaticAnalysis({ repoRoot, runCommand: passRunner() });

    expect(result.status).not.toBe('pass');
    expect(result.status).toBe('skip');
    expect(result.skipReason).toBe('constituent-skipped');
    expect(result.skipCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.output).not.toContain('Result: PASS');
    expect(result.output).toContain('Result: DEGRADED');
    expect(result.output).toContain("no 'lint' script in package.json");
  });

  /** A `--skip-*` flag narrows the scope, but the check that did not run is not evidence of a pass. */
  it('StaticAnalysis_ConstituentSkippedByFlag_DegradesAndCannotReportPass', () => {
    const repoRoot = nodeFixture(ALL_SCRIPTS);

    const result = realRunStaticAnalysis({
      repoRoot,
      skipLint: true,
      runCommand: passRunner(),
    });

    expect(result.status).not.toBe('pass');
    expect(result.status).toBe('skip');
    expect(result.skipReason).toBe('constituent-skipped');
    expect(result.skipCount).toBe(1);
    expect(result.output).toContain('Result: DEGRADED');
    expect(result.output).not.toContain('Result: PASS');
  });

  /**
   * Positive control. Without it, the DEGRADED assertions also hold for a stub that never returns 'pass'.
   * The declared `lint` script must also run, not only exist.
   */
  it('StaticAnalysis_EveryConstituentRanAndPassed_StillReportsPass', () => {
    const repoRoot = nodeFixture(ALL_SCRIPTS);
    const runner = passRunner();

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.skipCount).toBe(0);
    expect(result.passCount).toBe(3);
    expect(result.output).toContain('Result: PASS');
    expect(result.output).not.toContain('Result: DEGRADED');

    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(
        (c: unknown[]) =>
          c[0] === 'npm' && Array.isArray(c[1]) && (c[1] as string[]).join(' ') === 'run lint',
      ),
    ).toBe(true);
  });

  /** A real finding takes precedence over the degrade, so DEGRADED must not hide a FAIL. */
  it('StaticAnalysis_FailureAlongsideSkip_ReportsFailNotDegraded', () => {
    const repoRoot = nodeFixture({ lint: 'eslint .', typecheck: 'tsc --noEmit' });

    const runner: RunCommandFn = vi.fn((_cmd: string, args: readonly string[]) =>
      args.join(' ') === 'run lint'
        ? { exitCode: 1, stdout: '', stderr: 'lint errors' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
    expect(result.skipCount).toBe(1);
    expect(result.output).toContain('Result: FAIL');
  });

  it('handleStaticAnalysis_ConstituentSkipped_ReturnsNotPassedAndSkipped', async () => {
    mockRunStaticAnalysis.mockReturnValue({
      status: 'skip' as const,
      output: '**Result: DEGRADED** (1/1 checks passed, 2 skipped — inconclusive, not a pass)',
      skipReason: 'constituent-skipped' as const,
      passCount: 1,
      failCount: 0,
      skipCount: 2,
      projectType: 'Node.js',
    });

    const result = await handleStaticAnalysis(
      { featureId: 'feat-dr6', repoRoot: '/home/user/project' },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      skipped?: boolean;
      skipReason?: string;
      degraded?: boolean;
      skipCount: number;
      report: string;
    };
    expect(data.passed).toBe(false);
    expect(data.skipped).toBe(true);
    expect(data.skipReason).toBe('constituent-skipped');
    expect(data.degraded).toBe(true);
    expect(data.skipCount).toBe(2);
    expect(data.report).not.toContain('Result: PASS');
  });

  /**
   * An explicit skip is indeterminate whatever `passed` says. A `passed: true` skip carrier is also
   * indeterminate, so a gate that did not run cannot mint durable pass evidence. A real fail stays
   * fail, and a real pass stays pass.
   */
  it('NormalizeGateVerdict_SkippedStaticAnalysis_IsIndeterminateNotPassOrFail', async () => {
    const { normalizeGateVerdict } = await import('../../../../src/verbs/gates/gate-utils.js');

    const skipped = normalizeGateVerdict({
      success: true,
      data: { passed: false, skipped: true, skipReason: 'constituent-skipped' },
    } as unknown as ToolResult);
    expect(skipped).toBe('indeterminate');

    expect(
      normalizeGateVerdict({ success: true, data: { passed: false } } as unknown as ToolResult),
    ).toBe('fail');
    expect(
      normalizeGateVerdict({ success: true, data: { passed: true } } as unknown as ToolResult),
    ).toBe('pass');
    expect(
      normalizeGateVerdict({
        success: true,
        data: { passed: true, skipped: true },
      } as unknown as ToolResult),
    ).toBe('indeterminate');
  });

  /**
   * Runs the real admission algebra with schema-parsed evidence. Indeterminate evidence blocks like a
   * fail, and a waiver cannot rescue it, although the obligations are waivable. Only a real pass admits.
   * A phase advances only under `allow`, so indeterminate evidence leaves the phase unchanged.
   */
  it('AdmissionPolicy_IndeterminateGateEvidence_BlocksExactlyAsFailDoes', async () => {
    const [{ AdmissionEvidenceV1Schema, AdmissionRequirementV1Schema }, authorityMod, policyMod] =
      await Promise.all([
        import('../../../../src/workflow/admission/types.js'),
        import('../../../../src/workflow/admission/policy-authority.js'),
        import('../../../../src/workflow/admission/policy-evaluation.js'),
      ]);
    const { createCapabilityAuthority, POLICY_CAPABILITY } = authorityMod;
    const { evaluatePolicy } = policyMod;

    const SHA = 'a'.repeat(64);
    const EVAL_AT = '2026-08-04T20:00:00.000Z';
    const FRESH_AT = '2026-08-04T19:45:00.000Z';
    const GATE_PRODUCER = 'producer.gate-runner';
    const digest = { algorithm: 'sha256' as const, value: SHA };
    const subject = { kind: 'task' as const, taskId: 'T-09', digest };

    const authority = createCapabilityAuthority([
      { principalId: GATE_PRODUCER, capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE] },
    ]);

    const requirement = AdmissionRequirementV1Schema.parse({
      contractVersion: '1.0',
      requirementId: 'req-static-analysis',
      phaseAttemptId: 'pa-1',
      subject,
      kind: 'gate-evidence',
      gateId: 'gate.static-analysis',
    });

    const evidence = (verdict: 'pass' | 'fail' | 'indeterminate') =>
      AdmissionEvidenceV1Schema.parse({
        contractVersion: '1.0',
        evidenceId: `ev-${verdict}`,
        requirementId: 'req-static-analysis',
        phaseAttemptId: 'pa-1',
        subject,
        producer: {
          producerId: GATE_PRODUCER,
          providerRef: 'provider.static-analysis',
          providerVersion: '1.0',
          invocationId: 'inv-1',
        },
        policyId: 'policy-1',
        policyDigest: digest,
        contentDigest: { algorithm: 'sha256' as const, value: 'b'.repeat(64) },
        createdAt: FRESH_AT,
        kind: 'gate',
        verdict,
      });

    const evaluate = (verdict: 'pass' | 'fail' | 'indeterminate') =>
      evaluatePolicy({
        requirements: [requirement],
        obligations: {
          gates: [],
          minimumApprovals: 0,
          minimumCorroboratingSources: 0,
          waivable: true,
        },
        activeEvidence: [evidence(verdict)],
        authority,
        evaluatedAt: EVAL_AT,
        freshnessHorizonMs: 60 * 60 * 1000,
      });

    const onFail = evaluate('fail');
    const onIndeterminate = evaluate('indeterminate');
    const onPass = evaluate('pass');

    expect(onFail.verdict).not.toBe('allow');
    expect(onIndeterminate.verdict).not.toBe('allow');
    expect(onIndeterminate.verdict).toBe('indeterminate');
    expect(onIndeterminate.appliedWaiverIds).toEqual([]);
    expect(onPass.verdict).toBe('allow');
  });

  /**
   * The root `lint` script must run eslint with `eslint.config.js`, not a no-op that cannot fail. The
   * root must also declare `quality-check`, or the static-analysis dimension of this repo always degrades.
   */
  it('RootPackageJson_DeclaresRealLintScript_NotANoOp', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'),
    ) as { scripts?: Record<string, string> };

    const lint = pkg.scripts?.['lint'];
    expect(lint, 'root package.json must declare a `lint` script (DR-6)').toBeTruthy();
    expect(lint).toContain('eslint');
    expect(lint).not.toMatch(/^\s*(echo|true|:|exit\s+0)\b/);
    expect(fs.existsSync(path.join(repoRoot, 'eslint.config.js'))).toBe(true);

    expect(pkg.scripts?.['quality-check']).toBeTruthy();
  });

  /**
   * Loads the real `eslint.config.js` and lints a source that breaks one of its rules. A non-zero
   * `errorCount` makes `eslint` exit non-zero, which the gate reads as FAIL. The clean source is the
   * control, so the failure is the rule and not a broken config.
   */
  it('LintScript_ConfiguredEngine_ReportsViolationAsError', async () => {
    const { ESLint } = await import('eslint');
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..');
    const eslint = new ESLint({ cwd: repoRoot });

    const violating = [
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('npm', ['run', 'lint']);",
      '',
    ].join('\n');
    const clean = 'export const ok = 1;\n';
    const filePath = path.join(repoRoot, 'src/dr6-lint-probe.ts');

    const bad = await eslint.lintText(violating, { filePath });
    const good = await eslint.lintText(clean, { filePath });

    expect(bad.reduce((n, r) => n + r.errorCount, 0)).toBeGreaterThan(0);
    expect(good.reduce((n, r) => n + r.errorCount, 0)).toBe(0);
  }, 60_000);
});
