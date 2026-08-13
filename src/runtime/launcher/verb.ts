// ─── `exarchos <harness>` launcher verb — schema + dry-run + non-dry-run seam ─
//
// A CLI-only process-supervisor verb (the stdio MCP surface cannot own a
// child's lifecycle), so this module owns:
//
//   - the Zod verb schema (`<harness>` enum + `--feature` + `--dry-run`),
//   - `runLauncherVerb` — validates input, resolves the harness via the shared
//     `resolveHarness` (unknown → structured error carrying `validTargets`),
//     and on `--dry-run` derives the worktree path via the SAME
//     `topology.deriveWorktreePath` creation will use (Task 005) and returns
//     the event plan WITHOUT creating a worktree or spawning a process,
//   - `renderDryRunPlan` — the human-readable dry-run output (deliberately free
//     of any space / enforcement / confinement claim — an explicit non-goal of
//     this feature).
//
// The non-dry-run path runs the real lifecycle ({@link LifecycleRunner}): an
// explicit `lifecycle` override wins (tests / advanced callers), otherwise the
// verb builds the real `./lifecycle-core#runLifecycle` runner from the injected
// `lifecycleDeps`. Absent both — no event-store substrate to supervise a launch —
// it returns a structured `NOT_WIRED` result.
//
// Implements:
//   - DR-1: the `exarchos <harness>` launcher verb — schema-constrained enum,
//     Aspire-style, `--dry-run`-capable; unknown harness → `validTargets`.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import {
  TIER1_HARNESSES,
  resolveHarness,
  type HarnessTarget,
  type RuntimeId,
} from './harness-registry.js';
import { deriveWorktreePath } from './topology.js';
import { makeLifecycleRunner, type RunLifecycleDeps } from './lifecycle-core.js';
import { loadStandardBlockContent, previewInjectionChannel } from './injection-seam.js';
import type { ToolResult } from '../../format.js';

// ============================================================
// Event plan (what a real launch WOULD emit)
// ============================================================

/**
 * The ordered event plan a real (non-dry-run) launch WOULD emit, previewed by
 * `--dry-run`. Mirrors the DR-2 lifecycle exactly:
 *
 *   1. `worktree.reserved`          — ownership (before `git worktree add`)
 *   2. `worktree.create.requested`  — INV-13 creation intent
 *   3. `worktree.create.executed`   — INV-13 creation terminal (shared stem)
 *   4. `launch.executing_started`   — liveness start
 *   5. `launch.executed`            — liveness terminal (child exited)
 *
 * This is the single source of truth for the dry-run preview; the concrete
 * emissions are owned by Tasks 005 (create pair) and 006 (launch pair).
 */
export const LAUNCH_EVENT_PLAN = [
  'worktree.reserved',
  'worktree.create.requested',
  'worktree.create.executed',
  'launch.executing_started',
  'launch.executed',
] as const;

/** A single event type in the {@link LAUNCH_EVENT_PLAN}. */
export type LaunchEventType = (typeof LAUNCH_EVENT_PLAN)[number];

// ============================================================
// Verb schema (DR-1)
// ============================================================

/**
 * Zod schema for the `exarchos <harness>` verb.
 *
 * - `harness` is constrained to the five Tier-1 harness enum members
 *   ({@link TIER1_HARNESSES}) — the schema itself rejects any non-enum value.
 * - `feature` is an optional feature id the launch worktree is associated with.
 * - `dryRun` toggles the preview-only path (default `false`).
 *
 * The enum is sourced from {@link TIER1_HARNESSES} so the schema constraint and
 * the `resolveHarness` `validTargets` error can never drift apart.
 */
export const LauncherVerbSchema = z.object({
  harness: z.enum(TIER1_HARNESSES),
  feature: z.string().min(1).optional(),
  dryRun: z.boolean().optional().default(false),
});

/** Parsed, validated launcher verb input. */
export type LauncherVerbInput = z.infer<typeof LauncherVerbSchema>;

// ============================================================
// INV-5 conformance surface (DR-1: schema constraints + when-NOT-to-use)
// ============================================================

