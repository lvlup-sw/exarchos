// ─── check_test_adequacy handler (task 014) ──────────────────────────────────
//
// Orchestrate action that runs the kill probe (mutation-testing-at-N=1) for a
// task's diff and persists canonical subject-bound evidence. The probe composition itself
// lives in the pure-ish `test-adequacy.ts` (split/snapshot/revert/run/restore);
// this handler wires the production seams:
//   • resolve repoRoot (supports the worktree-aware 'auto' mode, #1330)
//   • compute the task diff's changed files via git (baseRef...HEAD)
//   • resolve the test command via resolveTestRuntime and shell it out,
//     scoped to the changed test files
//   • persist evidence with trusted-operation idempotency (INV-8)
//
// The result is an INV-5b advisory carrier: success:true with data.passed
// reflecting the probe verdict, never an error envelope for a vacuous-test
// finding (a failed probe is a finding, not a tool error).
// ────────────────────────────────────────────────────────────────────────────

import { runCommandSync } from '../utils/process.js';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { defaultGitExec, resolvePolicySkip, SKIPPED_BY_POLICY } from './gate-utils.js';
import { runGatePreflight } from './pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { resolveTestRuntime } from '../config/test-runtime-resolver.js';
import { splitCommand } from '../config/tokenize-command.js';
import { detectToolchain, testGlobsForToolchain } from '../config/toolchains.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import type { RiskTier } from '../workflow/verification-policy.js';
import type { GitExec } from './pure/execute-merge.js';
import { runProbe, type ProbeResult, type TestRunFn } from './test-adequacy.js';

// ─── Args / Result ───────────────────────────────────────────────────────────

export interface TestAdequacyArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). Defaults to the current branch. */
  readonly branch?: string;
  /** Base ref the task diff is measured against. Defaults to 'main'. */
  readonly baseBranch?: string;
  /**
   * Repo to probe. A literal path is used verbatim; `'auto'` resolves the
   * calling delegation's agent worktree (#1330); omitting it → process.cwd().
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /**
   * Legacy compatibility field. Evidence idempotency is bound exclusively to
   * the trusted DispatchContext operationId.
   */
  readonly operationId?: string;

  /**
   * Legacy phase carrier retained for public input compatibility. Evidence is
   * attributed to the active persisted phaseAttemptId.
   */
  readonly phase?: string;

  // ── Verification-ladder routing stamp (FIX-1a) ───────────────────────────
  /**
   * The task's stamped risk tier. When provided together with
   * {@link boundaryTouching}, the handler self-skips when the resolved
   * verification sequence does not include this gate (`skipped-by-policy`).
   * Absent (legacy callers) → the gate runs unconditionally.
   */
  readonly riskTier?: RiskTier;
  /** The task's stamped boundary-touching flag. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /**
   * The resolved project config (task 004). Threaded by the dispatch adapter so
   * the self-skip routing consumes the SAME config-resolved policy the
   * delegation stamp uses — a `.exarchos.yml` `verification:` cell that excludes
   * this gate makes the stamp drop it AND this handler skip it (they can never
   * disagree). Omitted → the resolver falls through to the built-in table.
   */
  readonly projectConfig?: ResolvedProjectConfig;

  // ── Test seams (DI; production defaults below) ───────────────────────────
  /** Git executor. Defaults to a 30s-ceiling shell-out. */
  readonly gitExec?: GitExec;
  /** Test runner. Defaults to the resolveTestRuntime-backed shell-out. */
  readonly runTests?: TestRunFn;
}

// ─── Production seams ──────────────────────────────────────────────────────
//
// `defaultGitExec` is shared from gate-utils (FIX-4 dedupe) — it was byte-
// identical across the three per-task gate handlers.

/**
 * Build the production test runner from the resolved test command. The command
 * string (e.g. `npm run test:run`) is tokenized with the shared `splitCommand`
 * (FIX-5: quoted-arg-aware, NOT a naive whitespace split) and run with the
 * scoped test files appended after a `--` separator so the runner targets only
 * the new/changed tests where it supports path args (vitest, jest, node --test,
 * pytest all accept this).
 */
