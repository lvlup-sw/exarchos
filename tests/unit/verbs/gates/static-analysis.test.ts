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

import { handleStaticAnalysis } from '../../../../src/verbs/gates/static-analysis.js';
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
});

/**
 * Runs the real `runBoundaryLint` against temp fixtures on disk with an injected runner. The leg runs
 * `npx depcruise --validate`. Without `.dependency-cruiser.cjs` the leg skips, like the gate skips a
 * missing lint script. The fixture config forbids imports from `domain-core` to `io-adapters`.
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
        ? "import { db } from '../../io-adapters/db.js';\nexport const order = db;\n"
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

  /** With a violating import, depcruise exits non-zero, so the leg must fail and name the broken rule. */
  it('StaticAnalysis_CoreImportsIOAdapter_BoundaryRuleFails', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: '',
      stderr: "error no-core-to-io: src/domain-core/order.js → src/io-adapters/db.js\n",
    }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('no-core-to-io');
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const [cmd, cmdArgs] = calls[0] as [string, string[]];
    expect(cmd).toBe('npx');
    expect(cmdArgs).toContain('depcruise');
    expect(cmdArgs).toContain('--validate');
  });

  it('StaticAnalysis_CompliantImports_Passes', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('PASS');
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
  });

  /** A missing config is an advisory skip, not a failure, and depcruise does not run. */
  it('StaticAnalysis_NoBoundaryConfig_LegSkippedAdvisory', () => {
    const repoRoot = makeBoundaryFixture({ withConfig: false, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
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

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.output).toContain('Import boundaries');
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('depcruise'))).toBe(true);
  });
});

/**
 * Runs the real `runRawIoTaint` and `runStaticAnalysis` against temp fixtures on disk with an injected
 * runner. The taint check is a dataflow rule that dependency-cruiser cannot express, so it runs Semgrep.
 * The leg runs only when the repo commits `.semgrep/no-raw-io-into-core.yml`. A missing ruleset, an
 * absent engine, or an engine error gives an advisory SKIP, not a FAIL. The exit code of the runner
 * decides the verdict, so the fixture ruleset only has to exist on disk.
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
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('RawIoTaint_EngineAbsent_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => {
      throw new Error('semgrep: command not found');
    });

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
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
    expect(result.detail ?? '').toContain('invalid rule schema');
  });

  /**
   * Only exit 1 fails the leg. A negative exit code from a killed engine is inconclusive, so the leg
   * skips with a generic label when stderr is empty.
   */
  it('RawIoTaint_SignalDeathNegativeExit_SkipsNotFail', () => {
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: -9,
      stdout: '',
      stderr: '',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.detail ?? '').toMatch(/inconclusive \(exit -9\)/);
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
    expect(result.detail ?? '').toContain('ENOENT');
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
