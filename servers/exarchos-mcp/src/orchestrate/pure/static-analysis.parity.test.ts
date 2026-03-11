import { describe, it, expect, vi } from 'vitest';
import { runStaticAnalysis } from './static-analysis.js';
import type { RunCommandFn, CommandResult } from './static-analysis.js';

/**
 * Behavioral parity tests for static-analysis.ts against the original
 * scripts/static-analysis-gate.sh bash script.
 *
 * Bash script behavior:
 *   - exit 0 → all checks pass (lint PASS, typecheck PASS)
 *   - exit 1 → one or more checks fail (lint FAIL, typecheck PASS)
 *   - quality-check and phase-names are SKIP when scripts are absent
 */

// Mock node:fs so readPackageJson can resolve package.json without disk access
vi.mock('node:fs', () => ({
  readFileSync: vi.fn((_path: string) =>
    JSON.stringify({
      scripts: {
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      },
    })
  ),
  existsSync: vi.fn(() => true),
}));

function makePassRunner(): RunCommandFn {
  return (_cmd: string, _args: readonly string[], _options?: { cwd?: string }): CommandResult => ({
    exitCode: 0,
    stdout: 'OK\n',
    stderr: '',
  });
}

function makeLintFailRunner(): RunCommandFn {
  return (_cmd: string, args: readonly string[], _options?: { cwd?: string }): CommandResult => {
    const scriptName = args[1];
    if (scriptName === 'lint') {
      return { exitCode: 1, stdout: '', stderr: 'Lint errors found\n' };
    }
    return { exitCode: 0, stdout: 'OK\n', stderr: '' };
  };
}

describe('behavioral parity with static-analysis-gate.sh', () => {
  it('all checks pass — status pass with correct pass/fail counts', () => {
    const result = runStaticAnalysis({
      repoRoot: '/fake/repo',
      runCommand: makePassRunner(),
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.output).toContain('**Result: PASS** (2/2 checks passed)');
  });

  it('lint fail — status fail with 1 failure and 1 pass', () => {
    const result = runStaticAnalysis({
      repoRoot: '/fake/repo',
      runCommand: makeLintFailRunner(),
    });

    expect(result.status).toBe('fail');
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.output).toContain('**Result: FAIL** (1/2 checks failed)');
    expect(result.output).toContain('**FAIL**: Lint');
    expect(result.output).toContain('**PASS**: Typecheck');
  });

  it('skip lint — skipped lint does not count toward pass or fail totals', () => {
    const result = runStaticAnalysis({
      repoRoot: '/fake/repo',
      skipLint: true,
      runCommand: makePassRunner(),
    });

    expect(result.status).toBe('pass');
    // Only typecheck runs (quality-check has no script in our mock package.json...
    // actually our mock includes lint and typecheck but not quality-check, so
    // quality-check is also SKIP). Lint is explicitly skipped.
    // Only typecheck passes → passCount=1, failCount=0
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.output).toContain('**SKIP**: Lint');
  });

  it('skip typecheck — skipped typecheck does not count toward pass or fail totals', () => {
    const result = runStaticAnalysis({
      repoRoot: '/fake/repo',
      skipTypecheck: true,
      runCommand: makePassRunner(),
    });

    expect(result.status).toBe('pass');
    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.output).toContain('**SKIP**: Typecheck');
  });

  it('output contains structured markdown report with repository path', () => {
    const result = runStaticAnalysis({
      repoRoot: '/my/project',
      runCommand: makePassRunner(),
    });

    expect(result.output).toContain('## Static Analysis Report');
    expect(result.output).toContain('**Repository:** `/my/project`');
  });
});
