// ─── Static Analysis Action Tests ────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
// The boundary-lint leg (SIV-3 Layer A, task 027) is exercised below against
// the REAL implementation. The module-level mock stubs only `runStaticAnalysis`
// (the handler tests inject canned results); every other export — including
// `runBoundaryLint` — is passed through via `importActual`, so the boundary
// tests drive genuine filesystem + runner behaviour without un-mocking the
// handler suite.
import {
  runBoundaryLint,
  runRawIoTaint,
  type BoundaryLintResult,
  type RawIoTaintResult,
  type RunCommandFn,
  type StaticAnalysisInput,
  type StaticAnalysisResult,
} from './pure/static-analysis.js';

// The integration test below needs the REAL `runStaticAnalysis` (the module
// mock replaces the imported binding with a stub). Resolve the un-mocked
// implementation via importActual once for the whole file.
let realRunStaticAnalysis: (input: StaticAnalysisInput) => StaticAnalysisResult;

// ─── Mock the pure TS static analysis module ────────────────────────────────

const mockRunStaticAnalysis = vi.fn();

vi.mock('./pure/static-analysis.js', async (importActual) => {
  const actual = await importActual<typeof import('./pure/static-analysis.js')>();
  return {
    ...actual,
    runStaticAnalysis: (...args: unknown[]) => mockRunStaticAnalysis(...args),
  };
});

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../views/tools.js', () => ({
  getOrCreateMaterializer: () => ({}),
}));

import { handleStaticAnalysis } from './static-analysis.js';

const STATE_DIR = '/tmp/test-static-analysis';

