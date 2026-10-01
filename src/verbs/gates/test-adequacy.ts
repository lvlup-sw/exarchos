/**
 * The kill-probe gate for `check_test_adequacy`. It proves that the tests of a task are not vacuous, with mutation testing at N=1.
 * The probe reverts only the source files of the task and keeps the test files. Then it runs the new or changed tests and expects at least one to go red.
 * A test that survives the source revert asserts nothing about the change.
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
  /** Changed files classified as source (everything not a test), in input order. */
  readonly sourceFiles: string[];
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

/**
 * Classifies the changed files of a task diff as test or source at the file level. A file is wholly test or wholly source.
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

  for (const file of changedFiles) {
    const isTest = matchers.some((re) => re.test(file));
    if (isTest) {
      testFiles.push(file);
    } else {
      sourceFiles.push(file);
    }
  }

  return { testFiles, sourceFiles };
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

/** Discriminants for the gate's failure modes (carried on the result). */
export type AdequacyDiscriminant =
  | 'no-new-tests'
  | 'revert-conflict'
  | 'restore-failed'
  | 'diff-failed'
  | 'base-missing';

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
 * A diff, revert, or restore that fails is an execution failure of a probe that had to run. It fails closed on every tier, including low.
 */
const INDETERMINATE_HANDLING: Readonly<Record<AdequacyDiscriminant, IndeterminateHandling>> = {
  'no-new-tests': 'advisory-skippable',
  'diff-failed': 'always-blocking',
  'revert-conflict': 'always-blocking',
  'restore-failed': 'always-blocking',
  'base-missing': 'always-blocking',
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
      if (probeRequired || handling === 'always-blocking') {
        const tierClause = probeRequired
          ? ` the ${riskTier} tier requires a kill probe, so adequacy is unproven`
          : ' the kill probe did not run, so test adequacy is unproven';
        return {
          disposition: 'blocked',
          passed: false,
          skipped: false,
          report: `${verdict.detail} —${tierClause}`,
        };
      }
      return {
        disposition: 'advisory-skip',
        passed: true,
        skipped: true,
        report:
          `${verdict.detail} — the kill probe did not run. This is an advisory ` +
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
  return typeof value === 'string' && Object.hasOwn(INDETERMINATE_HANDLING, value)
    ? (value as AdequacyDiscriminant)
    : undefined;
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
 * Restore the working tree to the snapshot captured by
 * {@link snapshotWorkingTree}. Re-checks-out every tracked path from the
 * snapshot commit's tree (`git checkout <stashSha> -- .`), undoing the targeted
 * source revert. Total: returns `{ restored: false, detail }` on any git
 * failure so the orchestrator can fold a restore failure into a
 * `restore-failed` discriminant rather than crashing the gate.
 */
export function restoreWorkingTree(
  gitExec: GitExec,
  repoRoot: string,
  stashSha: string,
): RestoreResult {
  try {
    const result = gitExec(repoRoot, ['checkout', stashSha, '--', '.']);
    if (result.exitCode !== 0) {
      return {
        restored: false,
        detail: `git checkout ${stashSha} -- . exited ${result.exitCode}: ${result.stdout.trim()}`,
      };
    }
    return { restored: true };
  } catch (err) {
    return { restored: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Result of running the (scoped) test command during the probe. */
export interface TestRunResult {
  /** True when the scoped test run PASSED (all green). */
  readonly passed: boolean;
  /** Optional human-readable output for diagnostics. */
  readonly output?: string;
}

/**
 * The injected runner of the resolved test command. It scopes the run to the new or changed test files where the runner allows.
 */
export type TestRunFn = (input: {
  readonly repoRoot: string;
  readonly testFiles: readonly string[];
}) => Promise<TestRunResult>;

export interface ProbeArgs {
  readonly gitExec: GitExec;
  readonly repoRoot: string;
  /** The base ref the task diff is measured against (revert target). */
  readonly baseRef: string;
  /** Repo-relative files changed by the task diff. */
  readonly changedFiles: readonly string[];
  /** Runs the scoped test command and returns pass or fail. */
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

/**
 * Runs the kill probe. The test runner and the changed-file list are injected, so unit tests need no real test command.
 *
 *   1. Split the diff into test and source files (no new or changed test file gives indeterminate `no-new-tests`).
 *   2. Snapshot the working tree (a failed snapshot stops the probe before any change).
 *   3. Revert the source files to `baseRef` (a conflict gives indeterminate `revert-conflict`).
 *   4. Run the scoped tests (`redObserved` is true when they fail).
 *   5. Restore the working tree in a `finally`, so the restore runs even when the test run throws.
 *
 * Red with a clean restore gives `passed`. Green tests give `failed`. Anything that stops the probe gives `indeterminate`.
 * A failed diff always blocks. {@link interpretProbeVerdict} applies the tier to derive the legacy `passed` boolean.
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

  const { testFiles, sourceFiles } = splitHunks(changedFiles, { testGlobs });

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

  let redObserved = false;
  let revertDetail: string | undefined;
  let restore: RestoreResult = { restored: false, detail: 'restore did not run' };

  try {
    if (sourceFiles.length > 0) {
      const reverted = revertSourceFiles(gitExec, repoRoot, baseRef, sourceFiles);
      if (!reverted.ok) {
        revertDetail = reverted.detail;
      }
    }

    if (revertDetail === undefined) {
      const runResult = await runTests({ repoRoot, testFiles });
      redObserved = !runResult.passed;
    }
  } finally {
    restore = restoreWorkingTree(gitExec, repoRoot, stashSha);
  }

  const restoredClean = restore.restored;

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

  return toProbeResult(
    redObserved
      ? { kind: 'passed', probedTests: testFiles }
      : {
          kind: 'failed',
          reason:
            'the scoped tests stayed GREEN with the task source reverted — ' +
            'they do not exercise the change (vacuous)',
          probedTests: testFiles,
        },
    { probedTests: testFiles, redObserved, restoredClean },
    riskTier,
  );
}
