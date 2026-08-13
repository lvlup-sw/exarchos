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
 * Orientation delivered via a CLI flag on the spawn `command`. `valueForm`
 * records how the orientation payload maps onto the flag's argument:
 *   - `file`       — the flag takes a path to a temp file holding the orientation
 *                    (e.g. Claude Code `--append-system-prompt-file <path>`).
 *   - `string`     — the flag takes the orientation string inline
 *                    (e.g. Claude Code `--append-system-prompt <text>`).
 *   - `assignment` — the flag takes a `${assignmentKey}=${orientation}` config
 *                    assignment (e.g. Codex `-c developer_instructions=<text>`).
 *
 * Pure data: no field is (or nests) a function. The spawn-time probe (Task 015)
 * reads this shape; this registry never executes it.
 */
export interface FlagInjectionCandidate {
  readonly kind: 'flag';
  /** Flag token prepended to the spawn args (e.g. `--append-system-prompt-file`, `-c`). */
  readonly flag: string;
  /** How the orientation payload maps onto the flag's value. */
  readonly valueForm: 'file' | 'string' | 'assignment';
  /**
   * For `valueForm: 'assignment'`, the config key the orientation is assigned to
   * (e.g. `developer_instructions`); the empty string for the `file`/`string`
   * forms, which take the value directly.
   */
  readonly assignmentKey: string;
  /** Provenance + fallback note — documentation only, never read as behavior. */
  readonly note: string;
}

/**
 * Orientation delivered via an environment variable. `payload` records what the
 * variable's value carries:
 *   - `dir`         — a temp-directory path holding a synthetic instructions file
 *                     the harness auto-loads (e.g. Copilot
 *                     `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` → a dir with a synthetic
 *                     `AGENTS.md`).
 *   - `config-json` — the harness parses this var as ITS OWN config JSON
 *                     (not a free-text field), so raw orientation prose is
 *                     invalid content. The applier materializes orientation
 *                     into a temp `.md` file and references it from the
 *                     harness's own instruction-file config key, e.g.
 *                     OpenCode `OPENCODE_CONFIG_CONTENT` = `{"instructions":
 *                     ["<tmp-file>"]}` (OpenCode's `instructions` config
 *                     field is an array of file paths/globs, per
 *                     opencode.ai/docs/config — never inline text).
 *
 * Pure data: no field is (or nests) a function.
 */
export interface EnvInjectionCandidate {
  readonly kind: 'env';
  /** Environment variable name the orientation rides on. */
  readonly envVar: string;
  /** What the variable's value carries. */
  readonly payload: 'dir' | 'config-json';
  /** Provenance + fallback note — documentation only, never read as behavior. */
  readonly note: string;
}

/**
 * The harness exposes NO native spawn-time injection channel. Orientation is
 * delivered out-of-band; `note` documents that fallback (e.g. Cursor's
 * managed-block path). Pure data.
 */
export interface NoInjectionCandidate {
  readonly kind: 'none';
  /** Provenance + fallback note — documentation only, never read as behavior. */
  readonly note: string;
}

/**
 * A single static injection-channel candidate — discriminated on `kind`
 * (`flag` | `env` | `none`). PURE DATA: `HasFunctionDeep` distributes over this
 * union, so a function smuggled into any member fails the type-test's
 * `AssertPureData` and thus `tsc --noEmit`.
 */
export type InjectionCandidate =
  | FlagInjectionCandidate
  | EnvInjectionCandidate
  | NoInjectionCandidate;

/**
 * Pure-data spawn descriptor (DR-4). A **closed shape** of primitive/array/
 * record fields — `command`, `args`, `cwd`, `env`, `injection` — with **no
 * function-typed fields and no behavior hooks**.
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
  /**
   * Static, **preference-ordered** candidate list of native orientation-injection
   * channels for this harness (DR-6). PURE DATA — the spawn-time capability probe
   * (Task 015) walks it front-to-back and selects the first channel the live CLI
   * supports; this registry never executes it. A channel-less harness declares a
   * single `{ kind: 'none' }` candidate documenting its out-of-band fallback.
   */
  readonly injection: readonly InjectionCandidate[];
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
  'claude-code': {
    command: 'claude',
    args: [],
    cwd: '.',
    env: {},
    injection: [
      {
        kind: 'flag',
        flag: '--append-system-prompt-file',
        valueForm: 'file',
        assignmentKey: '',
        note: 'Primary. Claude Code appends the referenced file contents to the system prompt. Provenance: claude CLI --append-system-prompt-file flag. Fallback: the string-valued --append-system-prompt candidate below when the file flag is absent.',
      },
      {
        kind: 'flag',
        flag: '--append-system-prompt',
        valueForm: 'string',
        assignmentKey: '',
        note: 'Fallback for CLIs lacking the file flag. Passes the orientation string inline. Provenance: claude CLI --append-system-prompt flag.',
      },
    ],
  },
  codex: {
    command: 'codex',
    args: [],
    cwd: '.',
    env: {},
    injection: [
      {
        kind: 'flag',
        flag: '-c',
        valueForm: 'assignment',
        assignmentKey: 'developer_instructions',
        note: 'Codex config override in the form -c developer_instructions=<orientation>, seeding the developer-instructions channel. Provenance: codex -c key=value config flag. Fallback: none native; degrade to no orientation if the config key is unsupported.',
      },
    ],
  },
  cursor: {
    command: 'cursor-agent',
    args: [],
    cwd: '.',
    env: {},
    injection: [
      {
        kind: 'none',
        note: 'The Cursor CLI (cursor-agent) exposes no native spawn-time orientation channel. Fallback: the managed-block path writes orientation into a repo instructions file out-of-band, not via a spawn-time flag or env channel.',
      },
    ],
  },
  copilot: {
    command: 'copilot',
    args: [],
    cwd: '.',
    env: {},
    injection: [
      {
        kind: 'env',
        envVar: 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
        payload: 'dir',
        note: 'Copilot CLI auto-loads AGENTS.md from each directory in this list. The launcher writes a synthetic AGENTS.md into a temp dir and points the var at that dir. Provenance: Copilot custom-instructions directories env var. Fallback: none native; degrade to no orientation if unsupported.',
      },
    ],
  },
  opencode: {
    command: 'opencode',
    args: [],
    cwd: '.',
    env: {},
    injection: [
      {
        kind: 'env',
        envVar: 'OPENCODE_CONFIG_CONTENT',
        payload: 'config-json',
        note: "OpenCode reads inline JSON config from this var and merges it over opencode.json (config#precedence-order); its `instructions` field is an array of instruction-file paths, not inline text. The launcher writes orientation to a temp file and sets this var to `{\"instructions\":[<tmp-file>]}`. Provenance: OpenCode config-content env var + `instructions` config key. Fallback: none native; degrade to no orientation if unsupported.",
      },
    ],
  },
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
