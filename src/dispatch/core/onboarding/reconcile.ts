/**
 * The harness-neutral onboarding reconciler. The `onboard` and `doctor` facades call it.
 *
 * - `detectDesiredState` derives the reconcile target.
 * - `diff` turns doctor check results into a `ReconcilePlan`.
 * - `apply` runs a plan and returns a `ReconcileResult`.
 * - `reconcileWithEvents` wraps `apply` in the `onboard.requested` and `onboard.executed` events,
 *   with crash recovery.
 *
 * This module imports nothing from `adapters/*`. It touches the event store only through an
 * injected seam. Desired commands come only from `resolveVerificationRuntime`, and an unresolved
 * command field is omitted, never fabricated.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { resolveVerificationRuntime } from '../../../config/test-runtime-resolver.js';
import { loadExarchosConfig } from '../../../config/load-exarchos-config.js';
import { BLOCK_DRIFT_CHECK_NAME } from '../../../verbs/onboard/block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../../verbs/onboard/hooks.js';
import {
  detectAgentEnvironments,
  type AgentRuntimeName,
} from '../../../runtime/agent-environment-detector.js';
import type { CheckResult } from '../../../verbs/doctor/schema.js';
import {
  seedExarchosConfig,
  type SeedResult,
} from '../../../verbs/init/seed-exarchos-config.js';
import type { WriterDeps } from '../../../verbs/init/probes.js';
import type {
  RuntimeConfigWriter,
  WriteOptions,
} from '../../../verbs/init/writers/writer.js';
import type {
  OnboardExecuted,
  OnboardRequested,
} from '../../../events/schemas.js';
import type {
  Advisory,
  DesiredState,
  PlanStep,
  PlanStepKind,
  ReconcilePlan,
  ReconcileResult,
  ResolvedCommands,
  Surface,
} from './types.js';

/**
 * Caller overrides for {@link detectDesiredState}. When a field is absent, detection reads the
 * filesystem.
 */
export interface DetectOptions {
  /** Explicit agent-host runtime ids from the `--runtime` flag. They bypass the probe. */
  readonly runtimes?: readonly string[];
  /** Explicit VCS id from the `--vcs` flag. It bypasses the `.git` probe. */
  readonly vcs?: string;
  /**
   * Command overrides for the override tier of the layered resolver. The resolver also resolves
   * `mutation` and `lint`, so this type accepts overrides for them too.
   */
  readonly commandOverride?: {
    readonly test?: string;
    readonly typecheck?: string;
    readonly install?: string;
    readonly mutation?: string;
    readonly lint?: string;
  };
  /**
   * Replaces the agent-host runtime probe, which reads the filesystem. It returns the configured
   * runtime ids for the repo.
   */
  readonly detectRuntimes?: (repoRoot: string) => Promise<readonly string[]>;
}

/**
 * Maps the layered resolver output onto {@link ResolvedCommands}. A `null` field means unresolved,
 * and the result omits it. The function never writes a default command.
 */
function deriveCommands(
  repoRoot: string,
  override?: DetectOptions['commandOverride'],
): ResolvedCommands {
  const resolved = resolveVerificationRuntime(
    repoRoot,
    override ? { override: { ...override } } : undefined,
  );

  const commands: ResolvedCommands = {};
  if (resolved.test !== null) commands.test = resolved.test;
  if (resolved.typecheck !== null) commands.typecheck = resolved.typecheck;
  if (resolved.install !== null) commands.install = resolved.install;
  if (resolved.mutation !== null) commands.mutation = resolved.mutation;
  if (resolved.lint !== null) commands.lint = resolved.lint;
  return commands;
}

/**
 * Reads the `mutation` and `lint` commands that `.exarchos.yml` declares at top level. A command
 * that the resolver derived from detection does not count as declared.
 *
 * A missing config gives `{}`. A loader error also gives `{}`, so a broken config cannot stop the
 * reconcile. The doctor checks report config validity.
 */
