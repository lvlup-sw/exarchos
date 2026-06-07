/**
 * The pure, harness-neutral onboarding reconciler (DR-1).
 *
 * This module is the single home for onboarding *behavior*. It is consumed by
 * the thin `onboard` / `doctor` facades (INV-2) and grows across the epic:
 *
 *   - `detectDesiredState` (task 005, here) — derive the reconcile target.
 *   - `diff`               (task 006)        — desired + actual → ReconcilePlan.
 *   - `apply`              (task 007)        — execute a plan → ReconcileResult.
 *
 * Hard constraints (enforced by tests + INV audits):
 *   - INV-2: NO imports from `adapters/*` — behavior lives here, not in the
 *     presentation facades.
 *   - INV-6: command derivation flows EXCLUSIVELY through the Bundle B layered
 *     resolver (`resolveTestRuntime`). There is no `applyLanguageCustomizations`
 *     / npm string-rewrite in this path; an unresolved command field is OMITTED,
 *     never fabricated.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { resolveTestRuntime } from '../../config/test-runtime-resolver.js';
import {
  detectAgentEnvironments,
  type AgentRuntimeName,
} from '../../runtime/agent-environment-detector.js';
import type { CheckResult } from '../../orchestrate/doctor/schema.js';
import type {
  DesiredState,
  PlanStep,
  PlanStepKind,
  ReconcilePlan,
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
  /** Command overrides threaded into the layered resolver's override tier. */
  readonly commandOverride?: {
    readonly test?: string;
    readonly typecheck?: string;
    readonly install?: string;
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
  const resolved = resolveTestRuntime(repoRoot, override ? { override: { ...override } } : undefined);

  const commands: ResolvedCommands = {};
  if (resolved.test !== null) commands.test = resolved.test;
  if (resolved.typecheck !== null) commands.typecheck = resolved.typecheck;
  if (resolved.install !== null) commands.install = resolved.install;
  return commands;
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
 * `diff(desired, actual)` — the structured `doctor` diff (DR-1 / DR-4).
 *
 * Turns the doctor check results into an EXECUTABLE {@link ReconcilePlan}: each
 * remediable (`Fail`/`Warning` with a `fix`) check becomes exactly one
 * {@link PlanStep}; passing and non-remediable checks contribute nothing. A
 * fully-configured repo (all checks `Pass`) ⇒ the empty plan `{ steps: [] }`,
 * which is the idempotence precondition for `apply` (task 007).
 *
 * Seam: `actual` is the doctor composer's own output — `readonly CheckResult[]`,
 * exactly what `handleDoctorWithChecks` produces by running the 11 checks. The
 * caller (doctor `--fix` / `onboard`) runs the probes; `diff` stays PURE (no fs,
 * no process) and only classifies. `desired` is accepted for forward-compatible
 * symmetry with the design's `diff(desired, actual)` signature and so future
 * desired-vs-actual command/runtime divergence can fold in here without a
 * signature change; today the plan is derived from the remediable checks alone.
 *
 * Step order mirrors the input check order so callers can scan top-to-bottom.
 */
export function diff(_desired: DesiredState, actual: readonly CheckResult[]): ReconcilePlan {
  const steps = actual.filter(isRemediable).map(toPlanStep);
  return { steps };
}
