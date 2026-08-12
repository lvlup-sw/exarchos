/**
 * handleOnboard — the `onboard` verb dispatch-core handler (DR-2).
 *
 * Composes the Wave-1 pure reconciler (`dispatch/core/onboarding/reconcile.ts`) into the
 * full onboarding pipeline:
 *
 *   DETECT → CONFIG → GENERATE → INSTALL → VERIFY
 *
 * Stage map (the reconciler owns the *behavior*; this handler owns the *wiring*
 * — INV-2 facade):
 *   - DETECT/CONFIG/GENERATE/INSTALL are driven by `reconcileWithEvents`, which
 *     `detect`→`diff`→`apply`s the structured `ReconcilePlan` and emits the
 *     DR-7 two-event split (`onboard.requested` → side effect →
 *     `onboard.executed`) over an INJECTED event seam.
 *   - VERIFY re-runs the doctor checks and re-`diff`s; a residual *blocking*
 *     Fail makes the result a failure carrying the doctor diff in an INV-5b
 *     error envelope (`suggestedFix`). On success the handler returns the INV-5b
 *     carrier (`data` + `next_actions` pointing at `doctor`).
 *
 * Wiring seams (this handler is the seam OWNER per `reconcile.ts`'s contract):
 *   - The event seam (`ReconcileEventCtx`) is built over the REAL
 *     {@link DispatchContext.eventStore}: `emit` is a plain (never CAS-pinned)
 *     append to {@link ONBOARD_STREAM_ID}; `readStreamTail` is a FRESH read of
 *     that stream (the CAS-pin idempotency trap is sidestepped by construction).
 *   - The apply seam (`ApplyCtx`) is built from the init writers
 *     (`getAllWriters()` + `buildWriterDeps()`) plus the injected
 *     `installStep`/`installHook` hooks.
 *
 * All seams below are WIRED to their production implementations (the epic is
 * complete — no stubs remain in this module):
 *   - `installStep` runs the real skills/deps install (`./install.ts`).
 *   - `installHook` installs the real #1485 SessionStart binding (`./hooks.ts`).
 *   - `--new` scaffolds a greenfield repo then runs the identical pipeline
 *     against it (`./new.ts`).
 *   - The `onboard` action is registered (registry.ts) with its Zod flag schema
 *     and dispatched through `handleOrchestrate` (composite.ts) + the `exarchos
 *     onboard` CLI verb.
 *   - `doctor --fix` reuses this same `apply`/pipeline with `trigger:'doctor-fix'`
 *     (`../doctor/index.ts`), sharing the extracted event seam
 *     (`dispatch/core/onboarding/event-ctx.ts`).
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

// ─── Args ────────────────────────────────────────────────────────────────────

/**
 * The `onboard` action arguments (DR-2 flag surface). Task 011 registers these
 * as a Zod schema on the `exarchos_orchestrate.onboard` action; this typed
 * shape is the contract that schema must mirror.
 */
export interface HandleOnboardArgs {
  /** DR-3 greenfield: scaffold `<name>` then run the identical pipeline. Real
   * greenfield behavior is task 016; accepted + routed to a stub here. */
  readonly new?: string;
  /** Explicit agent-host runtime ids (DR-2 `--runtime`). Bypasses probing. */
  readonly runtime?: readonly string[];
  /** Explicit VCS id (DR-2 `--vcs`). Bypasses `.git` probing. */
  readonly vcs?: string;
  /** Compute the plan but perform NO side effect and emit NO events. */
  readonly dryRun?: boolean;
  /** Overwrite hand-edited config (DR-10) — preserves it otherwise. */
  readonly force?: boolean;
  /** Skip the DR-8 SessionStart hook step (#1485). */
  readonly noHooks?: boolean;
  /** Output projection hint (the carrier is shape-stable across both). */
  readonly format?: 'table' | 'json';
  /**
   * Capability surface the run executes on (DR-6). `'cli'` runs cli-only steps
   * (skills/deps install); any other surface downgrades them to an advisory.
   * The MCP adapter (task 011) supplies its surface here; CLI passes `'cli'`.
   */
  readonly surface?: Surface | 'cli';
}

// ─── Injected dependency bundle (testable seam) ───────────────────────────────

/**
 * The injected dependency bundle for {@link handleOnboard}. Production callers
 * use {@link defaultOnboardDeps} (real writers + the real doctor composer + the
 * stub install/hook hooks that tasks 012/015 replace). Tests inject a fixture
 * repo, stub `runDoctorChecks`, and spy hooks.
 *
 * This is the single injection axis the handler exposes — keeping the
 * event-seam construction (over `ctx.eventStore`) internal so callers can't
 * accidentally CAS-pin the two-event split.
 */
