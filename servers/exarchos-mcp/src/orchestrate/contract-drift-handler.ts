// ─── check_contract_drift handler (task 023) ─────────────────────────────────
//
// Orchestrate action that runs the contract-drift gate for a task's
// schema-boundary changes and emits a `gate.executed` event. The drift
// composition itself lives in the pure-ish `contract-drift.ts`
// (merge-base baseline / codegen / typecheck / breaking-diff legs); this
// handler wires the production seams:
//   • resolve repoRoot (supports the worktree-aware 'auto' mode, #1330)
//   • resolve the contract + typecheck commands via resolveVerificationRuntime
//   • shell out each leg (codegen → typecheck → breaking-diff)
//   • emit gate.executed with operationId idempotency (INV-8)
//
// The result is an INV-5b advisory carrier: success:true with data.passed
// reflecting the gate verdict, never an error envelope for a drift finding
// (drift is a finding, not a tool error). On pass it carries exactly ONE
// next-actions steer: contracts verify SHAPE, not meaning — keep one semantic
// test per boundary, delete redundant shape assertions.
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
import type { RiskTier } from '../workflow/verification-policy.js';
import { resolveVerificationRuntime } from '../config/test-runtime-resolver.js';
import { splitCommand } from '../config/tokenize-command.js';
import type { GitExec } from './pure/execute-merge.js';
import {
  runContractDrift,
  type CommandRunFn,
  type ContractDriftResult,
} from './contract-drift.js';

// ─── The one-semantic-test steer (task 023) ─────────────────────────────────
//
// Contracts pin the SHAPE of a boundary, not its meaning. Once a contract gate
// guards the shape, redundant per-field shape assertions in unit tests are
// noise — keep exactly one semantic test that exercises the boundary's behavior.
export const ONE_SEMANTIC_TEST_STEER =
  'contracts verify shape, not meaning — keep exactly ONE semantic test for ' +
  'this boundary; delete redundant shape assertions';

// ─── Args ────────────────────────────────────────────────────────────────────

export interface ContractDriftHandlerArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). Defaults to the current branch. */
  readonly branch?: string;
  /** Base ref the branch diverged from (merge-base target). Defaults to 'main'. */
  readonly baseBranch?: string;
  /**
   * Repo to check. A literal path is used verbatim; `'auto'` resolves the
   * calling delegation's agent worktree (#1330); omitting it → process.cwd().
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /** Idempotency key for the gate emission (INV-8). */
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

  // ── Test seams (DI; production defaults below) ───────────────────────────
  readonly gitExec?: GitExec;
  readonly runCommand?: CommandRunFn;
}

// ─── Production seams ──────────────────────────────────────────────────────
//
// `defaultGitExec` is shared from gate-utils (FIX-4 dedupe) — it was byte-
// identical across the three per-task gate handlers.

/**
 * Default command runner: split the resolved command and shell it out, scoped
 * to the repo, returning the combined stdout/stderr + exit code. Never throws
 * on non-zero exit — the gate reads the exit code as a leg verdict.
 */
const defaultRunCommand: CommandRunFn = async ({ repoRoot, command }) => {
  let cmd: string;
  let cmdArgs: readonly string[];
  try {
    ({ cmd, args: cmdArgs } = splitCommand(command));
  } catch (err) {
    return { exitCode: 1, stdout: `unparseable command "${command}": ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const stdout = execFileSync(cmd, [...cmdArgs], {
      cwd: repoRoot,
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
    return { exitCode: e.status ?? 1, stdout: out };
  }
};

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleContractDrift(
  args: ContractDriftHandlerArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!eventStore) {
    return {
      success: false,
      error: { code: 'MISWIRED_CONTEXT', message: 'handleContractDrift: eventStore is required' },
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
  const policySkip = resolvePolicySkip({
    gateName: 'check_contract_drift',
    riskTier: args.riskTier,
    boundaryTouching: args.boundaryTouching,
  });
  if (policySkip) {
    try {
      await emitGateEvent(
        eventStore,
        args.featureId,
        'contract-drift',
        'delegate',
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
        drift: false,
        breaking: [],
        report: policySkip.reason,
        discriminant: SKIPPED_BY_POLICY,
      },
    };
  }

  const gitExec = args.gitExec ?? defaultGitExec;
  const runCommand = args.runCommand ?? defaultRunCommand;

  // Resolve the contract + typecheck commands in the repo (toolchain-neutral).
  const runtime = resolveVerificationRuntime(repoRoot);

  const drift: ContractDriftResult = await runContractDrift({
    repoRoot,
    baseRef,
    contract: runtime.contract,
    typecheck: runtime.typecheck,
    gitExec,
    runCommand,
  });

  // Emit gate.executed with operationId idempotency (INV-8). Fire-and-forget.
  try {
    await emitGateEvent(
      eventStore,
      args.featureId,
      'contract-drift',
      'delegate',
      drift.passed,
      {
        dimension: 'D1',
        phase: 'delegate',
        taskId: args.taskId,
        ...(args.branch ? { branch: args.branch } : {}),
        drift: drift.drift,
        breakingCount: drift.breaking.length,
        ...(drift.skipped ? { skipped: true } : {}),
      },
      args.operationId,
    );
  } catch {
    /* fire-and-forget */
  }

  // INV-5b advisory carrier — success:true with data.passed reflecting the
  // verdict, NOT an error envelope. On PASS, carry the one-semantic-test steer.
  return {
    success: true,
    data: {
      passed: drift.passed,
      drift: drift.drift,
      breaking: drift.breaking,
      report: drift.report,
      ...(drift.skipped ? { skipped: true } : {}),
      // Steer only on a clean pass — a failing gate's next action is to fix the
      // drift, not to prune tests.
      ...(drift.passed && !drift.skipped ? { next_actions: [ONE_SEMANTIC_TEST_STEER] } : {}),
    },
  };
}
