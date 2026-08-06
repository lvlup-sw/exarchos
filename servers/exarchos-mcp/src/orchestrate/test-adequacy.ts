// ─── check_test_adequacy — kill-probe gate ───────────────────────────────────
//
// Verification-ladder slice 1, Bundle B2. Proves a task's tests are NOT vacuous
// using "mutation testing at N=1": revert ONLY the task's SOURCE hunks (keeping
// the test hunks), re-run the new/changed tests, and assert at least one goes
// red. A test that survives the source revert asserted nothing about the change.
//
// This module is built bottom-up across tasks 011–013:
//   • task 011 — splitHunks (pure file-level test/source classification)
//
// `splitHunks` is exported cleanly so a sibling bundle (mock-boundary) can reuse
// the same classification without re-deriving the test globs.
// ────────────────────────────────────────────────────────────────────────────

import type { GitExec } from './pure/execute-merge.js';
import { assertNever } from '../contract/error-families.js';

// ─── splitHunks (task 011) ───────────────────────────────────────────────────

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
        // `**/` consumes zero-or-more leading segments; bare `**` matches all.
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
    // Escape regex metacharacters so the rest is matched literally.
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out);
}

/**
 * Classify a task diff's changed files into test vs source at the FILE level
 * (a file is wholly test or wholly source — never split mid-file). Pure: takes
 * the changed-file list and optional test globs, returns the partition. No git
 * calls, no fs access.
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
 * Resolve the test globs the PROBE should classify with, given the globs a
 * detected toolchain prescribes.
 *
 * SUBJECT FAULT (fixed here): `testGlobsForToolchain` returns a REPLACEMENT set
 * (`splitHunks` uses `options.testGlobs ?? DEFAULT_TEST_GLOBS`). Threading it
 * straight through meant that in ANY repo whose root marker resolves to a
 * toolchain with a prescribed layout (python `pyproject.toml`, rust
 * `Cargo.toml`, ruby `Gemfile`, …), the co-located conventions
 * (`*.test.*`, `*.spec.*`, `__tests__/**`) STOPPED being recognised. A polyglot
 * repo — python at the root, co-located `*.test.ts` beside the source — had
 * every one of its test files classified as SOURCE, so the probe resolved ZERO
 * test files and reported `no-new-tests` for a task that plainly added tests.
 * The gate was probing the wrong subject; at low/unset tier that surfaced as a
 * vacuous PASS.
 *
 * The toolchain layout is ADDITIVE, not authoritative-exclusive: a repo can
 * have both `tests/test_foo.py` AND `src/calc.test.ts`, and both are tests.
 * Union (deduped, defaults first) is the only classification that is correct
 * for both. Misclassifying a test as source is the failure mode that produces
 * false PASSES, so the union errs in the safe direction.
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

// ─── snapshot / revert / restore (task 012, INV-14) ──────────────────────────
//
// The probe MUST be able to restore the working tree to exactly what it was
// before the mutation, even if the test-run step throws. We capture the tree
// with `git stash create` (object-only — it produces a commit object and
// mutates NO ref, so it is NOT the banned `stash push`/`stash pop`). Reverting
// source files is a targeted `git checkout <base> -- <files>` (never
// `reset --hard`). Restore re-checks-out the snapshot tree.
//
// All three are total: they translate git failures into structured discriminants
// rather than throwing, so the orchestrator can run them under a finally and
// always reach restore.

/** Discriminants for the gate's failure modes (carried on the result). */
export type AdequacyDiscriminant =
  | 'no-new-tests'
  | 'revert-conflict'
  | 'restore-failed'
  | 'diff-failed';

/**
 * Risk tiers that require the kill probe to actually run. On these tiers an
 * INDETERMINATE probe is a blocking failure rather than an advisory skip
 * (WFQ-005): a medium/high task whose probe did not run has not been verified,
 * and reporting that as a pass is the "false advisory success" the gate exists
 * to prevent.
 */