/**
 * INV-5 conformance metadata for the CLI-only `exarchos <harness>` launcher
 * verb.
 *
 * The launcher is a process-supervisor **CLI** verb, NOT an MCP tool/action —
 * the stdio MCP surface cannot own a child's lifecycle (see
 * `renderImplementerPrompt` / the spec's chokepoint table). It therefore carries
 * its INV-5 conformance surface HERE, alongside the schema, rather than in the
 * MCP `TOOL_REGISTRY` (where the four composite tools declare theirs). Two
 * halves, mirroring what a registered action declares:
 *
 *  - `schemaConstraints` (INV-5a — input ergonomics): the explicit, enumerated
 *    input contract, each field's constraint spelled out, so the callable
 *    surface is self-describing and cannot silently accept off-contract input.
 *    Sourced from {@link LauncherVerbSchema} / {@link TIER1_HARNESSES} so the
 *    documented constraint and the enforced schema can never drift apart.
 *  - `whenNotToUse` (INV-5a / INV-5c — negative space): the "do NOT use for"
 *    clause. Each entry states a case where the launcher is the WRONG surface
 *    and points at the right alternative — the same convention the registry's
 *    `merge_orchestrate` / `invariants_scaffold` descriptions follow.
 */
export const LAUNCHER_VERB_CONFORMANCE = {
  /** The CLI verb this conformance surface describes. */
  verb: 'exarchos <harness>',
  /** INV-5a input contract — one constraint statement per schema field. */
  schemaConstraints: [
    `harness: required; enum of the five Tier-1 harnesses (${TIER1_HARNESSES.join(
      ' | ',
    )}) — any other value is rejected with a structured error carrying validTargets (never a throw).`,
    'feature: optional; a non-empty feature id the launch worktree is associated with (sanitized to a single safe path segment before derivation).',
    'dryRun: optional; boolean, default false — when true, previews the derived worktree path + event plan WITHOUT creating a worktree or spawning a process.',
  ],
  /** INV-5a / INV-5c negative space — "do NOT use for", each with a pointer. */
  whenNotToUse: [
    'Do NOT use to mutate Exarchos workflow state — state flows through the MCP dispatch handler (exarchos_workflow / exarchos_event / exarchos_orchestrate), never the launcher.',
    'Do NOT use to launch the `generic` runtime — it has no harness process to supervise (an explicit non-goal; the schema enum omits it).',
    'Do NOT use to enforce filesystem-write confinement or a space/boundary tier — an explicit non-goal; the launcher owns the process + top-level-worktree lifecycle, not the kernel write path.',
    'Do NOT use to track a harness-created nested subagent worktree — that is the WLM adopt/reconcile path; the launcher only reserves + creates the top-level worktree it spawns into.',
    'Do NOT use to serialize integration merges — route those through serialize_merge; the launcher is a caller, not the merge owner.',
  ],
} as const;

// ============================================================
// Worktree-id derivation (preview stand-in)
// ============================================================

/**
 * Derive the single-segment worktree id previewed by `--dry-run`.
 *
 * This is a **preview stand-in**: the authoritative id (carrying the
 * `operationId`) is generated by the creation path (Task 005). It is factored
 * out here so the dry-run path derives a *valid single segment*
 * ({@link deriveWorktreePath} rejects separators / traversal tokens) and so
 * Task 005 can reuse or supersede it without reshaping the verb.
 *
 * The feature id (if any) is sanitized to a safe segment fragment — any
 * character outside `[A-Za-z0-9._-]` collapses to `-` — so a feature like
 * `feat/x` cannot push the derived path deeper than one level.
 */
export function deriveLaunchWorktreeId(harness: HarnessTarget, feature?: string): string {
  const base = `exarchos-${harness}`;
  if (feature === undefined || feature.length === 0) return base;
  const safeFeature = feature.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safeFeature.length > 0 ? `${base}-${safeFeature}` : base;
}

// ============================================================
// Dry-run plan
// ============================================================

/**
 * Structured dry-run preview: the derived worktree path + the event plan a
 * real launch would emit. Carries `base` and `worktreeId` so a consumer can
 * independently re-derive the path via {@link deriveWorktreePath} and confirm
 * the verb used the SAME guard as creation (not a re-implementation).
 */
export interface DryRunPlan {
  readonly harness: HarnessTarget;
  readonly runtimeId: RuntimeId;
  readonly feature: string | null;
  /** Base worktree the launcher worktree is a sibling of. */
  readonly base: string;
  /** Single-segment id the derived path is built from. */
  readonly worktreeId: string;
  /** Derived sibling worktree path (via {@link deriveWorktreePath}). */
  readonly worktreePath: string;
  /** The ordered events a real launch would emit (none emitted in dry-run). */
  readonly eventPlan: readonly LaunchEventType[];
  /** Spawn-time orientation-injection preview (probe-free — no help spawn on dry-run). */
  readonly injection: DryRunInjection;
}

