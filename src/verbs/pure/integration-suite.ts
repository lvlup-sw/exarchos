/**
 * Integration Suite Gate (#1329)
 *
 * Runs the governed repository's FULL test suite against the integration tip.
 * On a runner that reports per-suite counts it folds file-LOAD failures into
 * the failure count; on a runner that reports only an exit code, the exit code
 * is the verdict.
 *
 * The trap (#1329): when a test file throws at IMPORT time (a bad import,
 * a circular dependency, a type-only export consumed at runtime, …) vitest
 * counts it as "1 failed test SUITE / 0 failed TESTS". The per-task gates
 * inspect the failed-TEST count, see zero, and pass — while the integration
 * tip has 125 files failing to load and ~1899 tests that never got collected.
 *
 * BOTH halves of the invocation are resolved, and from different authorities:
 * the COMMAND from the layered test-runtime resolver (override > `.exarchos.yml`
 * > user toolchains > task runner > built-in registry), and the RESULT CARRIER
 * from the registry's carrier table. Appending vitest's `--reporter=json` to
 * whatever command came back is what produced `cargo test --reporter=json` and
 * `pytest --reporter=json` — an unknown flag that makes the runner exit before
 * running anything, then read as a hard failure. The flag now travels ON the
 * carrier descriptor and is appended only when the command actually invokes the
 * runner that descriptor is about.
 *
 * This module isolates the pure parsing logic (`parseVitestResult`) from the
 * external command invocation (`runIntegrationSuite`), so the fold-in rule is
 * unit-testable without executing vitest. The runner is injected via a seam
 * shaped like the static-analysis gate's, widened by one field so a runner
 * killed for exceeding its wall clock can say so.
 */

import { assertNever } from '../../contract/error-families.js';
import type { CommandResult } from './static-analysis.js';
import { resolveTestRuntime } from '../../config/test-runtime-resolver.js';
import {
  detectToolchain,
  resolveTestReportFormat,
  type TestReportFormat,
  type Toolchain,
} from '../../config/toolchains.js';

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

/**
 * A {@link CommandResult} that can also report the runner was KILLED for
 * exceeding its wall clock.
 *
 * A killed runner is neither a pass nor a failure: nothing observed the suite
 * to a conclusion. It is distinct from `spawnError` (the process never started)
 * and from a non-zero exit (it ran and decided), and both other outcomes would
 * misreport it — which is why it is a field rather than a reused one.
 */
export interface IntegrationCommandResult extends CommandResult {
  readonly timedOut?: boolean;
}

/**
 * The external-runner seam. Shaped like the static-analysis gate's runner and
 * accepted from the same callers: a runner that never times out simply omits
 * the extra outcome and never reads the extra option.
 */
export type IntegrationRunCommandFn = (
  cmd: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly timeoutMs?: number },
) => IntegrationCommandResult;

export interface RunIntegrationSuiteInput {
  /** Repository root to run the suite against (worktree-aware). */
  readonly repoRoot: string;
  /** External command runner (dependency injection). */
  readonly runCommand: IntegrationRunCommandFn;
  /**
   * Explicit npm script that produces vitest JSON on stdout. When set it WINS
   * over resolution (`npm run <script> -- --reporter=json`). When absent, the
   * test command comes from the layered resolver, so a workspace layout, a
   * committed task runner or an `.exarchos.yml` entry picks the command instead
   * of a hardcoded `test:run`.
   */
  readonly testScript?: string | undefined;
  /**
   * Runtime-resolution seam (defaults to {@link resolveIntegrationRuntime}).
   * ONE seam rather than two, because the command and the identity that decides
   * how to read its output must describe the same repository — a fixture that
   * supplied only one of them was how a test came to pin a composition the gate
   * cannot produce.
   */
  readonly resolveRuntime?: IntegrationRuntimeResolver;
}

/**
 * Why the gate could not reach a verdict about this repository.
 *
 * Every arm is producible by the SHIPPED composition — not merely by an
 * injected seam. An arm nothing can reach is a control that only looks like
 * one, so an arm is removed rather than left standing when the composition
 * stops producing it.
 */
