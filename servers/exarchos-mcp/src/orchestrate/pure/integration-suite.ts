/**
 * Integration Suite Gate (#1329)
 *
 * Runs the FULL vitest suite against the integration tip and folds
 * file-LOAD failures into the failure count.
 *
 * The trap (#1329): when a test file throws at IMPORT time (a bad import,
 * a circular dependency, a type-only export consumed at runtime, …) vitest
 * counts it as "1 failed test SUITE / 0 failed TESTS". The per-task gates
 * inspect the failed-TEST count, see zero, and pass — while the integration
 * tip has 125 files failing to load and ~1899 tests that never got collected.
 *
 * This module isolates the pure parsing logic (`parseVitestResult`) from the
 * external command invocation (`runIntegrationSuite`), so the fold-in rule is
 * unit-testable without executing vitest. The runner is injected via the same
 * `RunCommandFn` seam used by the static-analysis gate.
 */

import type { RunCommandFn } from './static-analysis.js';

// ============================================================
// PUBLIC TYPES
// ============================================================

/** Parsed, folded-in view of a vitest run. */
export interface IntegrationSuiteParse {
  /** True only when there are no failed tests AND no load failures. */
  readonly passed: boolean;
  /** Number of test SUITES that failed (vitest `numFailedTestSuites`). */
  readonly failedSuites: number;
  /** Number of individual tests that failed (vitest `numFailedTests`). */
  readonly failedTests: number;
  /** Number of suites that failed with zero failed tests — the silent load-failure cohort. */
  readonly loadFailures: number;
  /** Total tests collected (vitest `numTotalTests`). */
  readonly totalTests: number;
  /**
   * Overall failure count, with load-failures FOLDED IN:
   *   failCount = failedTests + loadFailures
   * This is the number the gate reports so a load cascade can never read as 0.
   */
  readonly failCount: number;
  /** Names of files that failed to load (for the report), when discernible. */
  readonly loadFailureFiles: readonly string[];
}

export interface RunIntegrationSuiteInput {
  /** Repository root to run the suite against (worktree-aware). */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: RunCommandFn;
  /**
   * npm script that produces vitest JSON on stdout. Defaults to `test:run`.
   * The gate appends `--reporter=json` so the consumer project does not need
   * a bespoke script.
   */
  readonly testScript?: string;
}

export interface RunIntegrationSuiteResult extends IntegrationSuiteParse {
  /** True when the runner output could not be parsed as vitest JSON. */
  readonly parseError: boolean;
  /** Raw exit code from the runner. */
  readonly exitCode: number;
  /** Structured markdown report. */
  readonly report: string;
}

// ============================================================
// INTERNAL SHAPE OF VITEST JSON
// ============================================================

interface VitestTestResult {
  readonly name?: string;
  readonly status?: string;
  readonly message?: string;
  readonly assertionResults?: readonly unknown[];
}

interface VitestJson {
  readonly numFailedTestSuites?: number;
  readonly numFailedTests?: number;
  readonly numTotalTests?: number;
  readonly testResults?: readonly VitestTestResult[];
}

// ============================================================
// PURE PARSER
// ============================================================

/**
 * Parse a vitest JSON-reporter blob into a folded-in failure view.
 *
 * A "load failure" is a test SUITE that reports `status: 'failed'` with zero
 * assertion results — i.e. it failed before any test inside it ran. When the
 * per-suite breakdown is unavailable, we approximate load failures as
 * `max(0, numFailedTestSuites - <suites with failed tests>)`, falling back to
 * `numFailedTestSuites` when `numFailedTests === 0`.
 *
 * `failCount` ALWAYS folds load failures in, so a result with
 * `numFailedTests: 0, numFailedTestSuites: 1` yields `failCount >= 1`.
 */
