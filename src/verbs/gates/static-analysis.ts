// ─── Static Analysis Composite Action ────────────────────────────────────────
//
// Orchestrates static analysis checks (lint + typecheck) through the canonical
// durable evidence runner.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { resolveDiffBase } from '../../vcs/resolve-base-branch.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { execCommandRunner, runStaticAnalysis } from '../pure/static-analysis.js';

// ─── Argument & Result Types ─────────────────────────────────────────────────

interface StaticAnalysisArgs {
  readonly featureId: string;
  /**
   * Repository root to analyze. A literal path is used verbatim; the special
   * value `'auto'` resolves to the calling delegation's agent worktree (#1330);
   * omitting it falls back to `process.cwd()` for non-delegation callers.
   */
  readonly repoRoot?: string;
  /**
   * Explicit agent worktree path. Preferred resolver seam for `repoRoot:'auto'`
   * (threaded by the task-completion runbook in T-05). When absent, `'auto'`
   * falls back to the latest `worktree.created` event for `taskId`.
   */
  readonly worktreePath?: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly skipLint?: boolean;
  readonly skipTypecheck?: boolean;
}

interface StaticAnalysisResult {
  readonly passed: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly skipCount: number;
  readonly report: string;
  /**
   * True when the gate could not conclude. Two causes, both inconclusive:
   * no recognized toolchain (DR-4), or a constituent check that never ran
   * (DR-6 — a missing `lint`/`quality-check` script, or a `--skip-*` flag).
   * Distinct from `passed:false` alone (which means a real failure) —
   * callers must treat a skipped gate as inconclusive, not green. See DR-4 in
   * docs/plans/archive/2026-05-04-v290-dogfood-bundle.md and DR-6 in
   * docs/specs/2026-08-04-wiring-closure-and-unified-integration-suite.md.
   */
  readonly skipped?: boolean;
  /** Reason code when `skipped` is true ('no-toolchain' | 'constituent-skipped'). */
  readonly skipReason?: string;
  /**
   * True when the dimension is DEGRADED: a toolchain WAS detected and some
   * constituent ran, but at least one did not. Renders distinctly from a
   * whole-gate no-toolchain skip, and never as PASS.
   */
  readonly degraded?: boolean;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleStaticAnalysis(
  args: StaticAnalysisArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Preflight (DR-10): fail-fast on a miswired DispatchContext (a missing
  // eventStore is a wiring bug — without this guard the fire-and-forget emit
  // below silently swallows the failure and the gate runs without telemetry; see
  // PR #1185 / CR review 4177990662) / absent featureId, then resolve the
  // worktree-aware 'auto' repoRoot (#1330 — a literal path or the process.cwd()
  // default is preserved for existing callers).
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleStaticAnalysis',
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const base = await resolveDiffBase(repoRoot, args.baseBranch);

  return runDurableGateProducer(
    {
      gateClass: 'static-analysis',
      featureId: args.featureId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      // The diff base is a LABEL on the evidence subject here, not a range this
      // gate reads — it lints and typechecks the tree it was pointed at. So an
      // unresolved base withholds the label rather than yielding Indeterminate:
      // the gate still ran, it just cannot name a base it never used.
      ...(base.kind === 'resolved' ? { baseRef: base.branch } : {}),
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      // Run the pure TypeScript static analysis function.
      const analysisResult = runStaticAnalysis({
        repoRoot,
        skipLint: args.skipLint,
        skipTypecheck: args.skipTypecheck,
        runCommand: execCommandRunner,
      });

      // Map 'error' status to SCRIPT_ERROR response.
      if (analysisResult.status === 'error') {
        return {
          success: false,
          error: {
            code: 'SCRIPT_ERROR',
            message: analysisResult.error || 'Static analysis error',
          },
        };
      }

      // T-10 / DR-4: 'skip' with reason 'no-toolchain' means no recognized
      // toolchain — the gate never ran.
      // T-09 / DR-6: 'skip' with reason 'constituent-skipped' means a
      // toolchain WAS detected but a constituent check did not run. Both are
      // inconclusive, neither is green. Map to passed=false + skipped=true so
      // callers and canonical evidence render SKIP/DEGRADED distinctly from
      // PASS / FAIL, and so `normalizeGateVerdict` yields `indeterminate`
      // (which blocks protected promotion exactly as a fail does).
      const skipped = analysisResult.status === 'skip';
      const passed = analysisResult.status === 'pass';
      const degraded = skipped && analysisResult.skipReason === 'constituent-skipped';
      const { passCount, failCount, skipCount, output } = analysisResult;

      const result: StaticAnalysisResult = {
        passed,
        passCount,
        failCount,
        skipCount,
        report: output,
        ...(skipped ? { skipped: true, skipReason: analysisResult.skipReason ?? 'no-toolchain' } : {}),
        ...(degraded ? { degraded: true } : {}),
      };
      return { success: true, data: result };
    },
  );
}
