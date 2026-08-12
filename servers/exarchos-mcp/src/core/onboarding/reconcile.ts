/**
 * The pure, harness-neutral onboarding reconciler (DR-1).
 *
 * This module is the single home for onboarding *behavior*. It is consumed by
 * the thin `onboard` / `doctor` facades (INV-2) and grows across the epic:
 *
 *   - `detectDesiredState` (task 005, here) — derive the reconcile target.
 *   - `diff`               (task 006)        — desired + actual → ReconcilePlan.
 *   - `apply`              (task 007)        — execute a plan → ReconcileResult.
 *   - `reconcileWithEvents`(task 009, here)  — wrap `apply` in the DR-7 two-event
 *     split (`onboard.requested` → side effect → `onboard.executed`) with INV-13
 *     crash recovery, over an INJECTED event seam (INV-2 harness-neutrality).
 *
 * Hard constraints (enforced by tests + INV audits):
 *   - INV-2: NO imports from `adapters/*` — behavior lives here, not in the
 *     presentation facades.
 *   - INV-6: command derivation flows EXCLUSIVELY through the Bundle B layered
 *     resolver (`resolveVerificationRuntime` — the widened verification-ladder
 *     resolver covering test/typecheck/install PLUS mutation/lint). There is no
 *     `applyLanguageCustomizations` / npm string-rewrite in this path; an
 *     unresolved command field is OMITTED, never fabricated.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { resolveVerificationRuntime } from '../../config/test-runtime-resolver.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import { BLOCK_DRIFT_CHECK_NAME } from '../../orchestrate/onboard/block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../orchestrate/onboard/hooks.js';
import {
  detectAgentEnvironments,
  type AgentRuntimeName,
} from '../../runtime/agent-environment-detector.js';
import type { CheckResult } from '../../orchestrate/doctor/schema.js';
import {
  seedExarchosConfig,
  type SeedResult,
} from '../../orchestrate/init/seed-exarchos-config.js';
import type { WriterDeps } from '../../orchestrate/init/probes.js';
import type {
  RuntimeConfigWriter,
  WriteOptions,
} from '../../orchestrate/init/writers/writer.js';
import type {
  OnboardExecuted,
  OnboardRequested,
} from '../../events/schemas.js';
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

// ─── Options ─────────────────────────────────────────────────────────────────

/**
 * Caller-supplied overrides for {@link detectDesiredState}. All fields are
 * optional; when omitted, detection runs from the filesystem.
 *
 * - `runtimes` / `vcs` mirror the DR-2 `--runtime <id>…` / `--vcs <id>` flags:
 *   an explicit value short-circuits detection and is surfaced verbatim.
 * - `command` overrides are threaded straight into the layered resolver (its
 *   highest-precedence tier), so command derivation stays single-sourced.
 * - `detectRuntimes` is an injection seam for tests/consumers that want to stub
 *   the (async, fs-touching) agent-host probe without hitting `$HOME`.
 */
export interface DetectOptions {
  /** Explicit agent-host runtime ids (DR-2 `--runtime`). Bypasses probing. */
  readonly runtimes?: readonly string[];
  /** Explicit VCS id (DR-2 `--vcs`). Bypasses `.git` probing. */
  readonly vcs?: string;
  /**
   * Command overrides threaded into the layered resolver's override tier. Covers
   * the full verification-ladder field set — `deriveCommands` delegates to
   * `resolveVerificationRuntime`, which resolves `mutation`/`lint` alongside the
   * legacy triple, so the typed onboarding API must accept overrides for all of
   * them (otherwise mutation/lint could only be overridden via a type escape).
   */
  readonly commandOverride?: {
    readonly test?: string;
    readonly typecheck?: string;
    readonly install?: string;
    readonly mutation?: string;
    readonly lint?: string;
  };
  /**
   * Injection seam for the agent-host runtime probe (defaults to the real
   * filesystem detector). Returns the configured runtime ids for the repo.
   */
  readonly detectRuntimes?: (repoRoot: string) => Promise<readonly string[]>;
}

// ─── Command derivation (INV-6) ──────────────────────────────────────────────

/**
 * Map the layered resolver's output onto {@link ResolvedCommands}.
 *
 * The resolver returns `string | null` per field; `null` means "unresolved".
 * Per the Task 004 contract, an unresolved field is OMITTED from the result —
 * never coerced to `null` and never fabricated into a default command. This is
 * the concrete INV-6 obligation: every command we surface came from the
 * resolver, nothing was string-rewritten in.
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

// ─── Declared commands (§4.5-seed divergence) ───────────────────────────────

/**
 * Read the verification commands ALREADY DECLARED in the repo's `.exarchos.yml`
 * (the direct top-level `mutation:`/`lint:` keys). This is the "actual" side of
 * the §4.5-seed desired-vs-declared divergence: `diff` seeds a resolved command
 * only when it is NOT already pinned here.
 *
 * Only the directly-declared keys count as "declared" — a command the resolver
 * derived from detection (tier 5) is resolved-but-undeclared and IS a seed
 * candidate. Reads via the shared `.exarchos.yml` loader; a missing/empty config
 * yields `{}` (everything undeclared). Loader throws (malformed/invalid config)
 * are swallowed to `{}` so a broken config can't crash the reconcile — the
 * doctor checks own surfacing config validity.
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

// ─── VCS detection ───────────────────────────────────────────────────────────

/**
 * Detect the VCS at the repo root. Today only `git` is modelled (matching the
 * rest of the reconciler's git-centric assumptions); everything else collapses
 * to `'none'`. Presence is signalled by a `.git` entry (directory for a normal
 * clone, file for a worktree/submodule gitlink) — both count as "git".
 */
