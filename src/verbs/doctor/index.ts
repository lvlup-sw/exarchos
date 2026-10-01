/**
 * handleDoctor: runs every doctor check as one MCP action.
 *
 * The checks run in parallel and share one AbortSignal. Each check races a
 * timeout that resolves to a `Warning` result, so a slow check does not fail
 * the run. An external abort rethrows `AbortError`, so the dispatch path can
 * tell a cancellation from a result. `handleDoctorWithChecks` takes the check
 * list and the probe factory as arguments, so tests do not need the real ones.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { DOCTOR_STREAM_ID } from '../../dispatch/core/infra-streams.js';
import { buildProbes as defaultBuildProbes, DEFAULT_CHECK_BUDGET_MS } from './probes.js';
import type { DoctorProbes } from './probes.js';
import { DoctorOutputSchema, type CheckResult, type DoctorSummary } from './schema.js';
import type { CheckFn } from './checks/__shared__/make-stub-probes.js';
import {
  reconcileWithEvents,
  type ApplyCtx,
  type DetectOptions,
} from '../../dispatch/core/onboarding/reconcile.js';
import { buildOnboardEventCtx } from '../../dispatch/core/onboarding/event-ctx.js';
import type { ReconcilePlan, ReconcileResult } from '../../dispatch/core/onboarding/types.js';
import type { WriterDeps } from '../init/probes.js';
import { buildWriterDeps } from '../init/probes.js';
import { getAllWriters } from '../init/index.js';
import type { RuntimeConfigWriter } from '../init/writers/writer.js';
import type { SeedResult } from '../init/seed-exarchos-config.js';
import type { PlanStep } from '../../dispatch/core/onboarding/types.js';

import { runtimeNodeVersion } from './checks/runtime-node-version.js';
import { storageStateDir } from './checks/storage-state-dir.js';
import { storageSqliteHealth } from './checks/storage-sqlite-health.js';
import { storePathDivergence } from './checks/store-path-divergence.js';
import { runBundleIntegrity } from './checks/run-bundle-integrity.js';
import { envVariables } from './checks/env-variables.js';
import { vcsGitAvailable } from './checks/vcs-git-available.js';
import { agentConfigValid } from './checks/agent-config-valid.js';
import { agentMcpRegistered } from './checks/agent-mcp-registered.js';
import { sessionStartHook } from './checks/session-start-hook.js';
import { onrampBlockDrift } from './checks/onramp-block-drift.js';
import { retiredHooksPresent } from './checks/retired-hooks-present.js';
import { staleSkillDirs } from './checks/stale-skill-dirs.js';
import { pluginSkillHashSync } from './checks/plugin-skill-hash-sync.js';
import { pluginVersionMatch } from './checks/plugin-version-match.js';
import { installFreshness } from './checks/install-freshness.js';
import { remoteMcpStub } from './checks/remote-mcp-stub.js';
import { actionContractClosure } from './checks/action-contract-closure.js';
import { invariantsCatalog } from './checks/invariants-catalog.js';
import { verificationToolchain } from './checks/verification-toolchain.js';

/**
 * Every doctor check, in output order. `onramp-block-drift` comes before
 * `retired-hooks-present`, so the block-write step comes before the hook
 * removal step. The reconciler also enforces this order.
 */
export const ALL_CHECKS: ReadonlyArray<CheckFn> = [
  runtimeNodeVersion,
  storageStateDir,
  storageSqliteHealth,
  storePathDivergence,
  runBundleIntegrity,
  envVariables,
  vcsGitAvailable,
  agentConfigValid,
  agentMcpRegistered,
  sessionStartHook,
  onrampBlockDrift,
  retiredHooksPresent,
  staleSkillDirs,
  pluginSkillHashSync,
  pluginVersionMatch,
  installFreshness,
  remoteMcpStub,
  invariantsCatalog,
  actionContractClosure,
  verificationToolchain,
];

