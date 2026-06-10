// ─── check_contract_drift — contract-drift gate core (task 022) ───────────────
//
// Verification-ladder slice 1, Bundle B3. Proves a task's schema-boundary
// changes don't silently break the contract: regenerate bindings (codegen),
// typecheck the regen, then run a breaking-change diff against the MERGE-BASE.
//
// This is a DRIFT GATE, not a write-lock: it reports findings (drift + breaking
// list), never mutates the working tree or holds a lock. The composition is
// pure-ish — git and the command runner are injected — so the verdict logic is
// unit-testable without shelling out.
//
// Baseline (INV-parity with the kill probe): the breaking-diff baseline is the
// `git merge-base <baseRef> HEAD` commit, not a raw `baseRef..HEAD` range — the
// merge-base is the common ancestor the branch actually diverged from, so the
// diff measures only what THIS branch changed.
//
// Degrade (INV-4): when no contract tool resolves — including managed /
// non-native worktrees where a tool simply isn't wired — the gate returns a
// skipped/advisory PASS, never a hard fail.
// ────────────────────────────────────────────────────────────────────────────

import type { GitExec } from './pure/execute-merge.js';
import type { ContractCommands } from '../config/toolchains.js';

/** Result of running a single contract leg (codegen / typecheck / diff). */
export interface CommandRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Injected runner that executes a resolved shell command in the repo and
 * returns its exit code + combined output. Async to match real shell-outs.
 */
export type CommandRunFn = (input: {
  readonly repoRoot: string;
  readonly command: string;
}) => Promise<CommandRunResult>;

export interface ContractDriftArgs {
  readonly repoRoot: string;
  /** Base ref the branch diverged from — the merge-base is computed against this. */
  readonly baseRef: string;
  /** Resolved contract commands `{ codegen, diff }`, or null when none resolve. */
  readonly contract: ContractCommands | null;
  /** Resolved typecheck command (run after codegen). Null/absent → leg skipped. */
  readonly typecheck?: string | null;
  /** Git executor (injected). */
  readonly gitExec: GitExec;
  /** Command runner (injected). */
  readonly runCommand: CommandRunFn;
}

export interface ContractDriftResult {
  /**
   * The gate verdict. PASS means: every wired leg succeeded and the breaking-
   * diff reported no breakage. A skipped gate (no tool) also passes (advisory).
   */
  readonly passed: boolean;
  /** True when the breaking-diff reported breaking changes. */
  readonly drift: boolean;
  /** The breaking-change lines surfaced by the diff tool (empty when none). */
  readonly breaking: string[];
  /** Human-readable summary of what the gate did and found. */
  readonly report: string;
  /** True when no contract tool resolved → skipped/advisory (INV-4). */
  readonly skipped?: boolean;
  /** The merge-base sha used as the diff baseline (when computed). */
  readonly baseline?: string;
}

/** Extract the breaking-change lines from a diff tool's stdout. */
function extractBreaking(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /breaking/i.test(l));
}

/**
 * Compute the merge-base baseline via `git merge-base <baseRef> HEAD`.
 * Returns null on git failure (the gate then reports the diff couldn't be
 * baselined rather than crashing).
 */
function computeMergeBase(gitExec: GitExec, repoRoot: string, baseRef: string): string | null {
  const result = gitExec(repoRoot, ['merge-base', baseRef, 'HEAD']);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Run the contract-drift gate.
 *
 * Sequence:
 *   1. If no contract tool resolves → skipped/advisory PASS (INV-4).
 *   2. Compute the merge-base baseline (`git merge-base baseRef HEAD`).
 *   3. codegen leg (if wired): non-zero exit → failure leg (passed:false).
 *   4. typecheck leg (if wired): non-zero exit → failure leg.
 *   5. diff leg (if wired): non-zero exit OR breaking lines → drift, passed:false,
 *      breaking[] populated. Exit 0 with no breaking lines → clean.
 *
 * A codegen / typecheck failure is a FAILURE LEG (broken regen), distinct from
 * a BREAKING finding (the diff tool reporting incompatible schema changes) —
 * the carrier reports both shapes via `report` + `breaking`.
 */
export async function runContractDrift(args: ContractDriftArgs): Promise<ContractDriftResult> {
  const { repoRoot, baseRef, contract, typecheck, gitExec, runCommand } = args;

  const codegen = contract?.codegen ?? null;
  const diff = contract?.diff ?? null;

  // 1. No tool resolves → skipped/advisory (degrade per INV-4).
  if (
    (codegen === null || codegen.trim().length === 0) &&
    (diff === null || diff.trim().length === 0)
  ) {
    return {
      passed: true,
      drift: false,
      breaking: [],
      skipped: true,
      report:
        'check_contract_drift skipped: no contract codegen/diff command resolved ' +
        '(no .exarchos.yml contract: block and no artifact-keyed tool detected). Advisory pass.',
    };
  }

  // 2. Merge-base baseline.
  const baseline = computeMergeBase(gitExec, repoRoot, baseRef);
  const reportLines: string[] = [];
  reportLines.push(
    baseline
      ? `baseline = merge-base(${baseRef}, HEAD) = ${baseline}`
      : `baseline = merge-base(${baseRef}, HEAD) could not be computed`,
  );

  // 3. codegen leg.
  if (codegen !== null && codegen.trim().length > 0) {
    const cg = await runCommand({ repoRoot, command: codegen });
    if (cg.exitCode !== 0) {
      reportLines.push(`codegen FAILED (exit ${cg.exitCode}): ${cg.stdout.trim()}`);
      return {
        passed: false,
        drift: false,
        breaking: [],
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('codegen ok');
  }

  // 4. typecheck leg.
  if (typecheck && typecheck.trim().length > 0) {
    const tc = await runCommand({ repoRoot, command: typecheck });
    if (tc.exitCode !== 0) {
      reportLines.push(`typecheck FAILED (exit ${tc.exitCode}): ${tc.stdout.trim()}`);
      return {
        passed: false,
        drift: false,
        breaking: [],
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('typecheck ok');
  }

  // 5. breaking-diff leg.
  if (diff !== null && diff.trim().length > 0) {
    const df = await runCommand({ repoRoot, command: diff });
    const breaking = extractBreaking(df.stdout);
    // A non-zero exit OR explicit breaking lines counts as drift. (Diff tools
    // like oasdiff/buf-breaking exit non-zero on breaking changes by convention.)
    const isDrift = df.exitCode !== 0 || breaking.length > 0;
    if (isDrift) {
      // When the tool exited non-zero but emitted no parseable breaking line,
      // surface the raw output so the finding is never empty.
      const surfaced =
        breaking.length > 0
          ? breaking
          : [`breaking-diff reported drift (exit ${df.exitCode}): ${df.stdout.trim() || '<no output>'}`];
      reportLines.push(`breaking-diff DRIFT: ${surfaced.length} finding(s)`);
      return {
        passed: false,
        drift: true,
        breaking: surfaced,
        report: reportLines.join('\n'),
        ...(baseline ? { baseline } : {}),
      };
    }
    reportLines.push('breaking-diff clean');
  }

  // All wired legs passed.
  return {
    passed: true,
    drift: false,
    breaking: [],
    report: reportLines.join('\n'),
    ...(baseline ? { baseline } : {}),
  };
}