function detectVcs(repoRoot: string): string {
  return existsSync(path.join(repoRoot, '.git')) ? 'git' : 'none';
}

// ─── Runtime detection ───────────────────────────────────────────────────────

/**
 * Detect which agent-host runtimes are configured for this repo via the shared
 * {@link detectAgentEnvironments} probe, returning the ids whose project config
 * is present. The probe inspects `$HOME` / cwd for runtime configs; we point it
 * at the repo via its `cwd` seam so detection is repo-scoped and side-effect
 * free with respect to this module.
 */
async function detectRuntimesDefault(repoRoot: string): Promise<readonly string[]> {
  const environments = await detectAgentEnvironments({ cwd: () => repoRoot });
  return environments
    .filter((env) => env.configPresent)
    .map((env): AgentRuntimeName => env.name);
}

// ─── detectDesiredState ──────────────────────────────────────────────────────

/**
 * Derive the {@link DesiredState} reconcile target for a repo: detected agent
 * runtimes + VCS, plus resolver-derived commands.
 *
 * Command fields come EXCLUSIVELY from the layered resolver (DR-1 / INV-6).
 * `opts.runtimes` / `opts.vcs` short-circuit their respective detection (DR-2
 * `--runtime` / `--vcs`); `opts.commandOverride` is threaded into the resolver.
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

// ─── diff (DR-1 / DR-4) ──────────────────────────────────────────────────────

/**
 * Classification of one doctor check into reconcile-step terms. Keyed off the
 * check's stable `name` (its identity in the doctor output), this is the single
 * source for *how* a remediable check becomes a {@link PlanStep}:
 *   - `kind`    — the category of work (`config` / `generate` / `install` / `hook`).
 *   - `surface` — the capability surface required (DR-6: skills/deps install is
 *     `'cli-only'`; everything else runs on `'any'` harness path).
 *
 * A check absent from this map falls back to {@link classifyByCategory} so new
 * checks degrade to a sensible default instead of being silently dropped.
 */
interface StepClassification {
  readonly kind: PlanStepKind;
  readonly surface: Surface;
}

/**
 * Per-check classification table (DR-4 mapping). The doctor `name` is the stable
 * key; the `key` on each emitted {@link PlanStep} reuses it so consumers
 * (`apply` task 007, `doctor --fix` task 013) can idempotence-match a step back
 * to the check that produced it.
 */
const CHECK_CLASSIFICATION: Readonly<Record<string, StepClassification>> = {
  // runtime — Node upgrade is an environment install action (cli-only).
  'node-version': { kind: 'install', surface: 'cli-only' },
  // storage — state dir / sqlite are local config/state reconciliation (any).
  'state-dir': { kind: 'config', surface: 'any' },
  'storage-sqlite-health': { kind: 'config', surface: 'any' },
  // env — stray EXARCHOS_* vars are a config-drift concern (any).
  variables: { kind: 'config', surface: 'any' },
  // vcs — installing git is an environment install action (cli-only).
  'git-available': { kind: 'install', surface: 'cli-only' },
  // agent — regenerating runtime artifacts / MCP registration is `generate`.
  'agent-config-valid': { kind: 'generate', surface: 'any' },
  'agent-mcp-registered': { kind: 'generate', surface: 'any' },
  // agent (DR-8) — the SessionStart binding is a hook step.
  'session-start-hook': { kind: 'hook', surface: 'any' },
  // agent (DR-5, Task 013/017) — the on-ramp block write is a `generate` step
  // (the ClaudeCodeWriter's on-ramp phase writes AGENTS.md + the CLAUDE.md shim).
  // ORDERED before the retired-hooks removal step below so a failed block write
  // keeps the hooks (see `orderBlockWriteBeforeHookRemoval` + apply's gate).
  [BLOCK_DRIFT_CHECK_NAME]: { kind: 'generate', surface: 'any' },
  // agent (DR-7, Task 017) — removing the launcher-superseded retired lifecycle
  // hooks is a `hook` step; `apply` routes it to `removeRetiredHooks`.
  [RETIRED_HOOKS_CHECK_NAME]: { kind: 'hook', surface: 'any' },
  // plugin — skills-bundle regen / plugin reinstall are install actions (cli-only).
  'plugin-skill-hash-sync': { kind: 'install', surface: 'cli-only' },
  'plugin-version-match': { kind: 'install', surface: 'cli-only' },
  // invariants — catalog reconciliation is a `.exarchos.yml` config concern.
  'invariants-catalog': { kind: 'config', surface: 'any' },
};