/**
 * The `--dry-run` orientation-injection preview (DR-6). Both fields are derived
 * WITHOUT side effects: the channel from the harness's declared preference-ordered
 * candidate list (no help probe), the payload from `binding/standard/block.md`
 * (a read, not a spawn). The live launch re-resolves the channel via the actual
 * spawn-time probe.
 */
export interface DryRunInjection {
  /** The channel a real launch would resolve to — the declared primary candidate. */
  readonly channel: string;
  /** The orientation payload preview, or `null` when the block content is unavailable. */
  readonly payload: string | null;
}

// ============================================================
// Non-dry-run lifecycle seam (Task 010 fills this)
// ============================================================

/**
 * The resolved launch context handed to the lifecycle runner on the non-dry-run
 * path. Task 010's `./lifecycle-core#runLifecycle` consumes this to create the
 * worktree, place the child, exec the harness, and tear down.
 */
export interface ResolvedLaunch {
  readonly harness: HarnessTarget;
  readonly runtimeId: RuntimeId;
  readonly feature: string | null;
  readonly base: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
}

/**
 * The non-dry-run lifecycle entrypoint seam. The real implementation is
 * `./lifecycle-core#runLifecycle`; the verb builds it from
 * {@link LauncherVerbDeps.lifecycleDeps} or accepts an explicit override via
 * {@link LauncherVerbDeps.lifecycle}. Typed here so the core stays decoupled from
 * the verb's schema surface.
 */
export type LifecycleRunner = (launch: ResolvedLaunch) => Promise<ToolResult>;

/** Injectable dependencies for {@link runLauncherVerb}. */
export interface LauncherVerbDeps {
  /**
   * Base worktree path off which the launcher worktree is derived as a sibling.
   * Defaults to `process.cwd()`. Injected in tests for determinism.
   */
  readonly base?: string;
  /**
   * Explicit non-dry-run lifecycle runner override. Wins over the default built
   * from {@link lifecycleDeps} (tests / advanced callers inject a spy here).
   * Never invoked on the `--dry-run` path.
   */
  readonly lifecycle?: LifecycleRunner;
  /**
   * Dependencies the DEFAULT non-dry-run lifecycle runner is built from when no
   * explicit {@link lifecycle} is supplied — the real `runLifecycle` binding
   * (event store + spawn / holder seams). Absent (and no explicit `lifecycle`) →
   * the non-dry-run path returns a structured `NOT_WIRED`.
   */
  readonly lifecycleDeps?: RunLifecycleDeps;
  /**
   * Explicit orientation payload for the `--dry-run` injection preview; overrides
   * the default best-effort `binding/standard/block.md` load. Injected in tests so
   * the payload preview is deterministic without the repo file on disk.
   */
  readonly orientationContent?: string;
}

// ============================================================
// Verb core
// ============================================================