function declaredVerificationCommands(repoRoot: string): ResolvedCommands {
  let config;
  try {
    config = loadExarchosConfig(repoRoot)?.config;
  } catch {
    return {};
  }
  if (!config) return {};

  const declared: ResolvedCommands = {};
  if (config.mutation !== undefined) declared.mutation = config.mutation;
  if (config.lint !== undefined) declared.lint = config.lint;
  return declared;
}

/**
 * Returns `git` when a `.git` entry exists at the repo root, and `none` otherwise. A `.git` file,
 * which a worktree or a submodule uses, also counts.
 */
function detectVcs(repoRoot: string): string {
  return existsSync(path.join(repoRoot, '.git')) ? 'git' : 'none';
}

/**
 * Returns the agent-host runtime ids whose project config is present. The probe gets the repo root
 * as its `cwd`, so detection stays scoped to the repo.
 */
async function detectRuntimesDefault(repoRoot: string): Promise<readonly string[]> {
  const environments = await detectAgentEnvironments({ cwd: () => repoRoot });
  return environments
    .filter((env) => env.configPresent)
    .map((env): AgentRuntimeName => env.name);
}

/**
 * Derives the {@link DesiredState} for a repo: the agent runtimes, the VCS, and the
 * resolver-derived commands. `opts.runtimes` and `opts.vcs` skip their detection.
 * `opts.commandOverride` goes to the resolver.
 */
export async function detectDesiredState(
  repoRoot: string,
  opts?: DetectOptions,
): Promise<DesiredState> {
  const commands = deriveCommands(repoRoot, opts?.commandOverride);

  const vcs = opts?.vcs ?? detectVcs(repoRoot);

  const runtimes = opts?.runtimes
    ? [...opts.runtimes]
    : [...(await (opts?.detectRuntimes ?? detectRuntimesDefault)(repoRoot))];

  return { runtimes, vcs, commands };
}

/**
 * How a remediable doctor check becomes a {@link PlanStep}: the kind of work and the capability
 * surface that the step needs.
 */
interface StepClassification {
  readonly kind: PlanStepKind;
  readonly surface: Surface;
}

/**
 * The step classification of each doctor check, keyed by the check `name`. Each {@link PlanStep}
 * reuses that name as its `key`, so a consumer can match a step to its check. A check that is not
 * in this map falls back to {@link classifyByCategory}.
 */
const CHECK_CLASSIFICATION: Readonly<Record<string, StepClassification>> = {
  'node-version': { kind: 'install', surface: 'cli-only' },
  'state-dir': { kind: 'config', surface: 'any' },
  'storage-sqlite-health': { kind: 'config', surface: 'any' },
  variables: { kind: 'config', surface: 'any' },
  'git-available': { kind: 'install', surface: 'cli-only' },
  'agent-config-valid': { kind: 'generate', surface: 'any' },
  'agent-mcp-registered': { kind: 'generate', surface: 'any' },
  'session-start-hook': { kind: 'hook', surface: 'any' },
  /**
   * The on-ramp block write. The writer writes `AGENTS.md` and the `CLAUDE.md` shim. `diff` puts
   * this step before the retired-hooks removal, so a failed block write keeps the hooks.
   */
  [BLOCK_DRIFT_CHECK_NAME]: { kind: 'generate', surface: 'any' },
  /** The removal of the retired lifecycle hooks, which the session launcher replaces. */
  [RETIRED_HOOKS_CHECK_NAME]: { kind: 'hook', surface: 'any' },
  'plugin-skill-hash-sync': { kind: 'install', surface: 'cli-only' },
  'plugin-version-match': { kind: 'install', surface: 'cli-only' },
  'invariants-catalog': { kind: 'config', surface: 'any' },
};

/**
 * The fallback classification for a check that is not in {@link CHECK_CLASSIFICATION}. It keeps an
 * unknown remediable check from being dropped.
 */