/**
 * Fallback classification by doctor {@link CheckResult.category} for checks not
 * in {@link CHECK_CLASSIFICATION}. Keeps an unrecognised remediable check from
 * being dropped: `plugin` ⇒ cli-only install (the skills/plugin surface), every
 * other category ⇒ a generic `config`/`any` step the executor can still reason
 * about.
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
 * Is this check result a *remediable* finding — i.e. does it warrant a reconcile
 * step? Only `Fail`/`Warning` results that carry a `fix` hint qualify; a `Pass`
 * or a non-remediable `Skipped` (no `fix`) contributes no step. The schema
 * guarantees every `Fail`/`Warning` has a non-empty `fix`, so this also screens
 * out a `Skipped` that happens to carry one.
 */
function isRemediable(check: CheckResult): boolean {
  return (check.status === 'Fail' || check.status === 'Warning') && check.fix !== undefined;
}

/**
 * Derive the optional `target` a step acts on. Storage checks act on a known
 * artifact path; everything else leaves `target` unset (the description carries
 * the actionable detail). Kept conservative on purpose — `apply` (task 007) is
 * the owner of concrete path/identifier semantics, so we only set `target` when
 * the doctor check already pins it unambiguously.
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
 * Turn one remediable doctor check into a {@link PlanStep}. The `key` reuses the
 * check `name` for stable diff/idempotence; the `description` prefers the `fix`
 * hint (the actionable text) and falls back to the `message`.
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
 * The widened verification commands `diff` seeds when they are resolved but not
 * yet declared in `.exarchos.yml` (§4.5-seed). `test`/`typecheck`/`install` are
 * NOT in this set: their seeding is already covered by the doctor-check config
 * path + the fresh-create seeder, so adding them here would double-emit. Only
 * the verification-ladder additions (`mutation`, `lint`) flow through the
 * desired-vs-declared command divergence path.
 */
const SEEDABLE_VERIFICATION_FIELDS = ['mutation', 'lint'] as const;
type SeedableVerificationField = (typeof SEEDABLE_VERIFICATION_FIELDS)[number];

/**
 * The stable PlanStep key PREFIX for verification-command seed steps. Distinct
 * from the doctor-check keys so the two config-step families never collide and
 * `apply` / `doctor --fix` can idempotence-match per field. Shared by the key
 * builder and {@link isVerificationCommandStep} so the two never drift.
 */
const VERIFICATION_COMMAND_KEY_PREFIX = 'verification-command-';

/** The stable PlanStep key for seeding one resolved-but-undeclared command. */
function verificationCommandKey(field: SeedableVerificationField): string {
  return `${VERIFICATION_COMMAND_KEY_PREFIX}${field}`;
}

/**
 * Is `step` a verification-command seed step (vs the whole-config seed step)?
 * These steps are emitted ONLY for a resolved-but-UNDECLARED field, so a
 * pre-existing `.exarchos.yml` provably does NOT already contain the command —
 * which {@link applyConfigStep} uses to report an un-seedable field as residual
 * rather than mis-classifying it as a preserved hand-edit.
 */
function isVerificationCommandStep(step: PlanStep): boolean {
  return step.key.startsWith(VERIFICATION_COMMAND_KEY_PREFIX);
}

/**
 * Build the config-kind PlanSteps that seed resolved-but-undeclared verification
 * commands into `.exarchos.yml` (§4.5-seed). A field contributes a step iff the
 * resolver resolved it (it is present in `desired.commands`) AND it is NOT
 * already declared in the repo's `.exarchos.yml` (`declared`). The step shape
 * mirrors the test/typecheck config steps exactly — `kind: 'config'`,
 * `surface: 'any'` — so `apply` routes it through the SAME seeder; no new kinds.
 *
 * Idempotence: once `apply` has seeded a field, a re-detect surfaces it as
 * declared (config-direct tier), so the next `diff` omits the step → empty plan.
 *
 * NOTE (§4.5 negative guarantee): this seeds COMMANDS only. No `verification:`
 * policy block is ever emitted — seeding the resolved policy default would freeze
 * today's builtin table into consumer config (the gen-time-bake trap, #1483).
 */
function verificationCommandSteps(
  desired: DesiredState,
  declared: ResolvedCommands,
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const field of SEEDABLE_VERIFICATION_FIELDS) {
    const resolved = desired.commands[field];
    // Resolved (the resolver surfaced a value) AND not already declared in
    // `.exarchos.yml` (the operator hasn't pinned it). INV-6 omit-never-fabricate
    // carries through: an unresolved field is absent from `desired.commands`, so
    // it never becomes a step.
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
 * DR-7 plan-step ordering: the on-ramp managed-block WRITE
 * ({@link BLOCK_DRIFT_CHECK_NAME}, a `generate` step) MUST precede the retired-hooks
 * REMOVAL ({@link RETIRED_HOOKS_CHECK_NAME}, a `hook` step). Combined with apply's
 * cross-step gate (a failed block write ⇒ hooks kept), this guarantees no consumer
 * ever transitions through the hook-less + block-less window: the replacement
 * on-ramp is written before the superseded hooks are removed.
 *
 * The pass is a minimal, order-preserving reorder — it moves the block-write step
 * to immediately before the removal step ONLY when both are present and currently
 * out of order, leaving every other step's relative position untouched (so it can
 * safely run over the full plan without disturbing unrelated steps). Roster order
 * already emits them in the right order; this pass makes the guarantee robust to
 * any future reordering or a caller that hands checks in a different order.
 */
