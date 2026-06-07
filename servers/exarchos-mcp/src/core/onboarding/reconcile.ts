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
import type { DesiredState, ResolvedCommands } from './types.js';

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