// ─── Test Helpers ────────────────────────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleStaticAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('handleStaticAnalysis_MissingFeatureId_ReturnsError', async () => {
      // Arrange
      const args = { featureId: '' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
    });
  });

  // ─── All Checks Passing ────────────────────────────────────────────────

  describe('all checks passing', () => {
    it('handleStaticAnalysis_AllChecksPassing_ReturnsPassed', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
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

  // ─── Errors Found ─────────────────────────────────────────────────────

  describe('errors found', () => {
    it('handleStaticAnalysis_ErrorsFound_ReturnsFailWithFindings', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makeFailingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
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

  // ─── Gate Event Emission ──────────────────────────────────────────────

  describe('gate event emission', () => {
    it('handleStaticAnalysis_EmitsGateExecutedEvent', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      expect(appendCall[0]).toBe('feat-1');
      const event = appendCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.gateName).toBe('static-analysis');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(true);
      expect(event.data.details).toEqual({
        dimension: 'D2',
        phase: 'delegate',
        passCount: 2,
        failCount: 0,
      });
    });
  });

  // ─── Phase in Gate Event Details ──────────────────────────────────────

  describe('phase in gate event details', () => {
    it('handleStaticAnalysis_EmitsGateEvent_IncludesPhaseInDetails', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      const event = appendCall[1] as {
        type: string;
        data: {
          details: Record<string, unknown>;
        };
      };
      expect(event.data.details.phase).toBe('delegate');
    });
  });

  // ─── Error Status (e.g., no package.json) ──────────────────────────────

  describe('error status from analysis', () => {
    it('handleStaticAnalysis_ErrorStatus_ReturnsScriptError', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makeErrorResult());

      const args = { featureId: 'feat-1', repoRoot: '/nonexistent' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SCRIPT_ERROR');
      expect(result.error?.message).toContain('No package.json found');
    });
  });

  // ─── Skip Status (T-10: no-toolchain inconclusive) ───────────────────

  describe('skip status from analysis', () => {
    it('handleStaticAnalysis_SkipStatus_EmitsEventWithSkippedTrue', async () => {
      // Arrange: pure function reports skip / no-toolchain.
      mockRunStaticAnalysis.mockReturnValue(makeSkipResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/empty-repo' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert: handler returns success with passed=false + skipped=true.
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

      // Assert: gate.executed event reflects skip in details payload.
      expect(mockStore.append).toHaveBeenCalledTimes(1);
      const appendCall = mockStore.append.mock.calls[0];
      expect(appendCall[0]).toBe('feat-1');
      const event = appendCall[1] as {
        type: string;
        data: {
          gateName: string;
          layer: string;
          passed: boolean;
          details: Record<string, unknown>;
        };
      };
      expect(event.type).toBe('gate.executed');
      expect(event.data.gateName).toBe('static-analysis');
      expect(event.data.layer).toBe('quality');
      expect(event.data.passed).toBe(false);
      expect(event.data.details.dimension).toBe('D2');
      expect(event.data.details.skipped).toBe(true);
      expect(event.data.details.skipReason).toBe('no-toolchain');
    });
  });

  // ─── Skip Flags ───────────────────────────────────────────────────────

  describe('skip flags', () => {
    it('handleStaticAnalysis_SkipFlags_PassedToFunction', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = {
        featureId: 'feat-1',
        repoRoot: '/home/user/project',
        skipLint: true,
        skipTypecheck: true,
      };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
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

  // ─── Worktree-aware repoRoot resolution (#1330 / T-04) ──────────────────

  describe('worktree-aware repoRoot resolution', () => {
    it('CheckStaticAnalysis_DiffOnlyInWorktree_RunsTscAgainstWorktree', async () => {
      // Arrange: the agent's diff lives in a worktree path distinct from the
      // orchestrator's process.cwd(). Passing that path as repoRoot must make
      // the gate run tsc (via the injected runCommand cwd) against the worktree,
      // NOT against process.cwd() which lacks the agent's changes (#1330).
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-feat-1';
      expect(worktreePath).not.toBe(process.cwd());

      const args = { featureId: 'feat-1', repoRoot: worktreePath };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert: the pure analysis (which forwards repoRoot as the runCommand
      // cwd) was invoked against the worktree path.
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    it('CheckStaticAnalysis_RepoRootAuto_ResolvesWorktreePathArg', async () => {
      // Arrange: repoRoot: 'auto' with an explicit worktreePath arg resolves to
      // the worktree path (the preferred resolver seam for T-05).
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      const worktreePath = '/home/user/.worktrees/agent-feat-1';

      const args = {
        featureId: 'feat-1',
        repoRoot: 'auto' as const,
        worktreePath,
      };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    it('CheckStaticAnalysis_RepoRootAuto_ResolvesFromWorktreeCreatedEvent', async () => {
      // Arrange: repoRoot: 'auto' with no worktreePath arg falls back to the
      // latest worktree.created event recorded for taskId on the feature stream.
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

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(worktreePath);
    });

    it('CheckStaticAnalysis_RepoRootAuto_Unresolvable_ReturnsError', async () => {
      // Arrange: 'auto' with neither a worktreePath arg nor a worktree.created
      // event is unresolvable — must error rather than silently falling back to
      // process.cwd() (the #1330 coin-flip we are eliminating).
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());
      mockStore.query.mockResolvedValue([]);

      const args = { featureId: 'feat-1', repoRoot: 'auto' as const, taskId: 'task-9' };

      // Act
      const result = await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(mockRunStaticAnalysis).not.toHaveBeenCalled();
    });

    it('CheckStaticAnalysis_NoRepoRoot_DefaultsToProcessCwd', async () => {
      // Arrange: regression guard — omitting repoRoot keeps the existing
      // process.cwd() default for non-delegation callers.
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(process.cwd());
    });
  });

  // ─── runCommand adapter is passed ──────────────────────────────────────

  describe('runCommand adapter', () => {
    it('handleStaticAnalysis_PassesRunCommandAdapter', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockRunStaticAnalysis).toHaveBeenCalledTimes(1);
      const callArgs = mockRunStaticAnalysis.mock.calls[0][0] as {
        runCommand: unknown;
      };
      expect(typeof callArgs.runCommand).toBe('function');
    });
  });
});

// ─── SIV-3 Layer A: dependency-cruiser import-boundary leg (task 027) ────────
//
// Decision (made at plan time): the boundary lint rides on dependency-cruiser,
// NOT eslint-plugin-boundaries — this repo carries no ESLint infrastructure,
// so a standalone CLI (`npx depcruise --validate`) rides the static-analysis
// gate cleanly without dragging in an ESLint toolchain. Layer B (taint /
// "no raw IO into core") is explicitly DEFERRED; for non-TS workloads the
// degrade path is Semgrep/CodeQL (see the runBoundaryLint JSDoc).
//
// These tests drive the REAL `runBoundaryLint` (passed through the module
// mock via importActual) against on-disk temp fixtures with an injected
// runner, mirroring the pure-module fixture idioms. The leg's verdict is
// PASS / FAIL / SKIP, never a hard throw — SKIP is the INV-4 degrade when no
// `.dependency-cruiser.cjs` is present, exactly like the gate's existing
// "no lint script" SKIP.
describe('runBoundaryLint — import-boundary leg (SIV-3 Layer A, task 027)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('./pure/static-analysis.js')>(
      './pure/static-analysis.js',
    );
    realRunStaticAnalysis = actual.runStaticAnalysis;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-lint-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a fixture project with a `.dependency-cruiser.cjs` forbidding
   * `domain-core → io-adapters` imports. When `withViolation` is set, the
   * domain-core module imports the io-adapter (the rule must fail); otherwise
   * the import is omitted (the rule must pass).
   */
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

  it('StaticAnalysis_CoreImportsIOAdapter_BoundaryRuleFails', () => {
    // A real config forbidding domain-core → io-adapters plus a violating
    // import: depcruise exits non-zero, so the boundary leg must FAIL and
    // surface the broken rule.
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: '',
      stderr: "error no-core-to-io: src/domain-core/order.js → src/io-adapters/db.js\n",
    }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('no-core-to-io');
    // The injected runner was actually invoked with depcruise --validate.
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const [cmd, cmdArgs] = calls[0] as [string, string[]];
    expect(cmd).toBe('npx');
    expect(cmdArgs).toContain('depcruise');
    expect(cmdArgs).toContain('--validate');
  });

  it('StaticAnalysis_CompliantImports_Passes', () => {
    // Same config, no violating import: depcruise exits 0, leg PASSes.
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('PASS');
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
  });

  it('StaticAnalysis_NoBoundaryConfig_LegSkippedAdvisory', () => {
    // No `.dependency-cruiser.cjs` in repoRoot → the leg SKIPs (advisory),
    // exactly like the gate's existing "no lint script" SKIP. INV-4 degrade
    // discipline: a missing config is never a hard failure, and depcruise is
    // not even invoked.
    const repoRoot = makeBoundaryFixture({ withConfig: false, withViolation: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: BoundaryLintResult = runBoundaryLint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    // depcruise must NOT run when there is no config to validate against.
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('StaticAnalysis_BoundaryConfigPresent_FoldsLegIntoFullReport', () => {
    // Integration: when a real `.dependency-cruiser.cjs` is on disk, the full
    // runStaticAnalysis report folds the boundary leg into its output and
    // pass/fail counts. (Exercises the REAL runStaticAnalysis via importActual
    // — distinct from the handler suite above, which mocks it.)
    const repoRoot = makeBoundaryFixture({ withConfig: true, withViolation: false });
    // Make it a Node project so the gate has a recognized toolchain to run.
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { lint: 'eslint .' } }),
      'utf-8',
    );

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.output).toContain('Import boundaries');
    // The boundary leg is counted as a passing check, so depcruise ran.
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('depcruise'))).toBe(true);
  });
});

// ─── SIV-3 Layer B: boundary-parse "no raw IO into core" taint leg (#1529) ──
//
// Layer B is a DATAFLOW concern dependency-cruiser cannot express, so it rides
// its own resolved engine (Semgrep) over a committed taint ruleset. The leg
// follows Layer A's INV-4 degrade discipline exactly: it runs ONLY when a repo
// opts in by committing `.semgrep/no-raw-io-into-core.yml`, and a missing
// ruleset OR an absent/erroring engine yields an advisory SKIP, never a hard
// FAIL. The committed ruleset (not this module) encodes both halves of the
// invariant: raw IO not crossing a registered parser, AND downstream
// `as Brand`/`as any` casts. These tests drive the REAL `runRawIoTaint` and the
// REAL `runStaticAnalysis` against on-disk temp fixtures with an injected runner.
describe('runRawIoTaint — boundary-parse taint leg (SIV-3 Layer B, #1529)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('./pure/static-analysis.js')>(
      './pure/static-analysis.js',
    );
    realRunStaticAnalysis = actual.runStaticAnalysis;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-leg-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a fixture project, optionally with a committed taint ruleset. The
   * ruleset body is illustrative — the leg's behaviour is driven by the injected
   * runner's exit code, so the ruleset only needs to exist on disk to flip the
   * leg from SKIP to active. The example encodes both halves of the invariant.
   */
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
          '    paths: { include: ["src/core/**"] }',
          '    pattern-either:',
          '      - pattern: JSON.parse(...)',
          '      - pattern: $RES.json()',
          '      - pattern: $REQ.body',
          '      - pattern: fs.read$ANY(...)',
          '  - id: no-out-of-band-brand-cast',
          '    languages: [typescript]',
          '    severity: ERROR',
          '    message: out-of-band cast forges a branded type; route through a registered parser',
          '    paths: { include: ["src/core/**"] }',
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
    // Ruleset present, semgrep reports findings (exit 1): the leg FAILs and
    // surfaces the finding summary.
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: 'src/core/order.ts:3 no-raw-io-into-core: JSON.parse not crossing a parser\n',
      stderr: '',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('no-raw-io-into-core');
    // The injected runner ran semgrep --error --config <ruleset>.
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const [cmd, cmdArgs] = calls[0] as [string, string[]];
    expect(cmd).toBe('semgrep');
    expect(cmdArgs).toContain('--config');
    expect(cmdArgs).toContain('.semgrep/no-raw-io-into-core.yml');
  });

  it('RawIoTaint_DownstreamBrandCast_Flags', () => {
    // The second half of the invariant — an out-of-band `as Brand`/`as any`
    // cast downstream — is encoded in the same ruleset, so a finding (exit 1)
    // FAILs the leg identically. (The runner stands in for semgrep matching the
    // no-out-of-band-brand-cast rule.)
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: 'src/core/order.ts:7 no-out-of-band-brand-cast: `x as any` forges a branded type\n',
      stderr: '',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('FAIL');
    expect(result.detail ?? '').toContain('no-out-of-band-brand-cast');
  });

  it('RawIoTaint_AllInputsCrossRegisteredParser_Passes', () => {
    // Ruleset present, semgrep finds nothing (exit 0): the leg PASSes.
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('PASS');
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('RawIoTaint_NoRuleset_LegSkippedAdvisory', () => {
    // No committed `.semgrep/no-raw-io-into-core.yml` → advisory SKIP. The
    // engine is NOT invoked: a repo that has not adopted the parse-at-edge
    // convention is simply not subject to the leg (INV-4 degrade).
    const repoRoot = makeTaintFixture({ withRuleset: false });

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('RawIoTaint_EngineAbsent_SkipsNotFail', () => {
    // Ruleset present but the engine throws (not installed / unresolvable):
    // degrade to SKIP, never a hard FAIL.
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => {
      throw new Error('semgrep: command not found');
    });

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    expect(result.detail ?? '').toContain('not available');
  });

  it('RawIoTaint_EngineConfigError_SkipsNotFail', () => {
    // Exit ≥2 = semgrep engine/config error (e.g. a malformed ruleset). This is
    // inconclusive, not a boundary violation → SKIP, honoring the same degrade
    // discipline as a missing tool.
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 2,
      stdout: '',
      stderr: 'semgrep: invalid rule schema\n',
    }));

    const result: RawIoTaintResult = runRawIoTaint({ repoRoot, runCommand: runner });

    expect(result.status).toBe('SKIP');
    // The engine's own error is surfaced as the skip detail (it falls back to a
    // generic 'engine/config error (exit ≥2)' label only when stderr is empty).
    expect(result.detail ?? '').toContain('invalid rule schema');
  });

  it('StaticAnalysis_TaintRulesetPresent_FoldsLegIntoFullReport', () => {
    // Integration: a committed ruleset makes the full runStaticAnalysis report
    // fold the taint leg into its output and counts. Drives the REAL
    // runStaticAnalysis via importActual. The runner returns exit 0 for every
    // invocation (lint/typecheck/depcruise/semgrep), so the suite PASSes and the
    // taint leg shows up as a counted check.
    const repoRoot = makeTaintFixture({ withRuleset: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { lint: 'eslint .' } }),
      'utf-8',
    );

    const runner: RunCommandFn = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.output).toContain('Boundary IO taint');
    // The taint leg actually invoked semgrep as part of the full report.
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => c[0] === 'semgrep')).toBe(true);
  });
});
