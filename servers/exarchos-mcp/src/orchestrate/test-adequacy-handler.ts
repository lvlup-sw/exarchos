// ─── check_test_adequacy handler (task 014) ──────────────────────────────────
//
// Orchestrate action that runs the kill probe (mutation-testing-at-N=1) for a
// task's diff and emits a `gate.executed` event. The probe composition itself
// lives in the pure-ish `test-adequacy.ts` (split/snapshot/revert/run/restore);
// this handler wires the production seams:
//   • resolve repoRoot (supports the worktree-aware 'auto' mode, #1330)
//   • compute the task diff's changed files via git (baseRef...HEAD)
//   • resolve the test command via resolveTestRuntime and shell it out,
//     scoped to the changed test files
//   • emit gate.executed with operationId idempotency (INV-8)
//
// The result is an INV-5b advisory carrier: success:true with data.passed
// reflecting the probe verdict, never an error envelope for a vacuous-test
// finding (a failed probe is a finding, not a tool error).
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import {
  defaultGitExec,
  emitGateEvent,
  resolvePolicySkip,
  resolveRepoRoot,
  SKIPPED_BY_POLICY,
} from './gate-utils.js';
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
   * Idempotency key for the gate emission (INV-8). When the same operationId is
   * replayed, the gate.executed collapses to a single row.
   */
  readonly operationId?: string;

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
      const output = execFileSync(bin, args, {
        cwd: repoRoot,
        timeout: 120_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { passed: true, output };
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
 * Compute the repo-relative files changed by the task diff (baseRef...HEAD).
 * Returns an empty list on git failure (the probe then short-circuits to the
 * no-new-tests discriminant — never a spurious kill).
 */
function changedFilesFor(gitExec: GitExec, repoRoot: string, baseRef: string): string[] {
  const result = gitExec(repoRoot, ['diff', '--name-only', `${baseRef}...HEAD`]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleTestAdequacy(
  args: TestAdequacyArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!eventStore) {
    return {
      success: false,
      error: { code: 'MISWIRED_CONTEXT', message: 'handleTestAdequacy: eventStore is required' },
    };
  }
  if (!args.featureId) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'featureId is required' } };
  }
  if (!args.taskId) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'taskId is required' } };
  }

  // Resolve repoRoot — supports the worktree-aware 'auto' mode (#1330).
  const resolved = await resolveRepoRoot(
    {
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      featureId: args.featureId,
      taskId: args.taskId,
    },
    eventStore,
  );
  if (!resolved.ok) {
    return { success: false, error: { code: 'INVALID_INPUT', message: resolved.error } };
  }
  const repoRoot = resolved.repoRoot;
  const baseRef = args.baseBranch || 'main';

  // ── FIX-1a: verification-ladder self-routing on the stamped profile ──────
  // When the caller threads the task's riskTier/boundaryTouching stamp and the
  // policy sequence excludes this gate, skip BEFORE touching the tree — and
  // still record the routing decision as a gate.executed event.
  const policySkip = resolvePolicySkip({
    gateName: 'check_test_adequacy',
    riskTier: args.riskTier,
    boundaryTouching: args.boundaryTouching,
    config: args.projectConfig,
  });
  if (policySkip) {
    try {
      await emitGateEvent(
        eventStore,
        args.featureId,
        'test-adequacy',
        'testing',
        true,
        {
          dimension: 'D1',
          phase: 'delegate',
          taskId: args.taskId,
          ...(args.branch ? { branch: args.branch } : {}),
          skipped: true,
          discriminant: SKIPPED_BY_POLICY,
          reason: policySkip.reason,
        },
        args.operationId,
      );
    } catch {
      /* fire-and-forget */
    }
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
  const changedFiles = changedFilesFor(gitExec, repoRoot, baseRef);

  // ── FIX-3: thread the resolved toolchain's test-file layout into the probe.
  // The toolchain registry is the SoT for layout (python tests/**, go *_test.go,
  // …); toolchains on the co-located default convention resolve to null and the
  // probe falls back to DEFAULT_TEST_GLOBS.
  const toolchain = detectToolchain(repoRoot);
  const toolchainGlobs = toolchain ? testGlobsForToolchain(toolchain.id) : null;

  const probe: ProbeResult = await runProbe({
    gitExec,
    repoRoot,
    baseRef,
    changedFiles,
    runTests,
    ...(toolchainGlobs ? { testGlobs: toolchainGlobs } : {}),
  });

  // Emit gate.executed with operationId idempotency (INV-8). Fire-and-forget:
  // emission failure must not break the gate verdict.
  try {
    await emitGateEvent(
      eventStore,
      args.featureId,
      'test-adequacy',
      'testing',
      probe.passed,
      {
        dimension: 'D1',
        phase: 'delegate',
        taskId: args.taskId,
        ...(args.branch ? { branch: args.branch } : {}),
        redObserved: probe.redObserved,
        restoredClean: probe.restoredClean,
        probedTests: probe.probedTests,
        ...(probe.discriminant ? { discriminant: probe.discriminant } : {}),
        ...(probe.report ? { report: probe.report } : {}),
      },
      args.operationId,
    );
  } catch {
    /* fire-and-forget */
  }

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
}
