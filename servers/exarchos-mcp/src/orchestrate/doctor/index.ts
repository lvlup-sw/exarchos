/**
 * handleDoctor — composes the 11 per-check modules into a single MCP
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
import { ONBOARD_STREAM_ID, DOCTOR_STREAM_ID } from '../../core/infra-streams.js';
import { buildProbes as defaultBuildProbes } from './probes.js';
import type { DoctorProbes } from './probes.js';
import { DoctorOutputSchema, type CheckResult, type DoctorSummary } from './schema.js';
import type { CheckFn } from './checks/__shared__/make-stub-probes.js';
import {
  reconcileWithEvents,
  type ApplyCtx,
  type DetectOptions,
  type EmittedEvent,
  type ReconcileEventCtx,
} from '../../core/onboarding/reconcile.js';
import type { ReconcilePlan, ReconcileResult } from '../../core/onboarding/types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { WriterDeps } from '../init/probes.js';
import { buildWriterDeps } from '../init/probes.js';
import { getAllWriters } from '../init/index.js';
import type { RuntimeConfigWriter } from '../init/writers/writer.js';
import type { SeedResult } from '../init/seed-exarchos-config.js';
import type { PlanStep } from '../../core/onboarding/types.js';

import { runtimeNodeVersion } from './checks/runtime-node-version.js';
import { storageStateDir } from './checks/storage-state-dir.js';
import { storageSqliteHealth } from './checks/storage-sqlite-health.js';
import { envVariables } from './checks/env-variables.js';
import { vcsGitAvailable } from './checks/vcs-git-available.js';
import { agentConfigValid } from './checks/agent-config-valid.js';
import { agentMcpRegistered } from './checks/agent-mcp-registered.js';
import { sessionStartHook } from './checks/session-start-hook.js';
import { pluginSkillHashSync } from './checks/plugin-skill-hash-sync.js';
import { pluginVersionMatch } from './checks/plugin-version-match.js';
import { remoteMcpStub } from './checks/remote-mcp-stub.js';
import { invariantsCatalog } from './checks/invariants-catalog.js';

// ─── Canonical check list ──────────────────────────────────────────────────

/** All 12 checks. Order is preserved in the output — callers can scan
 * top-to-bottom for the first Fail. DR-8 added `session-start-hook` (#1485):
 * the SessionStart binding presence check that lands the default-on hook step. */
export const ALL_CHECKS: ReadonlyArray<CheckFn> = [
  runtimeNodeVersion,
  storageStateDir,
  storageSqliteHealth,
  envVariables,
  vcsGitAvailable,
  agentConfigValid,
  agentMcpRegistered,
  sessionStartHook,
  pluginSkillHashSync,
  pluginVersionMatch,
  remoteMcpStub,
  invariantsCatalog,
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

  const meta = check as { meta?: { name?: string; category?: string } };
  const checkCategory = meta.meta?.category ?? 'runtime';
  const checkName = meta.meta?.name ?? fnName;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        category: checkCategory as CheckResult['category'],
        name: checkName,
        status: 'Warning',
        message: `Check ${checkName} did not complete within ${timeoutMs}ms`,
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
  /**
   * DR-4: repair drift through the SHARED reconciler. When set, doctor runs the
   * checks, builds the structured `ReconcilePlan`, routes it through the SAME
   * `apply` `onboard` uses (via `reconcileWithEvents` with `trigger:'doctor-fix'`),
   * re-runs the checks, and reports residuals. Bare `doctor` (this unset) stays
   * read-only — it only emits `diagnostic.executed`, never an `onboard.*` event.
   */
  readonly fix?: boolean;
  /** Optional caller-supplied AbortSignal. When aborted, the composer
   * propagates cancellation to every running check and rethrows
   * AbortError. Used by long-running CLI invocations and MCP callers
   * that want to cancel mid-flight. */
  readonly externalSignal?: AbortSignal;
}

/**
 * The injected dependency bundle for the `doctor --fix` path (DR-4). Production
 * callers use {@link defaultDoctorFixDeps} (real init writers + real writer deps
 * + the real doctor composer as `runDoctorChecks`); tests inject a fixture repo,
 * a stateful `runDoctorChecks`, and a stub `seed`.
 *
 * `doctor --fix` reuses the reconciler DIRECTLY (it imports
 * `reconcileWithEvents` from `core/onboarding/reconcile.js`) rather than calling
 * the `onboard` handler — the two share the ONE `apply`, which is what makes them
 * converge by construction (DR-4). This is the single injection axis; the event
 * seam (over `ctx.eventStore`) is built internally so callers cannot mis-wire the
 * two-event split (the CAS-pin idempotency trap).
 */
