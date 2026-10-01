/**
 * `onboard` verb handler. It wires the onboarding reconciler into the pipeline DETECT, CONFIG,
 * GENERATE, INSTALL and VERIFY:
 *   - `reconcileWithEvents` runs DETECT to INSTALL. It applies the `ReconcilePlan` between an
 *     `onboard.requested` event and an `onboard.executed` event.
 *   - VERIFY runs the doctor checks again. A blocking `Fail` gives a failure with a `suggestedFix`.
 * The handler builds the event seam over `ctx.eventStore`, and the apply seam from the init writers
 * and the install hooks. The module also re-exports `ONBOARD_STREAM_ID` beside the handler.
 */

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { ONBOARD_STREAM_ID } from '../../dispatch/core/infra-streams.js';
import type { ToolResult } from '../../format.js';
import type { NextAction } from '../../next-action.js';
import type { CheckResult } from '../doctor/schema.js';
import { runChecksOnly } from '../doctor/index.js';
import { getAllWriters } from '../init/index.js';
import { installHook as defaultInstallHook } from './hooks.js';
import { installStep as defaultInstallStep } from './install.js';
import { scaffoldNewRepo, type ScaffoldNewResult, type ScaffoldError as ScaffoldNewError } from './new.js';
import { buildWriterDeps } from '../init/probes.js';
import type { WriterDeps } from '../init/probes.js';
import type { RuntimeConfigWriter } from '../init/writers/writer.js';
import type { SeedResult } from '../init/seed-exarchos-config.js';
import {
  reconcileWithEvents,
  type ApplyCtx,
  type DetectOptions,
  type OnboardTrigger,
  type ReconcileEventInput,
} from '../../dispatch/core/onboarding/reconcile.js';
import { buildOnboardEventCtx } from '../../dispatch/core/onboarding/event-ctx.js';
import type { ReconcilePlan, ReconcileResult, Surface } from '../../dispatch/core/onboarding/types.js';

/** The `onboard` action arguments. The registry schema of the action must match this shape. */
export interface HandleOnboardArgs {
  /** Greenfield: scaffold `<name>`, then run the same pipeline against it. */
  readonly new?: string;
  /** Explicit agent-host runtime ids from `--runtime`. They bypass the probe. */
  readonly runtime?: readonly string[];
  /** Explicit VCS id from `--vcs`. It bypasses the `.git` probe. */
  readonly vcs?: string;
  /** Compute the plan, apply no step and emit no events. With `new`, the greenfield scaffold still writes the target first. */
  readonly dryRun?: boolean;
  /** Overwrite hand-edited config. Without it, the run keeps that config. */
  readonly force?: boolean;
  /** Skip the SessionStart hook step. */
  readonly noHooks?: boolean;
  /** Output projection hint (the carrier is shape-stable across both). */
  readonly format?: 'table' | 'json';
  /**
   * The surface of the run. `'cli'`, the default, runs the CLI-only install steps. Any other
   * surface turns them into an advisory.
   */
  readonly surface?: Surface | 'cli';
}

/**
 * The injected dependencies of {@link handleOnboard}. Production uses {@link defaultOnboardDeps}.
 * The event seam is not in this bundle, so a caller cannot CAS-pin the two-event split.
 */