function classifyByCategory(category: CheckResult['category']): StepClassification {
  switch (category) {
    case 'plugin':
      return { kind: 'install', surface: 'cli-only' };
    case 'agent':
      return { kind: 'generate', surface: 'any' };
    default:
      return { kind: 'config', surface: 'any' };
  }
}

/**
 * Checks whose findings no reconcile step can repair. Their `fix` text is guidance for a person,
 * not an action that `apply` owns. Without this set, the category default makes each one a `config`
 * step. `apply` then writes a `.exarchos.yml` that the finding did not ask for and reports success.
 */
export const NON_REMEDIABLE_CHECKS: ReadonlySet<string> = new Set([
  'run-bundle-integrity',
  'store-path-divergence',
]);

/**
 * Returns every check name that the reconciler places on purpose: the keys of
 * {@link CHECK_CLASSIFICATION} and the members of {@link NON_REMEDIABLE_CHECKS}. Any other
 * registered check gets the category default.
 */
export function deliberatelyClassifiedCheckNames(): ReadonlySet<string> {
  return new Set([...Object.keys(CHECK_CLASSIFICATION), ...NON_REMEDIABLE_CHECKS]);
}

/**
 * Returns true when a check needs a reconcile step: a `Fail` or `Warning` result with a `fix` hint.
 * A check in {@link NON_REMEDIABLE_CHECKS} never needs a step.
 */
function isRemediable(check: CheckResult): boolean {
  if (NON_REMEDIABLE_CHECKS.has(check.name)) return false;
  return (check.status === 'Fail' || check.status === 'Warning') && check.fix !== undefined;
}

/**
 * Returns the step `target` for the two storage checks, which name a known artifact. Other checks
 * get no target, and the step description carries the detail.
 */
function deriveTarget(check: CheckResult): string | undefined {
  switch (check.name) {
    case 'state-dir':
      return 'state-dir';
    case 'storage-sqlite-health':
      return 'events.db';
    default:
      return undefined;
  }
}

/**
 * Turns one remediable check into a {@link PlanStep}. The `key` is the check `name`. The
 * description is the `fix` hint, or the `message` when the check has no hint.
 */
function toPlanStep(check: CheckResult): PlanStep {
  const classification = CHECK_CLASSIFICATION[check.name] ?? classifyByCategory(check.category);
  const description = check.fix ?? check.message;
  const target = deriveTarget(check);

  const step: PlanStep = {
    kind: classification.kind,
    surface: classification.surface,
    key: check.name,
    description,
  };
  return target !== undefined ? { ...step, target } : step;
}

/**
 * The commands that `diff` seeds when the resolver resolves them and `.exarchos.yml` does not
 * declare them. `test`, `typecheck` and `install` are not here, because the doctor-check config
 * step and the fresh-create seeder already seed them.
 */
const SEEDABLE_VERIFICATION_FIELDS = ['mutation', 'lint'] as const;
type SeedableVerificationField = (typeof SEEDABLE_VERIFICATION_FIELDS)[number];

/**
 * The `PlanStep` key prefix for verification-command seed steps. It keeps these keys apart from
 * the doctor-check keys. The key builder and {@link isVerificationCommandStep} share it.
 */
const VERIFICATION_COMMAND_KEY_PREFIX = 'verification-command-';

/** The stable PlanStep key for seeding one resolved-but-undeclared command. */
function verificationCommandKey(field: SeedableVerificationField): string {
  return `${VERIFICATION_COMMAND_KEY_PREFIX}${field}`;
}

/**
 * Returns true for a verification-command seed step. `diff` emits one only for an undeclared
 * field, so an existing `.exarchos.yml` does not contain that command. {@link applyConfigStep}
 * uses this to report such a step as residual.
 */
