/**
 * The kill-probe gate for `check_test_adequacy`. It proves that the tests of a task are not vacuous, with mutation testing at N=1.
 * The probe first runs the new or changed tests on the task source, and they must pass.
 * Then it reverts only the source files of the task and keeps the test files and the test-support files. It runs the same tests again and expects at least one to go red.
 * A test that survives the source revert asserts nothing about the change.
 *
 * `splitHunks` is exported so the mock-boundary gate can reuse the same classification.
 */

import type { GitExec } from '../pure/execute-merge.js';
import { assertNever } from '../../contract/error-families.js';

/**
 * Default test-file globs when the resolved toolchain/config supplies none.
 * Co-located convention: `*.test.*`, `*.spec.*`, and anything under a
 * `__tests__/` directory. Matched against the full (repo-relative) path.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
];

/**
 * The directory names that mark test support, such as a helper, a mock or a fixture.
 * A changed file that is not a test file and has a directory segment with one of these names is test support.
 * The probe does not revert test support. A reverted helper can make a test fail to load, and such a red run proves no kill.
 *
 * The table is a deliberate subset of the names that projects use for test support, such as `testdata` or `spec`.
 * Each name keeps more files out of the revert, so the owner chose a short table. A later change can make it configurable.
 */
export const DEFAULT_TEST_SUPPORT_SEGMENTS: readonly string[] = [
  'tests',
  'test',
  '__tests__',
  '__mocks__',
  '__fixtures__',
  'fixtures',
  'test-helpers',
];

export interface SplitHunksOptions {
  /**
   * Test-file globs from the resolved toolchain/config. When provided these
   * REPLACE the co-located defaults (the toolchain is authoritative about what
   * a "test file" is for that project). When omitted, {@link DEFAULT_TEST_GLOBS}
   * is used.
   */
  readonly testGlobs?: readonly string[] | undefined;
}

export interface SplitHunksResult {
  /** Changed files classified as tests, in input order. */
  readonly testFiles: string[];
  /** Changed files classified as source, in input order. A source file is not a test and not test support. */
  readonly sourceFiles: string[];
  /** Changed files that are not tests and sit under a test-support directory, in input order. They are in neither list above. */
  readonly supportFiles: string[];
}

/**
 * Translate a single glob into a RegExp anchored to the whole path.
 *
 * Supported tokens (sufficient for the co-located test conventions and simple
 * toolchain-supplied globs — NOT a full glob engine):
 *   • `**` (optionally followed by `/`) → any number of path segments
 *   • `*`                               → any run of non-`/` characters
 *   • every other character is matched literally
 */
function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out);
}

/** Returns true when a directory segment of the repo-relative path is in {@link DEFAULT_TEST_SUPPORT_SEGMENTS}. The file name is not a directory segment. */
function isTestSupport(file: string): boolean {
  return file
    .split('/')
    .slice(0, -1)
    .some((segment) => DEFAULT_TEST_SUPPORT_SEGMENTS.includes(segment));
}

/**
 * Classifies the changed files of a task diff as test, test support or source at the file level. Each file is in one class.
 * A file that matches a test glob is a test. Else a file under a test-support directory is test support. Every other file is source.
 *
 * The function is pure. It makes no git calls and no file system reads.
 *
 * @param changedFiles - repo-relative paths changed by the task diff
 * @param options.testGlobs - optional override for the test-file globs
 */
export function splitHunks(
  changedFiles: readonly string[],
  options?: SplitHunksOptions,
): SplitHunksResult {
  const globs = options?.testGlobs ?? DEFAULT_TEST_GLOBS;
  const matchers = globs.map(globToRegExp);

  const testFiles: string[] = [];
  const sourceFiles: string[] = [];
  const supportFiles: string[] = [];

  for (const file of changedFiles) {
    if (matchers.some((re) => re.test(file))) {
      testFiles.push(file);
    } else if (isTestSupport(file)) {
      supportFiles.push(file);
    } else {
      sourceFiles.push(file);
    }
  }

  return { testFiles, sourceFiles, supportFiles };
}

/**
 * Resolves the test globs for the probe from the globs that a detected toolchain prescribes.
 * `testGlobsForToolchain` returns a replacement set, and `splitHunks` uses it in place of the defaults.
 * With only the toolchain globs, a polyglot repo (python at the root, `*.test.ts` beside the source) classifies each co-located test as source.
 * So the result is the union of the defaults and the toolchain globs, deduplicated, with the defaults first.
 * A test misclassified as source gives a false pass, so the union errs in the safe direction.
 */
