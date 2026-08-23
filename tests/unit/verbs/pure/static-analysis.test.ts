import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  runStaticAnalysis,
  execCommandRunner,
  FAIL_DETAIL_MAX_LINES,
  FAIL_DETAIL_MAX_FILES,
  CHECK_COMMAND_TIMEOUT_MS,
} from '../../../../src/verbs/pure/static-analysis.js';
import type {
  StaticAnalysisResult,
  RunCommandFn,
  ToolchainConfigSource,
} from '../../../../src/verbs/pure/static-analysis.js';
import { BUILTIN_TOOLCHAINS, type ConfigToolchain } from '../../../../src/config/toolchains.js';

/** A loaded `.exarchos.yml` carrying just the `toolchains:` block. */
function configWithToolchains(toolchains: readonly ConfigToolchain[]): ToolchainConfigSource {
  return { config: { toolchains } };
}

describe('runStaticAnalysis', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-analysis-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // FIXTURE HELPERS
  // ============================================================

  /**
   * Create a package.json with specified npm scripts.
   */
  function createPackageJson(scripts: Record<string, string>): string {
    const repoRoot = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'test-repo', scripts }, null, 2),
      'utf-8'
    );
    return repoRoot;
  }

  /**
   * Create a RunCommandFn mock that always succeeds.
   */
  function successRunner(): RunCommandFn {
    return vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));
  }

  /**
   * Create a RunCommandFn mock that fails for specific scripts.
   */
  function failingRunner(failOn: Record<string, { stderr: string }>): RunCommandFn {
    return vi.fn((cmd: string, args: readonly string[]) => {
      const argsStr = args.join(' ');
      for (const [scriptName, response] of Object.entries(failOn)) {
        if (argsStr.includes(scriptName)) {
          return { exitCode: 1, stdout: '', stderr: response.stderr };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  }

  // ============================================================
  // ALL CHECKS PASS
  // ============================================================

  describe('all checks pass', () => {
    it('returns pass when all tools succeed', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'quality-check': 'echo quality',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('pass');
      expect(result.failCount).toBe(0);
    });

    it('output contains markdown heading', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.output).toContain('## Static Analysis Report');
    });

    it('output shows PASS markers for passing checks', () => {
      // `quality-check` must be declared too — an undeclared
      // constituent SKIPs, and a skipped constituent degrades the aggregate
      // off PASS. This test is about the PASS markers, so declare all three.
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'quality-check': 'echo quality',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.output).toContain('PASS');
      expect(result.output).toContain('Result: PASS');
    });
  });

  // ============================================================
  // LINT FAILS
  // ============================================================

  describe('lint fails', () => {
    it('returns fail when lint exits non-zero', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({
          lint: { stderr: 'error: ESLint found problems' },
        }),
      });

      expect(result.status).toBe('fail');
      expect(result.failCount).toBeGreaterThan(0);
    });

    it('output shows FAIL for lint', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({
          lint: { stderr: 'error: ESLint found problems' },
        }),
      });

      expect(result.output).toContain('FAIL');
      expect(result.output).toContain('Lint');
    });
  });

  // ============================================================
  // TYPECHECK FAILS
  // ============================================================

  describe('typecheck fails', () => {
    it('returns fail when typecheck exits non-zero', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({
          typecheck: { stderr: "error TS2322: Type 'string' is not assignable" },
        }),
      });

      expect(result.status).toBe('fail');
      expect(result.failCount).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // PARTIAL FAILURES (some pass, some fail)
  // ============================================================

  describe('partial failures', () => {
    it('lint fails but typecheck passes shows mixed results', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({
          lint: { stderr: 'lint errors' },
        }),
      });

      expect(result.status).toBe('fail');
      expect(result.passCount).toBeGreaterThan(0);
      expect(result.failCount).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // SKIP FLAGS
  // ============================================================

  describe('skip flags', () => {
    it('--skip-lint skips lint check even if it would fail', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'quality-check': 'echo quality',
      });

      const runner = failingRunner({
        lint: { stderr: 'should not run' },
      });

      const result = runStaticAnalysis({
        repoRoot,
        skipLint: true,
        runCommand: runner,
      });

      // Behavior change: this asserted `status === 'pass'`.
      // A `--skip-lint` flag means the lint check DID NOT RUN, and a check
      // that never ran is not evidence that it would have passed. The
      // aggregate is now DEGRADED/inconclusive, never PASS.
      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('constituent-skipped');
      expect(result.output).toContain('SKIP');
      expect(result.output).not.toContain('Result: PASS');
      // Lint should not have been invoked
      const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
      const lintCalled = calls.some(
        (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).some((a: string) => a.includes('lint'))
      );
      expect(lintCalled).toBe(false);
    });

    it('--skip-typecheck skips typecheck', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const result = runStaticAnalysis({
        repoRoot,
        skipTypecheck: true,
        runCommand: successRunner(),
      });

      expect(result.output).toContain('SKIP');
      expect(result.output).toMatch(/SKIP.*Typecheck/);
    });
  });

  // ============================================================
  // MISSING NPM SCRIPTS (should skip, not fail)
  // ============================================================

  describe('missing npm scripts', () => {
    it('missing script in package.json degrades the aggregate (DR-6)', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        // no typecheck, no quality-check
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      // Behavior change: this asserted `status === 'pass'`.
      // The missing scripts still SKIP the individual checks (they are not
      // failures), but the DIMENSION can no longer render as a clean pass off
      // the one check that actually ran.
      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('constituent-skipped');
      expect(result.skipCount).toBe(2);
      expect(result.output).toContain('SKIP');
      expect(result.output).toContain('Result: DEGRADED');
      expect(result.output).not.toContain('Result: PASS');
    });

    it('package.json with only lint cannot reach PASS on its own (DR-6)', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      // Behavior change: this asserted `status === 'pass'`.
      expect(result.status).not.toBe('pass');
      expect(result.status).toBe('skip');
      expect(result.passCount).toBe(1);
      expect(result.failCount).toBe(0);
      expect(result.skipCount).toBe(2);
    });

    it('every declared script running clean still reaches PASS', () => {
      // Positive control for the two degrade assertions above: PASS is reachable
      // — it is the SKIP, not the new tally, that degrades the aggregate.
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'quality-check': 'echo quality',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('pass');
      expect(result.skipCount).toBe(0);
      expect(result.output).toContain('Result: PASS');
    });
  });

  // ============================================================
  // WARNINGS ONLY (exit 0 with warning output)
  // ============================================================

  describe('warnings only', () => {
    it('warnings with exit 0 still passes', () => {
      // All three constituents declared so the only variable under test is the
      // warning output (an undeclared script would SKIP → degrade).
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'quality-check': 'echo quality',
      });

      const runner = vi.fn(() => ({
        exitCode: 0,
        stdout: '1 warning found',
        stderr: "warning: Unused variable 'x'",
      }));

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: runner,
      });

      expect(result.status).toBe('pass');
    });
  });

  // ============================================================
  // USAGE ERROR: missing repo root
  // ============================================================

  describe('usage errors', () => {
    it('empty directory with no project files returns skip (no applicable toolchain)', () => {
      // A no-toolchain repo produces a 'skip' (inconclusive) result so the
      // static-analysis gate cannot falsely-green a project that has no
      // recognized toolchain.
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      const result = runStaticAnalysis({
        repoRoot: emptyDir,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('no-toolchain');
      expect(result.projectType).toBeUndefined();
      expect(result.output).toContain('No recognized project type');
    });

    it('non-existent repo root returns error', () => {
      const result = runStaticAnalysis({
        repoRoot: path.join(tmpDir, 'nonexistent'),
        runCommand: successRunner(),
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('does not exist');
    });
  });

  // ============================================================
  // EXTERNAL TOOL NOT FOUND (graceful error)
  // ============================================================

  describe('external tool not found', () => {
    it('runner throwing error is treated as a failure', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const runner: RunCommandFn = vi.fn((cmd: string) => {
        throw new Error('ENOENT: command not found');
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: runner,
      });

      expect(result.status).toBe('fail');
      expect(result.output).toContain('FAIL');
    });
  });

  // ============================================================
  // STRUCTURED OUTPUT FORMAT
  // ============================================================

  describe('structured output', () => {
    it('output includes repository path', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.output).toContain(repoRoot);
    });

    it('output includes pass/total counts', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      // Should show something like "2/2 checks passed"
      expect(result.output).toMatch(/\d+\/\d+ checks passed/);
    });
  });

  // ============================================================
  // PLATFORM DETECTION — NON-NODE.JS PROJECTS
  // ============================================================

  describe('platform detection', () => {
    function createProjectDir(files: Record<string, string>): string {
      const repoRoot = path.join(tmpDir, 'project-' + Math.random().toString(36).slice(2));
      fs.mkdirSync(repoRoot, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(repoRoot, name), content, 'utf-8');
      }
      return repoRoot;
    }

    it('detects Node.js project and sets projectType', () => {
      const repoRoot = createPackageJson({ lint: 'eslint .' });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.projectType).toBe('Node.js');
    });

    it('.NET project (*.csproj) runs dotnet build', () => {
      const repoRoot = createProjectDir({ 'MyApp.csproj': '<Project />' });

      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot,
        runCommand: runner,
      });

      expect(result.status).toBe('pass');
      expect(result.projectType).toBe('.NET');
      expect(result.output).toContain('.NET');
      // Should call dotnet, not npm
      const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c: unknown[]) => c[0] === 'dotnet')).toBe(true);
      expect(calls.some((c: unknown[]) => c[0] === 'npm')).toBe(false);
    });

    it('.NET project (*.sln) is detected', () => {
      const repoRoot = createProjectDir({ 'MyApp.sln': '' });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.projectType).toBe('.NET');
    });

    it('.NET project (*.slnx) is detected and does not false-SKIP (#1507)', () => {
      const repoRoot = createProjectDir({ 'Dynatoi.slnx': '' });

      const runner = successRunner();
      const result = runStaticAnalysis({ repoRoot, runCommand: runner });

      expect(result.status).not.toBe('skip');
      expect(result.projectType).toBe('.NET');
      const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c: unknown[]) => c[0] === 'dotnet')).toBe(true);
    });

    it('Go project (go.mod) runs go vet', () => {
      const repoRoot = createProjectDir({ 'go.mod': 'module example.com/myapp' });

      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot,
        runCommand: runner,
      });

      expect(result.status).toBe('pass');
      expect(result.projectType).toBe('Go');
      const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c: unknown[]) => c[0] === 'go')).toBe(true);
    });

    it('Rust project (Cargo.toml) runs cargo check and clippy', () => {
      const repoRoot = createProjectDir({ 'Cargo.toml': '[package]\nname = "myapp"' });

      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot,
        runCommand: runner,
      });

      expect(result.status).toBe('pass');
      expect(result.projectType).toBe('Rust');
      const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c: unknown[]) => c[0] === 'cargo')).toBe(true);
    });

    it('unrecognized project type returns pass with no checks', () => {
      const repoRoot = createProjectDir({ 'README.md': '# Hello' });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      // No-toolchain resolves to 'skip' instead of 'pass' so the gate is
      // honestly inconclusive rather than falsely-green.
      expect(result.status).toBe('skip');
      expect(result.projectType).toBeUndefined();
      expect(result.passCount).toBe(0);
      expect(result.failCount).toBe(0);
    });

    // ─── SKIP status for unsupported toolchains ───────────────────────────

    it('runStaticAnalysis_NoToolchainDetected_ReturnsSkipStatus', () => {
      // A directory with no recognized project file (no package.json,
      // no *.csproj/*.sln, no go.mod, no Cargo.toml) should yield a
      // 'skip' status with skipReason='no-toolchain' rather than a
      // false-green 'pass'.
      const repoRoot = createProjectDir({ 'README.md': '# Empty repo' });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('no-toolchain');
      expect(result.projectType).toBeUndefined();
      expect(result.passCount).toBe(0);
      expect(result.failCount).toBe(0);
      // Output should announce SKIP, not PASS, in the result line.
      expect(result.output).toContain('Result: SKIP');
      expect(result.output).not.toContain('Result: PASS');
    });

    it('.NET project reports failure when dotnet build fails', () => {
      const repoRoot = createProjectDir({ 'MyApp.csproj': '<Project />' });

      const runner = failingRunner({ 'build': { stderr: 'error CS1002: ; expected' } });
      const result = runStaticAnalysis({
        repoRoot,
        runCommand: runner,
      });

      expect(result.status).toBe('fail');
      expect(result.failCount).toBeGreaterThan(0);
    });

    it('Node.js takes priority over other project files', () => {
      // A project with both package.json and Cargo.toml should be detected as Node.js
      const repoRoot = createProjectDir({
        'Cargo.toml': '[package]',
      });
      // Also add package.json
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({ name: 'hybrid', scripts: { lint: 'eslint .' } }),
        'utf-8',
      );

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.projectType).toBe('Node.js');
    });
  });

  // ============================================================
  // COMMANDS COME FROM THE TOOLCHAIN REGISTRY
  // ============================================================

  describe('registry-sourced commands', () => {
    function makeRepo(files: Record<string, string>): string {
      const repoRoot = path.join(tmpDir, 'reg-' + Math.random().toString(36).slice(2));
      fs.mkdirSync(repoRoot, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(repoRoot, name), content, 'utf-8');
      }
      return repoRoot;
    }

    /** What the registry declares for one toolchain, split into cmd + argv. */
    function declaredLint(toolchainId: string): { cmd: string; args: string[] } {
      const declared = BUILTIN_TOOLCHAINS.find((t) => t.id === toolchainId)?.commands.lint;
      // Denominator: the assertions below are about a command the registry
      // actually declares. If it stops declaring one, the test must say so
      // rather than compare against nothing.
      expect(declared, `the registry declares no lint command for '${toolchainId}'`).toBeTruthy();
      const [cmd = '', ...args] = String(declared).trim().split(/\s+/);
      return { cmd, args };
    }

    function spawns(runner: RunCommandFn): Array<{ cmd: string; args: string[] }> {
      return (runner as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => ({
        cmd: c[0] as string,
        args: [...(c[1] as string[])],
      }));
    }

    /** The lint spawn whose argv begins with what the registry declares. */
    function lintSpawnFor(
      runner: RunCommandFn,
      toolchainId: string,
    ): { cmd: string; args: string[] } | undefined {
      const declared = declaredLint(toolchainId);
      return spawns(runner).find(
        (c) =>
          c.cmd === declared.cmd &&
          c.args.slice(0, declared.args.length).join(' ') ===
            declared.args.join(' '),
      );
    }

    it('Commands_ComeFromTheRegistry_NotAPerLanguageSwitch', () => {
      // Go and Rust are the two supported toolchains whose linter the registry
      // declares. The gate must spawn that command — change the registry entry
      // and the gate follows, which is the whole point. A literal re-derived
      // here would keep passing its own hardcoded shape. The declaration is the
      // PREFIX of the spawn, not necessarily all of it: see the promotion test
      // below for what may follow it and why.
      for (const [id, marker, contents] of [
        ['go', 'go.mod', 'module example.com/myapp'],
        ['rust', 'Cargo.toml', '[package]\nname = "myapp"'],
      ] as const) {
        const runner = successRunner();
        runStaticAnalysis({ repoRoot: makeRepo({ [marker]: contents }), runCommand: runner });

        expect(
          lintSpawnFor(runner, id),
          `no spawn began with the registry's lint command for '${id}'`,
        ).toBeDefined();
      }
    });

    it('ClippyLeg_IsPromotedSoAFindingCanFailIt', () => {
      // Bare `cargo clippy` leaves almost every lint at `warn`, which exits 0.
      // A leg that cannot fail contributes a PASS while establishing nothing —
      // the same "green off no evidence" the whole gate exists to refuse — so
      // the declared linter is promoted to a denying one. This is the policy
      // the .NET leg already states in its own declaration with `-warnaserror`.
      const runner = successRunner();
      runStaticAnalysis({
        repoRoot: makeRepo({ 'Cargo.toml': '[package]\nname = "myapp"' }),
        runCommand: runner,
      });

      const clippy = spawns(runner).filter((c) => c.args.includes('clippy'));
      expect(clippy).toHaveLength(1);
      expect(clippy[0]?.args.slice(-3)).toEqual(['--', '-D', 'warnings']);
      // The registry's own declaration is still the head of the argv.
      expect(lintSpawnFor(runner, 'rust')).toBeDefined();
    });

    it('GoVetLeg_IsNotPromoted_BecauseItAlreadyFails', () => {
      // The promotion is a per-toolchain decision, not a blanket suffix. `go
      // vet` exits non-zero on what it reports, so appending anything to it
      // would be inventing a policy the toolchain does not need.
      const runner = successRunner();
      runStaticAnalysis({
        repoRoot: makeRepo({ 'go.mod': 'module example.com/myapp' }),
        runCommand: runner,
      });

      const vet = spawns(runner).filter((c) => c.cmd === declaredLint('go').cmd);
      expect(vet).toHaveLength(1);
      expect(vet[0]).toEqual(declaredLint('go'));
    });

    it('SupplementedLeg_SurvivesWhereTheRegistryDeclaresNothing', () => {
      // Rust's compile-only pass and .NET's build have no registry source, so
      // they stay declared here. Folding them away would silently drop a check.
      const rustRunner = successRunner();
      runStaticAnalysis({
        repoRoot: makeRepo({ 'Cargo.toml': '[package]\nname = "myapp"' }),
        runCommand: rustRunner,
      });
      expect(spawns(rustRunner)).toContainEqual({ cmd: 'cargo', args: ['check'] });

      const dotnetRunner = successRunner();
      runStaticAnalysis({
        repoRoot: makeRepo({ 'MyApp.csproj': '<Project />' }),
        runCommand: dotnetRunner,
      });
      expect(spawns(dotnetRunner)).toContainEqual({
        cmd: 'dotnet',
        args: ['build', '--no-restore', '-warnaserror'],
      });
    });

    it('NodeLegs_StayScriptIndirections_NotTheRegistryCommand', () => {
      // The registry's `tsc --noEmit` would run the compiler over the working
      // directory instead of the project the repository's own script targets,
      // and would bypass its package manager. Node keeps the script path.
      const runner = successRunner();
      runStaticAnalysis({
        repoRoot: createPackageJson({ lint: 'eslint .', typecheck: 'tsc --noEmit' }),
        runCommand: runner,
      });

      const calls = spawns(runner);
      // Named rather than quantified: a failing `every` reports only `false`,
      // and which command escaped the package manager is the whole finding.
      expect(
        calls.filter((c) => c.cmd !== 'npm').map((c) => c.cmd),
        'a script was spawned outside the package manager',
      ).toEqual([]);
      expect(calls.length, 'nothing was spawned, so the check above is vacuous').toBeGreaterThan(0);
      expect(calls).toContainEqual({ cmd: 'npm', args: ['run', 'typecheck'] });
      expect(calls.some((c) => c.cmd === 'tsc')).toBe(false);
    });

    it('PythonRepo_IsNotToldNoProjectType', () => {
      // The registry recognises Python perfectly well; it is this gate that has
      // no runner. Reporting "nothing recognised your project" sends the reader
      // looking for a missing marker that is right there.
      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot: makeRepo({ 'pyproject.toml': '[project]\nname = "app"' }),
        runCommand: runner,
      });

      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('no-toolchain');
      expect(result.projectType).toBe('Python');
      expect(result.output).not.toContain('No recognized project type');
      expect(result.output).toContain('Python');
      expect(result.output).toContain('no static-analysis runner');
      // Nothing was spawned: an unrunnable toolchain is not a half-run gate.
      expect(spawns(runner)).toEqual([]);
    });

    it('NothingDetected_EnumeratesEveryMarkerTheRegistryKnows', () => {
      // The old message listed only the four supported toolchains' markers, so
      // a reader could not tell "not recognised" from "not runnable".
      const result = runStaticAnalysis({
        repoRoot: makeRepo({ 'README.md': '# Hello' }),
        runCommand: successRunner(),
      });

      expect(result.status).toBe('skip');
      expect(result.projectType).toBeUndefined();
      expect(result.output).toContain('No recognized project type');
      for (const marker of BUILTIN_TOOLCHAINS.flatMap((t) => t.markers)) {
        expect(result.output).toContain(marker);
      }
    });
  });

  // ============================================================
  // BOUNDED WALL CLOCK
  // ============================================================

  describe('command timeout', () => {
    function makeRepo(files: Record<string, string>): string {
      const repoRoot = path.join(tmpDir, 'to-' + Math.random().toString(36).slice(2));
      fs.mkdirSync(repoRoot, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(repoRoot, name), content, 'utf-8');
      }
      return repoRoot;
    }

    it('TimeoutIsDeclared_NotDefaulted', () => {
      expect(CHECK_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);

      // Every spawn site, across the script path, the registry path, the
      // supplement path and the opt-in boundary leg. A site that forgot the
      // bound is the failure this catches.
      const repos = [
        createPackageJson({ lint: 'eslint .', typecheck: 'tsc --noEmit' }),
        makeRepo({ 'go.mod': 'module example.com/myapp' }),
        makeRepo({ 'Cargo.toml': '[package]\nname = "myapp"' }),
        makeRepo({ 'MyApp.csproj': '<Project />' }),
        makeRepo({
          'go.mod': 'module example.com/myapp',
          '.dependency-cruiser.cjs': 'module.exports = { forbidden: [] };',
        }),
      ];

      let totalCalls = 0;
      for (const repoRoot of repos) {
        const runner = successRunner();
        runStaticAnalysis({ repoRoot, runCommand: runner });

        const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length, `no command spawned for ${repoRoot}`).toBeGreaterThan(0);
        totalCalls += calls.length;
        for (const call of calls) {
          expect(call[2], `unbounded spawn: ${String(call[0])}`).toMatchObject({
            timeoutMs: CHECK_COMMAND_TIMEOUT_MS,
          });
        }
      }
      // Denominator: the loop above proves nothing if it inspected no calls.
      expect(totalCalls).toBeGreaterThanOrEqual(repos.length);
    });

    it('HungCommand_YieldsIndeterminate_NotAHang', () => {
      // A run the bound cut short reports through `spawnError`, which says the
      // exit code is not authoritative. The killed leg is inconclusive: it is
      // not evidence of a failure, and it is certainly not a pass.
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'quality-check': 'echo quality',
      });

      const runner: RunCommandFn = vi.fn((_cmd: string, args: readonly string[]) =>
        args.includes('typecheck')
          ? {
              exitCode: 1,
              stdout: '',
              stderr: '',
              spawnError: `killed after ${CHECK_COMMAND_TIMEOUT_MS}ms`,
            }
          : { exitCode: 0, stdout: '', stderr: '' },
      );

      const result = runStaticAnalysis({ repoRoot, runCommand: runner });

      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('constituent-skipped');
      expect(result.failCount).toBe(0);
      expect(result.skipCount).toBe(1);
      expect(result.output).toContain('SKIP');
      expect(result.output).toContain('killed after');
      expect(result.output).not.toContain('Result: PASS');
    });

    it('UnspawnableTool_Degrades_RatherThanReadingAsAFailure', () => {
      // Same channel, different cause: a linter that is not installed produced
      // no finding, so the leg is inconclusive rather than red.
      const repoRoot = makeRepo({ 'go.mod': 'module example.com/myapp' });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: vi.fn(() => ({
          exitCode: 127,
          stdout: '',
          stderr: '',
          spawnError: 'spawn go ENOENT',
        })),
      });

      expect(result.status).toBe('skip');
      expect(result.failCount).toBe(0);
      expect(result.output).toContain('spawn go ENOENT');
    });
  });

  // ============================================================
  // THE RUNNER THE GATE IS ACTUALLY COMPOSED WITH
  // ============================================================
  //
  // The degrades above are only worth anything if the runner production hands
  // this gate can produce their inputs. The handler's old adapter could not: it
  // dropped `timeoutMs` and never set `spawnError`, so every assertion about
  // either was proving a property of the test's own stub. These exercise the
  // real adapter against real child processes — no field is set by hand.

  describe('production command runner', () => {
    /** A binary that cannot exist, for the never-spawned path. */
    const ABSENT_BINARY = 'exarchos-no-such-binary-b7f3a1';

    it('ProductionRunner_ReportsARealExitCode_WithoutASpawnError', () => {
      // The denominator for everything below: a process that DID run must come
      // back as a verdict, or a runner that reported `spawnError` for every
      // outcome would satisfy the degrade tests while destroying the gate.
      const result = execCommandRunner(process.execPath, ['-e', 'process.exit(3)']);

      expect(result.exitCode).toBe(3);
      expect(result.spawnError).toBeUndefined();
    });

    it('ProductionRunner_CapturesStdout_OnSuccess', () => {
      const result = execCommandRunner(process.execPath, ['-e', 'process.stdout.write("ok")']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ok');
      expect(result.spawnError).toBeUndefined();
    });

    it('ProductionRunner_SetsSpawnError_WhenTheBinaryDoesNotExist', () => {
      const result = execCommandRunner(ABSENT_BINARY, []);

      expect(result.spawnError, 'the production runner never reports a spawn failure').toBeTruthy();
      expect(result.spawnError).toContain('ENOENT');
      expect(result.exitCode).not.toBe(0);
    });

    it('ProductionRunner_HonoursTimeoutMs_AndReportsTheKillAsNoVerdict', () => {
      // A bound the runner discards is a control that cannot run. This proves
      // the opposite two ways: the call returns far inside the child's own
      // lifetime, and the killed run is reported as no-verdict rather than as
      // a failing exit code.
      const started = Date.now();
      const result = execCommandRunner(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30000)'],
        { timeoutMs: 250 },
      );
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(15000);
      expect(result.spawnError, 'a killed run was reported as an authoritative exit').toBeTruthy();
    });

    it('SpawnFailure_FromTheProductionRunner_DegradesTheWholeGate', () => {
      // The composition end to end: the real adapter produces the field, the
      // gate reads it, and the aggregate refuses to call the result a pass.
      // Only the command NAME is substituted — nothing about the result is.
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        'quality-check': 'echo quality',
      });

      const runner: RunCommandFn = vi.fn((_cmd, _args, options) =>
        execCommandRunner(ABSENT_BINARY, [], options),
      );

      const result = runStaticAnalysis({ repoRoot, runCommand: runner, loadConfig: () => null });

      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('constituent-skipped');
      expect(result.failCount).toBe(0);
      expect(result.skipCount).toBe(3);
      expect(result.output).toContain('ENOENT');
      expect(result.output).not.toContain('Result: PASS');
    });

    it('ProductionRunner_IsWhatTheGateHandlerComposes', () => {
      // The seam the two tests above exercise has to be the seam production
      // uses. A second adapter in the handler would make every assertion here
      // a statement about an unused function.
      const handler = fs.readFileSync(
        fileURLToPath(new URL('../../../../src/verbs/gates/static-analysis.ts', import.meta.url)),
        'utf-8',
      );

      expect(handler).toContain("import { execCommandRunner, runStaticAnalysis } from '../pure/static-analysis.js'");
      expect(handler).toContain('runCommand: execCommandRunner');
      expect(handler, 'the handler declares a command runner of its own again').not.toMatch(
        /const\s+\w*[rR]unner\w*\s*:\s*RunCommandFn/,
      );
    });
  });

  // ============================================================
  // A GATE THAT RAN NOTHING IS NOT A GATE THAT PASSED
  // ============================================================

  describe('zero applicable checks', () => {
    it('ToolchainWithNoRunnableCommand_Skips_RatherThanPassing', () => {
      // `PASS (0/0 checks passed)` was reachable for any supported toolchain
      // whose declarations dried up: the tally saw an empty list, found no
      // failures and no skips, and rendered green. Zero legs is the strongest
      // possible case of "a check that never ran is not evidence it would
      // pass", so it lands on the same verdict.
      const repoRoot = path.join(tmpDir, 'silent-go');
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'go.mod'), 'module example.com/myapp', 'utf-8');

      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot,
        runCommand: runner,
        // A repository declaring `go` with no lint and no typecheck command is
        // the live route to an empty leg set; the built-in registry reaches the
        // same state the moment it stops declaring one.
        loadConfig: () => configWithToolchains([
          { id: 'go', projectType: 'Go', markers: ['go.mod'], commands: {} },
        ]),
      });

      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('constituent-skipped');
      expect(result.passCount).toBe(0);
      expect(result.failCount).toBe(0);
      expect(result.skipCount).toBe(1);
      expect(result.output).not.toContain('Result: PASS');
      expect(result.output).toContain('no lint and no typecheck command');
      // Nothing was spawned, which is exactly why nothing may be claimed.
      expect((runner as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('OneRunnableCommand_StillReachesPass', () => {
      // The kill-probe's other half: the skip above must come from the empty
      // set, not from the config path being present at all.
      const repoRoot = path.join(tmpDir, 'lint-only-go');
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'go.mod'), 'module example.com/myapp', 'utf-8');

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
        loadConfig: () => configWithToolchains([
          { id: 'go', projectType: 'Go', markers: ['go.mod'], commands: { lint: 'go vet ./...' } },
        ]),
      });

      expect(result.status).toBe('pass');
      expect(result.passCount).toBe(1);
    });
  });

  // ============================================================
  // THE `.exarchos.yml` TOOLCHAINS EXTENSION POINT
  // ============================================================

  describe('user-declared toolchains', () => {
    function makeRepo(files: Record<string, string>): string {
      const repoRoot = path.join(tmpDir, 'usr-' + Math.random().toString(36).slice(2));
      fs.mkdirSync(repoRoot, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(repoRoot, name), content, 'utf-8');
      }
      return repoRoot;
    }

    function spawns(runner: RunCommandFn): Array<{ cmd: string; args: string[] }> {
      return (runner as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => ({
        cmd: c[0] as string,
        args: [...(c[1] as string[])],
      }));
    }

    it('DeclaredToolchain_OverridesTheBuiltInCommands', () => {
      // The block is the sanctioned extension point and the test runtime
      // already honours it. This gate ignored it entirely, so a repository
      // could declare its linter, watch its tests use it, and have static
      // analysis run something else.
      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot: makeRepo({ 'Cargo.toml': '[package]\nname = "myapp"' }),
        runCommand: runner,
        loadConfig: () => configWithToolchains([
          {
            id: 'rust',
            projectType: 'Rust',
            markers: ['Cargo.toml'],
            commands: { lint: 'cargo clippy --all-targets' },
          },
        ]),
      });

      expect(result.status).toBe('pass');
      expect(spawns(runner)).toContainEqual({
        cmd: 'cargo',
        args: ['clippy', '--all-targets', '--', '-D', 'warnings'],
      });
    });

    it('DeclaredLintFlags_AreNotSecondGuessed', () => {
      // A declaration that already passes flags through to the compiler has
      // chosen its lint levels. Appending a second `--` would corrupt the argv
      // rather than harden it, so the promotion stands down.
      const runner = successRunner();
      runStaticAnalysis({
        repoRoot: makeRepo({ 'Cargo.toml': '[package]\nname = "myapp"' }),
        runCommand: runner,
        loadConfig: () => configWithToolchains([
          {
            id: 'rust',
            projectType: 'Rust',
            markers: ['Cargo.toml'],
            commands: { lint: 'cargo clippy -- -W clippy::pedantic' },
          },
        ]),
      });

      expect(spawns(runner)).toContainEqual({
        cmd: 'cargo',
        args: ['clippy', '--', '-W', 'clippy::pedantic'],
      });
    });

    it('DeclaredToolchain_WithAnUnknownId_IsRun_NotRefused', () => {
      // The gate's supported set exists to decide what a PARTIAL built-in
      // declaration should mean. A repository that names the commands itself
      // has already answered that, so refusing it would make the extension
      // point advisory.
      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot: makeRepo({ 'build.zig': 'pub fn build() void {}' }),
        runCommand: runner,
        loadConfig: () => configWithToolchains([
          {
            id: 'zig',
            projectType: 'Zig',
            markers: ['build.zig'],
            commands: { lint: 'zig fmt --check .' },
          },
        ]),
      });

      expect(result.status).toBe('pass');
      expect(result.projectType).toBe('Zig');
      expect(spawns(runner)).toContainEqual({ cmd: 'zig', args: ['fmt', '--check', '.'] });
    });

    it('NodeScriptIndirection_SurvivesAPartialOverride', () => {
      // Declaring node with only a test command must not cost the repository
      // its lint and typecheck legs — nothing about that declaration says how
      // to check it, so the script path still applies.
      const runner = successRunner();
      const result = runStaticAnalysis({
        repoRoot: createPackageJson({
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          'quality-check': 'echo quality',
        }),
        runCommand: runner,
        loadConfig: () => configWithToolchains([
          { id: 'node', projectType: 'Node.js', markers: ['package.json'], commands: { test: 'vitest run' } },
        ]),
      });

      expect(result.status).toBe('pass');
      expect(spawns(runner)).toContainEqual({ cmd: 'npm', args: ['run', 'lint'] });
    });

    it('UnreadableConfig_IsAnError_NotASilentlyIgnoredOne', () => {
      // A `.exarchos.yml` that will not load is not an absent one. Continuing
      // would mean running against a detection the operator did not ask for
      // and reporting the result as though nothing were wrong.
      const result = runStaticAnalysis({
        repoRoot: makeRepo({ 'go.mod': 'module example.com/myapp' }),
        runCommand: successRunner(),
        loadConfig: () => {
          throw new Error('Failed to parse .exarchos.yml at /repo/.exarchos.yml');
        },
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to parse .exarchos.yml');
    });
  });

  // ============================================================
  // DR-7a — FAIL-detail cap (counts-not-transcripts)
  // ============================================================

  describe('DR-7a FAIL-detail cap', () => {
    it('checkStaticAnalysis_FailWith500Lines_TruncatesWithCountAndSteering', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      // 500 lines of transcript with no file tokens — isolates the head-cap +
      // total-count + steering mechanism from the per-file breakdown.
      const totalLines = 500;
      const bigStderr = Array.from(
        { length: totalLines },
        (_, i) => `ESLint problem number ${i}`,
      ).join('\n');

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({ lint: { stderr: bigStderr } }),
      });

      expect(result.status).toBe('fail');

      // Head kept: the first line and the last kept line survive.
      expect(result.output).toContain('ESLint problem number 0');
      expect(result.output).toContain(
        `ESLint problem number ${FAIL_DETAIL_MAX_LINES - 1}`,
      );
      // Tail elided: the first dropped line and a far-tail line are gone.
      expect(result.output).not.toContain(
        `ESLint problem number ${FAIL_DETAIL_MAX_LINES}`,
      );
      expect(result.output).not.toContain(`ESLint problem number ${totalLines - 1}`);

      // Total count reported so the reader knows how much was elided.
      expect(result.output).toContain(String(totalLines));
      expect(result.output).toContain(`of ${totalLines} lines`);

      // Steering suffix points at the escape hatch (re-run for full output).
      expect(result.output).toContain('Re-run `npm run lint`');
      expect(result.output).toContain('full output');
    });

    it('checkStaticAnalysis_CappedFailDetail_IncludesEveryFailingFile', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      // 49 alpha lines + 1 beta line fill the 50-line head; 20 gamma lines then
      // appear ONLY beyond the cap, so triage would miss gamma without the
      // full-output per-file breakdown.
      const lines: string[] = [];
      for (let i = 1; i <= 49; i++) {
        lines.push(`src/alpha.ts(${i},1): error TS2322: type error`);
      }
      lines.push('src/beta.ts(1,1): error TS2345: bad arg');
      for (let i = 1; i <= 20; i++) {
        lines.push(`src/gamma.ts(${i},1): error TS2531: possibly null`);
      }
      const stderr = lines.join('\n'); // 70 lines total, gamma all past the cap

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({ typecheck: { stderr } }),
      });

      expect(result.status).toBe('fail');

      // gamma's raw transcript lines are dropped from the head…
      expect(result.output).not.toContain('src/gamma.ts(1,1)');
      // …yet gamma is still named with its complete count.
      expect(result.output).toContain('src/gamma.ts: 20');
      // In-head files carry per-file counts too.
      expect(result.output).toContain('src/alpha.ts: 49');
      expect(result.output).toContain('src/beta.ts: 1');
      // The complete set of distinct failing files is enumerated.
      expect(result.output).toContain('Failing files (3)');
    });

    it('checkStaticAnalysis_ManyFailingFiles_CapsBreakdownWithElidedCount', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      // 30 distinct files, 2 lines each (60 lines total), so the head cap
      // engages AND the per-file breakdown would list all 30 without a cap —
      // itself blowing the response budget the line cap protects.
      const fileCount = 30;
      const lines: string[] = [];
      for (let i = 1; i <= fileCount; i++) {
        const name = `src/file${String(i).padStart(2, '0')}.ts`;
        lines.push(`${name}(1,1): error TS2322: type error`);
        lines.push(`${name}(2,1): error TS2345: bad arg`);
      }

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({ typecheck: { stderr: lines.join('\n') } }),
      });

      expect(result.status).toBe('fail');
      // Total distinct-file count is still reported honestly…
      expect(result.output).toContain(`Failing files (${fileCount})`);
      // …but only the first FAIL_DETAIL_MAX_FILES are enumerated, with an
      // explicit elided-count line so the omission is perceivable.
      expect(result.output).toContain(
        `…and ${fileCount - FAIL_DETAIL_MAX_FILES} more files.`,
      );
      // The first file is shown; a folded-off file is absent entirely.
      expect(result.output).toContain('src/file01.ts: 2');
      expect(result.output).not.toContain('src/file30.ts');
    });
  });
});