const PROBE_REQUIRED_TIERS: ReadonlySet<string> = new Set(['medium', 'high']);

// ─── ProbeVerdict — "could not run" is not "ran and passed" ──────────────────
//
// The root defect class this union closes: `passed: boolean` gave "the probe
// ran and proved the tests non-vacuous" and "the probe could not run at all"
// ONE channel, so a SKIPPED check was representable as a SUCCESS. Every path
// that fell through to `passed: true` without a kill was, structurally, a
// vacuous pass waiting to happen.
//
// `ProbeVerdict` makes that unrepresentable: a probe that did not run yields
// `indeterminate`, which has NO `passed` field to set. The boolean the gate
// eventually reports is DERIVED from this union plus the risk tier
// (`interpretProbeVerdict`) and can never be authored independently of it.

/**
 * The verdict of a kill probe. The SINGLE authority for whether a task's tests
 * were proven non-vacuous.
 *
 * - `passed`        — the probe RAN: source was reverted, the scoped tests went
 *                     red, and the worktree restored cleanly. Real proof.
 * - `failed`        — the probe RAN and the tests SURVIVED the source revert
 *                     (or the run was otherwise conclusively bad). Real
 *                     disproof.
 * - `indeterminate` — the probe DID NOT RUN (or could not be trusted). NOT a
 *                     pass and NOT a failure of the tests: an absence of
 *                     evidence. Whether that blocks is a TIER policy decision
 *                     ({@link interpretProbeVerdict}), never a probe decision.
 */
export type ProbeVerdict =
  | { readonly kind: 'passed'; readonly probedTests: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string; readonly probedTests: readonly string[] }
  | {
      readonly kind: 'indeterminate';
      readonly cause: AdequacyDiscriminant;
      readonly detail: string;
    };

/** How an indeterminate cause is treated when the tier does NOT require the probe. */
type IndeterminateHandling =
  /** A legitimate "nothing to do" — may degrade to a labelled advisory skip (INV-4). */
  | 'advisory-skippable'
  /** The probe was SUPPOSED to run and could not. Fails closed at EVERY tier. */
  | 'always-blocking';

/**
 * Per-cause handling policy. Keyed by {@link AdequacyDiscriminant} as a total
 * `Record`, so adding a discriminant without deciding its handling is a COMPILE
 * error rather than a silent default-to-advisory (the exact hole that lets a
 * new "could not run" mode be laundered into a pass).
 *
 * Only `no-new-tests` is ever advisory: it is the one cause that means "there
 * was legitimately nothing to probe". A diff we could not compute, a revert we
 * could not apply, and a worktree we could not restore are all EXECUTION
 * failures of a probe that was supposed to run — they fail closed on every
 * tier, including low.
 */
const INDETERMINATE_HANDLING: Readonly<Record<AdequacyDiscriminant, IndeterminateHandling>> = {
  'no-new-tests': 'advisory-skippable',
  'diff-failed': 'always-blocking',
  'revert-conflict': 'always-blocking',
  'restore-failed': 'always-blocking',
};