export type IntegrationSuiteSkipReason =
  /** Nothing in the repository identified a project type. */
  | 'no-toolchain'
  /**
   * A project was identified but no test command resolved for it — the layered
   * resolver produced none (e.g. a Node package with no test script), or it
   * failed while trying (e.g. an unreadable `.exarchos.yml`).
   */
  | 'no-test-command'
  /** The runner could not be started, so its exit code decides nothing. */
  | 'runner-unavailable'
  /** The runner was killed for exceeding its wall clock. */
  | 'runner-timeout';

/**
 * What one invocation of the resolved test command established.
 *
 * Three arms because the runner set produces three genuinely different kinds of
 * evidence, and flattening them is what let a gate report counts it could not
 * have measured. `exit-code` deliberately carries NO suite/test/load counts: on
 * that carrier a load cascade and a failed assertion are indistinguishable from
 * outside the runner, and reporting them as zero would be the same false green
 * the fold-in rule exists to prevent.
 */
export type IntegrationSuiteRun =
  | ({
      readonly kind: 'vitest-counts';
      /**
       * True when the runner RAN but its output could not be parsed as vitest
       * JSON. The gate fails closed on it: a zero exit can mask a crashed or
       * garbled reporter, and the counts would then be a claim rather than a
       * measurement.
       *
       * There is no second cause to discriminate any more. A runner that never
       * started used to arrive here too, stamped `'spawn-failure'`, which minted
       * `passed: false` for a suite nothing observed; that outcome is now
       * `indeterminate` / `runner-unavailable` on both carriers.
       */
      readonly parseError: boolean;
      /** Raw exit code from the runner. */
      readonly exitCode: number;
      /** Structured markdown report. */
      readonly report: string;
    } & IntegrationSuiteParse)
  | {
      readonly kind: 'exit-code';
      /** The runner's own verdict: it exited zero, or it did not. */
      readonly passed: boolean;
      readonly exitCode: number;
      readonly report: string;
    }
  | {
      readonly kind: 'indeterminate';
      readonly skipReason: IntegrationSuiteSkipReason;
      readonly reason: string;
      readonly report: string;
    };

// ============================================================
// COMMAND RESOLUTION (#1537)
// ============================================================

/** The carrier arms a command can actually be READ through. */
type RunnableReportFormat = Exclude<TestReportFormat, { readonly kind: 'unknown' }>;

/**
 * The carrier every runnable command falls back to.
 *
 * Reading an exit code is sound for ANY executable and appends nothing to its
 * argv, so it is the floor rather than a degradation — the counted carrier is
 * the enrichment that has to be earned.
 */
const EXIT_CODE_ONLY: RunnableReportFormat = { kind: 'exit-code-only' };

/**
 * What this repository's tests are, as the two authorities see it: the layered
 * resolver says WHICH COMMAND, the registry says WHAT THE REPOSITORY IS.
 *
 * They are one value because they have to agree about one repository. Splitting
 * them into two seams let a caller supply an identity without a command — which
 * is not a state the shipped composition can be in.
 */
export interface IntegrationRuntime {
  /** The test command the layered resolver landed on, or null when none did. */
  readonly test: string | null;
  /** The registry's identity for this repository, when it recognizes one. */
  readonly toolchain: Toolchain | undefined;
  /** The resolver's own guidance when nothing resolved. */
  readonly remediation?: string | undefined;
}

export type IntegrationRuntimeResolver = (repoRoot: string) => IntegrationRuntime;

/**
 * The shipped resolution: the layered resolver for the command, the registry
 * for the identity.
 *
 * Reading `commands.test` straight off the detected toolchain — which is what
 * this replaced — sees only the built-in registry tier. A `pnpm`/`yarn`/`bun`
 * repository, an `.exarchos.yml` `test:` entry and a committed task runner were
 * all invisible to it, so every non-npm Node repository was handed `npm run
 * test:run` and failed a rung it had no way to clear.
 *
 * May throw: an unreadable or schema-invalid `.exarchos.yml` is a hard failure
 * inside the resolver. {@link resolveIntegrationCommand} converts that into an
 * unrunnable resolution rather than letting it escape as a crash.
 */