export interface OnboardDeps {
  /** Repo root of the pipeline: the cwd on the CLI, or an explicit root in tests. */
  readonly repoRoot: string;
  /** Writer deps for GENERATE (real-fs in prod, fixture-redirected in tests). */
  readonly writerDeps: WriterDeps;
  /** Init writers GENERATE routes through (the production set by default). */
  readonly writers: ReadonlyArray<RuntimeConfigWriter>;
  /**
   * Returns the doctor check results that `diff` classifies. A run that is not a dry run calls it
   * twice: once for the plan and once for VERIFY.
   */
  readonly runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>;
  /** Config seeder. When absent, `apply` uses the real `seedExarchosConfig`. */
  readonly seed?: (repoRoot: string, force: boolean) => SeedResult;
  /** CLI-only install step. When absent, `apply` runs a no-op. */
  readonly installStep?: (step: import('../../dispatch/core/onboarding/types.js').PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Lifecycle-hook installer. When absent, `apply` runs a no-op. */
  readonly installHook?: (step: import('../../dispatch/core/onboarding/types.js').PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Threaded into `detectDesiredState` (runtime/vcs/command overrides). */
  readonly detectOptions?: DetectOptions;
  /**
   * Greenfield scaffold for `--new <name>`. It seeds a new `<name>/` directory and returns its root,
   * or returns a refusal, such as for a non-empty target. When absent, {@link scaffoldNewRepo}
   * resolves `<name>` against {@link OnboardDeps.repoRoot}.
   */
  readonly scaffold?: (name: string) => ScaffoldNewResult;
}

/** The `onboard` result payload. Its shape is the same for both `--format` values. */
export interface OnboardOutput {
  /** True when this run scaffolded a greenfield repo. */
  readonly greenfield: boolean;
  /** Whether this was a dry-run (plan only, no writes, no events). */
  readonly dryRun: boolean;
  /** The reconcile plan, which is the structured doctor diff. */
  readonly plan: ReconcilePlan;
  /** The apply result. It is absent on a dry run. */
  readonly result?: ReconcileResult;
  /** The VERIFY summary. It is absent on a dry run, because nothing changed. */
  readonly verify?: OnboardVerify;
  /** Wall-clock duration of the whole pipeline, in milliseconds. */
  readonly durationMs: number;
}

/** The VERIFY stage summary: the post-apply doctor re-diff residual. */
export interface OnboardVerify {
  /** Plan steps still outstanding after apply (the re-diff). */
  readonly residual: ReconcilePlan;
  /** Count of residual checks whose status is a blocking `Fail`. */
  readonly residualBlocking: number;
  /** The names of the still-failing (blocking) checks, for the diff envelope. */
  readonly blockingChecks: readonly string[];
}

/**
 * VERIFY: runs the doctor checks after apply and calls `diff` again. Only a check that is still
 * `Fail` blocks. A `Warning` does not block the onboard. It loads `diff` lazily from the reconciler,
 * so it uses the same classification as the plan.
 */
async function verify(
  deps: OnboardDeps,
  plan: ReconcilePlan,
): Promise<OnboardVerify> {
  const { diff } = await import('../../dispatch/core/onboarding/reconcile.js');
  const checks = await deps.runDoctorChecks(deps.repoRoot);
  const residual = diff(
    { runtimes: [], vcs: 'git', commands: {} },
    checks,
  );
  const blocking = checks.filter((c) => c.status === 'Fail');
  return {
    residual,
    residualBlocking: blocking.length,
    blockingChecks: blocking.map((c) => c.name),
  };
}

/** Builds the {@link ApplyCtx} for a run. `--no-hooks` replaces the hook installer with a no-op. */
function buildApplyCtx(deps: OnboardDeps, args: HandleOnboardArgs): ApplyCtx {
  const installHook = args.noHooks
    ? async (): Promise<void> => undefined
    : deps.installHook;
  const ctx: ApplyCtx = {
    repoRoot: deps.repoRoot,
    surface: args.surface ?? 'cli',
    force: args.force ?? false,
    writerDeps: deps.writerDeps,
    writers: deps.writers,
    ...(deps.seed ? { seed: deps.seed } : {}),
    ...(deps.installStep ? { installStep: deps.installStep } : {}),
    ...(installHook ? { installHook } : {}),
  };
  return ctx;
}

/** The `next_actions` carried on a successful onboard: a pointer to `doctor`. */
function successNextActions(): NextAction[] {
  return [
    {
      verb: 'doctor',
      reason: 'verify the onboarded repo stays green with the read-only diagnosis',
      hint: 'run `exarchos doctor` (read-only) to re-check; `doctor --fix` reconciles drift',
    },
  ];
}

/**
 * The failure result for a blocking `Fail` after VERIFY. It names the failing checks and carries a
 * `suggestedFix` that runs `doctor`, so a partial success is never silent.
 */
function blockingResidualResult(output: OnboardOutput, verifyResult: OnboardVerify): ToolResult {
  return {
    success: false,
    data: output,
    error: {
      code: 'ONBOARD_RESIDUAL_BLOCKING',
      message:
        `onboard reconciled but ${verifyResult.residualBlocking} blocking check(s) still fail: ` +
        `${verifyResult.blockingChecks.join(', ')}. The repo is not fully configured.`,
      suggestedFix: {
        tool: 'exarchos_orchestrate',
        params: { action: 'doctor' },
      },
    },
    next_actions: [
      {
        verb: 'doctor',
        reason: 'inspect the residual blocking diff the onboard pipeline could not reconcile',
        hint: 'run `exarchos doctor` to see the structured diff of the still-failing checks',
      },
    ],
  };
}

/**
 * Seeds a new `<name>/` directory through `deps.scaffold` or {@link scaffoldNewRepo}. The caller
 * then runs the same pipeline against it, so greenfield and adopt share one code path.
 */
function scaffoldGreenfield(name: string, deps: OnboardDeps): ScaffoldNewResult {
  return deps.scaffold
    ? deps.scaffold(name)
    : scaffoldNewRepo(name, deps.repoRoot);
}

/**
 * Points `repoRoot` and the `cwd` of the writers at the new greenfield directory, so GENERATE writes
 * into it. It keeps `writerDeps.home`, because home-scoped writes such as the SessionStart binding
 * in `<home>/.claude/settings.json` belong in the real user home.
 */
function retargetDeps(deps: OnboardDeps, repoRoot: string): OnboardDeps {
  return {
    ...deps,
    repoRoot,
    writerDeps: { ...deps.writerDeps, cwd: () => repoRoot },
  };
}

/**
 * The refusal result when the greenfield scaffold refuses its target: an invalid name, a file, or a
 * non-empty directory. It carries the scaffold error and a `suggestedFix` that runs a plain
 * `onboard`.
 */
function greenfieldRefusalResult(error: ScaffoldNewError): ToolResult {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      suggestedFix: {
        tool: 'exarchos_orchestrate',
        params: { action: 'onboard' },
      },
    },
  };
}