function isVerificationCommandStep(step: PlanStep): boolean {
  return step.key.startsWith(VERIFICATION_COMMAND_KEY_PREFIX);
}

/**
 * Builds one `config` step for each seedable command that the resolver resolved and `.exarchos.yml`
 * does not declare. An unresolved field is absent from `desired.commands`, so it never becomes a
 * step. After `apply` seeds a field, the next detect reads it as declared, and the next `diff`
 * omits the step.
 *
 * The steps seed commands only, never a `verification:` policy block. A seeded policy default
 * freezes the builtin table into consumer config (lvlup-sw/exarchos#1483).
 */
function verificationCommandSteps(
  desired: DesiredState,
  declared: ResolvedCommands,
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const field of SEEDABLE_VERIFICATION_FIELDS) {
    const resolved = desired.commands[field];
    if (resolved !== undefined && declared[field] === undefined) {
      steps.push({
        kind: 'config',
        surface: 'any',
        key: verificationCommandKey(field),
        description: `Seed the resolved ${field} command into .exarchos.yml: ${resolved}`,
      });
    }
  }
  return steps;
}

/**
 * Moves the on-ramp block-write step to just before the retired-hooks removal step. The other
 * steps keep their order. Nothing moves when either step is absent or the order is already correct.
 *
 * With the gate in `apply`, this order writes the replacement on-ramp before it removes the hooks
 * that the on-ramp replaces. The roster order is already correct, so this pass guards against a
 * caller that supplies the checks in another order.
 */
function orderBlockWriteBeforeHookRemoval(steps: readonly PlanStep[]): PlanStep[] {
  const removalIdx = steps.findIndex((s) => s.key === RETIRED_HOOKS_CHECK_NAME);
  const blockIdx = steps.findIndex((s) => s.key === BLOCK_DRIFT_CHECK_NAME);
  if (removalIdx === -1 || blockIdx === -1 || blockIdx < removalIdx) {
    return [...steps];
  }
  const reordered = [...steps];
  const [blockStep] = reordered.splice(blockIdx, 1);
  if (blockStep === undefined) return [...steps];
  const newRemovalIdx = reordered.findIndex((s) => s.key === RETIRED_HOOKS_CHECK_NAME);
  reordered.splice(newRemovalIdx, 0, blockStep);
  return reordered;
}

/**
 * Turns doctor check results into an executable {@link ReconcilePlan}. Each remediable check gives
 * exactly one {@link PlanStep}, and a passing check gives none. It also adds a `config` step for
 * each verification command that is resolved but not declared. `declared` defaults to `{}`, which
 * treats every command as undeclared.
 *
 * `diff` is pure. The caller runs the probes and reads `.exarchos.yml`. The check steps come first
 * in input order, then the seed steps, and then the block write moves before the hook removal.
 */
export function diff(
  desired: DesiredState,
  actual: readonly CheckResult[],
  declared: ResolvedCommands = {},
): ReconcilePlan {
  const checkSteps = actual.filter(isRemediable).map(toPlanStep);
  const seedSteps = verificationCommandSteps(desired, declared);
  const ordered = orderBlockWriteBeforeHookRemoval([...checkSteps, ...seedSteps]);
  return { steps: ordered };
}

/**
 * The injected side-effect bundle for {@link apply}. `apply` performs its side effects only through
 * these fields and their defaults. It emits no events: {@link reconcileWithEvents} owns the event
 * pair and the crash recovery.
 */
