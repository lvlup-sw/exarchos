// ─── Static Analysis Action Tests ────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
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
} from '../pure/static-analysis.js';

// The integration test below needs the REAL `runStaticAnalysis` (the module
// mock replaces the imported binding with a stub). Resolve the un-mocked
// implementation via importActual once for the whole file.
let realRunStaticAnalysis: (input: StaticAnalysisInput) => StaticAnalysisResult;

// ─── Mock the pure TS static analysis module ────────────────────────────────

const mockRunStaticAnalysis = vi.fn();

vi.mock('../pure/static-analysis.js', async (importActual) => {
  const actual = await importActual<typeof import('../pure/static-analysis.js')>();
  return {
    ...actual,
    runStaticAnalysis: (...args: unknown[]) => mockRunStaticAnalysis(...args),
  };
});

// Carrier-focused legacy tests exercise the provider body. Durable proof
// behavior is covered against the real runner in ladder-gate-evidence.test.ts.
vi.mock('./durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<ToolResult>,
  ) => executeProvider(),
}));

// ─── Mock event store ────────────────────────────────────────────────────────

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

vi.mock('../../projections/views/tools.js', () => ({
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

  // ─── No legacy gate event emission ────────────────────────────────────

  describe('gate event emission', () => {
    it('handleStaticAnalysis_DoesNotEmitLegacyGateExecutedEvent', async () => {
      // Arrange
      mockRunStaticAnalysis.mockReturnValue(makePassingResult());

      const args = { featureId: 'feat-1', repoRoot: '/home/user/project' };

      // Act
      await handleStaticAnalysis(args, STATE_DIR, mockStore as unknown as EventStore);

      // Assert
      expect(mockStore.append).not.toHaveBeenCalled();
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

      expect(mockStore.append).not.toHaveBeenCalled();
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
      '../pure/static-analysis.js',
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
    // T-09 / DR-6: every constituent script must be declared — an undeclared
    // one SKIPs, and a skipped constituent now degrades the aggregate away
    // from 'pass'. This fixture is about the boundary leg, so it declares all
    // three to keep the aggregate reachable at PASS.
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
      '../pure/static-analysis.js',
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
    // Ruleset present, semgrep reports findings (exit 1): the leg FAILs and
    // surfaces the finding summary.
    const repoRoot = makeTaintFixture({ withRuleset: true });

    const runner: RunCommandFn = vi.fn(() => ({
      exitCode: 1,
      stdout: 'src/dispatch/core/order.ts:3 no-raw-io-into-core: JSON.parse not crossing a parser\n',
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
      stdout: 'src/dispatch/core/order.ts:7 no-out-of-band-brand-cast: `x as any` forges a branded type\n',
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
    // generic 'semgrep inconclusive (exit N)' label only when stderr is empty).
    expect(result.detail ?? '').toContain('invalid rule schema');
  });

  it('RawIoTaint_SignalDeathNegativeExit_SkipsNotFail', () => {
    // A signal-killed engine surfaced as a NEGATIVE exit code is inconclusive,
    // not a boundary violation — FAIL is reserved for exit 1 only, everything
    // else non-zero degrades to SKIP.
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

  it('RawIoTaint_RunnerReportsSpawnError_SkipsNotFail', () => {
    // The runner can report an unspawnable engine via `spawnError` instead of
    // throwing — and a coincidental `exitCode: 1` must NOT then read as a
    // boundary finding. The spawn-error guard takes precedence over the exit
    // code, degrading to SKIP (the same contract the integration-suite gate
    // honors, #1537).
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

  it('StaticAnalysis_TaintRulesetPresent_FoldsLegIntoFullReport', () => {
    // Integration: a committed ruleset makes the full runStaticAnalysis report
    // fold the taint leg into its output and counts. Drives the REAL
    // runStaticAnalysis via importActual. The runner returns exit 0 for every
    // invocation (lint/typecheck/depcruise/semgrep), so the suite PASSes and the
    // taint leg shows up as a counted check.
    const repoRoot = makeTaintFixture({ withRuleset: true });
    // T-09 / DR-6: declare every constituent script so no constituent SKIPs
    // and the aggregate can still reach PASS (this fixture is about the taint
    // leg, not about the skip-degrade rule).
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
    // The taint leg actually invoked semgrep as part of the full report.
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => c[0] === 'semgrep')).toBe(true);
  });
});

// ─── T-09 / DR-6: a skipped constituent check cannot render as PASS ─────────
//
// CHARACTERIZATION OF THE OLD BEHAVIOR (now deliberately changed):
//   `runStaticAnalysis` tallied only PASS and FAIL. A constituent that never
//   ran (no `lint` script, no `quality-check` script, or a `--skip-*` flag)
//   produced a `SKIP` line in the report that was invisible to the verdict.
//   With `total = passCount + failCount`, a repo whose only real check was
//   `typecheck` rendered `**Result: PASS** (2/2 checks passed)` — the exact
//   string DR-6 names — while lint and quality-check were silently skipped.
//   `status` was `failCount === 0 ? 'pass' : 'fail'`, so SKIP could never
//   move the aggregate off green.
//
// NEW CONTRACT (asserted below):
//   SKIP is tallied first-class. Precedence is FAIL ≻ DEGRADED ≻ PASS:
//   a real failure still dominates, otherwise ANY skipped constituent yields
//   `status:'skip'` + `skipReason:'constituent-skipped'` and a
//   `**Result: DEGRADED**` line. PASS is reachable only when every
//   constituent actually ran and passed.
describe('DR-6 — a skipped constituent renders DEGRADED, never PASS', () => {
  let tmpDir: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('./pure/static-analysis.js')>(
      '../pure/static-analysis.js',
    );
    realRunStaticAnalysis = actual.runStaticAnalysis;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr6-static-analysis-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A Node fixture declaring exactly the npm scripts given. */
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

  // ─── The aggregate cannot report PASS when a constituent was skipped ──────

  it('StaticAnalysis_LintScriptAbsent_DegradesAndCannotReportPass', () => {
    // The DR-6 defect verbatim: no `lint` and no `quality-check` script, a
    // passing `typecheck`. Old behavior: **Result: PASS** (n/n checks passed).
    const repoRoot = nodeFixture({ typecheck: 'tsc --noEmit' });

    const result = realRunStaticAnalysis({ repoRoot, runCommand: passRunner() });

    expect(result.status).not.toBe('pass');
    expect(result.status).toBe('skip');
    expect(result.skipReason).toBe('constituent-skipped');
    expect(result.skipCount).toBe(2); // Lint + Quality check
    expect(result.failCount).toBe(0);
    // The rendered dimension must not read as a clean pass.
    expect(result.output).not.toContain('Result: PASS');
    expect(result.output).toContain('Result: DEGRADED');
    expect(result.output).toContain("no 'lint' script in package.json");
  });

  it('StaticAnalysis_ConstituentSkippedByFlag_DegradesAndCannotReportPass', () => {
    // A `--skip-*` flag is still a check that did not run. The caller narrowed
    // the scope; that does not turn the unrun check into evidence of a pass.
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

  it('StaticAnalysis_EveryConstituentRanAndPassed_StillReportsPass', () => {
    // Positive control: PASS remains reachable — the degrade is caused by the
    // skip, not by the new tally. Without this, the DEGRADED assertions above
    // would also hold for a stub that never returns 'pass'.
    const repoRoot = nodeFixture(ALL_SCRIPTS);
    const runner = passRunner();

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('pass');
    expect(result.skipCount).toBe(0);
    expect(result.passCount).toBe(3);
    expect(result.output).toContain('Result: PASS');
    expect(result.output).not.toContain('Result: DEGRADED');

    // …and the declared `lint` script is actually INVOKED, not merely present.
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(
        (c: unknown[]) =>
          c[0] === 'npm' && Array.isArray(c[1]) && (c[1] as string[]).join(' ') === 'run lint',
      ),
    ).toBe(true);
  });

  it('StaticAnalysis_FailureAlongsideSkip_ReportsFailNotDegraded', () => {
    // Precedence: a real finding dominates the degrade so an operator sees the
    // failure first. DEGRADED must not mask a FAIL.
    const repoRoot = nodeFixture({ lint: 'eslint .', typecheck: 'tsc --noEmit' });

    const runner: RunCommandFn = vi.fn((_cmd: string, args: readonly string[]) =>
      args.join(' ') === 'run lint'
        ? { exitCode: 1, stdout: '', stderr: 'lint errors' }
        : { exitCode: 0, stdout: '', stderr: '' },
    );

    const result = realRunStaticAnalysis({ repoRoot, runCommand: runner });

    expect(result.status).toBe('fail');
    expect(result.failCount).toBe(1);
    expect(result.skipCount).toBe(1); // quality-check
    expect(result.output).toContain('Result: FAIL');
  });

  // ─── The handler carries the degrade to its callers ───────────────────────

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

  // ─── Indeterminate blocks protected promotion exactly as fail does ────────
  //
  // Trace: handleStaticAnalysis (passed:false + skipped:true)
  //   → gate-utils.normalizeGateVerdict  ⇒ 'indeterminate'
  //   → gate-runner records gate evidence with that verdict
  //   → admission/policy-evaluation.evaluateGate ⇒ indeterminate disposition
  //   → PolicyVerdict 'indeterminate'
  //   → admission/transition-command: phase advances ONLY under 'allow',
  //     so indeterminate leaves the phase UNCHANGED exactly as deny does.

  it('NormalizeGateVerdict_SkippedStaticAnalysis_IsIndeterminateNotPassOrFail', async () => {
    const { normalizeGateVerdict } = await import('./gate-utils.js');

    const skipped = normalizeGateVerdict({
      success: true,
      data: { passed: false, skipped: true, skipReason: 'constituent-skipped' },
    } as unknown as ToolResult);
    expect(skipped).toBe('indeterminate');

    // A real failure is still 'fail' — the skip branch must not swallow it.
    expect(
      normalizeGateVerdict({ success: true, data: { passed: false } } as unknown as ToolResult),
    ).toBe('fail');
    // …and a genuine pass is still 'pass'.
    expect(
      normalizeGateVerdict({ success: true, data: { passed: true } } as unknown as ToolResult),
    ).toBe('pass');
    // Deliberately narrow: the established skip-PASS advisory carriers
    // (`passed:true` + `skipped:true`) are untouched.
    expect(
      normalizeGateVerdict({
        success: true,
        data: { passed: true, skipped: true },
      } as unknown as ToolResult),
    ).toBe('pass');
  });

  it('AdmissionPolicy_IndeterminateGateEvidence_BlocksExactlyAsFailDoes', async () => {
    // Drives the REAL admission algebra (schema-parsed evidence, real
    // evaluatePolicy) — no hand-mock of the policy contract.
    const [{ AdmissionEvidenceV1Schema, AdmissionRequirementV1Schema }, authorityMod, policyMod] =
      await Promise.all([
        import('../../workflow/admission/types.js'),
        import('../../workflow/admission/policy-authority.js'),
        import('../../workflow/admission/policy-evaluation.js'),
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

    // A fail blocks…
    expect(onFail.verdict).not.toBe('allow');
    // …and an indeterminate blocks exactly the same way — never a
    // pass-with-a-warning, and (unlike a deny) not rescuable by a waiver even
    // though this obligation set is `waivable: true`.
    expect(onIndeterminate.verdict).not.toBe('allow');
    expect(onIndeterminate.verdict).toBe('indeterminate');
    expect(onIndeterminate.appliedWaiverIds).toEqual([]);
    // Control: only a real pass admits.
    expect(onPass.verdict).toBe('allow');
  });

  // ─── The `lint` script exists, is real, and can fail ──────────────────────

  it('RootPackageJson_DeclaresRealLintScript_NotANoOp', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'),
    ) as { scripts?: Record<string, string> };

    const lint = pkg.scripts?.['lint'];
    expect(lint, 'root package.json must declare a `lint` script (DR-6)').toBeTruthy();
    // It must invoke the linter this repo already carries (eslint + eslint.config.js),
    // not a no-op that can never fail.
    expect(lint).toContain('eslint');
    expect(lint).not.toMatch(/^\s*(echo|true|:|exit\s+0)\b/);
    expect(fs.existsSync(path.join(repoRoot, 'eslint.config.js'))).toBe(true);

    // The gate's other Node constituent must be declared too, or the repo's own
    // static-analysis dimension degrades forever (DR-6 applied to this repo).
    expect(pkg.scripts?.['quality-check']).toBeTruthy();
  });

  it('LintScript_ConfiguredEngine_ReportsViolationAsError', async () => {
    // Proves the `lint` script CAN fail: the repo's real eslint.config.js is
    // loaded and asked to lint a source that violates one of its rules. A
    // non-zero errorCount is exactly what makes `eslint` exit non-zero, which
    // is what the gate reads as FAIL.
    const { ESLint } = await import('eslint');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const eslint = new ESLint({ cwd: repoRoot });

    const violating = [
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('npm', ['run', 'lint']);",
      '',
    ].join('\n');
    const clean = 'export const ok = 1;\n';
    const filePath = path.join(repoRoot, 'servers/exarchos-mcp/src/dr6-lint-probe.ts');

    const bad = await eslint.lintText(violating, { filePath });
    const good = await eslint.lintText(clean, { filePath });

    expect(bad.reduce((n, r) => n + r.errorCount, 0)).toBeGreaterThan(0);
    // Control: the same config is clean on compliant source, so the failure
    // above is the rule firing, not a broken config.
    expect(good.reduce((n, r) => n + r.errorCount, 0)).toBe(0);
  }, 60_000);
});
