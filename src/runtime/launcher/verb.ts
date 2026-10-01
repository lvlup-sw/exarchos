/**
 * The `exarchos <harness>` launcher verb: its schema, its dry-run, and its non-dry-run seam. It is a
 * CLI-only process-supervisor verb, because the stdio MCP surface cannot own the lifecycle of a child.
 *
 * `runLauncherVerb` validates the input and resolves the harness. An unknown harness gives a structured
 * error with `validTargets`. On `--dry-run`, it derives the worktree path with `topology.deriveWorktreePath`,
 * the guard that creation uses, and returns the event plan with no worktree and no spawn.
 * `renderDryRunPlan` prints that plan with no space, enforcement, or confinement claim.
 *
 * The non-dry-run path runs an explicit `lifecycle` override, or a runner built from `lifecycleDeps`. With
 * neither, it returns a structured `NOT_WIRED` result.
 */

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

/**
 * The ordered events that a real launch emits, which `--dry-run` previews:
 *
 *   1. `worktree.reserved`: ownership, before `git worktree add`
 *   2. `worktree.create.requested`: creation intent
 *   3. `worktree.create.executed`: creation terminal
 *   4. `launch.executing_started`: liveness start
 *   5. `launch.executed`: liveness terminal, after the child exits
 *
 * The dry-run preview reads only this list. `create-worktree.ts` and `liveness.ts` emit the events.
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

/**
 * The conformance metadata of the CLI-only launcher verb. The launcher is a process-supervisor CLI verb,
 * not an MCP action, so it declares this surface here and not in `TOOL_REGISTRY`.
 *
 * `schemaConstraints` states the constraint of each input field, and it reads {@link TIER1_HARNESSES} like
 * {@link LauncherVerbSchema} does. `whenNotToUse` lists each case where the launcher is the wrong surface,
 * with the right alternative.
 */
export const LAUNCHER_VERB_CONFORMANCE = {
  /** The CLI verb this conformance surface describes. */
  verb: 'exarchos <harness>',
  /** The input contract: one constraint statement per schema field. */
  schemaConstraints: [
    `harness: required; enum of the five Tier-1 harnesses (${TIER1_HARNESSES.join(
      ' | ',
    )}) — any other value is rejected with a structured error carrying validTargets (never a throw).`,
    'feature: optional; a non-empty feature id the launch worktree is associated with (sanitized to a single safe path segment before derivation).',
    'dryRun: optional; boolean, default false — when true, previews the derived worktree path + event plan WITHOUT creating a worktree or spawning a process.',
  ],
  /** The cases where the launcher is the wrong surface, each with the right alternative. */
  whenNotToUse: [
    'Do NOT use to mutate Exarchos workflow state — state flows through the MCP dispatch handler (exarchos_workflow / exarchos_event / exarchos_orchestrate), never the launcher.',
    'Do NOT use to launch the `generic` runtime — it has no harness process to supervise (an explicit non-goal; the schema enum omits it).',
    'Do NOT use to enforce filesystem-write confinement or a space/boundary tier — an explicit non-goal; the launcher owns the process + top-level-worktree lifecycle, not the kernel write path.',
    'Do NOT use to track a harness-created nested subagent worktree — that is the WLM adopt/reconcile path; the launcher only reserves + creates the top-level worktree it spawns into.',
    'Do NOT use to serialize integration merges — route those through serialize_merge; the launcher is a caller, not the merge owner.',
  ],
} as const;

/**
 * Derives the single-segment worktree id of a launch. The dry-run previews it, and the live path passes it
 * to creation as the path segment. In the feature id, each run of characters outside `[A-Za-z0-9._-]`
 * becomes one `-`. Thus a feature such as `feat/x` cannot push the path deeper than one level.
 */
export function deriveLaunchWorktreeId(harness: HarnessTarget, feature?: string): string {
  const base = `exarchos-${harness}`;
  if (feature === undefined || feature.length === 0) return base;
  const safeFeature = feature.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safeFeature.length > 0 ? `${base}-${safeFeature}` : base;
}

