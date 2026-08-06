// ─── WFQ-003: script-runner preamble tolerance ───────────────────────────────
//
// The gate invokes the suite through a script runner (`npm run test:run --
// --reporter=json`). npm writes its own preamble to the SAME stream the vitest
// JSON reporter writes to, so `JSON.parse(stdout)` threw and the gate failed
// closed with `parseError: true` on a GREEN suite (#1537).
//
// These tests pin the tolerance both at the pure-parser boundary and through a
// REAL spawned process, so a regression cannot hide behind a stubbed runner.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import { execCommandRunner } from '../check-integration-suite.js';
import { parseVitestResult, runIntegrationSuite } from './integration-suite.js';

/** A green vitest run: no failed tests, no failed suites. */
const GREEN_REPORT = JSON.stringify({
  numTotalTestSuites: 12,
  numPassedTestSuites: 12,
  numFailedTestSuites: 0,
  numTotalTests: 84,
  numPassedTests: 84,
  numFailedTests: 0,
  success: true,
  testResults: [{ name: '/repo/src/a.test.ts', status: 'passed', assertionResults: [{}] }],
});

/** A red vitest run with one silent load failure folded in (#1329 shape). */
const RED_REPORT = JSON.stringify({
  numTotalTestSuites: 12,
  numPassedTestSuites: 10,
  numFailedTestSuites: 2,
  numTotalTests: 84,
  numPassedTests: 81,
  numFailedTests: 3,
  success: false,
  testResults: [
    { name: '/repo/src/a.test.ts', status: 'failed', assertionResults: [{}, {}, {}] },
    { name: '/repo/src/broken.test.ts', status: 'failed', assertionResults: [] },
  ],
});

/**
 * The literal npm preamble shape: the `>` script echo lines, a workspace
 * banner, and a deprecation notice — all before the reporter blob.
 */
function npmWrapped(report: string): string {
  return [
    '',
    '> @lvlup-sw/exarchos@2.12.0-preview.3 test:run',
    '> vitest run --reporter=json',
    '',
    'npm warn config production Use `--omit=dev` instead.',
    '',
    report,
    '',
  ].join('\n');
}

describe('parseVitestResult preamble tolerance (WFQ-003)', () => {
  it('IntegrationSuite_NpmPreambleAroundGreenReport_ParsesAsPassed', () => {
    const parsed = parseVitestResult(npmWrapped(GREEN_REPORT));
    expect(parsed).not.toBeNull();
    expect(parsed?.passed).toBe(true);
    expect(parsed?.failCount).toBe(0);
    expect(parsed?.totalTests).toBe(84);
  });

  it('IntegrationSuite_NpmPreambleAroundRedReport_FoldsLoadFailures', () => {
    const parsed = parseVitestResult(npmWrapped(RED_REPORT));
    expect(parsed).not.toBeNull();
    expect(parsed?.passed).toBe(false);
    expect(parsed?.failedTests).toBe(3);
    expect(parsed?.loadFailures).toBe(1);
    expect(parsed?.failCount).toBe(4);
    expect(parsed?.loadFailureFiles).toEqual(['/repo/src/broken.test.ts']);
  });

  it('IntegrationSuite_TrailingRunnerNoise_StillParses', () => {
    const raw = `${GREEN_REPORT}\nnpm notice New minor version of npm available!\n`;
    expect(parseVitestResult(raw)?.passed).toBe(true);
  });

  it('IntegrationSuite_BraceInsideBannerString_DoesNotDerailScan', () => {
    const raw = `> vitest run --reporter=json {not json}\n${GREEN_REPORT}`;
    expect(parseVitestResult(raw)?.passed).toBe(true);
  });

  // Fail-closed semantics must survive the tolerance: an unrecognizable stream
  // is still a shape-mismatch, never a false green.
  it.each([
    ['bare array', '[]'],
    ['empty object', '{}'],
    ['bare number', '42'],
    ['pure banner noise', '> vitest run\nnpm warn something happened'],
    ['object without counters', 'preamble\n{"unrelated":true}\n'],
  ])('IntegrationSuite_%s_StillFailsClosed', (_label, raw) => {
    expect(parseVitestResult(raw)).toBeNull();
  });
});

describe('runIntegrationSuite through a real spawned runner (WFQ-003)', () => {
  it('IntegrationSuite_RealProcessWithPreamble_ReportsParseErrorFalse', () => {
    // A genuine child process that reproduces the npm-wrapped stream: banner
    // lines and the reporter blob interleaved on one stdout.
    const script =
      'process.stdout.write("\\n> pkg@1.0.0 test:run\\n> vitest run --reporter=json\\n\\n");' +
      `process.stdout.write(${JSON.stringify(RED_REPORT)});` +
      'process.stdout.write("\\nnpm notice trailing chatter\\n");' +
      'process.exit(1);';

    const result = runIntegrationSuite({
      repoRoot: process.cwd(),
      // The PRODUCTION runner, spawning a real child process whose stdout
      // interleaves banner lines with the reporter blob.
      runCommand: (_cmd, _args, options) =>
        execCommandRunner(process.execPath, ['-e', script], options),
      testScript: 'test:run',
    });

    expect(result.parseError).toBe(false);
    expect(result.parseFailureKind).toBeUndefined();
    expect(result.passed).toBe(false);
    expect(result.failedTests).toBe(3);
    expect(result.loadFailures).toBe(1);
    expect(result.failCount).toBe(4);
    expect(result.report).toContain('**Result: FAIL**');
  });

  it('IntegrationSuite_RealProcessGreenWithPreamble_ReportsPass', () => {
    const script =
      'process.stdout.write("\\n> pkg@1.0.0 test:run\\n> vitest run --reporter=json\\n\\n");' +
      `process.stdout.write(${JSON.stringify(GREEN_REPORT)});` +
      'process.exit(0);';

    const result = runIntegrationSuite({
      repoRoot: process.cwd(),
      runCommand: (_cmd, _args, options) =>
        execCommandRunner(process.execPath, ['-e', script], options),
      testScript: 'test:run',
    });

    expect(result.parseError).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.failCount).toBe(0);
    expect(result.report).toContain('**Result: PASS**');
  });
});
