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
  findLocalDepcruise,
  runBoundaryLint,
  runRawIoTaint,
  type BoundaryLintResult,
  type CommandResult,
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
import { isolatedSync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** The dependency-cruiser bin that this repository installed. The real-tool cases run it through the production runner. */
const REPO_DEPCRUISE_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../node_modules/.bin',
  process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise',
);

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
        { name: 'Import boundaries', cause: 'out-of-memory', detail: 'dependency-cruiser gave no verdict: it ran out of memory' },
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
      expect(result.data).toMatchObject({
        passed: true,
        degraded: true,
        verdict: 'pass',
        completeness: 'degraded',
        advisorySkips,
      });
      expect(result.data).not.toHaveProperty('skipped');
      expect(result.data).not.toHaveProperty('skipReason');
      expect((result.data as { report: string }).report).toContain('Import boundaries');
      expect(normalizeGateVerdict(result)).toBe('pass');
    });

    /**
     * The carrier states the closed verdict of each run status, as the adequacy carrier does. A run with no advisory skip
     * is `complete` and carries no list, and a skip is `indeterminate`.
     */
    it('handleStaticAnalysis_EachRunStatus_StatesTheClosedVerdictAndTheCompleteness', async () => {
      const runs = [
        { label: 'pass', run: { ...makePassingResult(), skipCount: 0 }, verdict: 'pass' },
        { label: 'fail', run: { ...makeFailingResult(), skipCount: 0 }, verdict: 'fail' },
        { label: 'skip', run: { ...makeSkipResult(), skipCount: 0 }, verdict: 'indeterminate' },
      ];
      for (const { label, run, verdict } of runs) {
        mockRunStaticAnalysis.mockReturnValue(run);
        const result = await handleStaticAnalysis(
          { featureId: 'feat-1', repoRoot: '/home/user/project' },
          STATE_DIR,
          mockStore as unknown as EventStore,
        );
        expect(result.data, label).toMatchObject({ verdict, completeness: 'complete' });
        expect(result.data, label).not.toHaveProperty('advisorySkips');
      }
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

      const callArgs = mockRunStaticAnalysis.mock.calls[0]?.[0] as {
        firstPartyGlobs?: readonly string[];
        projectConfigError?: unknown;
      };
      expect(callArgs.firstPartyGlobs).toBeUndefined();
      expect(callArgs.projectConfigError).toBeUndefined();
    });

    /**
     * A project config that does not load is not read as no config. The handler passes the file and the error, and no
     * globs, so the boundary leg fails and names them. It does not scan the default roots.
     */
    it('handleStaticAnalysis_ProjectConfigThatDoesNotLoad_PassesTheLoadFailure', async () => {
      const file = path.join(configDir, '.exarchos.yml');
      fs.writeFileSync(file, "ownership:\n  firstParty:\n    - 'lib/**'\nnotARealKey: true\n", 'utf-8');
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      await handleStaticAnalysis(
        { featureId: 'feat-1', repoRoot: configDir },
        STATE_DIR,
        mockStore as unknown as EventStore,
      );

      const callArgs = mockRunStaticAnalysis.mock.calls[0]?.[0] as {
        firstPartyGlobs?: readonly string[];
        projectConfigError?: { source: string; message: string };
      };
      expect(callArgs.firstPartyGlobs).toBeUndefined();
      expect(callArgs.projectConfigError?.source).toBe(path.resolve(file));
      expect(callArgs.projectConfigError?.message).toMatch(/Invalid \.exarchos\.yml at .*notARealKey/s);
    });
  });
});

/**
 * Runs real processes through the production runner of the static-analysis legs. The legs read
 * `exitCode`, `signal` and `spawnError` from it, so each field must have the value that the process
 * really gave.
 */