export function resolveIntegrationRuntime(repoRoot: string): IntegrationRuntime {
  const runtime = resolveTestRuntime(repoRoot);
  return {
    test: runtime.test,
    toolchain: detectToolchain(repoRoot),
    ...(runtime.remediation !== undefined ? { remediation: runtime.remediation } : {}),
  };
}

/** A resolved test command: an executable, its argv, and the report it emits. */
export interface RunnableTestCommand {
  readonly kind: 'runnable';
  readonly cmd: string;
  readonly args: readonly string[];
  /** How to READ what this command produces. The gate branches on this alone. */
  readonly format: RunnableReportFormat;
}

/** No command could be composed, with the reason a reader can act on. */
export interface UnrunnableTestCommand {
  readonly kind: 'unrunnable';
  readonly skipReason: IntegrationSuiteSkipReason;
  readonly reason: string;
}

export type IntegrationCommandResolution = RunnableTestCommand | UnrunnableTestCommand;

/**
 * The Node package managers, which this module needs to recognize for two
 * reasons that happen to name the same set.
 *
 * They need a `--` before a flag meant for the script they run rather than for
 * the manager itself; and they are the invocations the registry's vitest-JSON
 * carrier row is written about — that row's whole justification is that a Node
 * repository's test command is a package-manager SCRIPT INDIRECTION. Any other
 * executable arriving from a higher resolver layer (`pytest`, `task test`, a
 * bare `mix`) is a runner nothing here knows, and handing it vitest's flag is
 * precisely the unknown-flag failure this module exists to have removed.
 */
const NODE_SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * The registry id whose row supplies the carrier for an explicitly-named npm
 * script. Naming an npm script IS naming that ecosystem's runner, so the
 * carrier is still looked up rather than assumed: nothing here spells a
 * reporter flag, and if that row ever changes this arm follows it.
 */
const NPM_SCRIPT_TOOLCHAIN_ID = 'node';

/** Split a shell-ish command string into an executable and its argv. */
function splitCommand(command: string): { readonly cmd: string; readonly args: readonly string[] } {
  const [cmd = '', ...args] = command.trim().split(/\s+/);
  return { cmd, args };
}

/**
 * Compose the argv for `command` under the carrier `toolchain` declares.
 *
 * The reporter flag is asked for on TWO conditions, not one: the identified
 * toolchain's row must say a report is emitted, AND the command must actually
 * invoke the runner that row is about. The second condition is what the layered
 * resolver made necessary — with the command coming from any of five layers, a
 * repository can now name `pytest` while still being identified as Node, and
 * keying the flag on identity alone would re-create `pytest --reporter=json`
 * through a different door.
 *
 * Everything else is spawned EXACTLY as resolved and read by its exit code. No
 * command is ever altered on that path, which is why it cannot fail the way
 * `cargo test --reporter=json` did.
 */
function composeCommand(command: string, toolchain: Toolchain | undefined): RunnableTestCommand {
  const { cmd, args } = splitCommand(command);
  const declared = toolchain ? resolveTestReportFormat(toolchain.id) : EXIT_CODE_ONLY;
  if (declared.kind === 'vitest-json' && NODE_SCRIPT_RUNNERS.has(cmd)) {
    return {
      kind: 'runnable',
      cmd,
      args: [...args, '--', declared.reporterFlag],
      format: declared,
    };
  }
  return { kind: 'runnable', cmd, args, format: EXIT_CODE_ONLY };
}

/**
 * Resolve the integration-suite test command for `repoRoot`, together with the
 * carrier its runner produces.
 *
 * Precedence:
 *   1. An explicit `testScript` wins → `npm run <script>`, under the carrier the
 *      npm-script runner's registry row declares.
 *   2. Otherwise the LAYERED resolver's test command (override > `.exarchos.yml`
 *      direct > user `toolchains:` > committed task runner > built-in registry),
 *      composed against the carrier the identified toolchain declares — and only
 *      when the command invokes the runner that carrier is about.
 *   3. No command, or a resolver that could not read the repository's own
 *      configuration → `unrunnable`. There is no fallback command: the previous
 *      one spawned this repository's own `npm run test:run` script name at any
 *      governed repository that failed detection, which is a guess, not a
 *      resolution.
 */