export function resolveProbeTestGlobs(
  toolchainGlobs: readonly string[] | null | undefined,
): readonly string[] {
  if (!toolchainGlobs || toolchainGlobs.length === 0) return DEFAULT_TEST_GLOBS;
  const merged = [...DEFAULT_TEST_GLOBS];
  for (const glob of toolchainGlobs) {
    if (!merged.includes(glob)) merged.push(glob);
  }
  return merged;
}

/** Returns the listed names as a tuple of literal types, so one list can feed each closed type and each total table. */
function closedNames<const Names extends readonly [string, ...string[]]>(...names: Names): Names {
  return names;
}

/**
 * Each cause of an indeterminate probe, in one list. A reader that needs every cause, such as a grader or a test table, reads this list.
 * `run-no-verdict` means that a scoped test run ended with no green and no red result.
 */
export const ADEQUACY_DISCRIMINANTS = closedNames(
  'no-new-tests',
  'revert-conflict',
  'restore-failed',
  'diff-failed',
  'base-missing',
  'baseline-red',
  'run-no-verdict',
);

/** Discriminants for the gate's failure modes (carried on the result). */
export type AdequacyDiscriminant = (typeof ADEQUACY_DISCRIMINANTS)[number];

/**
 * Risk tiers that require the kill probe to run. On these tiers an indeterminate probe blocks and does not degrade to an advisory skip.
 * A medium or high task whose probe did not run is unverified, and a pass for it is a false advisory success.
 */
const PROBE_REQUIRED_TIERS: ReadonlySet<string> = new Set(['medium', 'high']);

/**
 * The verdict of a kill probe, and the single authority on whether the tests of a task are non-vacuous.
 * A probe that did not run gives `indeterminate`, which has no `passed` field. So a skipped check cannot look like a success.
 *
 * - `passed`        — the probe ran: it reverted the source, the scoped tests went red, and the worktree restored cleanly.
 * - `failed`        — the probe ran and the tests survived the source revert, or the result is otherwise conclusively bad.
 * - `indeterminate` — the probe did not run, or its result cannot be trusted. It is an absence of evidence.
 *                     {@link interpretProbeVerdict} decides by tier whether it blocks.
 */
export type ProbeVerdict =
  | { readonly kind: 'passed'; readonly probedTests: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string; readonly probedTests: readonly string[] }
  | {
      readonly kind: 'indeterminate';
      readonly cause: AdequacyDiscriminant;
      readonly detail: string;
    };

/**
 * How an indeterminate cause is treated when the tier does not require the probe.
 * `advisory-skippable` is a valid "nothing to do", which can degrade to a labelled advisory skip.
 * `always-blocking` means the probe had to run and did not. It fails closed at every tier.
 */
type IndeterminateHandling =
  | 'advisory-skippable'
  | 'always-blocking';

/**
 * The handling policy for each cause. It is a total `Record`, so a new discriminant without a decision is a compile error, not a silent advisory default.
 * Only `no-new-tests` is advisory, because it means there was nothing to probe.
 *
 * A diff, revert, or restore that fails is an execution failure of a probe that had to run. It fails closed on every tier, including low.
 * Tests that fail on the task source make a kill impossible to observe, so `baseline-red` also fails closed on every tier.
 * A test run with no verdict is never a kill and never a pass, so `run-no-verdict` fails closed on every tier.
 */
const INDETERMINATE_HANDLING: Readonly<Record<AdequacyDiscriminant, IndeterminateHandling>> = {
  'no-new-tests': 'advisory-skippable',
  'diff-failed': 'always-blocking',
  'revert-conflict': 'always-blocking',
  'restore-failed': 'always-blocking',
  'base-missing': 'always-blocking',
  'baseline-red': 'always-blocking',
  'run-no-verdict': 'always-blocking',
};

/**
 * What the probe did for each indeterminate cause. The report states it, so the text is true for each cause.
 * A probe that stopped on `baseline-red` ran the tests, so the report must not say that the probe did not run.
 */