describe('execCommandRunner — the production runner of the static-analysis legs', () => {
  function runNode(script: string): Promise<CommandResult> {
    return isolatedSync(() => execCommandRunner(process.execPath, ['-e', script], { cwd: process.cwd() }));
  }

  /** A non-zero exit keeps its status and output and carries no signal and no runner error. */
  it('ExecCommandRunner_NonZeroExit_KeepsTheStatusAndTheOutput', async () => {
    const result = await runNode('process.stdout.write("out"); process.stderr.write("err"); process.exit(3);');

    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
  });

  it('ExecCommandRunner_CleanExit_GivesExitZeroAndTheOutput', async () => {
    expect(await runNode('process.stdout.write("ok")')).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
  });

  /** A process that a signal stopped has no exit status. The runner gives exit 1 and the signal. */
  it.skipIf(process.platform === 'win32')('ExecCommandRunner_SignalDeath_CarriesTheSignal', async () => {
    const result = await runNode('process.kill(process.pid, "SIGKILL")');

    expect(result.exitCode).toBe(1);
    expect(result.signal).toBe('SIGKILL');
    expect(result.spawnError).toBeUndefined();
  });

  it('ExecCommandRunner_MissingCommand_CarriesTheSpawnError', async () => {
    const result = await isolatedSync(() =>
      execCommandRunner('exarchos-no-such-command-for-this-test', [], { cwd: process.cwd() }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.spawnError).toBe('ENOENT');
  });

  /**
   * The boundary JSON report of this repository is about 2 MB. The default output limit of 1 MiB
   * stops such a run with ENOBUFS, so the runner raises the limit.
   */
  it('ExecCommandRunner_ReportOfSeveralMegabytes_IsReadInFull', async () => {
    const bytes = 8 * 1024 * 1024;

    const result = await runNode(`process.stdout.write("x".repeat(${bytes}))`);

    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(bytes);
  });

  /** Output past the raised limit is a runner error with the name ENOBUFS, not a clean run. */
  it('ExecCommandRunner_OutputPastTheLimit_CarriesENOBUFS', async () => {
    const bytes = 65 * 1024 * 1024;

    const result = await runNode(`process.stdout.write("x".repeat(${bytes}))`);

    expect(result.spawnError).toBe('ENOBUFS');
    expect(result.exitCode).toBe(1);
  });
});

/**
 * Runs the real `runBoundaryLint` against temp fixtures on disk with an injected runner. The leg runs the
 * installed `node_modules/.bin/depcruise --validate --output-type json` over the first-party roots and reads
 * `summary.error` and `summary.totalCruised`. Each fixture holds an empty file at that bin path, so the lookup
 * finds it. Without `.dependency-cruiser.cjs` the leg is not configured. The fixture config forbids imports from
 * `domain-core` to `io-adapters`.
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

  function localBin(repoRoot: string): string {
    return path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise');
  }

  function isDepcruise(cmd: string): boolean {
    return /^depcruise(\.cmd)?$/.test(path.basename(cmd));
  }

  function makeBoundaryFixture(opts: { withConfig: boolean; withViolation: boolean; withLocalBin?: boolean }): string {
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

    if (opts.withLocalBin ?? true) {
      fs.mkdirSync(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
      for (const name of ['depcruise', 'depcruise.cmd']) {
        fs.writeFileSync(path.join(repoRoot, 'node_modules', '.bin', name), '', 'utf-8');
      }
    }

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

  function cruiseReport(errors: number, totalCruised = 2): string {
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
        totalCruised,
      },
    });
  }

  function depcruiseArgs(runner: RunCommandFn, repoRoot: string): string[] {
    const calls = vi.mocked(runner).mock.calls;
    expect(calls.length).toBe(1);
    const [cmd, cmdArgs] = calls[0] ?? [];
    expect(cmd).toBe(localBin(repoRoot));
    return [...(cmdArgs ?? [])];
  }

  /** An `error` violation in the JSON report fails the leg and names the broken rule. */
  it('StaticAnalysis_CoreImportsIOAdapter_BoundaryRuleFails', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(1), stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.status === 'FAIL' ? result.cause : undefined).toBe('violations');
    expect(result.detail).toContain('no-core-to-io-0');
    expect(result.detail).toContain('1 violation of error severity');
    expect(result.detail).not.toContain('cycle-advice');
    const cmdArgs = depcruiseArgs(runner, repoRoot);
    expect(cmdArgs.slice(0, 4)).toEqual(['--validate', '.dependency-cruiser.cjs', '--output-type', 'json']);
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
    expect(result.status === 'FAIL' ? result.detail : '').toContain('256 violations of error severity');
  });

  /**
   * A report with zero `error` violations and checked modules passes, also with a `warn` violation and a
   * non-zero exit. The detail gives the count and names the default glob that names no path here.
   */
  it('BoundaryLint_ZeroErrorsInReport_PassesEvenWithANonZeroExit', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 1, stdout: cruiseReport(0), stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result).toEqual({
      status: 'PASS',
      cruised: 2,
      detail: '2 modules checked. ownership.firstParty globs that name no path, not scanned: servers/*/src/**.',
    });
  });

  it('StaticAnalysis_CompliantImports_Passes', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner, firstPartyGlobs: ['src/**'] });

    expect(result).toEqual({ status: 'PASS', cruised: 2, detail: '2 modules checked' });
    expect(vi.mocked(runner).mock.calls.length).toBe(1);
  });

  /**
   * A complete report with zero `error` violations and zero checked modules is no verdict, not a PASS. This is
   * the shape of a first-party root that holds no module that the config scans.
   */
  it('BoundaryLint_ZeroModulesChecked_DegradedSkipNotPass', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0, 0), stderr: '' }));

    const result = runBoundaryLint({ repoRoot, runCommand: runner, firstPartyGlobs: ['src/**'] });

    expect(result).toEqual({
      status: 'NO_VERDICT',
      cause: 'zero-modules',
      detail:
        'dependency-cruiser gave no verdict: the scan checked no module (summary.totalCruised is 0). ' +
        'The roots hold no module that the config scans',
    });
  });

  /** A missing config means that the leg is not configured. It is not a failure, and depcruise does not run. */
  it('StaticAnalysis_NoBoundaryConfig_LegNotConfigured', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: false, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('NOT_CONFIGURED');
    expect(vi.mocked(runner).mock.calls.length).toBe(0);
  });

  /**
   * Each fault outside the repository gives no verdict with its cause, and never a FAIL. The cases hold the
   * shapes that the production runner gives.
   */
  it.each<[string, { exitCode: number; stdout: string; stderr: string; signal?: string; spawnError?: string }, string, RegExp]>([
    [
      'heap exhaustion',
      {
        exitCode: 134,
        stdout: '',
        stderr: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n',
      },
      'out-of-memory',
      /ran out of memory/,
    ],
    ['a report cut short', { exitCode: 137, stdout: cruiseReport(0).slice(0, 40), stderr: '' }, 'signal', /exit 137, .*signal 9/],
    ['a signal, even with a complete report', { exitCode: 1, stdout: cruiseReport(1), stderr: '', signal: 'SIGKILL' }, 'signal', /stopped by SIGKILL/],
    ['a bin that did not start', { exitCode: 1, stdout: '', stderr: '', spawnError: 'EACCES' }, 'did-not-start', /runner reported EACCES/],
    ['a bin that is gone', { exitCode: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }, 'missing-tool', /runner reported ENOENT/],
    [
      'an interpreter that is not installed',
      { exitCode: 127, stdout: '', stderr: "/usr/bin/env: 'node': No such file or directory\n" },
      'missing-tool',
      /exit 127, the status of a command that was not found: .*'node'/,
    ],
    ['a report larger than the output limit', { exitCode: 1, stdout: cruiseReport(0).slice(0, 40), stderr: '', signal: 'SIGTERM', spawnError: 'ENOBUFS' }, 'output-limit', /output limit of the runner \(ENOBUFS\)/],
  ])('BoundaryLint_NoVerdict_DegradedSkipNotFail [%s]', (_label, commandResult, cause, text) => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => commandResult);

    const result = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('NO_VERDICT');
    expect(result.status === 'NO_VERDICT' ? result.cause : undefined).toBe(cause);
    expect(result.detail).toMatch(/^dependency-cruiser gave no verdict: /);
    expect(result.detail).toMatch(text);
  });

  /**
   * A run with no complete report and no fault outside the repository fails the leg. A broken config and a
   * usage error give exit 1 with no stdout. A report of another shape fails too, because the repository chose
   * the installed version. The detail quotes stderr and names the command to run again.
   */
  it.each<[string, { exitCode: number; stdout: string; stderr: string }, RegExp]>([
    [
      'a config that is not valid',
      {
        exitCode: 1,
        stdout: '',
        stderr: '\n  ERROR: The supplied configuration is not valid: data/forbidden/0/severity must be equal to one of the allowed values\n',
      },
      /no complete report \(exit 1\): ERROR: The supplied configuration is not valid/,
    ],
    ['a config with a syntax error', { exitCode: 1, stdout: '', stderr: "\n  ERROR: Unexpected token ';'\n" }, /\(exit 1\): ERROR: Unexpected token/],
    ['output that is not JSON', { exitCode: 1, stdout: '', stderr: "ERROR: Can't open 'src' for reading.\n" }, /\(exit 1\): ERROR: Can't open/],
    ['a usage error', { exitCode: 1, stdout: '', stderr: "error: unknown option '--no-such-flag'\n" }, /\(exit 1\): error: unknown option/],
    ['a JSON value with no summary', { exitCode: 0, stdout: '{"modules":[]}', stderr: '' }, /no complete report \(exit 0\)\. /],
    ['a summary with no module count', { exitCode: 0, stdout: '{"summary":{"error":0}}', stderr: '' }, /no complete report \(exit 0\)\. /],
    ['an unknown exit code with no stderr', { exitCode: 2, stdout: '', stderr: '' }, /no complete report \(exit 2\)\. /],
  ])('BoundaryLint_RepositoryFault_FailsNotSkip [%s]', (_label, commandResult, text) => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => commandResult);

    const result = runBoundaryLint({ repoRoot, runCommand: runner, firstPartyGlobs: ['src/**'] });

    expect(result.status).toBe('FAIL');
    expect(result.status === 'FAIL' ? result.cause : undefined).toBe('config-or-usage');
    expect(result.detail).toMatch(text);
    expect(result.detail).toContain(
      `Re-run \`${path.join('node_modules', '.bin', path.basename(localBin(repoRoot)))} --validate .dependency-cruiser.cjs src\``,
    );
  });

  it('BoundaryLint_RunnerThrows_DegradedSkipNotFail', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => {
      throw new Error('spawn failed');
    });

    const result = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('NO_VERDICT');
    expect(result.status === 'NO_VERDICT' ? result.cause : undefined).toBe('did-not-start');
    expect(result.detail).toContain('the tool did not start (spawn failed)');
  });

  /**
   * With no installed bin on the walk from the repository root, the leg has no tool. It gives no verdict with a
   * remedy, and it runs nothing, so no `npx` call can fetch a package from the registry.
   */
  it('BoundaryLint_NoLocalBin_MissingToolWithoutARun', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true, withLocalBin: false });
    expect(findLocalDepcruise(repoRoot), 'a bin on the walk above the temp directory voids this case').toBeUndefined();
    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    const result = runBoundaryLint({ repoRoot, runCommand: runner, firstPartyGlobs: ['src/**'] });

    expect(result.status).toBe('NO_VERDICT');
    expect(result.status === 'NO_VERDICT' ? result.cause : undefined).toBe('missing-tool');
    expect(result.detail).toContain(`no node_modules/.bin/${path.basename(localBin(repoRoot))} in ${repoRoot}`);
    expect(result.detail).toContain('npm install --save-dev dependency-cruiser');
    expect(result.detail).toContain('does not fetch it from the registry');
    expect(vi.mocked(runner).mock.calls).toEqual([]);
  });

  /**
   * A project config that does not load fails the leg with the file and the error. The leg runs nothing, so it never
   * scans the default roots in place of the configured ones. A repository with no boundary config has no leg to fail.
   */
  it('BoundaryLint_ProjectConfigThatDoesNotLoad_FailsWithoutARun', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));
    const projectConfigError = {
      source: path.join(repoRoot, '.exarchos.yml'),
      message: `Invalid .exarchos.yml at ${path.join(repoRoot, '.exarchos.yml')}: <root>: Unrecognized key: "notARealKey"`,
    };

    const result = runBoundaryLint({ repoRoot, runCommand: runner, projectConfigError });

    expect(result.status).toBe('FAIL');
    expect(result.status === 'FAIL' ? result.cause : undefined).toBe('project-config');
    expect(result.detail).toContain(`the project config ${projectConfigError.source} does not load`);
    expect(result.detail).toContain('Unrecognized key: "notARealKey"');
    expect(result.detail).toContain('does not scan the default roots');
    expect(vi.mocked(runner).mock.calls).toEqual([]);

    const unconfigured = fs.mkdtempSync(path.join(tmpDir, 'no-boundary-config-'));
    expect(runBoundaryLint({ repoRoot: unconfigured, runCommand: runner, projectConfigError }).status).toBe(
      'NOT_CONFIGURED',
    );
  });

  /**
   * The lookup walks up from the repository root as npm does, and the nearest `node_modules/.bin` with the bin
   * wins. A directory with the bin name is not a bin. On win32 the bin is the `.cmd` shim.
   */
  it('FindLocalDepcruise_WalksUpFromTheRepositoryRootAsNpmDoes', () => {
    const outer = path.join(tmpDir, 'outer');
    const repoRoot = path.join(outer, 'packages', 'app');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(path.join(outer, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(outer, 'node_modules', '.bin', 'depcruise'), '', 'utf-8');
    fs.writeFileSync(path.join(outer, 'node_modules', '.bin', 'depcruise.cmd'), '', 'utf-8');
    fs.mkdirSync(path.join(repoRoot, 'node_modules', '.bin', 'depcruise'), { recursive: true });

    expect(findLocalDepcruise(repoRoot, 'linux')).toBe(path.join(outer, 'node_modules', '.bin', 'depcruise'));
    expect(findLocalDepcruise(repoRoot, 'win32')).toBe(path.join(outer, 'node_modules', '.bin', 'depcruise.cmd'));

    fs.mkdirSync(path.join(outer, 'packages', 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(outer, 'packages', 'node_modules', '.bin', 'depcruise'), '', 'utf-8');

    expect(findLocalDepcruise(repoRoot, 'linux')).toBe(path.join(outer, 'packages', 'node_modules', '.bin', 'depcruise'));
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

    const result = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(depcruiseArgs(runner, repoRoot).slice(4)).toEqual(['servers/api/src', 'src']);
    expect(result).toEqual({ status: 'PASS', cruised: 2, detail: '2 modules checked' });
  });

  /** The roots hold no duplicate and no root inside another root. The detail names each glob that names no path. */
  it('BoundaryLint_ConfiguredGlobs_ScanTheirRootsWithoutNestedDuplicates', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.mkdirSync(path.join(repoRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'index.js'), 'export {};\n', 'utf-8');
    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    const result = runBoundaryLint({
      repoRoot,
      runCommand: runner,
      firstPartyGlobs: ['src/domain-core/**', 'lib/**', 'src/**/*.js', 'missing/**', 'index.js', '!lib/x/**'],
    });

    expect(depcruiseArgs(runner, repoRoot).slice(4)).toEqual(['index.js', 'lib', 'src']);
    expect(result.detail).toBe(
      '2 modules checked. ownership.firstParty globs that name no path, not scanned: missing/**, !lib/x/**.',
    );
  });

  /**
   * A glob in the dialect of the mock-boundary gate, such as a package specifier, names no path. The scan drops
   * it, and the report names it, also on a PASS.
   */
  it('BoundaryLint_GlobWithNoPath_PassReportNamesTheDroppedGlob', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );
    const runner: RunCommandFn = vi.fn((cmd: string) => ({
      exitCode: 0,
      stdout: isDepcruise(cmd) ? cruiseReport(0) : '',
      stderr: '',
    }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner, firstPartyGlobs: ['@acme/**', 'src/**'] });

    expect(result.status).toBe('pass');
    expect(result.output).toContain(
      '- **PASS**: Import boundaries — 2 modules checked. ownership.firstParty globs that name no path, not scanned: @acme/**.',
    );
    const depcruiseCall = vi.mocked(runner).mock.calls.find(([cmd]) => isDepcruise(cmd));
    expect(depcruiseCall?.[1].slice(4)).toEqual(['src']);
  });

  /**
   * A glob whose walk stops at its first segment widens the scan to the repository root. The leg detail and the
   * report name the widening, also on a PASS.
   */
  it('BoundaryLint_GlobWidenedToTheRoot_ReportNamesTheWidening', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );
    const legRunner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));
    const runner: RunCommandFn = vi.fn((cmd: string) => ({
      exitCode: 0,
      stdout: isDepcruise(cmd) ? cruiseReport(0) : '',
      stderr: '',
    }));

    const leg = runBoundaryLint({ repoRoot, runCommand: legRunner, firstPartyGlobs: ['**/src/**'] });
    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner, firstPartyGlobs: ['**/src/**'] });

    expect(depcruiseArgs(legRunner, repoRoot).slice(4)).toEqual(['.']);
    expect(leg).toEqual({
      status: 'PASS',
      cruised: 2,
      detail: '2 modules checked. ownership.firstParty globs widened to the repository root: **/src/**.',
    });
    expect(result.status).toBe('pass');
    expect(result.output).toContain(
      '- **PASS**: Import boundaries — 2 modules checked. ownership.firstParty globs widened to the repository root: **/src/**.',
    );
  });

  /** With no first-party root on disk, the leg has nothing to scan. It gives no verdict, and depcruise does not run. */
  it('BoundaryLint_NoFirstPartyRootExists_DegradedSkipWithoutARun', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: cruiseReport(0), stderr: '' }));

    const result = runBoundaryLint({ repoRoot, runCommand: runner, firstPartyGlobs: ['packages/*/src/**'] });

    expect(result.status).toBe('NO_VERDICT');
    expect(result.status === 'NO_VERDICT' ? result.cause : undefined).toBe('no-source-root');
    expect(result.detail).toContain('no ownership.firstParty source root exists (packages/*/src/**)');
    expect(vi.mocked(runner).mock.calls.length).toBe(0);
  });

  /**
   * Runs the installed dependency-cruiser of this repository through the production runner. The JSON report of
   * a violating fixture fails the leg. The report of a clean fixture passes it with the count of its two modules.
   */
  it('BoundaryLint_RealDependencyCruiser_ReadsTheVerdictFromTheJsonReport', async () => {
    const violating = await isolatedSync(() =>
      runBoundaryLint({
        repoRoot: makeBoundaryFixture({ withConfig: true, withViolation: true, withLocalBin: false }),
        runCommand: execCommandRunner,
        findDepcruise: () => REPO_DEPCRUISE_BIN,
      }),
    );
    rmrf(path.join(tmpDir, 'repo'));
    const clean = await isolatedSync(() =>
      runBoundaryLint({
        repoRoot: makeBoundaryFixture({ withConfig: true, withViolation: false, withLocalBin: false }),
        runCommand: execCommandRunner,
        findDepcruise: () => REPO_DEPCRUISE_BIN,
        firstPartyGlobs: ['src/**'],
      }),
    );

    expect(violating.status).toBe('FAIL');
    expect(violating.detail).toContain('error no-core-to-io: src/domain-core/order.js → src/io-adapters/db.js');
    expect(clean).toEqual({ status: 'PASS', cruised: 2, detail: '2 modules checked' });
  });

  /**
   * Pins the JSON contract of the installed dependency-cruiser for a root with no module. A first-party root
   * that holds only a README gives a complete report with `totalCruised` 0, so the leg gives no verdict. The
   * violation in `src`, outside the configured root, does not turn the empty scan into a PASS.
   */
  it('BoundaryLint_RealDependencyCruiserOnAnEmptyRoot_GivesZeroModulesNotPass', async () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true, withLocalBin: false });
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs', 'README.md'), '# docs\n', 'utf-8');

    const run = await isolatedSync(() =>
      execCommandRunner(REPO_DEPCRUISE_BIN, ['--validate', '.dependency-cruiser.cjs', '--output-type', 'json', 'docs'], {
        cwd: repoRoot,
      }),
    );
    const result = await isolatedSync(() =>
      runBoundaryLint({
        repoRoot,
        runCommand: execCommandRunner,
        findDepcruise: () => REPO_DEPCRUISE_BIN,
        firstPartyGlobs: ['docs/**'],
      }),
    );

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ summary: { error: 0, totalCruised: 0 } });
    expect(result.status).toBe('NO_VERDICT');
    expect(result.status === 'NO_VERDICT' ? result.cause : undefined).toBe('zero-modules');
  });

  /**
   * A broken config of the repository fails the leg through the installed dependency-cruiser. A syntax error
   * and a severity that the schema does not allow each give exit 1, no stdout and an `ERROR:` line on stderr.
   */
  it.each<[string, string, RegExp]>([
    ['a syntax error', 'module.exports = { forbidden: [ ;\n', /ERROR: Unexpected token/],
    [
      'a severity that the schema does not allow',
      "module.exports = { forbidden: [ { name: 'r', severity: 'fatal', from: { path: '^src' }, to: { path: '^lib' } } ] };\n",
      /ERROR: The supplied configuration is not valid/,
    ],
  ])('BoundaryLint_RealDependencyCruiserWithABrokenConfig_Fails [%s]', async (_label, config, text) => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false, withLocalBin: false });
    fs.writeFileSync(path.join(repoRoot, '.dependency-cruiser.cjs'), config, 'utf-8');

    const result = await isolatedSync(() =>
      runBoundaryLint({
        repoRoot,
        runCommand: execCommandRunner,
        findDepcruise: () => REPO_DEPCRUISE_BIN,
        firstPartyGlobs: ['src/**'],
      }),
    );

    expect(result.status).toBe('FAIL');
    expect(result.status === 'FAIL' ? result.cause : undefined).toBe('config-or-usage');
    expect(result.detail).toMatch(text);
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

    const runner: RunCommandFn = vi.fn((cmd: string) => ({
      exitCode: 0,
      stdout: isDepcruise(cmd) ? cruiseReport(0) : '',
      stderr: '',
    }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner, firstPartyGlobs: ['src/**'] });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(4);
    expect(result.advisorySkips).toBeUndefined();
    expect(result.output).toContain('- **PASS**: Import boundaries — 2 modules checked');
    expect(result.output).toContain('**Result: PASS** (4/4 checks passed)');
  });

  /**
   * A boundary scan that gives no verdict stays visible. The report lists it and marks the result degraded.
   * The status stays `pass`, so the gate does not fail on a fault outside the repository.
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

    const runner: RunCommandFn = vi.fn((cmd: string) =>
      isDepcruise(cmd)
        ? { exitCode: 134, stdout: '', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner, firstPartyGlobs: ['src/**'] });

    expect(result.status).toBe('pass');
    expect(result.skipCount).toBe(0);
    expect(result.passCount).toBe(3);
    expect(result.advisorySkips).toEqual([
      { name: 'Import boundaries', cause: 'out-of-memory', detail: 'dependency-cruiser gave no verdict: it ran out of memory' },
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

    const runner: RunCommandFn = vi.fn((cmd: string) => ({
      exitCode: 0,
      stdout: isDepcruise(cmd) ? cruiseReport(2) : '',
      stderr: '',
    }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
    expect(result.output).toContain('- **FAIL**: Import boundaries — dependency-cruiser found 2 violations');
  });

  /** A project config that does not load fails the whole result, and the report names the file and the error. */
  it('StaticAnalysis_ProjectConfigThatDoesNotLoad_FailsTheResult', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );
    const runner: RunCommandFn = vi.fn((cmd: string) => ({
      exitCode: 0,
      stdout: isDepcruise(cmd) ? cruiseReport(0) : '',
      stderr: '',
    }));
    const source = path.join(repoRoot, '.exarchos.yml');

    const result = realRunStaticAnalysis({
      repoRoot,
      runCommand: runner,
      projectConfigError: { source, message: `Failed to parse .exarchos.yml at ${source}: bad indentation` },
    });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
    expect(result.advisorySkips).toBeUndefined();
    expect(result.output).toContain(`- **FAIL**: Import boundaries — the project config ${source} does not load`);
    expect(result.output).toContain('bad indentation');
    expect(vi.mocked(runner).mock.calls.some(([cmd]) => isDepcruise(cmd))).toBe(false);
  });

  /** A broken boundary config fails the whole result. It is a counted FAIL, not an advisory skip. */
  it('StaticAnalysis_BoundaryConfigError_FailsTheResult', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', 'quality-check': 'npm run qc' },
      }),
      'utf-8',
    );

    const runner: RunCommandFn = vi.fn((cmd: string) =>
      isDepcruise(cmd)
        ? { exitCode: 1, stdout: '', stderr: "\n  ERROR: Unexpected token ';'\n" }
        : { exitCode: 0, stdout: '', stderr: '' },
    );

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner, firstPartyGlobs: ['src/**'] });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
    expect(result.advisorySkips).toBeUndefined();
    expect(result.output).toContain(
      "- **FAIL**: Import boundaries — dependency-cruiser gave no complete report (exit 1): ERROR: Unexpected token ';'",
    );
  });
});

