/**
 * The readers of the report of an integration suite. `verification.integration.report` selects a reader.
 * The exit code gives the verdict of a run, and a reader adds the counts of the report.
 * A reader holds no spawn, no flag and no program name.
 *
 * Vitest counts a test file that throws at import as one failed suite with zero failed tests.
 * A gate that reads only the failed-test count passes it. So the reader adds the load failures to the failure count.
 * The parser is pure, so a unit test starts no process.
 */

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

/** True for an object record. An array and null are not records. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count of the report. A value that is not a number of zero or more gives 0. */
function countOf(value: unknown): number {
  return typeof value === 'number' && value >= 0 ? value : 0;
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
 * added. It returns `null` for text that is not JSON, a value that is not a
 * plain object, or an object with no summary counter. If the parser reads
 * such a value as zero failures, the gate fails open.
 *
 * A load failure is a failed suite with zero assertion results. Without that
 * per-suite detail, failed suites with no failed tests count as load failures.
 * `failCount` is `failedTests + loadFailures`.
 */
function parseVitestDocument(candidate: string): IntegrationSuiteParse | null {
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!isRecord(json)) return null;

  const hasSummaryCounter =
    typeof json.numFailedTests === 'number' ||
    typeof json.numFailedTestSuites === 'number' ||
    typeof json.numTotalTests === 'number';
  if (!hasSummaryCounter) {
    return null;
  }

  const failedTests = countOf(json.numFailedTests);
  const failedSuites = countOf(json.numFailedTestSuites);
  const totalTests = countOf(json.numTotalTests);

  const results: readonly unknown[] = Array.isArray(json.testResults) ? json.testResults : [];
  const loadFailureFiles: string[] = [];
  let suitesWithFailedTests = 0;

  for (const r of results) {
    if (!isRecord(r) || r.status !== 'failed') continue;
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