const INDETERMINATE_OUTCOME: Readonly<Record<AdequacyDiscriminant, string>> = {
  'no-new-tests': 'the kill probe did not run',
  'diff-failed': 'the kill probe did not run',
  'base-missing': 'the kill probe did not run',
  'revert-conflict': 'the kill probe could not revert the source, so it observed no kill',
  'restore-failed': 'the kill probe could not snapshot or restore the working tree, so its result is not trusted',
  'baseline-red':
    'the kill probe stopped before the revert, because a red run after the revert proves no kill when the tests are red before it',
  'run-no-verdict':
    'the kill probe reached no verdict, because a scoped test run ended with no green and no red result, and such a run is never a kill',
};

/**
 * What the gate does about a verdict.
 * `advisory-skip` is a separate disposition, not a kind of `proved`. It carries `passed: true` for ladder routing, but every surface labels it a skip.
 */
export type AdequacyDisposition = 'proved' | 'blocked' | 'advisory-skip';

/** The tier-applied reading of a {@link ProbeVerdict}. */
export interface AdequacyInterpretation {
  readonly disposition: AdequacyDisposition;
  /** DERIVED from {@link disposition} — never authored independently. */
  readonly passed: boolean;
  /** True iff this is an explicitly-labelled skip (never proof). */
  readonly skipped: boolean;
  /** Self-explanatory diagnosis. Absent only for an unremarkable proof. */
  readonly report?: string;
}

/**
 * Applies the risk-tier policy to a {@link ProbeVerdict}. This is the only place where a probe outcome becomes a boolean.
 *   • `passed`        → proved.
 *   • `failed`        → blocked at every tier.
 *   • `indeterminate` → blocked at a required tier (medium or high). At a low or unset tier, an `advisory-skippable` cause
 *                       degrades to a labelled advisory skip, and an `always-blocking` cause still blocks.
 *
 * The switch is exhaustive (`assertNever`), so a new variant cannot pass silently.
 */
