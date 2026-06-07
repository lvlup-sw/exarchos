/**
 * handleOnboard — the `onboard` verb dispatch-core handler (DR-2).
 *
 * Composes the Wave-1 pure reconciler (`core/onboarding/reconcile.ts`) into the
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
 * Scope boundary (LATER tasks fill these seams — they are stubbable here):
 *   - `installStep` real `npx` skills/deps install → task 015.
 *   - `installHook` real #1485 SessionStart binding → task 012.
 *   - `--new` greenfield scaffold → task 016 (the flag is accepted + routed to a
 *     TODO stub here; no greenfield behavior lands in this task).
 *   - CLI/registry action registration + flag schema → task 011.
 *   - `doctor --fix` reuses this same `apply`/pipeline with `trigger:'doctor-fix'`
 *     → task 013.
 */

import type { DispatchContext } from '../../core/dispatch.js';
import { ONBOARD_STREAM_ID } from '../../core/infra-streams.js';
import type { ToolResult } from '../../format.js';
import type { NextAction } from '../../next-action.js';
import type { CheckResult } from '../doctor/schema.js';
import { handleDoctorWithChecks, ALL_CHECKS } from '../doctor/index.js';
import { buildProbes } from '../doctor/probes.js';
import { getAllWriters } from '../init/index.js';
import { buildWriterDeps } from '../init/probes.js';
import type { WriterDeps } from '../init/probes.js';
import type { RuntimeConfigWriter } from '../init/writers/writer.js';
import type { SeedResult } from '../init/seed-exarchos-config.js';
import {
  reconcileWithEvents,
  type ApplyCtx,
  type DetectOptions,
  type EmittedEvent,
  type OnboardTrigger,
  type ReconcileEventCtx,
  type ReconcileEventInput,
} from '../../core/onboarding/reconcile.js';
import type { ReconcilePlan, ReconcileResult, Surface } from '../../core/onboarding/types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

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
   * VERIFY re-diff. The real composer runs the 11 checks; tests stub it.
   */
  readonly runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>;
  /** Config seeder (defaults to the real `seedExarchosConfig` via `apply`). */
  readonly seed?: (repoRoot: string, force: boolean) => SeedResult;
  /** CLI-only install hook (real `npx` install is task 015; no-op default). */
  readonly installStep?: (step: import('../../core/onboarding/types.js').PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Lifecycle-hook installer (real #1485 binding is task 012; no-op default). */
  readonly installHook?: (step: import('../../core/onboarding/types.js').PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** Threaded into `detectDesiredState` (runtime/vcs/command overrides). */
  readonly detectOptions?: DetectOptions;
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
  const { diff } = await import('../../core/onboarding/reconcile.js');
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

// ─── Event seam (over the REAL EventStore) ────────────────────────────────────

/**
 * Build the {@link ReconcileEventCtx} over the real {@link EventStore}.
 *
 * `emit` is a PLAIN append (never CAS-pinned to a prior append's sequence — the
 * idempotency trap the reconciler's contract warns about).
 *
 * `readStreamTail` returns ONLY the tail of the CURRENT logical run — every
 * onboard event AFTER the stream's most recent `onboard.executed`. This is the
 * seam-owner's lever that reconciles two contracts the reconciler keys solely on
 * `repoRoot+trigger` (task 009):
 *
 *   - Crash recovery (INV-13): a dangling `onboard.requested` with NO paired
 *     `onboard.executed` sits AFTER the last completed run, so it is in the tail
 *     and the precheck resumes it (residual-only apply, no second `requested`).
 *   - Fresh-run reconciliation (DR-2 "re-run reconciles drift only"): a prior
 *     COMPLETED run's `requested`/`executed` pair is BEFORE the cut, so a fresh
 *     invocation sees an empty tail, does not idempotency-collapse, and
 *     reconciles whatever drift `diff` finds now.
 *
 * Without this cut the reconciler's `alreadyExecuted` short-circuit would make
 * every onboard after the first a permanent no-op on the same repo.
 */
function buildEventCtx(ctx: DispatchContext): ReconcileEventCtx {
  return {
    emit: async (event: EmittedEvent): Promise<void> => {
      // Plain append: the EventStore allocates the sequence. We never pass an
      // expectedSequence, so a retry never reproduces a CAS conflict.
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
          // Validated on append; the stored `data` matches the emitted payload.
          onboardEvents.push({ type: e.type, data: e.data } as EmittedEvent);
        }
      }
      // Cut to the current logical run: everything after the last executed half.
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

// ─── Greenfield stub (DR-3, task 016) ─────────────────────────────────────────

/**
 * Greenfield scaffold seam (DR-3). Task 016 fills this: create `<name>/`, seed
 * the salvageable scaffold (dir + `.exarchos.yml` seed + `.gitignore`), refuse
 * over a non-empty dir, then fall through to the IDENTICAL DR-2 pipeline. For
 * task 010 it is a no-op that records the requested name on the output flag so
 * the flag is accepted and routed, not silently dropped.
 */
function scaffoldGreenfield(_name: string): void {
  // TODO(task 016): real greenfield scaffold. Intentionally a no-op here so the
  // `--new` flag is accepted and the pipeline still runs against `repoRoot`.
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

  // DR-3: greenfield scaffold (no-op stub for task 010 — see seam above).
  const greenfield = typeof args.new === 'string' && args.new.length > 0;
  if (greenfield) scaffoldGreenfield(args.new as string);

  const trigger: OnboardTrigger = greenfield ? 'onboard-new' : 'onboard';

  const eventCtx = buildEventCtx(ctx);
  const applyCtx = buildApplyCtx(deps, args);

  const input: ReconcileEventInput = {
    repoRoot: deps.repoRoot,
    trigger,
    dryRun: args.dryRun ?? false,
    runDoctorChecks: deps.runDoctorChecks,
    ...(deps.detectOptions ? { detectOptions: deps.detectOptions } : {}),
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
  const verifyResult = await verify(deps, outcome.plan);

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
 * The production `runDoctorChecks` seam — runs the real 11 checks through the
 * doctor composer (`handleDoctorWithChecks`) and extracts the `CheckResult[]`.
 * Reuses the doctor composer verbatim (INV-2 / DR-4: one check source).
 */
function defaultRunDoctorChecks(
  ctx: DispatchContext,
): (repoRoot: string) => Promise<readonly CheckResult[]> {
  return async (): Promise<readonly CheckResult[]> => {
    const result = await handleDoctorWithChecks({}, ctx, ALL_CHECKS, buildProbes);
    if (!result.success) return [];
    const data = result.data as { checks?: readonly CheckResult[] } | undefined;
    return data?.checks ?? [];
  };
}

/**
 * Production deps: real init writers + real writer deps + the real doctor
 * composer. `installStep`/`installHook` are intentionally OMITTED so the
 * reconciler's no-op defaults apply until tasks 012/015 supply real impls.
 * `repoRoot` is the dispatch cwd (the repo being onboarded).
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
    ...(Object.keys(detectOptions).length > 0 ? { detectOptions } : {}),
  };
}

// Re-export the stream id so callers (task 011 registry, view filters) have a
// single import site alongside the handler.
export { ONBOARD_STREAM_ID };