function orderBlockWriteBeforeHookRemoval(steps: readonly PlanStep[]): PlanStep[] {
  const removalIdx = steps.findIndex((s) => s.key === RETIRED_HOOKS_CHECK_NAME);
  const blockIdx = steps.findIndex((s) => s.key === BLOCK_DRIFT_CHECK_NAME);
  // Nothing to do when either step is absent, or the block write already precedes
  // the removal (the common, roster-ordered case).
  if (removalIdx === -1 || blockIdx === -1 || blockIdx < removalIdx) {
    return [...steps];
  }
  // Block write currently AFTER removal — lift it to just before the removal step.
  const reordered = [...steps];
  const [blockStep] = reordered.splice(blockIdx, 1);
  if (blockStep === undefined) return [...steps];
  const newRemovalIdx = reordered.findIndex((s) => s.key === RETIRED_HOOKS_CHECK_NAME);
  reordered.splice(newRemovalIdx, 0, blockStep);
  return reordered;
}

/**
 * `diff(desired, actual, declared?)` — the structured `doctor` diff (DR-1 / DR-4).
 *
 * Turns the doctor check results into an EXECUTABLE {@link ReconcilePlan}: each
 * remediable (`Fail`/`Warning` with a `fix`) check becomes exactly one
 * {@link PlanStep}; passing and non-remediable checks contribute nothing. A
 * fully-configured repo (all checks `Pass`) ⇒ the empty plan `{ steps: [] }`,
 * which is the idempotence precondition for `apply` (task 007).
 *
 * `diff` ALSO folds in desired-vs-declared command divergence (§4.5-seed): a
 * verification command the resolver resolved (present in `desired.commands`) but
 * NOT yet declared in the repo's `.exarchos.yml` (`declared`) becomes a
 * `config`-kind step so `apply` seeds it via the SAME seeder test/typecheck use.
 * `declared` defaults to `{}` (treat everything as undeclared) so the legacy
 * two-arg call — the doctor-check path — keeps working unchanged.
 *
 * Seam: `actual` is the doctor composer's own output — `readonly CheckResult[]`,
 * exactly what `handleDoctorWithChecks` produces by running the 11 checks. The
 * caller (doctor `--fix` / `onboard`) runs the probes; `diff` stays PURE (no fs,
 * no process) and only classifies. `declared` is likewise supplied by the caller
 * (read from `.exarchos.yml`), keeping `diff` free of I/O.
 *
 * Step order: the doctor-check steps come first (mirroring input check order),
 * then the verification-command seed steps, so callers can scan top-to-bottom.
 */
export function diff(
  desired: DesiredState,
  actual: readonly CheckResult[],
  declared: ResolvedCommands = {},
): ReconcilePlan {
  const checkSteps = actual.filter(isRemediable).map(toPlanStep);
  const seedSteps = verificationCommandSteps(desired, declared);
  // DR-7 ordering: the on-ramp block WRITE must precede the retired-hook REMOVAL.
  const ordered = orderBlockWriteBeforeHookRemoval([...checkSteps, ...seedSteps]);
  return { steps: ordered };
}

// ─── apply (DR-1 / DR-10) ─────────────────────────────────────────────────────

/**
 * The injected side-effect dependency bundle for {@link apply}.
 *
 * `apply` is a PURE-ISH executor: it holds NO real I/O of its own and performs
 * side effects ONLY through these hooks, so task 009 (the event-emitting wrapper)
 * and the unit tests can drive it against a temp-dir fs without touching `$HOME`
 * or the event store. Crucially, `apply` emits NO events itself — the
 * `onboard.requested` / `onboard.executed` two-event split + crash recovery is
 * owned by task 009, which wraps this function (DR-7 / INV-13).
 */