export function interpretProbeVerdict(
  verdict: ProbeVerdict,
  riskTier?: string,
): AdequacyInterpretation {
  switch (verdict.kind) {
    case 'passed':
      return { disposition: 'proved', passed: true, skipped: false };
    case 'failed':
      return {
        disposition: 'blocked',
        passed: false,
        skipped: false,
        report: verdict.reason,
      };
    case 'indeterminate': {
      const probeRequired = PROBE_REQUIRED_TIERS.has(riskTier ?? '');
      const handling = INDETERMINATE_HANDLING[verdict.cause];
      const outcome = INDETERMINATE_OUTCOME[verdict.cause];
      if (probeRequired || handling === 'always-blocking') {
        const tierClause = probeRequired
          ? `Adequacy is unproven, because the ${riskTier} tier requires a kill probe.`
          : 'Test adequacy is unproven.';
        return {
          disposition: 'blocked',
          passed: false,
          skipped: false,
          report: `${verdict.detail} — ${outcome}. ${tierClause}`,
        };
      }
      return {
        disposition: 'advisory-skip',
        passed: true,
        skipped: true,
        report:
          `${verdict.detail} — ${outcome}. This is an advisory ` +
          `SKIP, NOT proof of test adequacy.`,
      };
    }
    default:
      return assertNever(verdict, 'ProbeVerdict');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard for a {@link ProbeVerdict} arriving as `unknown`. */
export function isProbeVerdict(value: unknown): value is ProbeVerdict {
  if (!isRecord(value)) return false;
  const kind = value['kind'];
  return kind === 'passed' || kind === 'failed' || kind === 'indeterminate';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readDiscriminant(value: unknown): AdequacyDiscriminant | undefined {
  return ADEQUACY_DISCRIMINANTS.find((discriminant) => discriminant === value);
}

/**
 * Recovers the authoritative {@link ProbeVerdict} from a probe carrier.
 * `runProbe` always stamps `verdict`, so the first branch is the production path.
 * The rebuild serves carriers from outside this module, such as test doubles with the legacy `ProbeResult` shape. It is total and fails closed:
 *   • It never reads `passed`. A fake vacuous pass (`{passed:true, discriminant:'no-new-tests'}`) becomes indeterminate and meets the tier policy again.
 *   • A known discriminant gives `indeterminate`. An unknown discriminant gives `failed`, never a pass.
 *   • Otherwise `redObserved && restoredClean` gives `passed`, and anything else gives `failed`.
 */
export function verdictOf(carrier: unknown): ProbeVerdict {
  const record = isRecord(carrier) ? carrier : {};
  const stamped = record['verdict'];
  if (isProbeVerdict(stamped)) return stamped;

  const probedTests = readStringArray(record['probedTests']);
  const report = readNonEmptyString(record['report']);
  const rawDiscriminant = record['discriminant'];
  const discriminant = readDiscriminant(rawDiscriminant);
  if (discriminant !== undefined) {
    return {
      kind: 'indeterminate',
      cause: discriminant,
      detail: report ?? `the probe reported '${discriminant}'`,
    };
  }
  const unknownDiscriminant = readNonEmptyString(rawDiscriminant);
  if (unknownDiscriminant !== undefined) {
    return {
      kind: 'failed',
      reason: `unrecognised probe discriminant '${unknownDiscriminant}' — failing closed`,
      probedTests,
    };
  }

  const redObserved = record['redObserved'] === true;
  const restoredClean = record['restoredClean'] !== false;
  if (redObserved && restoredClean) {
    return { kind: 'passed', probedTests };
  }
  return {
    kind: 'failed',
    reason:
      report ??
      'the scoped tests did not go red on the reverted source (no kill observed)',
    probedTests,
  };
}

export type SnapshotResult =
  | { readonly stashSha: string }
  | { readonly error: string };

export type RevertResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly discriminant: 'revert-conflict'; readonly detail: string };

export interface RestoreResult {
  readonly restored: boolean;
  readonly detail?: string;
}

/**
 * Captures the current working tree as an object-only snapshot. It does not throw.
 * `git stash create` writes a commit object of the dirty tree and returns its sha, and changes no ref.
 * `stash push` and `stash pop` change the stash storage that all worktrees share, so the probe does not use them.
 * On a clean tree, `stash create` prints nothing, so the snapshot is the HEAD commit.
 */
export function snapshotWorkingTree(gitExec: GitExec, repoRoot: string): SnapshotResult {
  try {
    const created = gitExec(repoRoot, ['stash', 'create']);
    if (created.exitCode !== 0) {
      return { error: `git stash create exited ${created.exitCode}: ${created.stdout.trim()}` };
    }
    const sha = created.stdout.trim();
    if (sha) {
      return { stashSha: sha };
    }
    const head = gitExec(repoRoot, ['rev-parse', 'HEAD']);
    if (head.exitCode !== 0) {
      return { error: `git rev-parse HEAD exited ${head.exitCode}: ${head.stdout.trim()}` };
    }
    const headSha = head.stdout.trim();
    if (!headSha) return { error: 'empty sha from git rev-parse HEAD' };
    return { stashSha: headSha };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reverts only the given source files to their state at `baseRef`. It never runs `reset --hard`.
 * A path that exists at the base gets a targeted checkout. A tracked path that the task added is removed, so the probe recreates the base.
 * A path that is absent from the base and from the current index is a `revert-conflict`, as is a git failure.
 * An empty file list is a trivial success.
 */
export function revertSourceFiles(
  gitExec: GitExec,
  repoRoot: string,
  baseRef: string,
  sourceFiles: readonly string[],
): RevertResult {
  if (sourceFiles.length === 0) {
    return { ok: true };
  }
  try {
    const verifiedBase = gitExec(repoRoot, [
      'rev-parse',
      '--verify',
      `${baseRef}^{commit}`,
    ]);
    if (verifiedBase.exitCode !== 0) {
      return {
        ok: false,
        discriminant: 'revert-conflict',
        detail: `git rev-parse ${baseRef} exited ${verifiedBase.exitCode}: ${verifiedBase.stdout.trim()}`,
      };
    }

    const basePaths: string[] = [];
    const taskAddedPaths: string[] = [];
    for (const sourceFile of sourceFiles) {
      const atBase = gitExec(repoRoot, [
        'cat-file',
        '-e',
        `${baseRef}:${sourceFile}`,
      ]);
      if (atBase.exitCode === 0) {
        basePaths.push(sourceFile);
        continue;
      }

      const trackedNow = gitExec(repoRoot, [
        'ls-files',
        '--error-unmatch',
        '--',
        sourceFile,
      ]);
      if (trackedNow.exitCode !== 0) {
        return {
          ok: false,
          discriminant: 'revert-conflict',
          detail: `source path is absent from both ${baseRef} and the current index: ${sourceFile}`,
        };
      }
      taskAddedPaths.push(sourceFile);
    }

    if (basePaths.length > 0) {
      const checkout = gitExec(repoRoot, [
        'checkout',
        baseRef,
        '--',
        ...basePaths,
      ]);
      if (checkout.exitCode !== 0) {
        return {
          ok: false,
          discriminant: 'revert-conflict',
          detail: `git checkout ${baseRef} -- <source> exited ${checkout.exitCode}: ${checkout.stdout.trim()}`,
        };
      }
    }

    if (taskAddedPaths.length > 0) {
      const remove = gitExec(repoRoot, [
        'rm',
        '--force',
        '--',
        ...taskAddedPaths,
      ]);
      if (remove.exitCode !== 0) {
        return {
          ok: false,
          discriminant: 'revert-conflict',
          detail: `git rm -- <task-added-source> exited ${remove.exitCode}: ${remove.stdout.trim()}`,
        };
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      discriminant: 'revert-conflict',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Restores the index and the tracked files to the tree of the snapshot from {@link snapshotWorkingTree}. It does not throw.
 * The checkout is `--no-overlay`, so it also removes a tracked path that the snapshot does not hold.
 * The revert brings back each deleted or renamed source path of the base, and the default overlay checkout leaves that path staged.
 * A file that git does not track stays as it is. A git failure returns `restored: false`, and the probe reports `restore-failed`.
 */
export function restoreWorkingTree(
  gitExec: GitExec,
  repoRoot: string,
  stashSha: string,
): RestoreResult {
  try {
    const result = gitExec(repoRoot, ['checkout', '--no-overlay', stashSha, '--', '.']);
    if (result.exitCode !== 0) {
      return {
        restored: false,
        detail: `git checkout --no-overlay ${stashSha} -- . exited ${result.exitCode}: ${result.stdout.trim()}`,
      };
    }
    return { restored: true };
  } catch (err) {
    return { restored: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Each end of a scoped test run that gives no verdict, in one list. {@link RUN_NO_VERDICT_TEXT} says what each cause means.
 * `did-not-start` also covers a runner that failed with no exit status.
 * `unknown-exit-code` is an exit code that is not 0 and not a test-failure code of the toolchain.
 */
export const RUN_NO_VERDICT_CAUSES = closedNames(
  'no-command',
  'unparseable-command',
  'did-not-start',
  'timeout',
  'signal',
  'overflow',
  'unknown-exit-code',
);

/** An end of a scoped test run that gives no verdict. */
export type RunNoVerdictCause = (typeof RUN_NO_VERDICT_CAUSES)[number];

/** The words of the probe text for each no-verdict cause. It is a total `Record`, so a new cause without a text is a compile error. */
const RUN_NO_VERDICT_TEXT: Readonly<Record<RunNoVerdictCause, string>> = {
  'no-command': 'no test command resolves for the repository',
  'unparseable-command': 'the test command does not split into a program and its arguments',
  'did-not-start': 'the test command did not start',
  timeout: 'the test command ran past its time limit',
  signal: 'a signal stopped the test command',
  overflow: 'the test command wrote more output than the runner reads',
  'unknown-exit-code': 'the test command exited with a code that the probe does not read as a test result',
};

/**
 * The outcome of one scoped test run during the probe.
 * `ran` is a run with a verdict: `green` for exit 0, and `red` for a test-failure exit code of the toolchain.
 * `no-verdict` is every other end, with its cause and a detail that names the fact, such as the exit code or the signal.
 * The probe never reads a `no-verdict` run as a kill or as a pass.
 */
export type RunOutcome =
  | {
      readonly kind: 'ran';
      readonly result: 'green' | 'red';
      readonly stdout?: string;
      readonly stderr?: string;
    }
  | {
      readonly kind: 'no-verdict';
      readonly cause: RunNoVerdictCause;
      readonly detail: string;
      readonly stdout?: string;
      readonly stderr?: string;
    };

/**
 * The injected runner of the resolved test command. It scopes the run to the new or changed test files where the runner allows.
 */
export type TestRunFn = (input: {
  readonly repoRoot: string;
  readonly testFiles: readonly string[];
}) => Promise<RunOutcome>;

export interface ProbeArgs {
  readonly gitExec: GitExec;
  readonly repoRoot: string;
  /** The base ref the task diff is measured against (revert target). */
  readonly baseRef: string;
  /** Repo-relative files changed by the task diff. */
  readonly changedFiles: readonly string[];
  /**
   * The changed files that the head side of the diff deletes. A renamed file gives its base path here.
   * They stay in the source revert, so the run after the revert sees them, and the restore removes them again.
   * A deleted test file is not at the head, so the probe never runs it.
   */
  readonly deletedFiles?: readonly string[];
  /** Runs the scoped test command and returns its run outcome. */
  readonly runTests: TestRunFn;
  /** Optional test-glob override forwarded to {@link splitHunks}. */
  readonly testGlobs?: readonly string[];
  /**
   * Risk tier of the task under probe. Governs whether an empty test set is an
   * advisory skip (low / unset) or a blocking failure (medium / high). See
   * {@link PROBE_REQUIRED_TIERS}.
   */
  readonly riskTier?: string;
  /**
   * True when the caller cannot compute the task diff (a git failure).
   * It separates a task that changed nothing from a diff that is unknown. An unknown diff never passes.
   */
  readonly diffFailed?: boolean;
}

export interface ProbeResult {
  /**
   * The single authority for this result. Each other verdict field below derives from it and the risk tier, in {@link toProbeResult}.
   * An exhaustive switch on `verdict.kind` is better than the derived boolean, which exists for wire compatibility.
   */
  readonly verdict: ProbeVerdict;
  /**
   * Derived. The gate verdict as a boolean. A pass is either a proof or a labelled advisory skip ({@link skipped}, never proof).
   * Read {@link disposition} to tell them apart. This boolean cannot carry that difference.
   */
  readonly passed: boolean;
  /** DERIVED. What the gate does about {@link verdict}. */
  readonly disposition: AdequacyDisposition;
  /**
   * DERIVED. Present and `true` ONLY for a non-blocking advisory skip — a
   * check that DID NOT RUN. Never set on a real proof.
   */
  readonly skipped?: boolean;
  /** The classified test files the probe ran. */
  readonly probedTests: string[];
  /** True when the scoped tests FAILED on the reverted source (the kill). */
  readonly redObserved: boolean;
  /** True when the working tree was restored to its pre-probe snapshot. */
  readonly restoredClean: boolean;
  /** DERIVED. Set iff the verdict is indeterminate — names the cause. */
  readonly discriminant?: AdequacyDiscriminant;
  /**
   * The diagnosis from {@link interpretProbeVerdict}. It is present for a `failed` or `indeterminate` verdict, and absent for a proof.
   */
  readonly report?: string;
}

/**
 * Facts that a probe run observes beside its verdict. They are diagnostics, not verdict channels. They must not be read as pass or fail.
 */
interface ProbeFacts {
  readonly probedTests: string[];
  readonly redObserved: boolean;
  readonly restoredClean: boolean;
}

/**
 * Derives the wire-compatible {@link ProbeResult} from the authoritative {@link ProbeVerdict}.
 * It is the only constructor of a `ProbeResult` in this module. No call site sets `passed` by hand, so "did not run" cannot be typed as success.
 */
function toProbeResult(
  verdict: ProbeVerdict,
  facts: ProbeFacts,
  riskTier?: string,
): ProbeResult {
  const interpretation = interpretProbeVerdict(verdict, riskTier);
  return {
    verdict,
    passed: interpretation.passed,
    disposition: interpretation.disposition,
    ...(interpretation.skipped ? { skipped: true } : {}),
    probedTests: facts.probedTests,
    redObserved: facts.redObserved,
    restoredClean: facts.restoredClean,
    ...(verdict.kind === 'indeterminate' ? { discriminant: verdict.cause } : {}),
    ...(interpretation.report === undefined ? {} : { report: interpretation.report }),
  };
}

/**
 * The result of a probe that did not start, because a check failed before the start.
 * The verdict is indeterminate, with nothing probed and nothing to restore. Tier policy decides
 * whether it blocks, as for any other cause.
 */
export function probeNotRun(cause: AdequacyDiscriminant, detail: string, riskTier?: string): ProbeResult {
  return toProbeResult(
    { kind: 'indeterminate', cause, detail },
    { probedTests: [], redObserved: false, restoredClean: true },
    riskTier,
  );
}

/** The number of trailing lines of runner output that a `baseline-red` or `run-no-verdict` detail keeps. */
const OUTPUT_TAIL_LINES = 20;

/** The largest number of characters of runner output that a `baseline-red` or `run-no-verdict` detail keeps. */
const OUTPUT_TAIL_CHARS = 2_000;

/** The largest number of characters of the first stderr line that a detail keeps ahead of the tail. */
const FIRST_STDERR_LINE_CHARS = 500;

/**
 * Returns the last lines of the runner output, stdout and then stderr, or a note when the runner gave no output.
 * The first non-empty stderr line comes first when the tail does not hold it. A runner often names its cause there, such as "No test files found".
 */
function outputTail(outcome: RunOutcome): string {
  const stderr = outcome.stderr ?? '';
  const text = [outcome.stdout ?? '', stderr].filter((part) => part.trim().length > 0).join('\n').trimEnd();
  if (text.length === 0) return '(the runner gave no output)';
  const lines = text.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
  const tail = lines.length > OUTPUT_TAIL_CHARS ? lines.slice(-OUTPUT_TAIL_CHARS) : lines;
  const firstStderrLine = stderr.split('\n').find((line) => line.trim().length > 0)?.trim();
  if (firstStderrLine === undefined || tail.includes(firstStderrLine)) return tail;
  return `${firstStderrLine.slice(0, FIRST_STDERR_LINE_CHARS)}\n...\n${tail}`;
}

/** Returns true for a run with a green verdict. A red run and a run with no verdict are not green. */
function isGreenRun(outcome: RunOutcome): boolean {
  switch (outcome.kind) {
    case 'ran':
      return outcome.result === 'green';
    case 'no-verdict':
      return false;
    default:
      return assertNever(outcome, 'RunOutcome');
  }
}

/** The detail of a `run-no-verdict` verdict. It names the run, the cause, the fact of the runner and the tail of the output. */
function noVerdictDetail(
  run: string,
  outcome: Extract<RunOutcome, { readonly kind: 'no-verdict' }>,
): string {
  return (
    `the scoped test run ${run} reached no verdict (${outcome.cause}), because ` +
    `${RUN_NO_VERDICT_TEXT[outcome.cause]}: ${outcome.detail}. ` +
    `The runner output ends with:\n${outputTail(outcome)}`
  );
}

/**
 * Reads the run on the task source. A green run returns `undefined`, so the probe goes on to the revert.
 * A red run gives `baseline-red`, and a run with no verdict gives `run-no-verdict`.
 */
function preRunVerdict(outcome: RunOutcome): ProbeVerdict | undefined {
  switch (outcome.kind) {
    case 'ran':
      return outcome.result === 'green'
        ? undefined
        : {
            kind: 'indeterminate',
            cause: 'baseline-red',
            detail:
              'the scoped tests failed on the task source, before any revert. ' +
              `The runner output ends with:\n${outputTail(outcome)}`,
          };
    case 'no-verdict':
      return { kind: 'indeterminate', cause: 'run-no-verdict', detail: noVerdictDetail('on the task source', outcome) };
    default:
      return assertNever(outcome, 'RunOutcome');
  }
}

/**
 * Reads the run after the revert. A red run is a kill and gives `passed`. A green run gives `failed`, because the tests survived the revert.
 * A run with no verdict gives `run-no-verdict`, never a kill.
 */
function postRevertVerdict(outcome: RunOutcome, probedTests: string[]): ProbeVerdict {
  switch (outcome.kind) {
    case 'ran':
      return outcome.result === 'red'
        ? { kind: 'passed', probedTests }
        : {
            kind: 'failed',
            reason:
              'the scoped tests stayed GREEN with the task source reverted — ' +
              'they do not exercise the change (vacuous)',
            probedTests,
          };
    case 'no-verdict':
      return { kind: 'indeterminate', cause: 'run-no-verdict', detail: noVerdictDetail('after the revert', outcome) };
    default:
      return assertNever(outcome, 'RunOutcome');
  }
}

/**
 * Runs the kill probe. The test runner and the changed-file list are injected, so unit tests need no real test command.
 *
 *   1. Split the diff into test, test-support and source files. A deleted test file is not run. No test file left gives `no-new-tests`.
 *   2. Snapshot the working tree (a failed snapshot stops the probe before any change).
 *   3. Run the scoped tests on the task source. A red run gives `baseline-red`, because a later red run proves no kill.
 *   4. Revert only the source files to `baseRef` and run the tests again. A task with no source file skips this step and fails.
 *   5. Restore the working tree in a `finally`, so the restore runs even when a test run throws.
 *
 * Red after green gives `passed`, and green after green gives `failed`. A failed revert or restore gives `indeterminate`. A failed restore wins over `baseline-red` and `run-no-verdict`.
 * A run with no verdict, such as a timeout, a signal or an unknown exit code, gives `run-no-verdict`. A run that does not finish is never a kill.
 *
 * Limit: the probe reads every red run after the revert as a kill. A test can fail to load when the revert removes or changes a module that it imports.
 * An example is a module that the task adds or renames. A reverted config file, such as `package.json`, can make the run red or collect no test. Test files and test-support files are never reverted.
 */
export async function runProbe(args: ProbeArgs): Promise<ProbeResult> {
  const { gitExec, repoRoot, baseRef, changedFiles, runTests, testGlobs } = args;
  const riskTier = args.riskTier;

  if (args.diffFailed === true) {
    return toProbeResult(
      {
        kind: 'indeterminate',
        cause: 'diff-failed',
        detail: 'could not compute the task diff',
      },
      { probedTests: [], redObserved: false, restoredClean: true },
      riskTier,
    );
  }

  const deleted = new Set(args.deletedFiles ?? []);
  const split = splitHunks(changedFiles, { testGlobs });
  const testFiles = split.testFiles.filter((file) => !deleted.has(file));
  const sourceFiles = split.sourceFiles;

  if (testFiles.length === 0) {
    return toProbeResult(
      {
        kind: 'indeterminate',
        cause: 'no-new-tests',
        detail:
          'nothing to probe — no new or changed test files found in the task ' +
          'diff (the task adds no tests)',
      },
      { probedTests: [], redObserved: false, restoredClean: true },
      riskTier,
    );
  }

  const snap = snapshotWorkingTree(gitExec, repoRoot);
  if ('error' in snap) {
    return toProbeResult(
      {
        kind: 'indeterminate',
        cause: 'restore-failed',
        detail: `could not snapshot the working tree: ${snap.error}`,
      },
      { probedTests: testFiles, redObserved: false, restoredClean: false },
      riskTier,
    );
  }
  const stashSha = snap.stashSha;

  let preRun: RunOutcome | undefined;
  let postRevert: RunOutcome | undefined;
  let revertDetail: string | undefined;
  let restore: RestoreResult = { restored: false, detail: 'restore did not run' };

  try {
    preRun = await runTests({ repoRoot, testFiles });
    if (isGreenRun(preRun) && sourceFiles.length > 0) {
      const reverted = revertSourceFiles(gitExec, repoRoot, baseRef, sourceFiles);
      if (reverted.ok) {
        postRevert = await runTests({ repoRoot, testFiles });
      } else {
        revertDetail = reverted.detail;
      }
    }
  } finally {
    restore = restoreWorkingTree(gitExec, repoRoot, stashSha);
  }

  const restoredClean = restore.restored;
  const redObserved = postRevert !== undefined && postRevert.kind === 'ran' && postRevert.result === 'red';

  if (revertDetail !== undefined) {
    return toProbeResult(
      {
        kind: 'indeterminate',
        cause: 'revert-conflict',
        detail: `could not revert the task's source hunks: ${revertDetail}`,
      },
      { probedTests: testFiles, redObserved: false, restoredClean },
      riskTier,
    );
  }

  if (!restoredClean) {
    return toProbeResult(
      {
        kind: 'indeterminate',
        cause: 'restore-failed',
        detail: `could not restore the working tree: ${restore.detail ?? 'unknown'}`,
      },
      { probedTests: testFiles, redObserved, restoredClean },
      riskTier,
    );
  }

  const stoppedBeforeRevert = preRunVerdict(preRun);
  if (stoppedBeforeRevert !== undefined) {
    return toProbeResult(
      stoppedBeforeRevert,
      { probedTests: testFiles, redObserved: false, restoredClean },
      riskTier,
    );
  }

  if (postRevert === undefined) {
    return toProbeResult(
      {
        kind: 'failed',
        reason:
          'the task changes no source file, so the probe had nothing to revert ' +
          '(the probe keeps test files and test-support files) — ' +
          'the scoped tests stay GREEN and no kill is possible',
        probedTests: testFiles,
      },
      { probedTests: testFiles, redObserved, restoredClean },
      riskTier,
    );
  }

  return toProbeResult(
    postRevertVerdict(postRevert, testFiles),
    { probedTests: testFiles, redObserved, restoredClean },
    riskTier,
  );
}