export interface ApplyCtx {
  /** Repo root the config step seeds (`.exarchos.yml` lives here). */
  readonly repoRoot: string;
  /**
   * The capability surface of the run. An `install` step runs only when this is `cli`. On another
   * surface, the step becomes an {@link Advisory}.
   */
  readonly surface: Surface | 'cli';
  /**
   * Overwrite hand-edited config. The default `false` keeps the never-overwrite rule of
   * `seedExarchosConfig`. `true` overwrites and records an advisory.
   */
  readonly force?: boolean;
  /** Injected writer deps for GENERATE (real-fs in prod, temp-dir in tests). */
  readonly writerDeps: WriterDeps;
  /**
   * The init writers for `generate` steps. The default is none, so the caller supplies the
   * production writer list.
   */
  readonly writers?: ReadonlyArray<RuntimeConfigWriter>;
  /** The config seeder. The default calls {@link seedExarchosConfig}, and tests replace it. */
  readonly seed?: (repoRoot: string, force: boolean) => SeedResult;
  /** The CLI-only install hook. The default does nothing. */
  readonly installStep?: (step: PlanStep, ctx: ApplyCtx) => Promise<void>;
  /** The lifecycle-hook installer. The default does nothing. */
  readonly installHook?: (step: PlanStep, ctx: ApplyCtx) => Promise<void>;
}

/**
 * Calls `seedExarchosConfig`, which never overwrites an existing `.exarchos.yml`. With `force`, it
 * injects `exists: () => false` to bypass that check, so the seeder writes over the hand edit.
 */
function defaultSeed(repoRoot: string, force: boolean): SeedResult {
  return force
    ? seedExarchosConfig(repoRoot, { exists: () => false })
    : seedExarchosConfig(repoRoot);
}

/** A mutable accumulator threaded through the per-step routers. */
interface ResultAcc {
  readonly applied: PlanStep[];
  readonly skipped: PlanStep[];
  readonly residual: PlanStep[];
  readonly advisories: Advisory[];
  /**
   * True when an earlier `config` step in this run wrote `.exarchos.yml`. The seeder writes the
   * whole config at once, so a later config step finds the file present. That result is
   * convergence, not a preserved hand edit.
   */
  configSeededThisRun: boolean;
  /**
   * True when the on-ramp block-write step ran in this plan and did not converge. The retired-hooks
   * removal step reads it and keeps the hooks.
   *
   * `false` also means that the plan had no block-write step, because the block already matched.
   * Removal is then safe.
   */
  blockWriteFailed: boolean;
}

/**
 * Routes a `config` step through the seeder. A write is `applied`, and a forced write also adds an
 * advisory. When the seeder has no fields to write, the step is `residual`.
 *
 * An `already-exists` result has three outcomes:
 * - If an earlier config step in this run wrote the file, the step converged and is `applied`.
 * - A verification-command step is `residual` with an advisory. The file existed before the run,
 *   and the create-only seeder cannot add one key to it.
 * - The whole-config seed step is `skipped`, because the never-overwrite rule keeps the hand edit.
 */
function applyConfigStep(step: PlanStep, ctx: ApplyCtx, acc: ResultAcc): void {
  const seed = ctx.seed ?? defaultSeed;
  const force = ctx.force ?? false;
  const seedResult = seed(ctx.repoRoot, force);

  if (seedResult.wrote) {
    acc.configSeededThisRun = true;
    acc.applied.push(step);
    if (force) {
      acc.advisories.push({
        surface: 'any',
        message: `--force overwrote ${seedResult.path} with the resolver-derived config (hand edits discarded).`,
      });
    }
    return;
  }

  if (seedResult.reason === 'already-exists') {
    if (acc.configSeededThisRun) {
      acc.applied.push(step);
    } else if (isVerificationCommandStep(step)) {
      acc.residual.push(step);
      acc.advisories.push({
        surface: 'any',
        message:
          `${step.description} — the existing ${seedResult.path} was left untouched ` +
          `(never-overwrite); add this key to it by hand to pin the command.`,
      });
    } else {
      acc.skipped.push(step);
    }
    return;
  }

  acc.residual.push(step);
}