/**
 * What the gate DOES about a verdict.
 *
 * `advisory-skip` is deliberately its own disposition rather than a flavour of
 * `proved`: it carries `passed: true` for ladder-routing compatibility, but it
 * is labelled a SKIP everywhere it surfaces so no reader (human or machine) can
 * mistake it for evidence of test adequacy.
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
 * Apply risk-tier policy to a {@link ProbeVerdict}. The ONLY place a probe
 * outcome becomes a boolean.
 *
 * Rules (WFQ-005):
 *   • `passed`        → proved (blocking-clean).
 *   • `failed`        → blocked. Always. No tier downgrades a real disproof.
 *   • `indeterminate` → blocked at a REQUIRED tier (medium/high) — a task whose
 *                       probe did not run is unverified, full stop. At low/unset
 *                       tier an `advisory-skippable` cause degrades to an
 *                       explicitly-labelled advisory SKIP; an `always-blocking`
 *                       cause still blocks.
 *
 * Exhaustive over the union (`assertNever`), so a future variant cannot be
 * silently ignored.
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

// ─── Verdict recovery for externally-authored carriers ───────────────────────

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
 * Recover the authoritative {@link ProbeVerdict} from a probe carrier.
 *
 * `runProbe` always stamps `verdict`, so the first branch is the production
 * path. The reconstruction exists for carriers authored OUTSIDE this module
 * (test doubles that fabricate the legacy `ProbeResult` wire shape), and it is
 * deliberately TOTAL and FAIL-CLOSED:
 *
 *   • it NEVER reads `passed`. A fabricated "vacuous pass"
 *     (`{passed:true, discriminant:'no-new-tests'}`) reconstructs to
 *     INDETERMINATE and is re-subjected to tier policy — the legacy shape
 *     cannot smuggle a skipped check past the gate as success.
 *   • a known discriminant → `indeterminate` (the probe did not run).
 *   • an UNRECOGNISED discriminant → `failed` (blocking), never a pass: an
 *     unknown "could not run" mode must not degrade to advisory.
 *   • otherwise the only remaining evidence is the observed kill, so
 *     `redObserved && restoredClean` → `passed`, else `failed`.
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
 * Capture the current working tree as an object-only snapshot.
 *
 * `git stash create` writes a commit object whose tree is the dirty working
 * tree and returns its sha WITHOUT touching `refs/stash` or any other ref —
 * the refuse-to-discard property INV-14 requires (no `stash push`/`pop`, which
 * mutate shared stash storage across worktrees). On a clean tree it returns
 * empty stdout; we fall back to HEAD's own tree so restore is always
 * well-defined.
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
    // Clean tree — snapshot HEAD (its commit sha is a valid restore source).
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
 * Revert ONLY the given source files to their state at `baseRef`. Paths present
 * at the base are restored via targeted checkout; task-added tracked paths are
 * removed from the index/worktree so the probe faithfully recreates the base
 * even when the implementation introduces a new module. Never `reset --hard`.
 * Unknown paths and git failures surface as `revert-conflict`.
 */