export interface DoctorFixDeps {
  /** Repo root the fix reconciles (the dispatch cwd in prod; a fixture in tests). */
  readonly repoRoot: string;
  /**
   * Produces the doctor `actual` check results the reconciler's `diff`
   * classifies. The reconciler calls this for the plan; doctor re-runs the
   * checks itself for the post-fix residual report. The real composer runs the
   * 12 checks; tests stub it.
   */
  readonly runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>;
  /** Writer deps for GENERATE (real-fs in prod, fixture-redirected in tests). */
  readonly writerDeps: WriterDeps;
  /** Init writers GENERATE routes through (the production set by default). */
  readonly writers: ReadonlyArray<RuntimeConfigWriter>;
  /** Config seeder (defaults to the real `seedExarchosConfig` via `apply`). */
  readonly seed?: (repoRoot: string, force: boolean) => SeedResult;
  /** CLI-only install hook (real `npx` install is task 015; no-op default). */
  readonly installStep?: (step: PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Lifecycle-hook installer (real #1485 binding lives in onboard/hooks.ts). */
  readonly installHook?: (step: PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Threaded into `detectDesiredState` (runtime/vcs/command overrides). */
  readonly detectOptions?: DetectOptions;
}

/** The post-fix re-diff residual surfaced on a `doctor --fix` result. */
export interface DoctorFixSummary {
  /** The plan that was reconciled (the structured doctor diff). */
  readonly plan: ReconcilePlan;
  /** The apply result (which steps applied/skipped/residual + advisories). */
  readonly result?: ReconcileResult;
  /** The post-apply re-diff: plan steps still outstanding after the fix. */
  readonly residual: ReconcilePlan;
}

export type BuildProbesFn = (ctx: DispatchContext) => DoctorProbes;

/**
 * Stream ID for diagnostic events. Doctor is phase-independent and
 * not tied to any workflow, so a dedicated stream keeps diagnostic
 * history separate from workflow streams. (`DOCTOR_STREAM_ID` is imported
 * with `ONBOARD_STREAM_ID` at the top of the module; re-exported here so
 * callers keep their single import site alongside the handler.)
 */
export { DOCTOR_STREAM_ID };

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
  fixDeps?: DoctorFixDeps,
): Promise<ToolResult> {
  // DR-4: `--fix` routes through the SHARED reconciler BEFORE the read-only
  // diagnosis. It emits the `onboard.requested`/`onboard.executed` split with
  // `trigger:'doctor-fix'` (NOT `diagnostic.executed`) and then runs the checks
  // a final time to report the post-fix residual. Bare `doctor` skips this
  // entirely and stays read-only.
  let fixSummary: DoctorFixSummary | undefined;
  if (args.fix) {
    fixSummary = await runDoctorFix(ctx, fixDeps ?? defaultDoctorFixDeps(ctx));
  }

  const timeoutMs = args.timeoutMs ?? 2000;
  const controller = new AbortController();
  const probes = buildProbes(ctx);
  const startedAt = Date.now();

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
  const durationMs = Date.now() - startedAt;

  // DIM-3: validate the output shape through Zod. A parse failure here
  // is a programming error (check returned an invalid shape or tally
  // disagrees with the refinement), not a user-facing condition —
  // throw loud so the defect is caught in CI, not silently forwarded.
  const output = DoctorOutputSchema.parse({ checks: results, summary });

  // Emit diagnostic.executed after the successful run — but ONLY on the
  // read-only path. Under `--fix` the audit trail is the shared
  // `onboard.requested`/`onboard.executed` split (already emitted by the
  // reconciler with `trigger:'doctor-fix'`); a `diagnostic.executed` here would
  // double-count the run and blur the read-only-vs-mutating boundary (DR-4). If
  // the caller aborted above, control never reaches here — the abort path
  // rejects before any partial event is written (DIM-7).
  if (!args.fix) {
    void emitDiagnosticEvent(ctx, output.checks, summary, durationMs).catch(() => {
      // best-effort telemetry; do not fail doctor output
    });
  }

  return {
    success: true,
    // On the fix path the structured reconcile summary (plan + apply result +
    // post-fix residual) rides alongside the final read-only checks so callers
    // can see both what was reconciled and what (if anything) still drifts.
    data: fixSummary ? { ...output, postFix: fixSummary } : output,
  };
}

// ─── doctor --fix (DR-4) ─────────────────────────────────────────────────────

/**
 * `runDoctorFix` — repair drift through the SHARED reconciler (DR-4).
 *
 * Builds the event seam over the real {@link DispatchContext.eventStore} and the
 * apply seam from the injected {@link DoctorFixDeps}, then calls
 * {@link reconcileWithEvents} with `trigger:'doctor-fix'`. The reconciler runs
 * `detect`→`diff`→`apply` and emits the DR-7 two-event split; we then re-run the
 * doctor checks and re-`diff` to surface the post-fix residual.
 *
 * Reuse, not re-implementation: this is the EXACT `apply` `onboard` drives, so a
 * `doctor --fix` and an `onboard` over the same repo converge by construction.
 * We import the reconciler directly (never the `onboard` handler) so the two
 * facades stay independent (INV-2) while sharing the one behavior.
 */
async function runDoctorFix(
  ctx: DispatchContext,
  deps: DoctorFixDeps,
): Promise<DoctorFixSummary> {
  const eventCtx = buildOnboardEventCtx(ctx);
  const applyCtx = buildFixApplyCtx(deps);

  const outcome = await reconcileWithEvents(
    {
      repoRoot: deps.repoRoot,
      trigger: 'doctor-fix',
      runDoctorChecks: deps.runDoctorChecks,
      ...(deps.detectOptions ? { detectOptions: deps.detectOptions } : {}),
    },
    eventCtx,
    applyCtx,
  );

  // Post-fix re-diff: re-run the checks and classify what (if anything) remains.
  const { diff } = await import('../../core/onboarding/reconcile.js');
  const postChecks = await deps.runDoctorChecks(deps.repoRoot);
  const residual = diff({ runtimes: [], vcs: 'git', commands: {} }, postChecks);

  return {
    plan: outcome.plan,
    ...(outcome.result ? { result: outcome.result } : {}),
    residual,
  };
}

/**
 * Build the {@link ReconcileEventCtx} over the real {@link EventStore}, mirroring
 * the `onboard` handler's seam: `emit` is a PLAIN append to
 * {@link ONBOARD_STREAM_ID} (never CAS-pinned — the idempotency trap), and
 * `readStreamTail` returns ONLY the tail of the current logical run (everything
 * after the last `onboard.executed`) so a fresh `doctor --fix` reconciles drift
 * rather than idempotency-collapsing onto a prior completed run.
 */
function buildOnboardEventCtx(ctx: DispatchContext): ReconcileEventCtx {
  return {
    emit: async (event: EmittedEvent): Promise<void> => {
      await ctx.eventStore.append(ONBOARD_STREAM_ID, {
        type: event.type,
        data: event.data,
      });
    },
    readStreamTail: async (): Promise<readonly EmittedEvent[]> => {
      const events: WorkflowEvent[] = await ctx.eventStore.query(ONBOARD_STREAM_ID);
      const onboardEvents: EmittedEvent[] = [];
      for (const e of events) {
        if (e.type === 'onboard.requested' || e.type === 'onboard.executed') {
          onboardEvents.push({ type: e.type, data: e.data } as EmittedEvent);
        }
      }
      let lastExecutedIdx = -1;
      for (let i = onboardEvents.length - 1; i >= 0; i--) {
        if (onboardEvents[i].type === 'onboard.executed') {
          lastExecutedIdx = i;
          break;
        }
      }
      return onboardEvents.slice(lastExecutedIdx + 1);
    },
  };
}

/** Build the {@link ApplyCtx} side-effect bundle for a `doctor --fix` run. */
function buildFixApplyCtx(deps: DoctorFixDeps): ApplyCtx {
  return {
    repoRoot: deps.repoRoot,
    // doctor --fix runs from the CLI surface (it is a local maintenance verb), so
    // cli-only install steps execute rather than downgrading to an advisory.
    surface: 'cli',
    writerDeps: deps.writerDeps,
    writers: deps.writers,
    ...(deps.seed ? { seed: deps.seed } : {}),
    ...(deps.installStep ? { installStep: deps.installStep } : {}),
    ...(deps.installHook ? { installHook: deps.installHook } : {}),
  };
}

/**
 * Production `doctor --fix` deps: the real init writers + writer deps + the real
 * doctor composer as `runDoctorChecks` (reusing the 12-check composer verbatim —
 * one check source, INV-2/DR-4). `repoRoot` is the dispatch cwd. The
 * `installHook`/`installStep` hooks default to the reconciler's no-ops until
 * tasks 012/015 supply the real binders.
 */
export function defaultDoctorFixDeps(ctx: DispatchContext): DoctorFixDeps {
  return {
    repoRoot: ctx.cwd ?? process.cwd(),
    runDoctorChecks: async (): Promise<readonly CheckResult[]> => {
      const result = await handleDoctorWithChecks({}, ctx, ALL_CHECKS, defaultBuildProbes);
      if (!result.success) return [];
      const data = result.data as { checks?: readonly CheckResult[] } | undefined;
      return data?.checks ?? [];
    },
    writerDeps: buildWriterDeps(),
    writers: getAllWriters(),
  };
}

/** Emit a `diagnostic.executed` event with summary, checkCount,
 * failedCheckNames, and durationMs. Schema for the event payload lives
 * in event-store/schemas.ts. */
async function emitDiagnosticEvent(
  ctx: DispatchContext,
  results: ReadonlyArray<CheckResult>,
  summary: DoctorSummary,
  durationMs: number,
): Promise<void> {
  const failedCheckNames = results
    .filter((r) => r.status === 'Fail')
    .map((r) => r.name);
  await ctx.eventStore.append(DOCTOR_STREAM_ID, {
    type: 'diagnostic.executed' as const,
    data: {
      summary,
      checkCount: results.length,
      failedCheckNames,
      durationMs,
    },
  });
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