/**
 * Runs one check against a timeout. On timeout, it resolves to a `Warning`
 * result. If the check has no `meta.name` and no function name, the result
 * uses `unknown-check`, because the schema rejects an empty name.
 */
async function runCheckWithTimeout(
  check: CheckFn,
  probes: DoctorProbes,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CheckResult> {
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

/**
 * Runs the doctor checks and returns the results without a
 * `diagnostic.executed` event. The mutating paths (`doctor --fix` and
 * `onboard`) use it. Their audit trail is the `onboard.requested` and
 * `onboard.executed` pair, so an extra diagnostic event counts the run twice.
 * The checks run against `repoRoot`, not the dispatch cwd. The probe bundle
 * carries the timeout, so a bounded check can size its work to fit.
 */
export async function runChecksOnly(
  ctx: DispatchContext,
  repoRoot: string,
  checks: ReadonlyArray<CheckFn> = ALL_CHECKS,
  buildProbes: BuildProbesFn = defaultBuildProbes,
  timeoutMs = DEFAULT_CHECK_BUDGET_MS,
): Promise<readonly CheckResult[]> {
  const checkCtx: DispatchContext =
    ctx.cwd === repoRoot ? ctx : { ...ctx, cwd: repoRoot };
  const probes: DoctorProbes = { ...buildProbes(checkCtx), checkBudgetMs: timeoutMs };
  const controller = new AbortController();
  return Promise.all(
    checks.map((c) => runCheckWithTimeout(c, probes, controller.signal, timeoutMs)),
  );
}

export interface HandleDoctorArgs {
  readonly timeoutMs?: number;
  readonly format?: 'table' | 'json';
  /**
   * If true, doctor repairs drift through the shared reconciler with
   * `trigger:'doctor-fix'`, then runs the checks again and reports the residual.
   * If not set, doctor is read-only and emits only `diagnostic.executed`.
   */
  readonly fix?: boolean;
  /**
   * Caller abort signal. On abort, every running check gets the signal, and
   * the handler rethrows `AbortError`.
   */
  readonly externalSignal?: AbortSignal;
}

/**
 * Dependencies for the `doctor --fix` path. Production uses
 * {@link defaultDoctorFixDeps}, and tests inject fixtures. `doctor --fix` calls
 * `reconcileWithEvents` directly, not the `onboard` handler. The two share one
 * `apply`, so they converge. The event context is built internally, so a caller
 * cannot mis-wire the two-event split.
 */
export interface DoctorFixDeps {
  /** Repo root that the fix reconciles: the dispatch cwd in production, a fixture in tests. */
  readonly repoRoot: string;
  /**
   * Produces the check results that the reconciler `diff` classifies.
   * `runDoctorFix` also calls it for the post-fix residual.
   */
  readonly runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>;
  /** Writer deps for GENERATE: the real filesystem in production, a fixture in tests. */
  readonly writerDeps: WriterDeps;
  /** Init writers GENERATE routes through (the production set by default). */
  readonly writers: ReadonlyArray<RuntimeConfigWriter>;
  /** Config seeder (defaults to the real `seedExarchosConfig` via `apply`). */
  readonly seed?: (repoRoot: string, force: boolean) => SeedResult;
  /** CLI-only install hook. If not set, the reconciler uses a no-op. */
  readonly installStep?: (step: PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Lifecycle-hook installer. If not set, the reconciler uses a no-op. */
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

export { DOCTOR_STREAM_ID };

/**
 * Runs the given checks with the given probe factory. `handleDoctor` binds the
 * real ones. With `fix`, the reconciler runs first, and the reconcile summary
 * goes in `postFix`. Without `fix`, the handler awaits the `diagnostic.executed`
 * append, so the event is in the stream when the call returns. The output goes
 * through `DoctorOutputSchema.parse`, so a check result that is not valid throws.
 */
export async function handleDoctorWithChecks(
  args: HandleDoctorArgs,
  ctx: DispatchContext,
  checks: ReadonlyArray<CheckFn>,
  buildProbes: BuildProbesFn,
  fixDeps?: DoctorFixDeps,
): Promise<ToolResult> {
  let fixSummary: DoctorFixSummary | undefined;
  if (args.fix) {
    fixSummary = await runDoctorFix(ctx, fixDeps ?? defaultDoctorFixDeps(ctx));
  }

  const timeoutMs = args.timeoutMs ?? DEFAULT_CHECK_BUDGET_MS;
  const controller = new AbortController();
  const probes: DoctorProbes = { ...buildProbes(ctx), checkBudgetMs: timeoutMs };
  const startedAt = Date.now();

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

  const output = DoctorOutputSchema.parse({ checks: results, summary });

  if (!args.fix) {
    await emitDiagnosticEvent(ctx, output.checks, summary, durationMs);
  }

  return {
    success: true,
    data: fixSummary ? { ...output, postFix: fixSummary } : output,
  };
}

/**
 * Repairs drift through the shared reconciler with `trigger:'doctor-fix'`. The
 * reconciler runs `detect`, `diff`, and `apply`, and emits the two-event split.
 * Then this function runs the checks again and calls `diff` to get the residual.
 * It imports the reconciler, not the `onboard` handler, so the two verbs stay
 * independent but share one `apply`.
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

  const { diff } = await import('../../dispatch/core/onboarding/reconcile.js');
  const postChecks = await deps.runDoctorChecks(deps.repoRoot);
  const residual = diff({ runtimes: [], vcs: 'git', commands: {} }, postChecks);

  return {
    plan: outcome.plan,
    ...(outcome.result ? { result: outcome.result } : {}),
    residual,
  };
}

/**
 * Builds the {@link ApplyCtx} for a `doctor --fix` run. The surface is `cli`
 * because doctor is a local verb, so cli-only install steps do not become
 * advisories.
 */
function buildFixApplyCtx(deps: DoctorFixDeps): ApplyCtx {
  return {
    repoRoot: deps.repoRoot,
    surface: 'cli',
    writerDeps: deps.writerDeps,
    writers: deps.writers,
    ...(deps.seed ? { seed: deps.seed } : {}),
    ...(deps.installStep ? { installStep: deps.installStep } : {}),
    ...(deps.installHook ? { installHook: deps.installHook } : {}),
  };
}

/**
 * Production deps for `doctor --fix`: the real init writers, the real writer
 * deps, and {@link runChecksOnly} as `runDoctorChecks`. `repoRoot` is the
 * dispatch cwd. `installHook` and `installStep` are not set, so the reconciler
 * uses its no-ops for them.
 */
export function defaultDoctorFixDeps(ctx: DispatchContext): DoctorFixDeps {
  return {
    repoRoot: ctx.cwd ?? process.cwd(),
    runDoctorChecks: (repoRoot) => runChecksOnly(ctx, repoRoot),
    writerDeps: buildWriterDeps(),
    writers: getAllWriters(),
  };
}

/**
 * Appends a `diagnostic.executed` event with the summary, the check count, the
 * names of the failed and warned checks, and the duration. A `Warning` does not
 * change the exit code, so this event is the record of which check warned.
 */
async function emitDiagnosticEvent(
  ctx: DispatchContext,
  results: ReadonlyArray<CheckResult>,
  summary: DoctorSummary,
  durationMs: number,
): Promise<void> {
  const failedCheckNames = results
    .filter((r) => r.status === 'Fail')
    .map((r) => r.name);
  const warningCheckNames = results
    .filter((r) => r.status === 'Warning')
    .map((r) => r.name);
  await ctx.eventStore.append(DOCTOR_STREAM_ID, {
    type: 'diagnostic.executed' as const,
    data: {
      summary,
      checkCount: results.length,
      failedCheckNames,
      warningCheckNames,
      durationMs,
    },
  });
}

/** Counts the results by status. */
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

/** Production entry point: binds the real check list and the real probe factory. */
export async function handleDoctor(
  args: HandleDoctorArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  return handleDoctorWithChecks(args, ctx, ALL_CHECKS, defaultBuildProbes);
}