export function revertSourceFiles(
  gitExec: GitExec,
  repoRoot: string,
  baseRef: string,
  sourceFiles: readonly string[],
): RevertResult {
  if (sourceFiles.length === 0) {
    // Nothing to revert is not a conflict — caller decides whether that's a
    // probe-skip; here it is trivially successful.
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

      // A path absent from the base is a valid task addition only when it is
      // tracked in the current index. A typo/nonexistent path remains a
      // conflict rather than being silently accepted.
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

// ─── runProbe (task 013) ─────────────────────────────────────────────────────
//
// The orchestration that ties the kill probe together: split the task diff,
// snapshot the worktree, revert ONLY the source hunks, run the new/changed
// tests, observe whether they go red, and ALWAYS restore. The test runner and
// the changed-file list are injected so this composition is unit-testable
// without shelling out to a real test command.

/** Result of running the (scoped) test command during the probe. */
export interface TestRunResult {
  /** True when the scoped test run PASSED (all green). */
  readonly passed: boolean;
  /** Optional human-readable output for diagnostics. */
  readonly output?: string;
}

/**
 * Injected runner that executes the resolved test command, scoped to the
 * new/changed test files where the runner allows. Async to match real
 * shell-outs; receives the repo + the test files to scope to.
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
  /** Runs the scoped test command; returns pass/fail. */
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
   * True when the caller could not compute the task diff at all (git failure).
   * Distinguishes "this task genuinely changed nothing" from "we could not
   * see what it changed" — the latter must never pass (WFQ-005).
   */
  readonly diffFailed?: boolean;
}

export interface ProbeResult {
  /**
   * The SINGLE authority for this result. Every other verdict-bearing field
   * below is DERIVED from it (plus the risk tier) — see {@link toProbeResult}.
   * Consumers should switch on `verdict.kind` exhaustively rather than reading
   * the derived boolean, which exists for wire compatibility.
   */
  readonly verdict: ProbeVerdict;
  /**
   * DERIVED. The gate verdict as a boolean. PASS means EITHER the probe proved
   * the tests are non-vacuous, OR the verdict was an explicitly-labelled
   * advisory skip ({@link skipped} — never proof). Read {@link disposition} to
   * tell those apart; that is precisely the distinction this boolean cannot
   * carry.
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
   * Human-readable diagnosis carried for the advisory discriminants (currently
   * `no-new-tests`), so the verdict is self-explanatory in the gate.executed
   * payload and the handler response. Absent for the ordinary pass/kill paths.
   */
  readonly report?: string;
}

/**
 * Observable facts a probe run produces alongside its verdict. These are
 * DIAGNOSTICS, not verdict channels — none of them may be read as pass/fail.
 */
interface ProbeFacts {
  readonly probedTests: string[];
  readonly redObserved: boolean;
  readonly restoredClean: boolean;
}

/**
 * Derive the wire-compatible {@link ProbeResult} from the authoritative
 * {@link ProbeVerdict}. The ONLY constructor of a `ProbeResult` — no call site
 * may author `passed` by hand, so "did not run" can never be typed as success.
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
 * Run the kill probe.
 *
 * Sequence (with INV-14 restore in a finally — restore ALWAYS runs):
 *   1. split the diff into test vs source files
 *   2. if there are no new/changed test files → indeterminate `no-new-tests`
 *   3. snapshot the working tree (object-only)
 *   4. revert the source files to `baseRef`; on conflict → restore + indeterminate
 *      `revert-conflict`
 *   5. run the scoped tests; `redObserved = !passed`
 *   6. restore the working tree; `restoredClean = restore.restored`
 *
 * The probe reports a {@link ProbeVerdict}, NOT a boolean:
 *   • red observed + clean restore  → `passed`        (real proof)
 *   • tests stayed green            → `failed`        (real disproof)
 *   • anything that stopped the probe from running    → `indeterminate`
 *
 * Whether an `indeterminate` verdict blocks is a TIER decision made by
 * {@link interpretProbeVerdict}, applied here only to derive the legacy
 * `passed` boolean. A medium/high task whose probe did not run is ALWAYS
 * blocked; a low/unset-tier task degrades to an explicitly-labelled advisory
 * SKIP (INV-4 degrade discipline) — which is reported as a skip, never as
 * proof of test adequacy (WFQ-005).
 */
export async function runProbe(args: ProbeArgs): Promise<ProbeResult> {
  const { gitExec, repoRoot, baseRef, changedFiles, runTests, testGlobs } = args;
  const riskTier = args.riskTier;

  // Could not compute the diff at all. An unreadable diff is NOT evidence of a
  // well-tested task — indeterminate (and `always-blocking`), never laundered
  // into an advisory pass (WFQ-005 "false advisory success").
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

  // No new/changed tests — the probe has nothing to kill. INDETERMINATE: the
  // check did not run, so it proves nothing. Tier policy decides whether that
  // blocks (medium/high) or degrades to a labelled advisory skip (low/unset).
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
    // Could not snapshot — refuse to mutate a tree we cannot restore.
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
  // Default to a not-restored result so that if the finally never assigns it
  // (it always does, but the type system needs an initializer) the gate fails
  // safe as restore-failed rather than falsely reporting a clean restore.
  let restore: RestoreResult = { restored: false, detail: 'restore did not run' };

  try {
    // Mutation step: revert ONLY source. If there is no source to revert the
    // probe still runs (a test-only task can still be vacuous), but with
    // nothing reverted the tests cannot go red on the mutation — handled below.
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
    // INV-14: restore ALWAYS runs, even if the test run threw.
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