export function resolveIntegrationCommand(
  repoRoot: string,
  testScript: string | undefined,
  resolveRuntime: IntegrationRuntimeResolver = resolveIntegrationRuntime,
): IntegrationCommandResolution {
  if (testScript) {
    // Built here rather than through `composeCommand` so a script name that
    // carries whitespace survives as ONE argument. The flag is still looked up
    // rather than spelled: naming an npm script IS naming that ecosystem's
    // runner, and if that row ever changes this arm follows it — down to the
    // sound floor, which is what the second branch is. The registry answers
    // `vitest-json` for this id today, so that branch is the row's tail rather
    // than a second contract; what matters is that it degrades to running the
    // script and reading its exit code instead of refusing to run at all.
    const format = resolveTestReportFormat(NPM_SCRIPT_TOOLCHAIN_ID);
    if (format.kind === 'vitest-json') {
      return {
        kind: 'runnable',
        cmd: 'npm',
        args: ['run', testScript, '--', format.reporterFlag],
        format,
      };
    }
    return { kind: 'runnable', cmd: 'npm', args: ['run', testScript], format: EXIT_CODE_ONLY };
  }

  let runtime: IntegrationRuntime;
  try {
    runtime = resolveRuntime(repoRoot);
  } catch (err) {
    // An unreadable or schema-invalid `.exarchos.yml` throws inside the layered
    // resolver. That is still "no command could be resolved" — a crash out of a
    // gate would take the whole runbook step with it and say less.
    return {
      kind: 'unrunnable',
      skipReason: 'no-test-command',
      reason: `the test command could not be resolved at '${repoRoot}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const command = runtime.test?.trim();
  if (!command) {
    // Which of the two "nothing to run" cases this is turns on whether the
    // repository looks like a project at all, not on which resolver layer was
    // consulted: an unrecognized directory and a recognized project with no test
    // script call for different fixes, and the resolver's own remediation names
    // the second one precisely.
    return runtime.toolchain
      ? {
          kind: 'unrunnable',
          skipReason: 'no-test-command',
          reason:
            runtime.remediation ??
            `no test command resolves for the '${runtime.toolchain.id}' project at '${repoRoot}'`,
        }
      : {
          kind: 'unrunnable',
          skipReason: 'no-toolchain',
          reason:
            runtime.remediation ??
            `no recognized project type at '${repoRoot}', so there is no test command to run`,
        };
  }

  return composeCommand(command, runtime.toolchain);
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
/**
 * Yield candidate JSON documents from a runner's raw stdout, best-first.
 *
 * WFQ-003: the gate invokes the suite through a script runner whose preamble
 * (`> pkg@1.0.0 test:run`, workspace banners, deprecation notices) is
 * concatenated with the reporter's JSON on the same stream. Requiring the whole
 * stream to be one JSON document made a green suite fail closed with
 * `parseError` (#1537).
 *
 * The scan is string-aware (braces inside JSON string literals do not change
 * depth) and yields complete top-level `{…}` spans in REVERSE order, because
 * the reporter blob is emitted after any preamble. The whole trimmed stream is
 * tried first so a clean single-document stdout takes the fast path.
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
 * Parse ONE candidate JSON document into a folded-in failure view.
 *
 * Returns `null` when the document is not a recognizable vitest result, so the
 * caller can fall through to the next candidate.
 */
function parseVitestDocument(candidate: string): IntegrationSuiteParse | null {
  let json: VitestJson;
  try {
    json = JSON.parse(candidate) as VitestJson;
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

/**
 * Parse a runner's raw stdout into a folded-in failure view.
 *
 * Tolerates a script-runner preamble around the reporter blob (WFQ-003) by
 * trying each complete top-level JSON object, reporter-blob-first. Returns
 * `null` — which the caller turns into a fail-closed `shape-mismatch` — only
 * when no candidate is a recognizable vitest result.
 */
export function parseVitestResult(raw: string): IntegrationSuiteParse | null {
  for (const candidate of vitestJsonCandidates(raw)) {
    const parsed = parseVitestDocument(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

// ============================================================
// REPORT
// ============================================================

/**
 * Counts, not transcripts: a load cascade can list hundreds of files. The
 * report enumerates at most N of them, then a single total-count line steers to
 * the uncapped escape hatch (re-run the suite locally). A fixed internal cap,
 * deliberately NOT a schema parameter — the caller has no basis for choosing a
 * different number and a knob here would only make reports incomparable.
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
 * The report for a runner whose only output is an exit code.
 *
 * It states what it could not measure, so a reader never mistakes the absent
 * counts for zeros. The verdict itself is complete: the runner was asked to run
 * the suite and it either succeeded or it did not.
 */
function buildExitCodeReport(repoRoot: string, command: string, exitCode: number): string {
  return [
    '## Integration Suite Report',
    '',
    `**Repository:** \`${repoRoot}\``,
    `**Command:** \`${command}\``,
    '**Result carrier:** exit code — this invocation produces no machine-readable ' +
      'summary the gate can read.',
    '',
    'Suite, test and load-failure counts are not reportable on this carrier: from ' +
      'outside the runner a file that failed to load is indistinguishable from a ' +
      'failed assertion. The exit code is the whole verdict — and a complete one: ' +
      'a runner whose files fail to import still exits non-zero.',
    '',
    '---',
    '',
    exitCode === 0
      ? '**Result: PASS** (runner exited 0)'
      : `**Result: FAIL** (runner exited ${exitCode})`,
  ].join('\n');
}

/**
 * The report for a run that reached no verdict. Named as neither a pass nor a
 * failure, because claiming either would report something nothing observed.
 *
 * It also has to say what to DO, and that is not padding. The carrier omits
 * `passed`, which is honest but is also the only field anything downstream turns
 * into a stop — see the reader survey on {@link runIntegrationSuite}. Until an
 * admission requirement claims this gate's evidence, the caller reading this
 * report IS the enforcement, so the report states the non-clearance instead of
 * leaving it to be inferred.
 */
function buildIndeterminateReport(
  repoRoot: string,
  skipReason: IntegrationSuiteSkipReason,
  reason: string,
): string {
  return [
    '## Integration Suite Report',
    '',
    `**Repository:** \`${repoRoot}\``,
    '',
    `- **INDETERMINATE** (\`${skipReason}\`): ${reason}`,
    '',
    '---',
    '',
    '**Result: INDETERMINATE** — the suite did not run to a conclusion here, ' +
      'so this is neither proof that it passes nor a finding that it fails.',
    '',
    '**This rung is NOT cleared.** Fix the cause above and re-run the gate. Do ' +
      'not treat this result as a pass, and do not proceed past a step whose ' +
      'failure policy is `stop`.',
  ].join('\n');
}

// ============================================================
// RUNNER
// ============================================================

/**
 * The counted carrier's fail-closed result: the runner RAN and promised a
 * machine-readable report that did not arrive.
 *
 * Failing closed here is a finding, not a guess — a zero exit is compatible with
 * a crashed or garbled reporter, so trusting it would be the false green the
 * fold-in rule exists to prevent. The counts it stamps are the minimum that
 * cannot read as "nothing wrong"; the report says where they came from.
 */
function failClosed(repoRoot: string, exitCode: number, detail: string): IntegrationSuiteRun {
  return {
    kind: 'vitest-counts',
    passed: false,
    failedSuites: 1,
    failedTests: 0,
    loadFailures: 1,
    totalTests: 0,
    failCount: 1,
    loadFailureFiles: [],
    parseError: true,
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
      '**Result: FAIL** (unparseable output)',
    ].join('\n'),
  };
}

