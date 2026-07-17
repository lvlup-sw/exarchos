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
import { detectToolchain, type Toolchain } from '../../config/toolchains.js';

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
   * Explicit npm script that produces vitest JSON on stdout. When set it WINS
   * over toolchain resolution (`npm run <script> -- --reporter=json`). When
   * absent, the test command is resolved via the layered toolchain resolver
   * (#1537) so the monorepo-root / workspace layout — or a `.exarchos.yml`
   * override — picks the right command instead of a hardcoded `test:run`.
   */
  readonly testScript?: string;
  /**
   * Toolchain detector seam (defaults to {@link detectToolchain}). Injected in
   * tests; production may thread a config-aware detector so `.exarchos.yml`
   * `toolchains:` overrides participate.
   */
  readonly detectToolchain?: (repoRoot: string) => Toolchain | undefined;
}

export interface RunIntegrationSuiteResult extends IntegrationSuiteParse {
  /** True when the runner output could not be parsed as vitest JSON. */
  readonly parseError: boolean;
  /**
   * When `parseError`, WHY the gate failed closed: `'spawn-failure'` (the runner
   * command could not execute) vs `'shape-mismatch'` (it ran but emitted
   * unparseable output). Unset on a clean parse. Lets operators tell a missing
   * test command apart from a crashed/garbled reporter (#1537).
   */
  readonly parseFailureKind?: 'spawn-failure' | 'shape-mismatch';
  /** Raw exit code from the runner. */
  readonly exitCode: number;
  /** Structured markdown report. */
  readonly report: string;
}

// ============================================================
// COMMAND RESOLUTION (#1537 / DR-15)
// ============================================================

/** A resolved test command split into an executable + argv. */
export interface ResolvedTestCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * Resolve the integration-suite test command for `repoRoot`.
 *
 * Precedence (layered, #1537):
 *   1. An explicit `testScript` wins → `npm run <script> -- --reporter=json`.
 *   2. Otherwise the layered toolchain resolver's `commands.test` (which a
 *      config-aware `detect` lets `.exarchos.yml` override) — split into an
 *      executable + argv, with `--reporter=json` appended (after a `--`
 *      passthrough for script runners).
 *   3. Fallback when no toolchain is detected → node's `npm run test:run`.
 */
export function resolveIntegrationCommand(
  repoRoot: string,
  testScript: string | undefined,
  detect: (repoRoot: string) => Toolchain | undefined = detectToolchain,
): ResolvedTestCommand {
  if (testScript) {
    return { cmd: 'npm', args: ['run', testScript, '--', '--reporter=json'] };
  }

  const resolved = detect(repoRoot)?.commands.test;
  if (resolved && resolved.trim().length > 0) {
    const [cmd = 'npm', ...rest] = resolved.trim().split(/\s+/);
    // Script runners (npm/pnpm/yarn/bun) need the reporter flag AFTER a `--`
    // passthrough; a direct runner (vitest, …) takes it inline.
    const isScriptRunner = cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun';
    const args = isScriptRunner ? [...rest, '--', '--reporter=json'] : [...rest, '--reporter=json'];
    return { cmd, args };
  }

  return { cmd: 'npm', args: ['run', 'test:run', '--', '--reporter=json'] };
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

  // Guard: only a plain object can be a vitest result. A bare number, string,
  // null, or array (`[]`) is not — and must NOT normalize to a passing run.
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return null;
  }

  // Guard: an object lacking every summary counter (e.g. `{}`) is not a vitest
  // result either. Treating it as zero-failures would fail OPEN — a false green
  // whenever the runner emits an unexpected JSON shape. Require at least one
  // recognizable counter before trusting the payload.
  const hasSummaryCounter =
    typeof json.numFailedTests === 'number' ||
    typeof json.numFailedTestSuites === 'number' ||
    typeof json.numTotalTests === 'number';
  if (!hasSummaryCounter) {
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

/**
 * Counts-not-transcripts cap (DR-7, audit O-4): a load cascade can list
 * hundreds of files. The report enumerates at most N of them, then a single
 * total-count line steers to the uncapped escape hatch (re-run the suite
 * locally). Fixed internal cap — NOT a schema param (that boundary is Task 022).
 */
export const LOAD_FAILURE_LIST_CAP = 20;

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
    const shownFiles = parse.loadFailureFiles.slice(0, LOAD_FAILURE_LIST_CAP);
    for (const f of shownFiles) {
      lines.push(`- \`${f}\``);
    }
    if (parse.loadFailureFiles.length > shownFiles.length) {
      const remaining = parse.loadFailureFiles.length - shownFiles.length;
      lines.push(
        `- …and ${remaining} more (${parse.loadFailureFiles.length} load failures total). ` +
          `Re-run the suite locally for the full list.`,
      );
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
/**
 * Build a fail-closed result with a distinct `parseFailureKind` + report. Both
 * spawn-failure and shape-mismatch fail closed (counts non-authoritative), but
 * the kind + report make the cause actionable rather than a generic "no JSON".
 */
function failClosed(
  repoRoot: string,
  exitCode: number,
  kind: 'spawn-failure' | 'shape-mismatch',
  detail: string,
): RunIntegrationSuiteResult {
  return {
    passed: false,
    failedSuites: 1,
    failedTests: 0,
    loadFailures: 1,
    totalTests: 0,
    failCount: 1,
    loadFailureFiles: [],
    parseError: true,
    parseFailureKind: kind,
    exitCode,
    report: [
      '## Integration Suite Report',
      '',
      `**Repository:** \`${repoRoot}\``,
      '',
      `- **FAIL**: ${detail}; gate failed closed`,
      '',
      '---',
      '',
      `**Result: FAIL** (${kind === 'spawn-failure' ? 'runner spawn failure' : 'unparseable output'})`,
    ].join('\n'),
  };
}

export function runIntegrationSuite(input: RunIntegrationSuiteInput): RunIntegrationSuiteResult {
  const { repoRoot, runCommand, testScript, detectToolchain: detect } = input;

  // Resolve the test command via the layered toolchain resolver (#1537) so a
  // monorepo-root / workspace layout — or an explicit testScript — picks the
  // right command instead of a hardcoded `npm run test:run`.
  const { cmd, args } = resolveIntegrationCommand(repoRoot, testScript, detect ?? detectToolchain);
  const cmdResult = runCommand(cmd, args as string[], { cwd: repoRoot });

  // A runner-spawn failure (the command itself could not execute) is distinct
  // from a JSON-shape mismatch (it ran but emitted unparseable output) — #1537.
  if (cmdResult.spawnError) {
    return failClosed(
      repoRoot,
      cmdResult.exitCode,
      'spawn-failure',
      `runner failed to spawn (\`${cmd}\`: ${cmdResult.spawnError})`,
    );
  }

  const parse = parseVitestResult(cmdResult.stdout);
  if (parse === null) {
    // Ran, but the output is not recognizable vitest JSON. Fail CLOSED — a
    // zero exit here can mask a crashed/garbled reporter — and flag the kind so
    // operators don't confuse it with a missing test command.
    return failClosed(
      repoRoot,
      cmdResult.exitCode,
      'shape-mismatch',
      'runner produced no parseable vitest JSON (ran, but the output shape was unrecognized)',
    );
  }

  return {
    ...parse,
    parseError: false,
    exitCode: cmdResult.exitCode,
    report: buildReport(repoRoot, parse),
  };
}