/**
 * Routes a `generate` step through every supplied init writer. The step is `applied` when every
 * writer converges with the status `written` or `skipped`. A `failed` or `stub` status, a thrown
 * error, or an empty writer list makes it `residual`.
 *
 * Two generate steps can share one writer set. The writers then return `skipped` for the second
 * step, and that counts as convergence. A writer error does not stop `apply`.
 *
 * For the block-write step, `onrampFailed` also means no convergence. A block-write step that does
 * not converge sets `blockWriteFailed`, so the retired-hooks removal step keeps the hooks.
 */
async function applyGenerateStep(
  step: PlanStep,
  ctx: ApplyCtx,
  acc: ResultAcc,
): Promise<void> {
  const writers = ctx.writers ?? [];
  if (writers.length === 0) {
    acc.residual.push(step);
    if (step.key === BLOCK_DRIFT_CHECK_NAME) acc.blockWriteFailed = true;
    return;
  }

  const options: WriteOptions = {
    projectRoot: ctx.writerDeps.cwd(),
    nonInteractive: true,
    forceOverwrite: ctx.force ?? false,
  };

  let allConverged = true;
  for (const writer of writers) {
    try {
      const res = await writer.write(ctx.writerDeps, options);
      if (res.status !== 'written' && res.status !== 'skipped') allConverged = false;
      if (step.key === BLOCK_DRIFT_CHECK_NAME && res.onrampFailed) allConverged = false;
    } catch {
      allConverged = false;
    }
  }

  if (allConverged) {
    acc.applied.push(step);
  } else {
    acc.residual.push(step);
    if (step.key === BLOCK_DRIFT_CHECK_NAME) acc.blockWriteFailed = true;
  }
}

/**
 * Routes an `install` step. Off the `cli` surface, it adds an {@link Advisory} that points to the
 * CLI and does not run the step.
 *
 * On the `cli` surface, it calls {@link ApplyCtx.installStep}. A thrown error does not stop
 * `apply`. The step stays `residual` with an advisory, and the steps that already ran stay applied.
 * A re-run resumes from the residual step.
 */
async function applyInstallStep(
  step: PlanStep,
  ctx: ApplyCtx,
  acc: ResultAcc,
): Promise<void> {
  if (ctx.surface !== 'cli') {
    acc.advisories.push({
      surface: 'cli-only',
      message: `${step.description} requires the CLI surface; run it from the Exarchos CLI.`,
      commands: ['exarchos onboard'],
    });
    return;
  }

  const installStep = ctx.installStep ?? (async () => undefined);
  try {
    await installStep(step, ctx);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    acc.residual.push(step);
    acc.advisories.push({
      surface: 'cli-only',
      message:
        `${step.description} failed: ${reason}. ` +
        `The reconcile is forward-only — already-applied steps were kept; re-run to resume from the residual.`,
      commands: ['exarchos onboard'],
    });
    return;
  }
  acc.applied.push(step);
}

/**
 * Routes a `hook` step through {@link ApplyCtx.installHook}. A thrown error does not stop `apply`.
 * The step stays `residual` with an advisory, and the steps that already ran stay applied.
 *
 * If the block write failed in this run, the retired-hooks removal step does not run. It stays
 * `residual` with an advisory, so the consumer keeps the hooks until a re-run writes the block.
 */
async function applyHookStep(
  step: PlanStep,
  ctx: ApplyCtx,
  acc: ResultAcc,
): Promise<void> {
  if (step.key === RETIRED_HOOKS_CHECK_NAME && acc.blockWriteFailed) {
    acc.residual.push(step);
    acc.advisories.push({
      surface: step.surface,
      message:
        `${step.description} was deferred: the on-ramp block write did not succeed, ` +
        `so the retired lifecycle hooks were KEPT to avoid leaving this consumer with ` +
        `neither the on-ramp block nor the hooks. Re-run once the block write succeeds.`,
    });
    return;
  }

  const installHook = ctx.installHook ?? (async () => undefined);
  try {
    await installHook(step, ctx);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    acc.residual.push(step);
    acc.advisories.push({
      surface: step.surface,
      message:
        `${step.description} failed: ${reason}. ` +
        `The reconcile is forward-only — already-applied steps were kept; re-run to resume from the residual.`,
    });
    return;
  }
  acc.applied.push(step);
}

