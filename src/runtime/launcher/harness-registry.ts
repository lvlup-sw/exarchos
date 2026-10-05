/**
 * The spawn descriptors and the runtime-id map for the five Tier-1 harnesses
 * that Exarchos can launch. The `exarchos <harness>` verb resolves a harness
 * value to a runtime id. An unknown value gives an error with `validTargets`.
 * Each descriptor is pure data, with no function fields and no per-harness
 * behavior.
 */

/**
 * The five Tier-1 harnesses, in schema-enum order. {@link HarnessTarget} and
 * the `validTargets` of an invalid input both come from this tuple.
 */
export const TIER1_HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'opencode',
] as const;

/** A Tier-1 harness value that the launcher verb accepts. */
export type HarnessTarget = (typeof TIER1_HARNESSES)[number];

/**
 * The basename of a runtime map at `content/harness/runtimes/<id>.yaml`.
 * `claude-code` maps to `claude`, and each other harness keeps its own name.
 */
export type RuntimeId = 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';

/**
 * Orientation through a CLI flag on the spawn `command`. `valueForm` sets the
 * flag argument:
 *   - `file`: a path to a temp file with the orientation, such as Claude Code
 *     `--append-system-prompt-file <path>`.
 *   - `string`: the orientation text, such as `--append-system-prompt <text>`.
 *   - `assignment`: a `<assignmentKey>=<orientation>` config value, such as
 *     Codex `-c developer_instructions=<text>`.
 */
export interface FlagInjectionCandidate {
  readonly kind: 'flag';
  /** The flag token, such as `--append-system-prompt-file` or `-c`. */
  readonly flag: string;
  /** How the orientation payload maps onto the flag's value. */
  readonly valueForm: 'file' | 'string' | 'assignment';
  /**
   * For `valueForm: 'assignment'`, the config key of the orientation, such as
   * `developer_instructions`. The `file` and `string` forms use an empty string.
   */
  readonly assignmentKey: string;
  /** A provenance and fallback note. The launcher can report it, but never acts on it. */
  readonly note: string;
}

/**
 * Orientation through an environment variable. `payload` sets the value:
 *   - `dir`: a temp directory with a synthetic instructions file that the
 *     harness loads, such as `AGENTS.md` for `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`.
 *   - `config-json`: the config JSON of the harness, where raw prose is not
 *     valid. The applier writes the orientation to a temp `.md` file and names
 *     it in the instruction-file key, such as OpenCode
 *     `OPENCODE_CONFIG_CONTENT` = `{"instructions":["<tmp-file>"]}`.
 */
export interface EnvInjectionCandidate {
  readonly kind: 'env';
  /** Environment variable name the orientation rides on. */
  readonly envVar: string;
  /** What the variable's value carries. */
  readonly payload: 'dir' | 'config-json';
  /** A provenance and fallback note. The launcher can report it, but never acts on it. */
  readonly note: string;
}

/**
 * The harness has no native spawn-time injection channel. `note` describes the
 * fallback, such as the managed-block path of Cursor.
 */
export interface NoInjectionCandidate {
  readonly kind: 'none';
  /** A provenance and fallback note. The launcher can report it, but never acts on it. */
  readonly note: string;
}

/** One static injection-channel candidate, discriminated on `kind`. No member holds a function. */
export type InjectionCandidate =
  | FlagInjectionCandidate
  | EnvInjectionCandidate
  | NoInjectionCandidate;

/**
 * A pure-data spawn descriptor with the fields `command`, `args`, `cwd`, `env`
 * and `injection`, and no function fields. `env` holds only strings, because a
 * wider value type admits functions.
 */
export interface HarnessDescriptor {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  /**
   * The native orientation channels of this harness, in order of preference.
   * `resolveInjectionChannel` selects the first channel that the live CLI
   * supports. A harness with no channel declares one `{ kind: 'none' }` entry.
   */
  readonly injection: readonly InjectionCandidate[];
}

/**
 * The map from harness value to runtime id. Only `claude-code` gets a different
 * name. Each id is a basename in `content/harness/runtimes/`.
 */
export const HARNESS_RUNTIME_ID: Readonly<Record<HarnessTarget, RuntimeId>> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor',
  copilot: 'copilot',
  opencode: 'opencode',
} as const;

/**
 * The spawn descriptor of each Tier-1 harness. `command` is the first entry of
 * `detection.binaries` in `content/harness/runtimes/<id>.yaml`. For Cursor
 * that is `cursor-agent`, not the `cursor` GUI shim. The lifecycle core
 * replaces `cwd` with the worktree path at launch.
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
 * The result of {@link resolveHarness}. Success carries the `target`, its
 * `runtimeId` and its `descriptor`. Failure carries an `INVALID_INPUT` error
 * with `validTargets`, as in `runbooks/handler.ts`. The function does not
 * throw, so the CLI boundary can render a stable error envelope.
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
 * Resolve an untrusted harness value to its runtime id and descriptor. An
 * unknown value returns an `INVALID_INPUT` error with the five `validTargets`.
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