/** Build the INVALID_INPUT ToolResult for a Zod validation failure. */
function invalidInput(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

/**
 * Run the `exarchos <harness>` verb.
 *
 * Flow:
 *   1. Resolve the harness via {@link resolveHarness} — an unknown value
 *      returns a structured `INVALID_INPUT` error carrying `validTargets` (the
 *      five enum members), never a throw.
 *   2. Validate the remaining input (`feature`, `dryRun`) via
 *      {@link LauncherVerbSchema}.
 *   3. `--dry-run`: derive the worktree path via {@link deriveWorktreePath}
 *      (the SAME guard creation uses) and return the {@link DryRunPlan} — NO
 *      worktree created, NO process spawned.
 *   4. non-dry-run: run the real lifecycle — an explicit {@link LifecycleRunner}
 *      override, else the default runner built from
 *      {@link LauncherVerbDeps.lifecycleDeps}; absent both, a structured
 *      `NOT_WIRED` result.
 */
export async function runLauncherVerb(
  raw: unknown,
  deps: LauncherVerbDeps = {},
): Promise<ToolResult> {
  if (raw === null || typeof raw !== 'object') {
    return invalidInput('launcher verb input must be an object');
  }
  const rawInput = raw as Record<string, unknown>;

  // (1) Resolve harness FIRST so an unknown value yields the structured
  // `validTargets` error (independent of the schema's enum rejection).
  const harnessValue = rawInput.harness;
  const resolution = resolveHarness(
    typeof harnessValue === 'string' ? harnessValue : String(harnessValue),
  );
  if (!resolution.success) {
    return {
      success: false,
      error: {
        code: resolution.code,
        message: resolution.message,
        validTargets: resolution.validTargets,
      },
    };
  }

  // (2) Validate the full input through the schema (feature / dryRun shape).
  const parsed = LauncherVerbSchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(
      parsed.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
        .join('; '),
    );
  }

  const { harness, feature, dryRun } = parsed.data;
  const base = deps.base ?? process.cwd();
  const worktreeId = deriveLaunchWorktreeId(harness, feature);

  // Derive the sibling worktree path via the SHARED pure guard — the same
  // function the creation task (005) calls before `git worktree add`. A bad id
  // (traversal / separator) surfaces as a structured error, not a throw.
  let worktreePath: string;
  try {
    worktreePath = deriveWorktreePath(base, worktreeId);
  } catch (err) {
    return invalidInput(
      `cannot derive launcher worktree path: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // (3) Dry-run: preview only — no worktree, no spawn, no help probe.
  if (dryRun) {
    // Probe-free channel + payload preview (a file read, never a spawn), so the
    // dry-run has zero side effects; the live launch re-resolves via the probe.
    const rawPayload = deps.orientationContent ?? loadStandardBlockContent();
    const plan: DryRunPlan = {
      harness,
      runtimeId: resolution.runtimeId,
      feature: feature ?? null,
      base,
      worktreeId,
      worktreePath,
      eventPlan: LAUNCH_EVENT_PLAN,
      injection: {
        channel: previewInjectionChannel(resolution.descriptor.injection),
        // Empty/absent content is unavailable → null (renders the graceful note).
        payload: rawPayload && rawPayload.length > 0 ? rawPayload : null,
      },
    };
    return { success: true, data: plan };
  }

  // (4) Non-dry-run: run the real lifecycle. An explicit `lifecycle` override
  // wins; otherwise build the real `runLifecycle` runner from `lifecycleDeps`.
  // With neither there is no event-store substrate to supervise a launch, so
  // return a structured `NOT_WIRED`.
  const runner: LifecycleRunner | undefined =
    deps.lifecycle ??
    (deps.lifecycleDeps ? makeLifecycleRunner(deps.lifecycleDeps) : undefined);
  if (runner) {
    return runner({
      harness,
      runtimeId: resolution.runtimeId,
      feature: feature ?? null,
      base,
      worktreeId,
      worktreePath,
    });
  }
  return {
    success: false,
    error: {
      code: 'NOT_WIRED',
      message:
        'exarchos <harness>: non-dry-run launch requires a wired lifecycle substrate (event store); none supplied. Re-run with --dry-run to preview the derived worktree path + event plan.',
    },
  };
}

// ============================================================
// Dry-run rendering (human output — no enforcement claim)
// ============================================================

/**
 * Render a {@link DryRunPlan} as human-readable CLI output.
 *
 * The output is deliberately confined to lifecycle facts — the harness, its
 * runtime, the derived worktree path, and the ordered event plan. It makes NO
 * space / enforcement / confinement / sandbox / boundary claim, because
 * filesystem-write confinement is an explicit non-goal of this launcher (see
 * the spec's chokepoint table). `Verb_DryRun_NoEnforcementClaimInOutput`
 * pins that absence.
 */
export function renderDryRunPlan(plan: DryRunPlan): string {
  const lines: string[] = [];
  lines.push(`[dry-run] exarchos ${plan.harness} (runtime: ${plan.runtimeId})`);
  if (plan.feature) lines.push(`  feature:       ${plan.feature}`);
  lines.push(`  base:          ${plan.base}`);
  lines.push(`  worktree path: ${plan.worktreePath}`);
  lines.push(`  orientation channel: ${plan.injection.channel}`);
  if (plan.injection.payload !== null) {
    lines.push('  orientation payload (would inject at spawn; none injected in dry-run):');
    for (const payloadLine of plan.injection.payload.split('\n')) {
      lines.push(`    │ ${payloadLine}`);
    }
  } else {
    lines.push('  orientation payload: (unavailable — launch would proceed without orientation)');
  }
  lines.push('  event plan (would emit; none emitted in dry-run):');
  plan.eventPlan.forEach((event, index) => {
    lines.push(`    ${index + 1}. ${event}`);
  });
  lines.push('  (no worktree created, no process spawned)');
  return lines.join('\n');
}

// ============================================================
// Type guard for the dry-run result shape
// ============================================================

/**
 * Narrow a successful {@link ToolResult} whose `data` is a {@link DryRunPlan}.
 * Used by the CLI adapter to choose human rendering vs the JSON envelope.
 */
export function isDryRunPlan(data: unknown): data is DryRunPlan {
  if (data === null || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.worktreePath === 'string' &&
    typeof d.worktreeId === 'string' &&
    Array.isArray(d.eventPlan)
  );
}