function buildDefaultRunTests(repoRoot: string): TestRunFn {
  const resolved = resolveTestRuntime(repoRoot);
  const testCmd = resolved.test;
  return async ({ testFiles }) => {
    if (!testCmd) {
      // No resolvable test command — treat as a passing run so the probe
      // reports `redObserved:false` (inconclusive, never a false kill).
      return { passed: true, output: 'no resolvable test command' };
    }
    let bin: string;
    let rest: readonly string[];
    try {
      const tokens = splitCommand(testCmd);
      bin = tokens.cmd;
      rest = tokens.args;
    } catch (err) {
      return {
        passed: true,
        output: `unparseable test command "${testCmd}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!bin) {
      // Whitespace-only command tokenizes to an empty binary — same inconclusive
      // (never a false kill) degrade as an unresolvable command.
      return { passed: true, output: 'no resolvable test command' };
    }
    const args = [...rest, '--', ...testFiles];
    try {
      // runCommandSync (not raw execFileSync): on Windows the resolved test
      // command is a package-manager shim (`npm run test:run`) whose `.cmd`
      // launcher execFile refuses to start since CVE-2024-27980 (Node
      // >= 20.12.2) — it would throw EINVAL, which the catch below misreads as a
      // failing (red) test and FALSELY passes the kill probe. (#1623)
      const output = runCommandSync(bin, args, {
        cwd: repoRoot,
        timeout: 120_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { passed: true, output: output.toString() };
    } catch (err) {
      const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
      const out =
        (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
        (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
      return { passed: false, output: out };
    }
  };
}

/**
 * Compute the repo-relative files changed by the task diff.
 *
 * The HEAD side is the task `branch` when the caller names one, falling back to
 * the checked-out `HEAD`. Diffing `HEAD` unconditionally silently probed the
 * wrong tree whenever `repoRoot` was not the task worktree (e.g. an orchestrator
 * calling from the main worktree), yielding an empty diff and a vacuous pass.
 *
 * Returns a discriminated result so a git failure is distinguishable from a
 * genuinely empty diff: the former must fail the gate, not skip it (WFQ-005).
 */
export type ChangedFilesResult =
  | { readonly ok: true; readonly files: string[] }
  | { readonly ok: false; readonly detail: string };

export function changedFilesFor(
  gitExec: GitExec,
  repoRoot: string,
  baseRef: string,
  headRef?: string,
): ChangedFilesResult {
  const head = headRef && headRef.trim().length > 0 ? headRef.trim() : 'HEAD';
  const result = gitExec(repoRoot, ['diff', '--name-only', `${baseRef}...${head}`]);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      detail: `git diff ${baseRef}...${head} exited ${result.exitCode}: ${result.stdout.trim()}`,
    };
  }
  return {
    ok: true,
    files: result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleTestAdequacy(
  args: TestAdequacyArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Preflight (DR-10): validate the DispatchContext + inputs and resolve the
  // worktree-aware 'auto' repoRoot (#1330). Byte-preserves the prior envelopes.
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleTestAdequacy',
      requireTaskId: true,
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const baseRef = args.baseBranch || 'main';

  return runDurableGateProducer(
    {
      gateClass: 'test-adequacy',
      featureId: args.featureId,
      taskId: args.taskId,
      ...(args.branch ? { branch: args.branch } : {}),
      baseRef,
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      const policySkip = resolvePolicySkip({
        gateName: 'check_test_adequacy',
        riskTier: args.riskTier,
        boundaryTouching: args.boundaryTouching,
        config: args.projectConfig,
      });
      if (policySkip) {
        return {
          success: true,
          data: {
            passed: true,
            skipped: true,
            redObserved: false,
            restoredClean: true,
            probedTests: [],
            discriminant: SKIPPED_BY_POLICY,
            reason: policySkip.reason,
          },
        };
      }

      const gitExec = args.gitExec ?? defaultGitExec;
      const runTests = args.runTests ?? buildDefaultRunTests(repoRoot);
      const changed = changedFilesFor(gitExec, repoRoot, baseRef, args.branch);
      const toolchain = detectToolchain(repoRoot);
      const toolchainGlobs = toolchain ? testGlobsForToolchain(toolchain.id) : null;

      const probe: ProbeResult = await runProbe({
        gitExec,
        repoRoot,
        baseRef,
        changedFiles: changed.ok ? changed.files : [],
        ...(changed.ok ? {} : { diffFailed: true }),
        ...(args.riskTier ? { riskTier: args.riskTier } : {}),
        runTests,
        ...(toolchainGlobs ? { testGlobs: toolchainGlobs } : {}),
      });

      // INV-5b advisory carrier — success:true with data.passed reflecting the
      // probe verdict, NOT an error envelope.
      return {
        success: true,
        data: {
          passed: probe.passed,
          redObserved: probe.redObserved,
          restoredClean: probe.restoredClean,
          probedTests: probe.probedTests,
          ...(probe.discriminant ? { discriminant: probe.discriminant } : {}),
          ...(probe.report ? { report: probe.report } : {}),
        },
      };
    },
  );
}
