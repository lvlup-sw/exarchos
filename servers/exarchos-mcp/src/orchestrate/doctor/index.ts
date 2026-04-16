/**
 * handleDoctor — composes the 10 per-check modules into a single MCP
 * action.
 *
 * Design notes:
 *   - Parallel fan-out with `Promise.all` so wall-time is bounded by the
 *     slowest check, not the sum. Every check receives the same
 *     AbortSignal so a caller-initiated abort cancels everything at
 *     once (DIM-7).
 *   - Per-check timeout wrapped with `runCheckWithTimeout`: a race
 *     between the check and a sleep returning a Warning CheckResult.
 *     Timeouts are non-fatal — the composer reports what it knows and
 *     lets the operator follow the `fix` hint.
 *   - External abort is a caller exception, not a result — we rethrow
 *     AbortError so the surrounding dispatch path can distinguish
 *     user-cancellation from a result-bearing outcome (DIM-7).
 *   - Testable seam: `handleDoctorWithChecks` takes an explicit `checks`
 *     array and `buildProbes` factory so tests never rely on the real
 *     probe bundle or the canonical check list (DIM-4).
 */

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { buildProbes as defaultBuildProbes } from './probes.js';
import type { DoctorProbes } from './probes.js';
import { DoctorOutputSchema, type CheckResult, type DoctorSummary } from './schema.js';
import type { CheckFn } from './checks/__shared__/make-stub-probes.js';

import { runtimeNodeVersion } from './checks/runtime-node-version.js';
import { storageStateDir } from './checks/storage-state-dir.js';
import { storageSqliteHealth } from './checks/storage-sqlite-health.js';
import { envVariables } from './checks/env-variables.js';
import { vcsGitAvailable } from './checks/vcs-git-available.js';
import { agentConfigValid } from './checks/agent-config-valid.js';
import { agentMcpRegistered } from './checks/agent-mcp-registered.js';
import { pluginSkillHashSync } from './checks/plugin-skill-hash-sync.js';
import { pluginVersionMatch } from './checks/plugin-version-match.js';
import { remoteMcpStub } from './checks/remote-mcp-stub.js';

// ─── Canonical check list ──────────────────────────────────────────────────

/** All 10 checks. Order is preserved in the output — callers can scan
 * top-to-bottom for the first Fail. */
export const ALL_CHECKS: ReadonlyArray<CheckFn> = [
  runtimeNodeVersion,
  storageStateDir,
  storageSqliteHealth,
  envVariables,
  vcsGitAvailable,
  agentConfigValid,
  agentMcpRegistered,
  pluginSkillHashSync,
  pluginVersionMatch,
  remoteMcpStub,
];

// ─── Per-check timeout ─────────────────────────────────────────────────────

async function runCheckWithTimeout(
  check: CheckFn,
  probes: DoctorProbes,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CheckResult> {
  // Extract a usable name for the timeout Warning result. Falls back to
  // a sentinel when the function has no binding name (e.g. arrow
  // expressions returned by a factory). Schema requires name.length >= 1.
  const fnBindingName = (check as { name?: string }).name;
  const fnName = fnBindingName && fnBindingName.length > 0 ? fnBindingName : 'unknown-check';

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        category: 'runtime',
        name: fnName,
        status: 'Warning',
        message: `Check ${fnName} did not complete within ${timeoutMs}ms`,
        fix: `Check exceeded ${timeoutMs}ms timeout; investigate manually`,
        durationMs: timeoutMs,
      });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([check(probes, signal), timeoutPromise]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

export interface HandleDoctorArgs {
  readonly timeoutMs?: number;
  readonly format?: 'table' | 'json';
  /** Optional caller-supplied AbortSignal. When aborted, the composer
   * propagates cancellation to every running check and rethrows
   * AbortError. Used by long-running CLI invocations and MCP callers
   * that want to cancel mid-flight. */
  readonly externalSignal?: AbortSignal;
}

export type BuildProbesFn = (ctx: DispatchContext) => DoctorProbes;

/**
 * Testable seam — accepts an explicit `checks` list and `buildProbes`
 * factory. Production callers use `handleDoctor` which binds these to
 * the real canonical sources.
 */
export async function handleDoctorWithChecks(
  args: HandleDoctorArgs,
  ctx: DispatchContext,
  checks: ReadonlyArray<CheckFn>,
  buildProbes: BuildProbesFn,
): Promise<ToolResult> {
  const timeoutMs = args.timeoutMs ?? 2000;
  const controller = new AbortController();
  const probes = buildProbes(ctx);

  // Wire the external signal so caller-initiated cancellation aborts
  // the per-check controller too. Do NOT abort the controller if the
  // external signal is never supplied.
  const externalSignal = args.externalSignal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      externalSignal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }

  const pending = Promise.all(
    checks.map((c) => runCheckWithTimeout(c, probes, controller.signal, timeoutMs)),
  );

  // Abort handling: caller abort short-circuits the waiter with an
  // AbortError. The per-check controller already propagated the signal
  // to each running check.
  const results = await Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      if (externalSignal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      externalSignal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }),
  ]);

  const summary = tallySummary(results);

  // DIM-3: validate the output shape through Zod. A parse failure here
  // is a programming error (check returned an invalid shape or tally
  // disagrees with the refinement), not a user-facing condition —
  // throw loud so the defect is caught in CI, not silently forwarded.
  const output = DoctorOutputSchema.parse({ checks: results, summary });

  return {
    success: true,
    data: output,
  };
}

/** Group results by status and count them. Pure — takes the results
 * array, returns a DoctorSummary whose totals equal the array length. */
function tallySummary(results: ReadonlyArray<CheckResult>): DoctorSummary {
  const summary: DoctorSummary = { passed: 0, warnings: 0, failed: 0, skipped: 0 };
  for (const r of results) {
    switch (r.status) {
      case 'Pass':
        summary.passed += 1;
        break;
      case 'Warning':
        summary.warnings += 1;
        break;
      case 'Fail':
        summary.failed += 1;
        break;
      case 'Skipped':
        summary.skipped += 1;
        break;
    }
  }
  return summary;
}

/**
 * Production entry point — binds the real check list and real probe
 * factory.
 */
export async function handleDoctor(
  args: HandleDoctorArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  return handleDoctorWithChecks(args, ctx, ALL_CHECKS, defaultBuildProbes);
}