/**
 * The dry-run preview: the derived worktree path and the event plan of a real launch. It carries `base` and
 * `worktreeId`. Thus a consumer can derive the path again with {@link deriveWorktreePath} and confirm that
 * the verb used the same guard as creation.
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
  /** The ordered events of a real launch. The dry-run emits none. */
  readonly eventPlan: readonly LaunchEventType[];
  /** Spawn-time orientation-injection preview (probe-free — no help spawn on dry-run). */
  readonly injection: DryRunInjection;
}

/**
 * The orientation-injection preview of `--dry-run`. Neither field has a side effect. The channel comes from
 * the declared candidate list of the harness with no help probe, and the payload comes from a read of
 * `binding/standard/block.md`. The live launch resolves the channel with the real probe.
 */
export interface DryRunInjection {
  /** The declared primary candidate. The live probe can select a different channel. */
  readonly channel: string;
  /** The orientation payload preview, or `null` when the block content is unavailable. */
  readonly payload: string | null;
}

/**
 * The resolved launch context that the non-dry-run path hands to the lifecycle runner.
 * `./lifecycle-core#runLifecycle` uses it to create the worktree, place the child, run the harness, and
 * tear down.
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
 * The non-dry-run lifecycle entry point. The real implementation is `./lifecycle-core#runLifecycle`. The
 * verb builds it from {@link LauncherVerbDeps.lifecycleDeps}, or takes {@link LauncherVerbDeps.lifecycle}
 * as an override. The type lives here, so the core does not depend on the schema of the verb.
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
   * The dependencies of the default runner: `runLifecycle` with the event store and the spawn and holder
   * seams. With no `lifecycleDeps` and no {@link lifecycle}, the non-dry-run path returns `NOT_WIRED`.
   */
  readonly lifecycleDeps?: RunLifecycleDeps;
  /**
   * The orientation payload for the `--dry-run` preview. It overrides the load of
   * `binding/standard/block.md`, so a test gets a fixed payload with no repo file.
   */
  readonly orientationContent?: string;
}

/** Build the INVALID_INPUT ToolResult for a Zod validation failure. */
function invalidInput(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

/**
 * Runs the `exarchos <harness>` verb.
 *
 * 1. It resolves the harness with {@link resolveHarness} before the schema runs, so an unknown value gives a
 *    structured `INVALID_INPUT` error with `validTargets`, never a throw.
 * 2. It checks `feature` and `dryRun` with {@link LauncherVerbSchema}.
 * 3. It derives the worktree path with {@link deriveWorktreePath}, the guard that creation uses. A bad id
 *    gives a structured error.
 * 4. On `--dry-run`, it returns the {@link DryRunPlan}. An empty or absent payload previews as `null`.
 * 5. Otherwise it runs the explicit `lifecycle`, or a runner from `lifecycleDeps`, or returns `NOT_WIRED`.
 */
export async function runLauncherVerb(
  raw: unknown,
  deps: LauncherVerbDeps = {},
): Promise<ToolResult> {
  if (raw === null || typeof raw !== 'object') {
    return invalidInput('launcher verb input must be an object');
  }
  const rawInput = raw as Record<string, unknown>;

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

  let worktreePath: string;
  try {
    worktreePath = deriveWorktreePath(base, worktreeId);
  } catch (err) {
    return invalidInput(
      `cannot derive launcher worktree path: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (dryRun) {
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
        payload: rawPayload && rawPayload.length > 0 ? rawPayload : null,
      },
    };
    return { success: true, data: plan };
  }

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

/**
 * Renders a {@link DryRunPlan} as human-readable CLI output. The output holds only lifecycle facts: the
 * harness, its runtime, the worktree path, the orientation preview, and the event plan. It makes no space,
 * enforcement, confinement, sandbox, or boundary claim, because write confinement is a non-goal of the
 * launcher. `Verb_DryRun_NoEnforcementClaimInOutput` pins that absence.
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

/**
 * Narrows the `data` of a successful {@link ToolResult} to a {@link DryRunPlan}. The CLI adapter uses it to
 * choose human output or the JSON envelope.
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
