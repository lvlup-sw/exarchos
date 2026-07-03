// ─── Harness Registry ────────────────────────────────────────────────────────
//
// Declarative spawn descriptors + enum→runtime-id map for the five Tier-1
// harnesses Exarchos can launch.
//
// Implements:
//   - DR-1: the `exarchos <harness>` launcher verb resolves a schema-enum
//     harness value to a runtime id (`claude-code` → `runtimes/claude.yaml`);
//     an unknown value yields a structured error carrying `validTargets`.
//   - DR-4: one shared abstraction — per-harness variation is *declarative
//     data* (a closed `command/args/cwd/env` shape), never behavior. No
//     function-typed fields and no per-harness branching hide inside a
//     descriptor. The pure-data property is pinned at compile time in
//     `harness-registry.type-test.ts` (a `tsc`-failing conditional-type check),
//     so a future function-valued field cannot slip past a runtime value sample.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The five Tier-1 harnesses, in canonical schema-enum order. This tuple is the
 * single source of truth for both {@link HarnessTarget} and the `validTargets`
 * an invalid input is reported against.
 */
export const TIER1_HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'opencode',
] as const;

/** A Tier-1 harness enum value accepted by the launcher verb (DR-1). */
export type HarnessTarget = (typeof TIER1_HARNESSES)[number];

/**
 * Runtime id — the basename of the runtime map under `runtimes/<id>.yaml`.
 * `claude-code` maps to `claude`; the other four share their name with their
 * runtime file.
 */
export type RuntimeId = 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';

/**
 * Pure-data spawn descriptor (DR-4). A **closed shape** of primitive/array/
 * record fields — `command`, `args`, `cwd`, `env` — with **no function-typed
 * fields and no behavior hooks**.
 *
 * `env` is `Record<string, string>` on purpose: string values only. Using
 * `unknown` (or any wider type) would admit function values and defeat the
 * pure-data guarantee. The invariant is enforced at compile time by the
 * `HasFunctionDeep<HarnessDescriptor>` assertion in
 * `harness-registry.type-test.ts` — the real gate is a green `tsc`, not a
 * runtime check.
 */
export interface HarnessDescriptor {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/**
 * Enum → runtime-id map (DR-1). Only `claude-code` diverges from its own name;
 * the other four are identity mappings that still correspond to real
 * `runtimes/<id>.yaml` basenames.
 */
export const HARNESS_RUNTIME_ID: Readonly<Record<HarnessTarget, RuntimeId>> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor',
  copilot: 'copilot',
  opencode: 'opencode',
} as const;

/**
 * Declarative per-harness spawn descriptors, one per Tier-1 harness.
 *
 * `command` is the primary CLI binary name each harness is detected/launched by
 * (see `runtimes/<id>.yaml` → `detection.binaries[0]`); Cursor's primary
 * binary is `cursor-agent` (the `cursor` GUI shim is a fallback, not the launch
 * target). `cwd`/`args`/`env` carry declarative defaults; the lifecycle
 * orchestrator (later tasks) overlays the derived worktree path and any
 * per-launch env without changing this registry's shape.
 */
export const HARNESS_DESCRIPTORS: Readonly<Record<HarnessTarget, HarnessDescriptor>> = {
  'claude-code': { command: 'claude', args: [], cwd: '.', env: {} },
  codex: { command: 'codex', args: [], cwd: '.', env: {} },
  cursor: { command: 'cursor-agent', args: [], cwd: '.', env: {} },
  copilot: { command: 'copilot', args: [], cwd: '.', env: {} },
  opencode: { command: 'opencode', args: [], cwd: '.', env: {} },
} as const;

/**
 * Discriminated-union result of {@link resolveHarness}.
 *
 * On success, carries the normalized `target`, its `runtimeId`, and the
 * declarative `descriptor`. On failure, an `INVALID_INPUT` structured error
 * (matching the repo-wide `validTargets` convention, e.g. `runbooks/handler.ts`
 * and `workspace/discovery.ts`) — never a throw, so the CLI/dispatch boundary
 * can render a stable error envelope.
 */
export type HarnessResolution =
  | {
      readonly success: true;
      readonly target: HarnessTarget;
      readonly runtimeId: RuntimeId;
      readonly descriptor: HarnessDescriptor;
    }
  | {
      readonly success: false;
      readonly code: 'INVALID_INPUT';
      readonly message: string;
      readonly validTargets: readonly HarnessTarget[];
    };

/** Type guard: is an arbitrary string one of the five Tier-1 harness enum values? */
export function isHarnessTarget(value: string): value is HarnessTarget {
  return (TIER1_HARNESSES as readonly string[]).includes(value);
}

/**
 * Resolve a (possibly untrusted) harness enum value to its runtime id +
 * declarative descriptor (DR-1). An unknown value returns a structured
 * `INVALID_INPUT` error carrying `validTargets` — the five enum members — rather
 * than throwing.
 */
export function resolveHarness(target: string): HarnessResolution {
  if (!isHarnessTarget(target)) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: `Unknown harness target: '${target}'. Expected one of: ${TIER1_HARNESSES.join(', ')}.`,
      validTargets: TIER1_HARNESSES,
    };
  }

  return {
    success: true,
    target,
    runtimeId: HARNESS_RUNTIME_ID[target],
    descriptor: HARNESS_DESCRIPTORS[target],
  };
}
