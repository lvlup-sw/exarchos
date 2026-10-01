/**
 * The integration suite gate logic. It runs the vitest suite against the
 * integration tip and adds file load failures to the failure count.
 *
 * Vitest counts a test file that throws at import as one failed suite with
 * zero failed tests. A gate that reads only the failed-test count passes it.
 * The parser (`parseVitestResult`) is pure, and the runner calls an injected
 * `RunCommandFn`, so unit tests do not run vitest.
 */

import type { RunCommandFn } from './static-analysis.js';
import { detectToolchain, type Toolchain } from '../../config/toolchains.js';

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
   * An npm script that writes vitest JSON to stdout. When set, it takes
   * precedence over toolchain resolution. When absent, the layered toolchain
   * resolver gives the test command, so a workspace layout or a `.exarchos.yml`
   * override selects the correct command.
   */
  readonly testScript?: string | undefined;
  /**
   * The toolchain detector, {@link detectToolchain} by default. Tests inject a
   * stub. A config-aware detector lets `.exarchos.yml` `toolchains:` overrides
   * apply.
   */
  readonly detectToolchain?: (repoRoot: string) => Toolchain | undefined;
}

export interface RunIntegrationSuiteResult extends IntegrationSuiteParse {
  /** True when the runner output does not parse as vitest JSON. */
  readonly parseError: boolean;
  /**
   * The cause of a `parseError`. `'spawn-failure'` means that the runner command
   * did not start. `'shape-mismatch'` means that it ran, but the output does not
   * parse. Unset on a clean parse.
   */
  readonly parseFailureKind?: 'spawn-failure' | 'shape-mismatch';
  /** Raw exit code from the runner. */
  readonly exitCode: number;
  /** Structured markdown report. */
  readonly report: string;
}

/** A resolved test command split into an executable + argv. */
export interface ResolvedTestCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * Resolves the integration-suite test command for `repoRoot`, in this order:
 *   1. An explicit `testScript` gives `npm run <script> -- --reporter=json`.
 *   2. Else the `commands.test` of the detected toolchain, split on spaces, with
 *      `--reporter=json` added. A script runner (npm, pnpm, yarn, bun) gets the
 *      flag after a `--` passthrough.
 *   3. Else `npm run test:run -- --reporter=json`.
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
    const isScriptRunner = cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun';
    const args = isScriptRunner ? [...rest, '--', '--reporter=json'] : [...rest, '--reporter=json'];
    return { cmd, args };
  }

  return { cmd: 'npm', args: ['run', 'test:run', '--', '--reporter=json'] };
}

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

/**
 * Yields candidate JSON documents from the raw stdout of a runner. A script
 * runner writes a preamble, such as `> pkg@1.0.0 test:run`, before the reporter
 * JSON on the same stream.
 *
 * It yields the whole trimmed stream first. Then it yields each complete
 * top-level `{…}` span in reverse order, because the reporter JSON comes after
 * the preamble. Braces inside JSON strings do not change the depth.
 */
function* vitestJsonCandidates(raw: string): Generator<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  yield trimmed;

  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(trimmed.slice(start, i + 1));
        start = -1;
      }
    }
  }

  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span !== undefined && span !== trimmed) yield span;
  }
}

/**
 * Parses one candidate JSON document into a failure view with load failures
 * added. It returns `null` for a value that is not a plain object, and for an
 * object with no summary counter. Zero failures for such a value make the gate
 * fail open.
 *
 * A load failure is a failed suite with zero assertion results. Without that
 * per-suite detail, failed suites with no failed tests count as load failures.
 * `failCount` is `failedTests + loadFailures`.
 */
function parseVitestDocument(candidate: string): IntegrationSuiteParse | null {
  let json: VitestJson;
  try {
    json = JSON.parse(candidate) as VitestJson;
  } catch {
    return null;
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return null;
  }

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

  let loadFailures: number;
  if (loadFailureFiles.length > 0) {
    loadFailures = loadFailureFiles.length;
  } else if (failedSuites > suitesWithFailedTests) {
    loadFailures = failedSuites - suitesWithFailedTests;
  } else if (failedSuites > 0 && failedTests === 0) {
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

/**
 * Parses the raw stdout of a runner into a failure view. It tries each
 * candidate from {@link vitestJsonCandidates} in turn. It returns `null` only
 * when no candidate is a vitest result, and the caller then fails closed with
 * `shape-mismatch`.
 */
export function parseVitestResult(raw: string): IntegrationSuiteParse | null {
  for (const candidate of vitestJsonCandidates(raw)) {
    const parsed = parseVitestDocument(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * The maximum number of load-failure files that the report lists. A load
 * cascade can list hundreds of files. After the cap, one line gives the total
 * and tells the reader to run the suite locally. It is not a schema parameter.
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

/**
 * Builds a fail-closed result with a `parseFailureKind` and a report. Both
 * kinds fail closed because the counts are not authoritative. The kind and the
 * report tell the operator the cause.
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

/**
 * Runs the test command from {@link resolveIntegrationCommand} in `repoRoot`
 * and parses the stdout. It has no side effect other than the injected
 * `runCommand`. A spawn failure gives `spawn-failure`. Output that is not vitest
 * JSON gives `shape-mismatch`, also on a zero exit, because a crashed reporter
 * can exit zero.
 */
export function runIntegrationSuite(input: RunIntegrationSuiteInput): RunIntegrationSuiteResult {
  const { repoRoot, runCommand, testScript, detectToolchain: detect } = input;

  const { cmd, args } = resolveIntegrationCommand(repoRoot, testScript, detect ?? detectToolchain);
  const cmdResult = runCommand(cmd, args as string[], { cwd: repoRoot });

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