/** No verdict, and why. */
function indeterminate(
  repoRoot: string,
  skipReason: IntegrationSuiteSkipReason,
  reason: string,
): IntegrationSuiteRun {
  return {
    kind: 'indeterminate',
    skipReason,
    reason,
    report: buildIndeterminateReport(repoRoot, skipReason, reason),
  };
}

/**
 * Run the governed repository's test suite against `repoRoot`. Pure aside from
 * the injected `runCommand`.
 *
 * The command comes from the layered resolver and the way its result is read
 * comes from the registry's carrier table, so the three outcomes are:
 *   • `vitest-counts`  — the runner emitted a per-suite JSON summary; load
 *                        failures are folded into the failure count so a load
 *                        cascade can never read as zero (#1329).
 *   • `exit-code`      — the runner reports only an exit code, and that IS the
 *                        verdict. Complete, and honest about what it omits.
 *   • `indeterminate`  — no command could be resolved, or the runner never ran
 *                        to a conclusion. Not a pass, not a failure.
 *
 * WHO READS AN INDETERMINATE, honestly surveyed — because the carrier used to
 * carry prose asserting a guarantee that is not in the tree:
 *   • `normalizeGateVerdict` maps the `skipped` marker to `'indeterminate'`, and
 *     the durable `admission.evidence-recorded` row keeps the reason. That row
 *     is folded into the workflow projection for AUDIT/SHADOW VISIBILITY ONLY —
 *     the projection says so at the fold — so it alters no phase and no guard.
 *   • the admission evaluator WOULD deny on an indeterminate gate, but it only
 *     ever adjudicates requirements an edge obligation claims
 *     (`req:gate:<gateId>:<edge>`). This gate stamps
 *     `verification-ladder:integration-suite`, which no edge claims, so that
 *     path never reaches this evidence.
 *   • the runbook step carries `onFail: 'stop'`, and the runbook contract states
 *     the projection is advisory — no step is halted on anyone's behalf.
 * The enforcement is therefore the CALLER reading this carrier, which is why
 * the indeterminate report states the non-clearance in words and why `passed`
 * stays absent: a `false` here would be a red nothing observed, and a `true`
 * would be proof nothing produced.
 */
