// ─── Post-Merge Gate Handler ────────────────────────────────────────────────
//
// Orchestrates the post-merge regression check at the
// synthesize -> cleanup boundary. Calls the pure TypeScript
// checkPostMerge function and emits gate.executed events for
// flywheel integration.
// ────────────────────────────────────────────────────────────────────────────

import { spawnCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { emitGateEvent } from './gate-utils.js';
import { checkPostMerge } from '../pure/post-merge.js';
import type { CommandResult, PostMergeResult as PostMergeCheck } from '../pure/post-merge.js';
import { classifyCommandFailure } from '../pure/command-outcome.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface PostMergeArgs {
  readonly featureId: string;
  readonly prUrl: string;
  readonly mergeSha: string;
  readonly repoRoot?: string;
}

interface PostMergeResult {
  /** True only for `status: 'pass'`. An unmeasured check is never a pass. */
  readonly passed: boolean;
  /**
   * The check's own three-valued outcome. Carried alongside `passed` because
   * `passed: false` alone cannot tell a regression the check OBSERVED from one
   * it never got to look for, and the caller acts differently on each.
   */
  readonly status: PostMergeCheck['status'];
  readonly prUrl: string;
  readonly mergeSha: string;
  readonly findings: string[];
  readonly report: string;
  /** Present only when `status` is `'indeterminate'`: which check could not run. */
  readonly reason?: string;
}

// ─── Command Runner Adapter ─────────────────────────────────────────────────

/**
 * Wraps spawnSync to match the command runner signature expected by
 * the pure TypeScript checkPostMerge function. Routes through
 * `spawnCommandSync` so a resolved package-manager command launches its `.cmd`
 * shim on Windows — raw `spawnSync('npm', …)` throws EINVAL since
 * CVE-2024-27980 (Node >= 20.12.2). (#1623)
 *
 * A run that never started or was killed at its wall clock is reported through
 * the dedicated fields rather than as `exitCode: 1`: the pure check reads them
 * to keep "no regression was observed" from being written down as "a regression
 * was observed".
 */
function execCommandRunner(
  cmd: string,
  args: readonly string[],
  cwd?: string,
): CommandResult {
  const result = spawnCommandSync(cmd, [...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error !== undefined) {
    const failure = classifyCommandFailure({
      ...(typeof result.status === 'number' ? { status: result.status } : {}),
      code: (result.error as NodeJS.ErrnoException).code,
      message: result.error.message,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
    return {
      exitCode: failure.exitCode,
      stdout: failure.stdout,
      stderr: failure.stderr || failure.detail,
      ...(failure.kind === 'spawn' ? { spawnError: failure.detail } : {}),
      ...(failure.kind === 'timeout' ? { timedOut: true } : {}),
    };
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handlePostMerge(
  args: PostMergeArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Guard clauses: validate all required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.prUrl) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prUrl is required' },
    };
  }

  if (!args.mergeSha) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'mergeSha is required' },
    };
  }

  // Run the pure TypeScript post-merge check. `repoRoot` is threaded, not just
  // handed to the runner: the check resolves the test command from the same
  // tree it runs it in, and passing one without the other would let it resolve
  // this process's own toolchain and run it somewhere else.
  const cwd = args.repoRoot;
  const checkResult = await checkPostMerge({
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    ...(cwd !== undefined ? { repoRoot: cwd } : {}),
    runCommand: (cmd, cmdArgs) => execCommandRunner(cmd, cmdArgs, cwd),
  });

  const { status, findings, report, reason } = checkResult;
  const passed = status === 'pass';

  // Emit gate.executed event for flywheel integration (fire-and-forget). The
  // three-valued outcome travels with it: a row that says only `passed: false`
  // cannot distinguish a regression that was found from a check that never ran,
  // and the second one is not a finding anybody may act on.
  try {
    const store = eventStore;
    await emitGateEvent(store, args.featureId, 'post-merge', 'post-merge', passed ? 'pass' : 'fail', {
      dimension: 'D4',
      phase: 'synthesize',
      prUrl: args.prUrl,
      mergeSha: args.mergeSha,
      findings,
      status,
      ...(reason !== undefined ? { reason } : {}),
    });
  } catch { /* fire-and-forget: emission failure must not break the gate check */ }

  // Build result
  const data: PostMergeResult = {
    passed,
    status,
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    findings,
    report,
    ...(reason !== undefined ? { reason } : {}),
  };

  return { success: true, data };
}