export interface ApplyCtx {
  /** Repo root the config step seeds (`.exarchos.yml` lives here). */
  readonly repoRoot: string;
  /**
   * Capability surface the run executes on (DR-6). A `cli-only` step is only
   * run when `surface === 'cli'`; off-CLI it is downgraded to an {@link Advisory}.
   */
  readonly surface: Surface | 'cli';
  /**
   * Overwrite hand-edited config (DR-10). Default `false` preserves the
   * `seedExarchosConfig` never-overwrite posture; `true` overwrites and records
   * the overwrite as an advisory.
   */
  readonly force?: boolean;
  /** Injected writer deps for GENERATE (real-fs in prod, temp-dir in tests). */
  readonly writerDeps: WriterDeps;
  /**
   * Init writers GENERATE steps route through (defaults to none — the caller
   * supplies the production writer list). Reused verbatim; not reimplemented.
   */
  readonly writers?: ReadonlyArray<RuntimeConfigWriter>;
  /**
   * Config seeder (defaults to {@link seedExarchosConfig}). Injection seam so
   * tests can stub detection; production passes the real seeder.
   */
  readonly seed?: (repoRoot: string, force: boolean) => SeedResult;
  /**
   * CLI-only install hook (real impl is task 015). Default no-op so the routing
   * + result semantics can be exercised before install logic lands.
   */
  readonly installStep?: (step: PlanStep, ctx: ApplyCtx) => Promise<void>;
  /**
   * Lifecycle-hook installer (real impl is task 012). Default no-op so the hook
   * routing can be exercised before the #1485 binding logic lands.
   */
  readonly installHook?: (step: PlanStep, ctx: ApplyCtx) => Promise<void>;
}

/**
 * The config seeder, with `force` threaded onto the never-overwrite check.
 *
 * `seedExarchosConfig` is non-destructive by contract: it short-circuits on an
 * existing `.exarchos.yml`. The only honest way to overwrite under `--force`
 * (DR-10 "force overwrites and says so") is to bypass its existence gate — which
 * we do by injecting `exists: () => false`, so the real seeder writes the
 * resolver-derived config over the hand-edit. Without force we call the seeder
 * unmodified, preserving its posture verbatim.
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
   * Did an EARLIER `config` step in THIS apply run already write `.exarchos.yml`?
   * The single-file seeder writes the whole resolver-derived config in one shot,
   * so once the first config step seeds the file, every later config step in the
   * same plan (e.g. a second verification-command seed) finds it already present.
   * That `already-exists` is CONVERGENCE (their field was just written by us),
   * not a preserved hand-edit. Tracking it lets {@link applyConfigStep}
   * distinguish the two — see its body.
   */
  configSeededThisRun: boolean;
  /**
   * DR-7 cross-step gate: did the on-ramp managed-block WRITE step
   * ({@link BLOCK_DRIFT_CHECK_NAME}) run in this plan AND fail to converge
   * (residual)? The retired-hooks REMOVAL step consults this — a failed block
   * write ⇒ KEEP the hooks (never strand the consumer with neither the on-ramp
   * block nor the superseded hooks). The plan ordering (block write before
   * removal) is what makes this flag authoritative by the time removal runs.
   *
   * Note the polarity: `false` also means "no block-write step was in the plan",
   * i.e. the on-ramp block already matched (its drift check Passed) — in which
   * case the block is present and removal is safe to proceed.
   */
  blockWriteFailed: boolean;
}

/**
 * Route a `config` step through the (force-aware) seeder. A fresh write or a
 * forced overwrite ⇒ applied; an unresolved-no-fields seeder no-op ⇒ residual
 * (still needs doing). A forced overwrite additionally emits an advisory.
 *
 * The `already-exists` no-op splits two ways (mirroring {@link applyGenerateStep}
 * convergence, #1534): the single-file seeder writes the whole config in one
 * shot, so multiple config steps in one plan (the test/typecheck doctor-check
 * step PLUS the §4.5-seed verification-command steps) all hit the SAME file.
 *   - If an EARLIER config step in this run already wrote it
 *     ({@link ResultAcc.configSeededThisRun}), this step's field was just seeded
 *     by us — it CONVERGED → `applied`. Marking it `skipped` would mis-report the
 *     verification-command seed as "not run" even though it landed in the file.
 *   - Otherwise the file pre-existed the run — a genuine hand-edit preserved by
 *     the never-overwrite posture → `skipped`.
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
      // An earlier config step in THIS run already seeded the file — this step's
      // field is in it now. That is convergence, not a preserved hand-edit.
      acc.applied.push(step);
    } else if (isVerificationCommandStep(step)) {
      // A verification-command step is emitted ONLY for a resolved-but-UNDECLARED
      // field, so a pre-existing `.exarchos.yml` does NOT already contain it. The
      // create-only seeder cannot add a single key to an existing file, so the
      // command is genuinely still absent → RESIDUAL (a re-diff re-surfaces it),
      // NOT `skipped`. Reporting it `skipped` would mis-classify a never-written
      // verification command as a preserved hand-edit — a silent success that
      // leaves the ladder on the built-in fallback (Sentry 14615676).
      acc.residual.push(step);
      acc.advisories.push({
        surface: 'any',
        message:
          `${step.description} — the existing ${seedResult.path} was left untouched ` +
          `(never-overwrite); add this key to it by hand to pin the command.`,
      });
    } else {
      // The whole-config seed step: the file pre-existed → hand-edit preserved
      // by the never-overwrite posture.
      acc.skipped.push(step);
    }
    return;
  }

  // unresolved-no-fields: nothing could be written; the step still needs doing.
  acc.residual.push(step);
}

/**
 * Route a `generate` step through the existing init writers (no rewrite). Runs
 * every supplied writer with the injected {@link WriterDeps}.
 *
 * Convergence, not "did we write": a generate step is APPLIED when every writer
 * reaches its desired state — `'written'` (just produced) OR `'skipped'`
 * (already present / not applicable). It is RESIDUAL only when a writer genuinely
 * could not converge: a `'failed'` / `'stub'` status or a thrown error (the
 * latter swallowed for forward-only reconcile, DR-10).
 *
 * This matters for multi-step plans (#1534 review): `agent-config-valid` and
 * `agent-mcp-registered` both classify to `kind: 'generate'`, so a repo failing
 * both yields two generate steps over the SAME writer set. Once the first step
 * writes the artifacts, the second step's writers legitimately no-op
 * (`'skipped'`). Keying success on `'written'` alone would mis-mark that second
 * step `residual` and misreport convergence in the `onboard.executed` result
 * (INV-1). Treating an already-converged writer as success fixes it; the VERIFY
 * re-diff remains the authoritative blocking gate.
 */
