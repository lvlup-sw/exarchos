import { describe, it, expect, vi } from 'vitest';
import { runStaticAnalysis } from './static-analysis.js';
import type { RunCommandFn, CommandResult } from './static-analysis.js';

/**
 * Behavioral parity tests for static-analysis.ts against the original
 * scripts/static-analysis-gate.sh bash script.
 *
 * Bash script behavior:
 *   - Runs lint, typecheck, quality-check via npm scripts
 *   - exit 0 → all checks pass, exit 1 → one or more fail
 *   - Missing scripts → SKIP (not counted in pass/fail totals)
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
    exitCode: 0, stdout: 'OK\n', stderr: '',
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
  it('all checks pass — PASS (2/2), quality-check SKIP (no script)', () => {
    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'pass',
      output: [
        '## Static Analysis Report',
        '',
        '**Repository:** `/fake/repo`',
        '**Project type:** Node.js',
        '',
        '- **PASS**: Lint',
        '- **PASS**: Typecheck',
        "- **SKIP**: Quality check — no 'quality-check' script in package.json",
        '',
        '---',
        '',
        '**Result: PASS** (2/2 checks passed)',
      ].join('\n'),
      passCount: 2,
      failCount: 0,
      projectType: 'Node.js',
    });
  });

  it('lint fail — FAIL (1/2), typecheck passes', () => {
    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      runCommand: makeLintFailRunner(),
    })).toEqual({
      status: 'fail',
      output: [
        '## Static Analysis Report',
        '',
        '**Repository:** `/fake/repo`',
        '**Project type:** Node.js',
        '',
        '- **FAIL**: Lint — Lint errors found',
        '- **PASS**: Typecheck',
        "- **SKIP**: Quality check — no 'quality-check' script in package.json",
        '',
        '---',
        '',
        '**Result: FAIL** (1/2 checks failed)',
      ].join('\n'),
      passCount: 1,
      failCount: 1,
      projectType: 'Node.js',
    });
  });

  it('skip lint — lint SKIP, typecheck passes, PASS (1/1)', () => {
    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      skipLint: true,
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'pass',
      output: [
        '## Static Analysis Report',
        '',
        '**Repository:** `/fake/repo`',
        '**Project type:** Node.js',
        '',
        '- **SKIP**: Lint — --skip-lint',
        '- **PASS**: Typecheck',
        "- **SKIP**: Quality check — no 'quality-check' script in package.json",
        '',
        '---',
        '',
        '**Result: PASS** (1/1 checks passed)',
      ].join('\n'),
      passCount: 1,
      failCount: 0,
      projectType: 'Node.js',
    });
  });

  it('skip typecheck — typecheck SKIP, lint passes, PASS (1/1)', () => {
    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      skipTypecheck: true,
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'pass',
      output: [
        '## Static Analysis Report',
        '',
        '**Repository:** `/fake/repo`',
        '**Project type:** Node.js',
        '',
        '- **PASS**: Lint',
        '- **SKIP**: Typecheck — --skip-typecheck',
        "- **SKIP**: Quality check — no 'quality-check' script in package.json",
        '',
        '---',
        '',
        '**Result: PASS** (1/1 checks passed)',
      ].join('\n'),
      passCount: 1,
      failCount: 0,
      projectType: 'Node.js',
    });
  });

  it('empty repoRoot — error status with "Missing repoRoot" message', () => {
    expect(runStaticAnalysis({
      repoRoot: '',
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'error',
      output: '',
      error: 'Missing repoRoot',
      passCount: 0,
      failCount: 0,
    });
  });
});

describe('quality-check path', () => {
  it('quality-check script present and passing — counted in totals', async () => {
    // Override the fs mock for this test to include quality-check
    const { readFileSync } = await import('node:fs');
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify({
        scripts: {
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          'quality-check': 'npm run test:quality',
        },
      })
    );

    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'pass',
      output: [
        '## Static Analysis Report',
        '',
        '**Repository:** `/fake/repo`',
        '**Project type:** Node.js',
        '',
        '- **PASS**: Lint',
        '- **PASS**: Typecheck',
        '- **PASS**: Quality check',
        '',
        '---',
        '',
        '**Result: PASS** (3/3 checks passed)',
      ].join('\n'),
      passCount: 3,
      failCount: 0,
      projectType: 'Node.js',
    });
  });
});