export interface OnboardDeps {
  /** Repo root the pipeline targets (the cwd for CLI; an explicit root in tests). */
  readonly repoRoot: string;
  /** Writer deps for GENERATE (real-fs in prod, fixture-redirected in tests). */
  readonly writerDeps: WriterDeps;
  /** Init writers GENERATE routes through (the production set by default). */
  readonly writers: ReadonlyArray<RuntimeConfigWriter>;
  /**
   * Produces the doctor `actual` check results that `diff` classifies. Called
   * TWICE per non-dry-run pipeline: once for the plan (DETECT) and once for the
   * VERIFY re-diff. The real composer runs the 12 checks; tests stub it.
   */
  readonly runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>;
  /** Config seeder (defaults to the real `seedExarchosConfig` via `apply`). */
  readonly seed?: (repoRoot: string, force: boolean) => SeedResult;
  /** CLI-only install hook (real `npx` install is task 015; no-op default). */
  readonly installStep?: (step: import('../../dispatch/core/onboarding/types.js').PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Lifecycle-hook installer (real #1485 binding is task 012; no-op default). */
  readonly installHook?: (step: import('../../dispatch/core/onboarding/types.js').PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Threaded into `detectDesiredState` (runtime/vcs/command overrides). */
  readonly detectOptions?: DetectOptions;
  /**
   * DR-3 greenfield scaffold seam (`--new <name>`). Seeds the salvageable
   * initial scaffold into a FRESH `<name>/` dir and returns its root, or refuses
   * cleanly over a non-empty target (DR-10). Defaults to {@link scaffoldNewRepo}
   * resolving `<name>` against {@link OnboardDeps.repoRoot} (the run's cwd).
   * Tests inject to control WHERE the new repo lands.
   */
  readonly scaffold?: (name: string) => ScaffoldNewResult;
}

// ─── Output shape ─────────────────────────────────────────────────────────────

/**
 * The structured `onboard` result payload. Shape-stable across `--format
 * table|json` (the format flag is a projection hint, not a shape switch).
 */
export interface OnboardOutput {
  /** Whether this run scaffolded a greenfield repo (DR-3; always false today). */
  readonly greenfield: boolean;
  /** Whether this was a dry-run (plan only, no writes, no events). */
  readonly dryRun: boolean;
  /** The structured reconcile plan (= the structured doctor diff). */
  readonly plan: ReconcilePlan;
  /** The apply result; absent on the dry-run path. */
  readonly result?: ReconcileResult;
  /** The VERIFY re-diff summary (absent on dry-run — no apply, nothing to verify). */
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

// ─── VERIFY ───────────────────────────────────────────────────────────────────

/**
 * VERIFY: re-run the doctor checks after apply and re-`diff`. A residual
 * *blocking* failure is a check that is still `Fail` (DR-2/DR-10: `Warning`
 * is non-blocking — the operator is advised but the onboard succeeds).
 */
async function verify(
  deps: OnboardDeps,
  plan: ReconcilePlan,
): Promise<OnboardVerify> {
  // The pure `diff` lives in the reconciler; import lazily to keep this module's
  // import graph tight and to reuse the EXACT classification the plan used.
  const { diff } = await import('../../dispatch/core/onboarding/reconcile.js');
  const checks = await deps.runDoctorChecks(deps.repoRoot);
  // `diff(desired, actual)` ignores `desired` today (the plan is derived from the
  // remediable checks); pass the prior plan's notional desired-state placeholder.
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

// ─── Apply seam ───────────────────────────────────────────────────────────────

/** Build the {@link ApplyCtx} side-effect bundle for a run. */
function buildApplyCtx(deps: OnboardDeps, args: HandleOnboardArgs): ApplyCtx {
  // DR-8: `--no-hooks` neutralizes the hook installer (the hook step still
  // routes, but its side effect is a no-op). The default hooks are no-ops too
  // (tasks 012/015 fill them) — tests inject spies.
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

// ─── INV-5b carriers ──────────────────────────────────────────────────────────

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
 * The INV-5b error envelope for a residual blocking Fail: a structured failure
 * carrying `suggestedFix` (re-run `doctor` to see the diff) + the still-failing
 * check names, never a silent partial success (DR-2/DR-10).
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

// ─── Greenfield scaffold (DR-3, task 016) ─────────────────────────────────────

/**
 * Greenfield scaffold (DR-3). Seeds the salvageable initial scaffold (dir +
 * `.exarchos.yml` seed + `.gitignore`) into a FRESH `<name>/` then hands the new
 * repo root back so the caller runs the IDENTICAL DR-2 pipeline against it. A
 * non-empty target is refused cleanly (DR-10) — the refusal is propagated as a
 * {@link ScaffoldNewResult} the handler turns into a structured `ToolResult`.
 *
 * `--new` is the ONLY difference between greenfield and adopt: this function
 * produces a freshly-seeded empty dir and nothing else, so running the pipeline
 * against it is byte-equivalent (modulo timestamps) to adopting an
 * equivalently-seeded empty dir. There is exactly one pipeline code path.
 *
 * The scaffold behavior lives in {@link scaffoldNewRepo} (in `./new.ts`); this
 * wrapper just resolves the default (`<name>` against `deps.repoRoot`, the run's
 * cwd) versus the injected `deps.scaffold` seam.
 */
function scaffoldGreenfield(name: string, deps: OnboardDeps): ScaffoldNewResult {
  return deps.scaffold
    ? deps.scaffold(name)
    : scaffoldNewRepo(name, deps.repoRoot);
}

/**
 * Retarget the injected deps at the freshly-scaffolded greenfield `repoRoot`.
 *
 * The greenfield dir is a NEW path (a child of the run's cwd), so the
 * project-scoped half of the pipeline — `repoRoot` (DETECT/CONFIG/VERIFY) AND
 * the GENERATE writers' `cwd` — must point at it, not the parent cwd.
 * Retargeting `writerDeps.cwd` here is what makes the GENERATE step write
 * `CLAUDE.md` / `.claude/` INTO the new dir.
 *
 * `writerDeps.home` is deliberately NOT retargeted: `home` is the user's
 * agent-host home (`~`), a per-USER global location, not a per-PROJECT one.
 * Scaffolding a new project does not create a new home. Home-scoped writes — most
 * notably the #1485 SessionStart binding at `<home>/.claude/settings.json` —
 * must still land in the real home, never inside the scaffolded project dir.
 * (Pinning `home` to the project root would install the hook in the wrong place.)
 */
function retargetDeps(deps: OnboardDeps, repoRoot: string): OnboardDeps {
  return {
    ...deps,
    repoRoot,
    writerDeps: { ...deps.writerDeps, cwd: () => repoRoot },
  };
}

/**
 * The structured refusal `ToolResult` for a greenfield target that exists and is
 * non-empty (DR-10). Carries the scaffold error verbatim plus a `suggestedFix`
 * pointing at a plain `onboard` (adopt the existing dir in place) — no partial
 * scaffold was written, and no events were emitted.
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

// ─── Handler (testable seam) ──────────────────────────────────────────────────

/**
 * `handleOnboard(args, ctx, deps)` — the `onboard` verb pipeline.
 *
 * `deps` is the injection seam (default: {@link defaultOnboardDeps}). The
 * event seam is built INTERNALLY over `ctx.eventStore` so callers cannot
 * mis-wire the two-event split.
 *
 * Returns the INV-5b carrier on success (data + `next_actions`→`doctor`); a
 * residual blocking Fail returns the structured failure envelope with
 * `suggestedFix`.
 */
export async function handleOnboard(
  args: HandleOnboardArgs,
  ctx: DispatchContext,
  deps: OnboardDeps = defaultOnboardDeps(ctx, args),
): Promise<ToolResult> {
  const startedAt = Date.now();

  // DR-3: greenfield is the ONLY pre-pipeline difference. When `--new <name>` is
  // given, seed the salvageable scaffold into a FRESH `<name>/` and RETARGET the
  // pipeline at that dir; everything below is the identical adopt pipeline. A
  // non-empty target refuses cleanly (DR-10) BEFORE any pipeline step or event.
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

  // DETECT → CONFIG → GENERATE → INSTALL (the two-event split + apply).
  const outcome = await reconcileWithEvents(input, eventCtx, applyCtx);

  // Dry-run: surface the plan; no apply, no events, no VERIFY (nothing changed).
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

  // VERIFY: re-run the doctor checks → re-diff → blocking-residual gate.
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

// ─── Production wiring ────────────────────────────────────────────────────────

/**
 * The production `runDoctorChecks` seam — runs the real 12 checks through the
 * shared {@link runChecksOnly} core (one check source, INV-2 / DR-4). The 12th
 * check (`session-start-hook`, DR-8) is what lands the default-on hook step.
 *
 * It uses the check-execution core directly rather than {@link handleDoctorWithChecks}
 * so onboard does NOT emit a read-only `diagnostic.executed` for each of its
 * DETECT/VERIFY check passes — onboard's audit trail is the
 * `onboard.requested` / `onboard.executed` split (INV-1 / INV-13). The
 * `repoRoot` the reconciler passes (e.g. an `--new` greenfield dir) is honoured.
 */
function defaultRunDoctorChecks(
  ctx: DispatchContext,
): (repoRoot: string) => Promise<readonly CheckResult[]> {
  return (repoRoot) => runChecksOnly(ctx, repoRoot);
}

/**
 * Production deps: real init writers + real writer deps + the real doctor
 * composer + the real DR-8 SessionStart hook installer (`installHook`) + the
 * real DR-2/DR-6 skills + deps install hook (`installStep`).
 *
 * `installHook` is wired by DEFAULT (#1485, task 012): when the `session-start-hook`
 * doctor check reports the binding missing, `diff` lands a `hook` PlanStep that
 * `apply` routes to this installer. `--no-hooks` neutralizes it upstream in
 * `buildApplyCtx`, so the default-on posture is owned here and the opt-out is a
 * single seam.
 *
 * `installStep` is wired by DEFAULT (task 015): an `install` PlanStep (skills
 * bundle / project deps) is routed to it by `apply`'s install router — but ONLY
 * on the CLI surface (`apply` downgrades it to a cli-only advisory off-CLI, so
 * this hook never needs a surface guard of its own). It reuses `installSkills`'
 * local-copy fast path + `npx` fallback and the Bundle B install-command
 * resolver. `repoRoot` is the dispatch cwd (the repo being onboarded).
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

// Re-export the stream id so callers (task 011 registry, view filters) have a
// single import site alongside the handler.
export { ONBOARD_STREAM_ID };