/**
 * Runs the steps of a {@link ReconcilePlan} in order and returns a {@link ReconcileResult}. It
 * routes each step by `kind`:
 * - `config` goes to the seeder, which overwrites only with `ctx.force`.
 * - `generate` goes to the init writers in `ctx.writers`.
 * - `install` runs only on the CLI surface. On another surface it becomes an {@link Advisory}.
 * - `hook` goes to `ctx.installHook`.
 *
 * An empty plan does nothing, and `apply` emits no events. The switch is exhaustive, so a new
 * {@link PlanStepKind} without a router does not compile.
 */
export async function apply(plan: ReconcilePlan, ctx: ApplyCtx): Promise<ReconcileResult> {
  const acc: ResultAcc = {
    applied: [],
    skipped: [],
    residual: [],
    advisories: [],
    configSeededThisRun: false,
    blockWriteFailed: false,
  };

  for (const step of plan.steps) {
    const kind: PlanStepKind = step.kind;
    switch (kind) {
      case 'config':
        applyConfigStep(step, ctx, acc);
        break;
      case 'generate':
        await applyGenerateStep(step, ctx, acc);
        break;
      case 'install':
        await applyInstallStep(step, ctx, acc);
        break;
      case 'hook':
        await applyHookStep(step, ctx, acc);
        break;
      default: {
        const _exhaustive: never = kind;
        throw new Error(`apply: unhandled PlanStep kind: ${String(_exhaustive)}`);
      }
    }
  }

  return {
    applied: acc.applied,
    skipped: acc.skipped,
    residual: acc.residual,
    advisories: acc.advisories,
  };
}

/**
 * The trigger on both events of the pair. It derives from the `OnboardRequested` data type, so it
 * always matches `OnboardTriggerSchema`.
 */
export type OnboardTrigger = OnboardRequested['trigger'];

/**
 * An event that the wrapper gives to the injected seam, with only `type` and `data`. The seam owner
 * adds the full `WorkflowEvent` envelope, so this module stays harness-neutral.
 */
export type EmittedEvent =
  | { readonly type: 'onboard.requested'; readonly data: OnboardRequested }
  | { readonly type: 'onboard.executed'; readonly data: OnboardExecuted };

/**
 * The injected event-store seam. The wrapper appends through {@link emit} and reads the earlier
 * intent through {@link readStreamTail}.
 *
 * {@link readStreamTail} must read the current tail fresh. The seam owner must not CAS-pin an
 * `emit` to the sequence of an earlier `emit`. The appender checks its idempotency cache before
 * the CAS check, so a pinned retry repeats the same conflict forever.
 */
export interface ReconcileEventCtx {
  /** Append one event (plain append — never CAS-pinned to a prior sequence). */
  emit(event: EmittedEvent): Promise<void>;
  /** Fresh read of the current stream tail (for the crash-recovery precheck). */
  readStreamTail(): Promise<readonly EmittedEvent[]>;
}

/**
 * Input to {@link reconcileWithEvents}. `runDoctorChecks` produces the check results that `diff`
 * classifies, and `detectOptions` goes to {@link detectDesiredState}.
 */
export interface ReconcileEventInput {
  /** Repo root the reconcile targets. */
  readonly repoRoot: string;
  /** Why the reconcile ran (audit discriminator on both events). */
  readonly trigger: OnboardTrigger;
  /** Dry-run: compute the plan but perform NO side effect and emit NO events. */
  readonly dryRun?: boolean;
  /** Produces the doctor `actual` check results `diff` classifies. */
  readonly runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>;
  /** Threaded into {@link detectDesiredState} (runtime/vcs/command overrides). */
  readonly detectOptions?: DetectOptions;
}