export function runIntegrationSuite(input: RunIntegrationSuiteInput): IntegrationSuiteRun {
  const { repoRoot, runCommand, testScript, resolveRuntime } = input;

  const resolution = resolveIntegrationCommand(
    repoRoot,
    testScript,
    resolveRuntime ?? resolveIntegrationRuntime,
  );
  if (resolution.kind === 'unrunnable') {
    return indeterminate(repoRoot, resolution.skipReason, resolution.reason);
  }

  const { cmd, args, format } = resolution;
  const cmdResult = runCommand(cmd, args, { cwd: repoRoot });

  // ── Two outcomes that belong to no carrier ────────────────────────────────
  // Both are checked BEFORE the carrier switch, because both describe a process
  // that produced no evidence about the suite, and each carrier would misread
  // them in its own way — one as a verdict, the other as a garbled report.

  // Killed for exceeding its wall clock: whatever is on stdout is a truncated
  // prefix and the exit status belongs to the kill, not to the suite.
  if (cmdResult.timedOut === true) {
    return indeterminate(
      repoRoot,
      'runner-timeout',
      `\`${cmd}\` was killed for exceeding its time limit before the suite finished`,
    );
  }

  // Never started: there is no exit code to read and no report to miss. This
  // used to fail CLOSED on the counted carrier, minting `passed: false` for a
  // suite nothing ran — a red that named a failure nobody observed, and one the
  // exit-code carrier already refused to name for the very same event. The
  // command comes from the repository's own configuration now, so "it could not
  // be launched" is a configuration finding, not a test result.
  if (cmdResult.spawnError) {
    return indeterminate(
      repoRoot,
      'runner-unavailable',
      `runner failed to spawn (\`${cmd}\`: ${cmdResult.spawnError})`,
    );
  }

  switch (format.kind) {
    case 'exit-code-only':
      return {
        kind: 'exit-code',
        passed: cmdResult.exitCode === 0,
        exitCode: cmdResult.exitCode,
        report: buildExitCodeReport(repoRoot, [cmd, ...args].join(' '), cmdResult.exitCode),
      };
    case 'vitest-json': {
      const parse = parseVitestResult(cmdResult.stdout);
      if (parse === null) {
        // Ran, but the output is not recognizable vitest JSON. Fail CLOSED — a
        // zero exit here can mask a crashed or garbled reporter.
        return failClosed(
          repoRoot,
          cmdResult.exitCode,
          'runner produced no parseable vitest JSON (ran, but the output shape was unrecognized)',
        );
      }

      return {
        kind: 'vitest-counts',
        ...parse,
        parseError: false,
        exitCode: cmdResult.exitCode,
        report: buildReport(repoRoot, parse),
      };
    }
    default:
      return assertNever(format, 'TestReportFormat');
  }
}