export function parseVitestResult(raw: string): IntegrationSuiteParse | null {
  let json: VitestJson;
  try {
    json = JSON.parse(raw) as VitestJson;
  } catch {
    return null;
  }

  // Guard: a parseable-but-non-object payload (e.g. a bare number) is not a
  // vitest result.
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const failedTests =
    typeof json.numFailedTests === 'number' && json.numFailedTests >= 0
      ? json.numFailedTests
      : 0;
  const failedSuites =
    typeof json.numFailedTestSuites === 'number' && json.numFailedTestSuites >= 0
      ? json.numFailedTestSuites
      : 0;
  const totalTests =
    typeof json.numTotalTests === 'number' && json.numTotalTests >= 0
      ? json.numTotalTests
      : 0;

  // Per-suite analysis: a suite that failed with zero assertion results never
  // collected a test — it is a load failure.
  const results = Array.isArray(json.testResults) ? json.testResults : [];
  const loadFailureFiles: string[] = [];
  let suitesWithFailedTests = 0;

  for (const r of results) {
    if (r.status !== 'failed') continue;
    const assertionCount = Array.isArray(r.assertionResults) ? r.assertionResults.length : 0;
    if (assertionCount === 0) {
      loadFailureFiles.push(typeof r.name === 'string' ? r.name : '<unknown>');
    } else {
      suitesWithFailedTests++;
    }
  }

  // Prefer the per-suite count when testResults is present and informative;
  // otherwise derive from the summary counters.
  let loadFailures: number;
  if (loadFailureFiles.length > 0) {
    loadFailures = loadFailureFiles.length;
  } else if (failedSuites > suitesWithFailedTests) {
    // Failed suites that did not correspond to any suite-with-failed-tests
    // are load failures even when per-file detail is absent.
    loadFailures = failedSuites - suitesWithFailedTests;
  } else if (failedSuites > 0 && failedTests === 0) {
    // The canonical #1329 shape with no testResults breakdown: a failed suite
    // and zero failed tests can only be a load failure.
    loadFailures = failedSuites;
  } else {
    loadFailures = 0;
  }

  const failCount = failedTests + loadFailures;
  const passed = failCount === 0;

  return {
    passed,
    failedSuites,
    failedTests,
    loadFailures,
    totalTests,
    failCount,
    loadFailureFiles,
  };
}

// ============================================================
// REPORT
// ============================================================

function buildReport(repoRoot: string, parse: IntegrationSuiteParse): string {
  const lines: string[] = [
    '## Integration Suite Report',
    '',
    `**Repository:** \`${repoRoot}\``,
    `**Tests collected:** ${parse.totalTests}`,
    `**Failed tests:** ${parse.failedTests}`,
    `**Failed suites:** ${parse.failedSuites}`,
    `**Load failures (folded in):** ${parse.loadFailures}`,
    '',
  ];

  if (parse.loadFailureFiles.length > 0) {
    lines.push('### Files that failed to load');
    for (const f of parse.loadFailureFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  lines.push('---', '');
  if (parse.passed) {
    lines.push(`**Result: PASS** (${parse.totalTests} tests, no load failures)`);
  } else {
    lines.push(
      `**Result: FAIL** (${parse.failCount} failures: ${parse.failedTests} test + ${parse.loadFailures} load)`,
    );
  }

  return lines.join('\n');
}

// ============================================================
// RUNNER
// ============================================================

/**
 * Run the full vitest suite against `repoRoot` and fold load-failures into the
 * failure count. Pure aside from the injected `runCommand`.
 *
 * Invokes: `npm run <testScript> -- --reporter=json` in `repoRoot`. vitest
 * emits the JSON summary on stdout; we parse it via {@link parseVitestResult}.
 */
export function runIntegrationSuite(input: RunIntegrationSuiteInput): RunIntegrationSuiteResult {
  const { repoRoot, runCommand, testScript = 'test:run' } = input;

  const cmdResult = runCommand(
    'npm',
    ['run', testScript, '--', '--reporter=json'],
    { cwd: repoRoot },
  );

  const parse = parseVitestResult(cmdResult.stdout);

  if (parse === null) {
    // The runner ran but emitted no parseable JSON. Treat a non-zero exit as a
    // failure (the suite did blow up) but flag parseError so callers know the
    // counts are not authoritative.
    const failedFromExit = cmdResult.exitCode !== 0;
    const fallback: IntegrationSuiteParse = {
      passed: !failedFromExit,
      failedSuites: failedFromExit ? 1 : 0,
      failedTests: 0,
      loadFailures: failedFromExit ? 1 : 0,
      totalTests: 0,
      failCount: failedFromExit ? 1 : 0,
      loadFailureFiles: [],
    };
    return {
      ...fallback,
      parseError: true,
      exitCode: cmdResult.exitCode,
      report: [
        '## Integration Suite Report',
        '',
        `**Repository:** \`${repoRoot}\``,
        '',
        failedFromExit
          ? '- **FAIL**: suite exited non-zero and produced no parseable vitest JSON'
          : '- **PASS**: suite exited zero (no parseable vitest JSON to fold)',
        '',
        '---',
        '',
        failedFromExit ? '**Result: FAIL** (unparseable output)' : '**Result: PASS**',
      ].join('\n'),
    };
  }

  return {
    ...parse,
    parseError: false,
    exitCode: cmdResult.exitCode,
    report: buildReport(repoRoot, parse),
  };
}