/**
 * The result of the production runner for a command name that is on no PATH.
 * The taint suite gets it once before its tests, through `isolatedSync`, so no test spawns synchronously.
 */
let missingSemgrepResult: CommandResult | undefined;

/** Gives the result of the production runner for the missing semgrep command. A missing command fails the same way for all arguments. */
const missingSemgrepRunner: RunCommandFn = () => {
  if (missingSemgrepResult === undefined) throw new Error('the taint suite did not run the missing semgrep command');
  return missingSemgrepResult;
};

/**
 * Runs the real `runRawIoTaint` and `runStaticAnalysis` against temp fixtures on disk with an injected
 * runner. The taint check is a dataflow rule that dependency-cruiser cannot express, so it runs Semgrep.
 * The leg runs only when the repo commits `.semgrep/no-raw-io-into-core.yml`, else it is not configured.
 * An engine that did not start or did not finish gives no verdict, which the report lists. A ruleset error
 * fails the leg. The exit code of the runner decides the verdict, so the fixture ruleset only has to exist.
 */
describe('runRawIoTaint — boundary-parse taint leg (SIV-3 Layer B, #1529)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../../../src/verbs/gates/pure/static-analysis.js')>(
      '../../../../src/verbs/pure/static-analysis.js',
    );
    realRunStaticAnalysis = actual.runStaticAnalysis;
    missingSemgrepResult = await isolatedSync(() =>
      execCommandRunner('exarchos-no-such-semgrep-for-this-test', [], { cwd: process.cwd() }),
    );
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
    expect(result.status === 'FAIL' ? result.cause : undefined).toBe('findings');
    expect(result.status === 'FAIL' ? result.detail : '').toContain('no-raw-io-into-core');
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
    expect(result.status === 'FAIL' ? result.detail : '').toContain('no-out-of-band-brand-cast');
  });

  it('RawIoTaint_AllInputsCrossRegisteredParser_Passes', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('PASS');
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  /** A repo without the ruleset is not subject to the leg, so the engine does not run. */
  it('RawIoTaint_NoRuleset_LegNotConfigured', () => {
    const repoRoot = makeTaintFixture({ withRuleset: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('NOT_CONFIGURED');
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('RawIoTaint_EngineAbsent_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => {
      throw new Error('semgrep: command not found');
    });

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result).toEqual({
      status: 'NO_VERDICT',
      cause: 'did-not-start',
      detail: 'semgrep gave no verdict: semgrep not available (semgrep: command not found)',
    });
  });

  /**
   * Exit 4 is the status of semgrep for a rule that does not parse. A ruleset error is a fault inside the
   * repository, so the leg fails. The detail quotes the stderr of the engine and the command to re-run.
   */
  it('RawIoTaint_EngineConfigError_Fails', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 4,
      stdout: '',
      stderr: 'semgrep: invalid rule schema\n',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result).toEqual({
      status: 'FAIL',
      cause: 'ruleset-or-usage',
      detail:
        'semgrep exited 4, its status for a rule that does not parse: semgrep: invalid rule schema. ' +
        'A ruleset or a usage error fails the leg. ' +
        'Re-run `semgrep --error --config .semgrep/no-raw-io-into-core.yml .` without --quiet to read its message',
    });
  });

  /**
   * The `--quiet` flag hides the messages of semgrep, so a ruleset error comes with no stderr. Each status that
   * semgrep gives for a ruleset or a usage error fails the leg, and the detail names the fault of the status.
   */
  it.each([
    [4, 'a rule that does not parse'],
    [5, 'a config that is not valid YAML'],
    [7, 'a config that it did not find'],
    [8, 'a language that it does not know'],
  ])('RawIoTaint_RulesetErrorStatus%i_FailsWithNoStderr', (exitCode, fault) => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status === 'FAIL' ? result.cause : result.status).toBe('ruleset-or-usage');
    expect(result.status === 'FAIL' ? result.detail : '').toMatch(
      new RegExp(`^semgrep exited ${exitCode}, its status for ${fault} with no stderr\\. `),
    );
  });

  /**
   * Exit 2 is the fatal status of semgrep. When its engine runs out of memory, semgrep writes one of these texts
   * and exits 2. That is a fault outside the repository, so the leg gives no verdict, and the gate does not fail.
   */
  it.each([
    [
      'the engine stopped with a signal',
      'Error while matching: Semgrep exceeded system resources. This may be caused by\n' +
        '    1. Stack overflow.\n    2. Out of memory. Try increasing the memory available to\n',
    ],
    [
      'the engine output ended',
      'You are seeing this because the engine was killed.\n\n' +
        'The most common reason this happens is because it used too much memory.\n',
    ],
  ])('RawIoTaint_EngineOutOfResources_DegradedSkipNotFail (%s)', (_case, stderr) => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 2, stdout: '', stderr }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status === 'NO_VERDICT' ? result.cause : result.status).toBe('out-of-memory');
    expect(result.status === 'NO_VERDICT' ? result.detail : '').toMatch(
      /^semgrep gave no verdict: exit 2, the engine ran out of system resources: /,
    );
  });

  /** The semgrep launcher exits 2 when the install has no engine binary. That is a missing tool, so the leg skips. */
  it('RawIoTaint_InstallWithNoEngine_DegradedSkipNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 2,
      stdout: '',
      stderr: 'Failed to find semgrep-core in PATH or in the semgrep package.\n',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result).toEqual({
      status: 'NO_VERDICT',
      cause: 'missing-tool',
      detail:
        'semgrep gave no verdict: exit 2, the semgrep install has no engine: ' +
        'Failed to find semgrep-core in PATH or in the semgrep package.',
    });
  });

  /** The text of an engine out of memory names a fault outside the repository only with the fatal exit 2. */
  it('RawIoTaint_MemoryTextWithARulesetStatus_StaysARulesetFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 4, stdout: '', stderr: 'rule message: too much memory\n' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status === 'FAIL' ? result.cause : result.status).toBe('ruleset-or-usage');
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

    expect(result).toEqual({
      status: 'NO_VERDICT',
      cause: 'signal',
      detail: 'semgrep gave no verdict: it was stopped by SIGKILL',
    });
  });

  /**
   * A fatal exit 2 with no text names no fault, because `--quiet` hides the messages of semgrep. Only a known fault
   * outside the repository gives no verdict, so the leg fails with the cause `unknown-exit` and the command to re-run.
   */
  it('RawIoTaint_FatalExitWithNoText_FailsWithTheExitStatus', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 2, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result).toEqual({
      status: 'FAIL',
      cause: 'unknown-exit',
      detail:
        'semgrep exited 2 with no stderr. The leg cannot tell a ruleset fault from an engine fault, so it fails. ' +
        'Re-run `semgrep --error --config .semgrep/no-raw-io-into-core.yml .` without --quiet to read its message',
    });
  });

  /** A shell status of a signal stop is a fault outside the repository, so the leg gives no verdict. */
  it('RawIoTaint_SignalExitStatus_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 137, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result).toEqual({
      status: 'NO_VERDICT',
      cause: 'signal',
      detail: 'semgrep gave no verdict: exit 137, the status of a process stopped by signal 9',
    });
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

    expect(result.status).toBe('NO_VERDICT');
    expect(result.status === 'NO_VERDICT' ? result.detail : '').toContain('ENOENT');
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
      status: 'NO_VERDICT',
      cause: 'output-limit',
      detail: 'semgrep gave no verdict: its output passed the output limit of the runner (ENOBUFS)',
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
      status: 'NO_VERDICT',
      cause: 'missing-tool',
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
      { name: 'Boundary IO taint', cause: 'missing-tool', detail: 'semgrep gave no verdict: the runner reported ENOENT' },
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
