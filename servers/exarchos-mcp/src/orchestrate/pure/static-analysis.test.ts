import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runStaticAnalysis } from './static-analysis.js';
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
    it('empty directory with no project files returns pass (no applicable toolchain)', () => {
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      const result = runStaticAnalysis({
        repoRoot: emptyDir,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('pass');
      expect(result.projectType).toBeUndefined();
      expect(result.output).toContain('No recognized project type');
    });

    it('non-existent repo root returns pass (no applicable toolchain)', () => {
      const result = runStaticAnalysis({
        repoRoot: path.join(tmpDir, 'nonexistent'),
        runCommand: successRunner(),
      });

      expect(result.status).toBe('pass');
      expect(result.projectType).toBeUndefined();
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

      expect(result.status).toBe('pass');
      expect(result.projectType).toBeUndefined();
      expect(result.passCount).toBe(0);
      expect(result.failCount).toBe(0);
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
});
