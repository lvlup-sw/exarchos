import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runStaticAnalysis,
  FAIL_DETAIL_MAX_LINES,
  FAIL_DETAIL_MAX_FILES,
} from '../../../../src/verbs/pure/static-analysis.js';
import type { StaticAnalysisResult, RunCommandFn } from '../../../../src/verbs/pure/static-analysis.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

describe('runStaticAnalysis', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-analysis-test-'));
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

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

  function successRunner(): RunCommandFn {
    return vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));
  }

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

    /**
     * An undeclared script skips its check, and a skipped check stops a PASS.
     * So the test declares all three scripts.
     */
    it('output shows PASS markers for passing checks', () => {
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

  describe('skip flags', () => {
    /**
     * A check that did not run is not evidence of a pass. So with `skipLint`,
     * lint does not run and the result is `skip`, not PASS.
     */
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

      expect(result.status).toBe('skip');
      expect(result.skipReason).toBe('constituent-skipped');
      expect(result.output).toContain('SKIP');
      expect(result.output).not.toContain('Result: PASS');
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

  describe('missing npm scripts', () => {
    /**
     * A missing script skips its check and does not fail it. The result is
     * `skip`, because one check that ran cannot make a clean pass.
     */
    it('missing script in package.json degrades the aggregate (DR-6)', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
      });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

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

      expect(result.status).not.toBe('pass');
      expect(result.status).toBe('skip');
      expect(result.passCount).toBe(1);
      expect(result.failCount).toBe(0);
      expect(result.skipCount).toBe(2);
    });

    /** A positive control: the result is PASS when no check skips. */
    it('every declared script running clean still reaches PASS', () => {
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

  describe('warnings only', () => {
    /** The test declares all three scripts, so the warning output is the only variable. */
    it('warnings with exit 0 still passes', () => {
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

  describe('usage errors', () => {
    /** A directory with no recognized toolchain gives `skip`, so the gate cannot report a false pass. */
    it('empty directory with no project files returns skip (no applicable toolchain)', () => {
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

      expect(result.output).toMatch(/\d+\/\d+ checks passed/);
    });
  });

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

    /** With no toolchain, the result is `skip`, not `pass`. */
    it('unrecognized project type returns pass with no checks', () => {
      const repoRoot = createProjectDir({ 'README.md': '# Hello' });

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: successRunner(),
      });

      expect(result.status).toBe('skip');
      expect(result.projectType).toBeUndefined();
      expect(result.passCount).toBe(0);
      expect(result.failCount).toBe(0);
    });

    it('runStaticAnalysis_NoToolchainDetected_ReturnsSkipStatus', () => {
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
      const repoRoot = createProjectDir({
        'Cargo.toml': '[package]',
      });
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

  /**
   * The FAIL detail keeps the first `FAIL_DETAIL_MAX_LINES` lines and states the
   * total line count. A breakdown names the failing files, up to
   * `FAIL_DETAIL_MAX_FILES` files.
   */
  describe('DR-7a FAIL-detail cap', () => {
    /**
     * The transcript names no files, so the test covers only the line cap, the
     * total count, and the re-run steer.
     */
    it('checkStaticAnalysis_FailWith500Lines_TruncatesWithCountAndSteering', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

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

      expect(result.output).toContain('ESLint problem number 0');
      expect(result.output).toContain(
        `ESLint problem number ${FAIL_DETAIL_MAX_LINES - 1}`,
      );
      expect(result.output).not.toContain(
        `ESLint problem number ${FAIL_DETAIL_MAX_LINES}`,
      );
      expect(result.output).not.toContain(`ESLint problem number ${totalLines - 1}`);

      expect(result.output).toContain(String(totalLines));
      expect(result.output).toContain(`of ${totalLines} lines`);

      expect(result.output).toContain('Re-run `npm run lint`');
      expect(result.output).toContain('full output');
    });

    /**
     * 49 alpha lines and 1 beta line fill the 50-line head, so the 20 gamma
     * lines are past the cap. The breakdown must still name gamma with its full
     * count.
     */
    it('checkStaticAnalysis_CappedFailDetail_IncludesEveryFailingFile', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

      const lines: string[] = [];
      for (let i = 1; i <= 49; i++) {
        lines.push(`src/alpha.ts(${i},1): error TS2322: type error`);
      }
      lines.push('src/beta.ts(1,1): error TS2345: bad arg');
      for (let i = 1; i <= 20; i++) {
        lines.push(`src/gamma.ts(${i},1): error TS2531: possibly null`);
      }
      const stderr = lines.join('\n');

      const result = runStaticAnalysis({
        repoRoot,
        runCommand: failingRunner({ typecheck: { stderr } }),
      });

      expect(result.status).toBe('fail');

      expect(result.output).not.toContain('src/gamma.ts(1,1)');
      expect(result.output).toContain('src/gamma.ts: 20');
      expect(result.output).toContain('src/alpha.ts: 49');
      expect(result.output).toContain('src/beta.ts: 1');
      expect(result.output).toContain('Failing files (3)');
    });

    /**
     * 30 files with two lines each pass the line cap. The breakdown lists only
     * the first `FAIL_DETAIL_MAX_FILES` files and states how many it leaves out.
     * The total file count stays correct.
     */
    it('checkStaticAnalysis_ManyFailingFiles_CapsBreakdownWithElidedCount', () => {
      const repoRoot = createPackageJson({
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      });

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
      expect(result.output).toContain(`Failing files (${fileCount})`);
      expect(result.output).toContain(
        `…and ${fileCount - FAIL_DETAIL_MAX_FILES} more files.`,
      );
      expect(result.output).toContain('src/file01.ts: 2');
      expect(result.output).not.toContain('src/file30.ts');
    });
  });
});