async function applyGenerateStep(
  step: PlanStep,
  ctx: ApplyCtx,
  acc: ResultAcc,
): Promise<void> {
  const writers = ctx.writers ?? [];
  if (writers.length === 0) {
    acc.residual.push(step);
    // A block-write generate step with no writers can't have written the block.
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
      // 'written' = produced now; 'skipped' = already in desired state (e.g.
      // written by an earlier generate step in this same plan, or not applicable
      // to this repo). Both are convergence. 'failed'/'stub' are not.
      if (res.status !== 'written' && res.status !== 'skipped') allConverged = false;
      // DR-7: a writer can converge overall (its MCP/commands/skills phases wrote)
      // while its consumer-side on-ramp block (AGENTS.md) write FAILED — surfaced
      // as `onrampFailed`, never a status change. For the on-ramp block-write step
      // that means the replacement on-ramp is NOT in place, so it must NOT count as
      // converged (else the retired-hooks removal below runs and strands the
      // consumer with neither the on-ramp block nor the hooks).
      if (step.key === BLOCK_DRIFT_CHECK_NAME && res.onrampFailed) allConverged = false;
    } catch {
      // forward-only: a writer failure does not abort apply (DR-10).
      allConverged = false;
    }
  }

  if (allConverged) {
    acc.applied.push(step);
  } else {
    acc.residual.push(step);
    // DR-7 gate input: a non-converged on-ramp block write means the replacement
    // on-ramp is NOT in place, so the retired-hooks removal step must be deferred.
    if (step.key === BLOCK_DRIFT_CHECK_NAME) acc.blockWriteFailed = true;
  }
}

/**
 * Route an `install` step (DR-6 + DR-10 forward-only). Install is CLI-only: on
 * the `'cli'` surface it runs through the injected {@link ApplyCtx.installStep}
 * hook (a no-op default here; real `npx` install is task 015) and is applied.
 * Off-CLI it is downgraded to a structured {@link Advisory} pointing at the CLI —
 * never a silent server-side write.
 *
 * FORWARD-ONLY (DR-10): an install side effect that THROWS (offline / `npx`
 * network error) must NOT abort the whole `apply` — that would reject the
 * pipeline AFTER config/generate have already written, with no way to keep the
 * work that succeeded. Instead, mirroring {@link applyGenerateStep}, the throw is
 * swallowed: the step is left in `residual` (so the VERIFY re-diff sees it still
 * failing and a re-run resumes it) and an {@link Advisory} records the failure
 * so the operator is told. The already-applied config/generate steps are NOT
 * rolled back; the run exits non-zero via the VERIFY blocking-residual gate.
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
    // forward-only: an install failure does not abort apply (DR-10). Leave the
    // step residual and surface the failure as an advisory; config/generate
    // steps already applied stay applied (no rollback).
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
 * Route a `hook` step through the injected {@link ApplyCtx.installHook} (a no-op
 * default; the #1485 SessionStart binding installer lives in `onboard/hooks.ts`).
 *
 * FORWARD-ONLY (DR-10): a hook side effect that THROWS (e.g. an unwritable
 * settings file) must NOT abort the whole `apply` — that would reject the
 * pipeline AFTER config/generate/install have already written, with no way to
 * keep the work that succeeded. Mirroring {@link applyInstallStep}, the throw is
 * swallowed: the step is left in `residual` (so the VERIFY re-diff sees it still
 * failing and a re-run resumes it) and an {@link Advisory} records the failure so
 * the operator is told. Already-applied steps are NOT rolled back; the run exits
 * non-zero via the VERIFY blocking-residual gate. Applied on success.
 */
