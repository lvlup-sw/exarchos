/**
 * Parity tests for `runStaticAnalysis` against the behavior of the retired `static-analysis-gate.sh` script.
 * The gate runs lint, typecheck, and quality-check through npm scripts. A missing script gives a SKIP.
 *
 * One case differs from the script on purpose. The script let a SKIP leave the result at PASS, so `PASS (2/2)` showed while checks did not run.
 * Now a SKIP counts, and the result degrades to `status: 'skip'`, `skipReason: 'constituent-skipped'`, and `**Result: DEGRADED**`.
 * The PASS case without a skip, the FAIL case, and the error case keep parity.
 *
 * The `node:fs` mock gives `readPackageJson` a `package.json` without disk access.
 * It also stubs `readdirSync`, because `detectToolchain` lists the directory for a glob marker.
 */
import { describe, it, expect, vi } from 'vitest';
import { runStaticAnalysis } from '../../../../src/verbs/pure/static-analysis.js';
import type { RunCommandFn, CommandResult } from '../../../../src/verbs/pure/static-analysis.js';

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
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  readdirSync: vi.fn(() => []),
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
  it('quality-check absent — DEGRADED, not PASS (2/2) (T-09 / DR-6)', () => {
    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'skip',
      skipReason: 'constituent-skipped',
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
        '**Result: DEGRADED** (2/2 checks passed, 1 skipped — inconclusive, not a pass)',
      ].join('\n'),
      passCount: 2,
      failCount: 0,
      skipCount: 1,
      projectType: 'Node.js',
    });
  });

  /** A FAIL wins over a SKIP, as in the script. */
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
      skipCount: 1,
      projectType: 'Node.js',
    });
  });

  it('skip lint — lint SKIP, typecheck passes, DEGRADED (T-09 / DR-6)', () => {
    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      skipLint: true,
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'skip',
      skipReason: 'constituent-skipped',
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
        '**Result: DEGRADED** (1/1 checks passed, 2 skipped — inconclusive, not a pass)',
      ].join('\n'),
      passCount: 1,
      failCount: 0,
      skipCount: 2,
      projectType: 'Node.js',
    });
  });

  it('skip typecheck — typecheck SKIP, lint passes, DEGRADED (T-09 / DR-6)', () => {
    expect(runStaticAnalysis({
      repoRoot: '/fake/repo',
      skipTypecheck: true,
      runCommand: makePassRunner(),
    })).toEqual({
      status: 'skip',
      skipReason: 'constituent-skipped',
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
        '**Result: DEGRADED** (1/1 checks passed, 2 skipped — inconclusive, not a pass)',
      ].join('\n'),
      passCount: 1,
      failCount: 0,
      skipCount: 2,
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
      skipCount: 0,
    });
  });
});

describe('quality-check path', () => {
  it('quality-check script present and passing — counted in totals', async () => {
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
      skipCount: 0,
      projectType: 'Node.js',
    });
  });
});
