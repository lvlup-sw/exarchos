// ─── Post-Merge Gate Handler ────────────────────────────────────────────────
//
// Orchestrates the post-merge regression check (DR-4) at the
// synthesize -> cleanup boundary. Calls the pure TypeScript
// checkPostMerge function and emits gate.executed events for
// flywheel integration.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';
import { checkPostMerge } from './pure/post-merge.js';
import type { CommandResult } from './pure/post-merge.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface PostMergeArgs {
  readonly featureId: string;
  readonly prUrl: string;
  readonly mergeSha: string;
}

interface PostMergeResult {
  readonly passed: boolean;
  readonly prUrl: string;
  readonly mergeSha: string;
  readonly findings: string[];
  readonly report: string;
}

// ─── Command Runner Adapter ─────────────────────────────────────────────────

/**
 * Wraps execFileSync to match the command runner signature expected by
 * the pure TypeScript checkPostMerge function.
 */
function execCommandRunner(
  cmd: string,
  args: readonly string[],
): CommandResult {
  try {
    const output = execFileSync(cmd, args as string[], {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return { exitCode: 0, stdout: output, stderr: '' };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: execErr.status ?? 1,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
    };
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handlePostMerge(
  args: PostMergeArgs,
  stateDir: string,
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

  // Run the pure TypeScript post-merge check
  const checkResult = checkPostMerge({
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    runCommand: execCommandRunner,
  });

  const passed = checkResult.status === 'pass';
  const { findings, report } = checkResult;

  // Emit gate.executed event for flywheel integration (fire-and-forget)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'post-merge', 'post-merge', passed, {
      dimension: 'D4',
      phase: 'synthesize',
      prUrl: args.prUrl,
      mergeSha: args.mergeSha,
      findings,
    });
  } catch { /* fire-and-forget: emission failure must not break the gate check */ }

  // Build result
  const data: PostMergeResult = {
    passed,
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    findings,
    report,
  };

  return { success: true, data };
}