/** The outcome of {@link reconcileWithEvents}. */
export interface ReconcileOutcome {
  /** The plan diffed for this run (the structured doctor diff). */
  readonly plan: ReconcilePlan;
  /**
   * The apply result. It is absent on the dry-run path and when the key already has an
   * `onboard.executed` event.
   */
  readonly result?: ReconcileResult;
  /** The key both emitted events share. */
  readonly idempotencyKey: string;
  /** True when this call resumed a run that crashed between the two events. */
  readonly recovered: boolean;
}

/**
 * Derives the idempotency key from `repoRoot` and `trigger`. A retry of the same run maps to one
 * `onboard.requested`, and another trigger gets its own pair. The key uses no clock and no
 * randomness, so the crash-recovery check can match an earlier intent.
 */
function deriveIdempotencyKey(repoRoot: string, trigger: OnboardTrigger): string {
  return `onboard:${repoRoot}:${trigger}`;
}

/**
 * Returns true when the tail has an `onboard.requested` for `key` and no matching
 * `onboard.executed`. The earlier run then crashed between the two events, and this call resumes
 * it without a second request.
 */
function hasDanglingRequest(tail: readonly EmittedEvent[], key: string): boolean {
  const requested = tail.some(
    (e) => e.type === 'onboard.requested' && e.data.idempotencyKey === key,
  );
  if (!requested) return false;
  const executed = tail.some(
    (e) => e.type === 'onboard.executed' && e.data.idempotencyKey === key,
  );
  return !executed;
}

/**
 * Wraps {@link apply} in the `onboard.requested` and `onboard.executed` events.
 *
 * 1. It detects and diffs to get the plan. `declared` holds the commands that `.exarchos.yml`
 *    pins, so a re-run after a seed gives an empty plan.
 * 2. On a dry run, it returns the plan, emits nothing, and runs no side effect.
 * 3. It reads the stream tail fresh. If the key has an `onboard.executed` event, it returns.
 * 4. If a request for the key has no pair, it resumes that run and emits no second request.
 *    The plan is then the re-diff of the half-applied repo, so only the remaining steps run.
 * 5. Otherwise it emits `onboard.requested` before any side effect.
 * 6. It runs `apply`, then emits `onboard.executed` with the result and the duration.
 *
 * @param applyCtx the side-effect bundle for `apply`, kept apart from the event seam.
 */
export async function reconcileWithEvents(
  input: ReconcileEventInput,
  ctx: ReconcileEventCtx,
  applyCtx: ApplyCtx,
): Promise<ReconcileOutcome> {
  const { repoRoot, trigger } = input;
  const idempotencyKey = deriveIdempotencyKey(repoRoot, trigger);

  const desired = await detectDesiredState(repoRoot, input.detectOptions);
  const checks = await input.runDoctorChecks(repoRoot);
  const declared = declaredVerificationCommands(repoRoot);
  const plan = diff(desired, checks, declared);

  if (input.dryRun) {
    return { plan, idempotencyKey, recovered: false };
  }

  const tail = await ctx.readStreamTail();

  const alreadyExecuted = tail.some(
    (e) => e.type === 'onboard.executed' && e.data.idempotencyKey === idempotencyKey,
  );
  if (alreadyExecuted) {
    return { plan, idempotencyKey, recovered: false };
  }

  const recovering = hasDanglingRequest(tail, idempotencyKey);

  if (!recovering) {
    await ctx.emit({
      type: 'onboard.requested',
      data: { trigger, plan, idempotencyKey },
    });
  }

  const startedAt = Date.now();
  const result = await apply(plan, applyCtx);
  const durationMs = Date.now() - startedAt;

  await ctx.emit({
    type: 'onboard.executed',
    data: { trigger, result, idempotencyKey, durationMs },
  });

  return { plan, result, idempotencyKey, recovered: recovering };
}