/**
 * Runs the `onboard` pipeline. With `--new <name>`, it scaffolds first, and a scaffold refusal
 * returns before any pipeline step or event. A dry run returns the plan with no apply, no events
 * and no VERIFY. A success points `next_actions` at `doctor`.
 */
export async function handleOnboard(
  args: HandleOnboardArgs,
  ctx: DispatchContext,
  deps: OnboardDeps = defaultOnboardDeps(ctx, args),
): Promise<ToolResult> {
  const startedAt = Date.now();

  const greenfield = typeof args.new === 'string' && args.new.length > 0;
  let effectiveDeps = deps;
  if (greenfield) {
    const scaffolded = scaffoldGreenfield(args.new as string, deps);
    if (!scaffolded.ok) {
      return greenfieldRefusalResult(scaffolded.error);
    }
    effectiveDeps = retargetDeps(deps, scaffolded.repoRoot);
  }

  const trigger: OnboardTrigger = greenfield ? 'onboard-new' : 'onboard';

  const eventCtx = buildOnboardEventCtx(ctx);
  const applyCtx = buildApplyCtx(effectiveDeps, args);

  const input: ReconcileEventInput = {
    repoRoot: effectiveDeps.repoRoot,
    trigger,
    dryRun: args.dryRun ?? false,
    runDoctorChecks: effectiveDeps.runDoctorChecks,
    ...(effectiveDeps.detectOptions ? { detectOptions: effectiveDeps.detectOptions } : {}),
  };

  const outcome = await reconcileWithEvents(input, eventCtx, applyCtx);

  if (input.dryRun) {
    const output: OnboardOutput = {
      greenfield,
      dryRun: true,
      plan: outcome.plan,
      durationMs: Date.now() - startedAt,
    };
    return {
      success: true,
      data: output,
      next_actions: successNextActions(),
    };
  }

  const verifyResult = await verify(effectiveDeps, outcome.plan);

  const output: OnboardOutput = {
    greenfield,
    dryRun: false,
    plan: outcome.plan,
    ...(outcome.result ? { result: outcome.result } : {}),
    verify: verifyResult,
    durationMs: Date.now() - startedAt,
  };

  if (verifyResult.residualBlocking > 0) {
    return blockingResidualResult(output, verifyResult);
  }

  return {
    success: true,
    data: output,
    next_actions: successNextActions(),
  };
}

/**
 * The production `runDoctorChecks`. It calls {@link runChecksOnly}, not `handleDoctorWithChecks`, so
 * onboard emits no `diagnostic.executed` for its check passes. The audit trail of onboard is the
 * `onboard.requested` and `onboard.executed` pair.
 */
function defaultRunDoctorChecks(
  ctx: DispatchContext,
): (repoRoot: string) => Promise<readonly CheckResult[]> {
  return (repoRoot) => runChecksOnly(ctx, repoRoot);
}

/**
 * Production deps: the init writers, the real doctor checks, the SessionStart hook installer and
 * the skills and deps installer. A missing SessionStart binding gives a `hook` step, which `apply`
 * routes to `installHook`. `apply` routes an `install` step to `installStep` on the CLI surface
 * only. `repoRoot` is the dispatch cwd.
 */
export function defaultOnboardDeps(
  ctx: DispatchContext,
  args: HandleOnboardArgs,
): OnboardDeps {
  const detectOptions: DetectOptions = {
    ...(args.runtime ? { runtimes: args.runtime } : {}),
    ...(args.vcs ? { vcs: args.vcs } : {}),
  };
  return {
    repoRoot: ctx.cwd ?? process.cwd(),
    writerDeps: buildWriterDeps(),
    writers: getAllWriters(),
    runDoctorChecks: defaultRunDoctorChecks(ctx),
    installStep: defaultInstallStep,
    installHook: defaultInstallHook,
    ...(Object.keys(detectOptions).length > 0 ? { detectOptions } : {}),
  };
}

export { ONBOARD_STREAM_ID };