async function applyHookStep(
  step: PlanStep,
  ctx: ApplyCtx,
  acc: ResultAcc,
): Promise<void> {
  // DR-7 cross-step gate: the retired-hooks REMOVAL step consults the on-ramp
  // block-write outcome. If the block write (ordered before this step) failed,
  // KEEP the retired hooks — removing them now would strand the consumer with
  // neither the replacement on-ramp block nor the superseded hooks. The removal
  // stays residual so the VERIFY re-diff resurfaces it and a re-run (once the
  // block write succeeds) completes the uninstall.
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
    // forward-only: a hook failure does not abort apply (DR-10). Leave the step
    // residual and surface the failure as an advisory; already-applied steps
    // stay applied (no rollback).
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
 * `apply(plan, ctx)` — execute a {@link ReconcilePlan} into a
 * {@link ReconcileResult} (DR-1 / DR-10).
 *
 * Routes each {@link PlanStep} to the right EXISTING writer by `kind`:
 *   - `config`   → `seedExarchosConfig` (never-overwrite unless `ctx.force`).
 *   - `generate` → the init writers (`ctx.writers`, run with `ctx.writerDeps`).
 *   - `install`  → CLI-only; off-CLI it downgrades to an {@link Advisory} (DR-6).
 *   - `hook`     → `ctx.installHook` (real impl task 012; no-op default).
 *
 * Result semantics: `applied` = side effect ran; `skipped` = intentionally not
 * run (preserved hand-edit without force); `residual` = still needs doing after
 * apply (feeds the verify re-diff); `advisories` = surface-gated downgrades +
 * the forced-overwrite notice.
 *
 * Idempotence precondition: an empty plan is a NO-OP — no side effect fires and
 * every bucket is empty. Apply emits NO events; that is task 009's wrapper.
 *
 * Steps run in plan order; routing is exhaustive over {@link PlanStepKind} so an
 * unhandled kind is a compile error, never a silent drop.
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
        // Exhaustiveness guard — a new PlanStepKind must add a router here.
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

// ─── reconcileWithEvents (DR-7 / DR-10 — two-event split + crash recovery) ─────

/**
 * The trigger discriminator carried on both halves of the split — mirrors the
 * `OnboardTriggerSchema` enum in `event-store/schemas.ts` (`onboard` reconciles
 * an existing repo, `onboard-new` scaffolds, `doctor-fix` applies the structured
 * doctor diff). Derived from the event data type so the two never drift.
 */
export type OnboardTrigger = OnboardRequested['trigger'];

/**
 * A type-tagged event the wrapper hands to the injected seam. We model ONLY the
 * `{ type, data }` shape `apply`'s wrapper needs — the full `WorkflowEvent`
 * envelope (streamId, sequence, timestamp…) is the seam owner's concern
 * (Task 010's `onboard` handler), keeping `reconcile.ts` harness-neutral (INV-2).
 *
 * The two-event split only ever emits these two types; `data` is the validated
 * payload shape from `event-store/schemas.ts`.
 */
export type EmittedEvent =
  | { readonly type: 'onboard.requested'; readonly data: OnboardRequested }
  | { readonly type: 'onboard.executed'; readonly data: OnboardExecuted };

/**
 * The injected event-store seam (INV-2). The wrapper performs NO real I/O
 * against the event store — it appends through {@link emit} and inspects prior
 * intent through {@link readStreamTail}. Tests pass spies; production (Task 010)
 * wires the real `EventStore` + `getAllWriters()` + `buildWriterDeps()`.
 *
 * CRITICAL (CAS-pin idempotency trap): {@link readStreamTail} MUST be a FRESH
 * read of the current stream tail. The seam owner MUST NOT CAS-pin a follow-on
 * `emit` to a prior `emit`'s returned sequence — the appender's idempotency
 * cache-hit precedes its CAS check, so a pinned retry reproduces the same
 * conflict forever. Plain appends + fresh tail reads sidestep that entirely.
 */
export interface ReconcileEventCtx {
  /** Append one event (plain append — never CAS-pinned to a prior sequence). */
  emit(event: EmittedEvent): Promise<void>;
  /** Fresh read of the current stream tail (for the crash-recovery precheck). */
  readStreamTail(): Promise<readonly EmittedEvent[]>;
}

/**
 * Input to {@link reconcileWithEvents}: the repo + trigger plus the (injected)
 * detect/diff seams. `runDoctorChecks` produces the `actual` check results that
 * `diff` classifies; `detectOptions` thread into {@link detectDesiredState}.
 * Both are seams so the wrapper stays pure (no fs/process of its own); the
 * `onboard` handler (Task 010) supplies the real doctor composer + detection.
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

/**
 * The structured outcome of {@link reconcileWithEvents}: the plan that was
 * diffed and the {@link ReconcileResult} (omitted on the dry-run path, which
 * runs no `apply`). `idempotencyKey` is surfaced so callers can correlate the
 * run with its event pair.
 */
export interface ReconcileOutcome {
  /** The plan diffed for this run (the structured doctor diff). */
  readonly plan: ReconcilePlan;
  /** The apply result; absent on the dry-run path. */
  readonly result?: ReconcileResult;
  /** The key both emitted events share. */
  readonly idempotencyKey: string;
  /** Whether this invocation resumed a crashed prior run (INV-13). */
  readonly recovered: boolean;
}

/**
 * Derive the idempotency key for a logical reconcile run (INV-8). Keyed off the
 * `repoRoot` + `trigger`, so a retry of the *same* logical run (same repo, same
 * reason) collapses onto one `onboard.requested`, while a genuinely different
 * trigger (e.g. `onboard` vs `doctor-fix`) gets its own pair. Deterministic and
 * side-effect-free — no clock, no randomness — which is what makes the
 * crash-recovery precheck able to MATCH a dangling prior intent.
 */
function deriveIdempotencyKey(repoRoot: string, trigger: OnboardTrigger): string {
  return `onboard:${repoRoot}:${trigger}`;
}

/**
 * Crash-recovery precheck (INV-13 + INV-8). Reads the FRESH stream tail and asks:
 * is there a prior `onboard.requested` for THIS key with NO paired
 * `onboard.executed`? If so the prior run crashed between the two events, and
 * this invocation must resume it — re-detect, re-diff, apply only the residual,
 * and emit the missing `onboard.executed` — WITHOUT a second `requested` and
 * without re-running an already-completed non-idempotent write.
 *
 * Returns `true` when a dangling request for `key` exists (⇒ recovery mode).
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
 * `reconcileWithEvents(input, ctx, applyCtx)` — the DR-7 two-event orchestration
 * around the event-free {@link apply} (Task 007). `apply`'s contract is unchanged
 * and it still emits NO events of its own; this wrapper owns the event split.
 *
 * Flow (per the DR-7 event diagram):
 *   1. detect → diff to compute the plan.
 *   2. dry-run ⇒ return the plan, emit NOTHING, run NO side effect.
 *   3. crash-recovery precheck (fresh tail read): a dangling `onboard.requested`
 *      for this key ⇒ RESUME — skip emitting a second `requested`, re-diff, and
 *      apply only the residual, then emit the missing `onboard.executed`.
 *   4. normal path: emit `onboard.requested {plan, trigger, idempotencyKey}`
 *      BEFORE side effects → `await apply(plan, applyCtx)` →
 *      emit `onboard.executed {result, trigger, idempotencyKey, durationMs}`.
 *
 * INV-2: every event-store touch goes through the injected {@link ctx}; INV-13 +
 * INV-8: the non-idempotent side effect runs AT MOST ONCE across a crash because
 * a re-run with a completed `executed` short-circuits and a crashed run applies
 * only the residual. INV-8: the key is derived deterministically so retries
 * collapse onto one logical request.
 *
 * @param applyCtx the {@link ApplyCtx} side-effect bundle passed straight to
 *   `apply` (writers, seeder, install/hook hooks) — kept separate from the event
 *   seam so the two injection axes stay independent.
 */
export async function reconcileWithEvents(
  input: ReconcileEventInput,
  ctx: ReconcileEventCtx,
  applyCtx: ApplyCtx,
): Promise<ReconcileOutcome> {
  const { repoRoot, trigger } = input;
  const idempotencyKey = deriveIdempotencyKey(repoRoot, trigger);

  // detect → diff (always; needed for the dry-run plan AND the live re-diff).
  // `declared` is the verification commands ALREADY pinned in `.exarchos.yml` —
  // the "actual" side of the §4.5-seed divergence, so a re-run after a seed
  // (commands now declared) re-diffs to an empty plan (idempotence).
  const desired = await detectDesiredState(repoRoot, input.detectOptions);
  const checks = await input.runDoctorChecks(repoRoot);
  const declared = declaredVerificationCommands(repoRoot);
  const plan = diff(desired, checks, declared);

  // Dry-run: surface the plan, but emit nothing and perform no side effect.
  if (input.dryRun) {
    return { plan, idempotencyKey, recovered: false };
  }

  // Crash-recovery precheck — FRESH tail read (no CAS-pin to a prior append).
  const tail = await ctx.readStreamTail();

  // Already-completed run for this key ⇒ fully idempotent no-op (no re-apply,
  // no duplicate events). This is what makes a retry collapse (INV-8).
  const alreadyExecuted = tail.some(
    (e) => e.type === 'onboard.executed' && e.data.idempotencyKey === idempotencyKey,
  );
  if (alreadyExecuted) {
    return { plan, idempotencyKey, recovered: false };
  }

  const recovering = hasDanglingRequest(tail, idempotencyKey);

  // Normal path emits the INTENT before any side effect. Recovery resumes a
  // prior intent, so it must NOT emit a second `requested`.
  if (!recovering) {
    await ctx.emit({
      type: 'onboard.requested',
      data: { trigger, plan, idempotencyKey },
    });
  }

  // Execute. On recovery, `plan` IS the residual re-diff (detect/diff above ran
  // against the half-applied repo), so only the outstanding steps run.
  const startedAt = Date.now();
  const result = await apply(plan, applyCtx);
  const durationMs = Date.now() - startedAt;

  // Emit the RESULT after side effects, pairing on the shared key.
  await ctx.emit({
    type: 'onboard.executed',
    data: { trigger, result, idempotencyKey, durationMs },
  });

  return { plan, result, idempotencyKey, recovered: recovering };
}
