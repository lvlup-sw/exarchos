import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runStaticAnalysis,
  FAIL_DETAIL_MAX_LINES,
  FAIL_DETAIL_MAX_FILES,
} from './static-analysis.js';
import type { StaticAnalysisResult, RunCommandFn } from './static-analysis.js';

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
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
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
      });

      const runner = failingRunner({
        lint: { stderr: 'should not run' },
      });

      const result = runStaticAnalysis({
        repoRoot,
        skipLint: true,
        runCommand: runner,
      });

      expect(result.status).toBe('pass');
      expect(result.output).toContain('SKIP');
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
    it('missing script in package.json skips that check', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        // no typecheck, no quality-check
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('pass');
      expect(result.output).toContain('SKIP');
    });

    it('package.json with only lint still passes when lint passes', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('pass');
    });
  });

  // ============================================================
  // WARNINGS ONLY (exit 0 with warning output)
  // ============================================================

  describe('warnings only', () => {
    it('warnings with exit 0 still passes', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
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
      // T-10: no-toolchain repos produce a 'skip' (inconclusive) result so
      // the static-analysis gate cannot falsely-green a project that has
      // no recognized toolchain. See DR-4 in
      // docs/plans/2026-05-04-v290-dogfood-bundle.md.
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

      // T-10: no-toolchain now resolves to 'skip' instead of 'pass' so the
      // gate is honestly inconclusive rather than falsely-green.
      expect(result.status).toBe('skip');
      expect(result.projectType).toBeUndefined();
      expect(result.passCount).toBe(0);
      expect(result.failCount).toBe(0);
    });

    // ─── T-10: SKIP status for unsupported toolchains ──────────────────────

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
      // itself blowing the DR-7 budget the line cap protects.
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
