/**
 * The shared harness for the CLI and MCP parity suites. It is the only copy of these helpers.
 *
 * - `callCli` parses Commander in-process and returns the JSON envelope from stdout.
 * - `callMcp` calls `dispatch()` with the `{ action, ...args }` shape that the MCP SDK sends.
 * - `normalize` replaces or drops timestamps, UUIDs and telemetry fields, so the two arms give
 *   equal trees.
 *
 * Each suite passes `normalize` options for the placeholders and the per-key transforms that its
 * fixtures need.
 */
import { vi } from 'vitest';
import { CommanderError } from 'commander';

import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../../src/dispatch/caller-identity.js';
import type { ToolResult, Envelope, ErrorEnvelope } from '../../src/format.js';
import { toEnvelope } from '../../src/format.js';
import {
  buildCli,
  commanderErrorToResult,
  applyExitOverrideRecursively,
  type CliExitCode,
} from '../../src/adapters/cli/cli.js';

/** Options for {@link callCli}. */
export interface CliCallOptions {
  /**
   * When `true`, {@link callCli} maps a Commander error through `commanderErrorToResult` and
   * returns the result. A test of the `INVALID_INPUT` contract needs it for an unknown subcommand
   * or a missing mandatory option.
   */
  readonly captureCommanderErrors?: boolean;
}

/**
 * The return shape of {@link callCli}. `result` is the envelope that `--json` prints through
 * `toCliResult(toEnvelope(...))`. It carries `next_actions`, `_meta` and `_perf` beside `success`,
 * `error.code` and `data`.
 */
export interface CliCallResult {
  readonly result: Envelope<unknown> | ErrorEnvelope;
  readonly exitCode: number;
}

/**
 * Runs a CLI action through Commander in-process and returns the parsed `--json` envelope.
 *
 * `flags` keys are camelCase and become kebab-case options. An object value becomes a JSON string.
 * A boolean becomes `--flag` or `--no-flag`.
 *
 * The CLI prints the envelope as pretty JSON on many lines, so the parser reads from the first `{`
 * to the end of stdout. The function restores `process.exitCode` before it throws again, because
 * a non-zero value corrupts the exit-code assertions of later tests. A captured Commander error
 * returns as an envelope, so each path gives the same shape.
 */
export async function callCli(
  ctx: DispatchContext,
  toolAlias: string,
  actionFlag: string,
  flags: Record<string, unknown>,
  options: CliCallOptions = {},
): Promise<CliCallResult> {
  const program = buildCli(ctx);
  applyExitOverrideRecursively(program);

  const capturedStdout: string[] = [];
  const capturedStderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      capturedStdout.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      capturedStderr.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;

  const argv: string[] = ['node', 'exarchos', toolAlias, actionFlag];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    const kebab = key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    if (typeof value === 'boolean') {
      argv.push(value ? `--${kebab}` : `--no-${kebab}`);
    } else if (typeof value === 'object' && value !== null) {
      argv.push(`--${kebab}`, JSON.stringify(value));
    } else {
      argv.push(`--${kebab}`, String(value));
    }
  }
  argv.push('--json');

  let commanderError: CommanderError | undefined;
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError && options.captureCommanderErrors) {
      commanderError = err;
    } else {
      process.exitCode = savedExitCode;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      throw err;
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const exitCode =
    typeof process.exitCode === 'number'
      ? process.exitCode
      : commanderError?.exitCode ?? 0;
  process.exitCode = savedExitCode;

  const stdoutText = capturedStdout.join('').trim();
  if (stdoutText) {
    const firstBrace = stdoutText.indexOf('{');
    if (firstBrace < 0) {
      throw new Error(
        `CLI produced non-JSON stdout for ${toolAlias} ${actionFlag}: ${stdoutText}`,
      );
    }
    const jsonText = stdoutText.slice(firstBrace);
    const parsed = JSON.parse(jsonText) as Envelope<unknown> | ErrorEnvelope;
    return { result: parsed, exitCode };
  }

  if (commanderError) {
    const { result, exitCode: mappedExit } = commanderErrorToResult(commanderError);
    return { result: toEnvelope(result), exitCode: mappedExit };
  }

  throw new Error(
    `CLI emitted no stdout for ${toolAlias} ${actionFlag} ${JSON.stringify(flags)} — exit code ${exitCode}`,
  );
}

/**
 * Calls a composite tool action through `dispatch`, the entry point that the MCP SDK calls after
 * argument validation. `args` must include `action`, as in the MCP JSON-RPC shape.
 *
 * The result goes through `toEnvelope`, as in `src/adapters/mcp/mcp.ts`, so the two arms return
 * the same carrier shape.
 *
 * When `ctx` has no `callerIdentity`, the helper binds the local-operator identity that `buildCli`
 * binds on the CLI arm. Without it, admission denies the MCP arm and grants the CLI arm. A suite
 * that needs an untrusted session must set `callerIdentity`.
 */
export async function callMcp(
  ctx: DispatchContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<Envelope<unknown> | ErrorEnvelope> {
  const trusted =
    ctx.callerIdentity === undefined
      ? { ...ctx, callerIdentity: deriveLocalOperatorIdentity(ctx.stateDir) }
      : ctx;
  const result = await dispatch(tool, args, trusted);
  return toEnvelope(result);
}

export const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UUID_ANY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
export const TMP_PATH_RE =
  /\/(?:tmp|var\/folders\/[^/\s"']+)\/[A-Za-z0-9_.\-/]*/g;

/** Options for {@link normalize}. */
export interface NormalizeOptions {
  /** The placeholder for an ISO timestamp. The default is `<TS>`. */
  readonly timestampPlaceholder?: string;
  /** The placeholder for a UUID. The default is `<UUID>`. */
  readonly uuidPlaceholder?: string;
  /** The placeholder for a commit SHA. The default is `null`, which skips SHA detection. */
  readonly shaPlaceholder?: string | null;
  /** The placeholder for a temporary path. The default is `null`, which skips the replacement. */
  readonly tmpPathPlaceholder?: string | null;
  /** The UUID regex. The default is the strict `UUID_V4_RE`. `UUID_ANY_RE` accepts each version. */
  readonly uuidRegex?: RegExp;
  /** Keys whose values become the timestamp placeholder. */
  readonly timestampKeys?: ReadonlySet<string>;
  /** Keys whose values become the UUID placeholder. */
  readonly uuidKeys?: ReadonlySet<string>;
  /** A map from a key to its fixed placeholder, such as `minutesSinceActivity` to `<MINUTES>`. */
  readonly keyPlaceholders?: Readonly<Record<string, string>>;
  /** Keys that each object node loses. Use it for telemetry fields that are not deterministic. */
  readonly dropKeys?: ReadonlySet<string>;
  /**
   * When `true`, an object loses each string field whose value matches the ISO timestamp regex or
   * the UUID regex. Those fields get no placeholder.
   */
  readonly stripTimeSensitiveValues?: boolean;
}

const DEFAULTS: Required<Omit<NormalizeOptions, 'shaPlaceholder' | 'tmpPathPlaceholder' | 'timestampKeys' | 'uuidKeys' | 'keyPlaceholders' | 'dropKeys' | 'stripTimeSensitiveValues'>> & {
  readonly shaPlaceholder: string | null;
  readonly tmpPathPlaceholder: string | null;
  readonly timestampKeys: ReadonlySet<string>;
  readonly uuidKeys: ReadonlySet<string>;
  readonly keyPlaceholders: Readonly<Record<string, string>>;
  readonly dropKeys: ReadonlySet<string>;
  readonly stripTimeSensitiveValues: boolean;
} = {
  timestampPlaceholder: '<TS>',
  uuidPlaceholder: '<UUID>',
  shaPlaceholder: null,
  tmpPathPlaceholder: null,
  uuidRegex: UUID_V4_RE,
  timestampKeys: new Set<string>(),
  uuidKeys: new Set<string>(),
  keyPlaceholders: {},
  dropKeys: new Set<string>(),
  stripTimeSensitiveValues: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replaces timestamps and UUIDs with stable placeholders at each depth, so two arms give equal
 * trees. {@link NormalizeOptions} sets the placeholders, the per-key transforms and the keys to
 * drop.
 */
export function normalize(value: unknown, options: NormalizeOptions = {}): unknown {
  const opts = { ...DEFAULTS, ...options };

  const visit = (node: unknown): unknown => {
    if (node === null || node === undefined) return node;

    if (Array.isArray(node)) {
      return node.map(visit);
    }

    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (opts.dropKeys.has(k)) continue;
        if (opts.keyPlaceholders[k] !== undefined) {
          out[k] = opts.keyPlaceholders[k];
          continue;
        }
        if (opts.timestampKeys.has(k)) {
          out[k] = opts.timestampPlaceholder;
          continue;
        }
        if (opts.uuidKeys.has(k)) {
          out[k] = opts.uuidPlaceholder;
          continue;
        }
        if (opts.stripTimeSensitiveValues && typeof v === 'string') {
          if (ISO_TIMESTAMP_RE.test(v)) continue;
          if (opts.uuidRegex.test(v)) continue;
        }
        out[k] = visit(v);
      }
      return out;
    }

    if (typeof node === 'string') {
      if (ISO_TIMESTAMP_RE.test(node)) return opts.timestampPlaceholder;
      if (opts.uuidRegex.test(node)) return opts.uuidPlaceholder;
      if (opts.shaPlaceholder !== null && COMMIT_SHA_RE.test(node) && node.length >= 7) {
        return opts.shaPlaceholder;
      }
      if (opts.tmpPathPlaceholder !== null && TMP_PATH_RE.test(node)) {
        return node.replace(TMP_PATH_RE, opts.tmpPathPlaceholder);
      }
    }

    return node;
  };

  return visit(value);
}

export { applyExitOverrideRecursively, commanderErrorToResult, type CliExitCode };

/**
 * A scenario that the CLI arm and the MCP arm must run with equal results. `setup` primes the
 * `DispatchContext`. `cliCall` and `mcpCall` hold the arguments for each carrier. A suite compares
 * the two normalized results.
 */
export interface ParityFixture {
  /** A stable identifier for the fixture. */
  readonly name: string;
  /** A description for failure messages. */
  readonly description: string;
  /**
   * Primes a {@link DispatchContext}, for example with a workflow or with seed events. A suite
   * calls it one time for each arm, with a fresh context.
   */
  readonly setup: (ctx: DispatchContext) => Promise<void>;
  /** The CLI arm, for {@link callCli}. */
  readonly cliCall: {
    readonly toolAlias: string;
    readonly action: string;
    readonly flags: Record<string, unknown>;
  };
  /** The MCP arm, for {@link callMcp}. */
  readonly mcpCall: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
}

/**
 * A feature workflow in the `delegate` phase, for the rehydrate test in `workflow/parity.test.ts`.
 * `handleRehydrate` composes a non-null `phasePlaybook` for that phase. The rehydration envelope
 * must be equal across the CLI and MCP carriers.
 *
 * `setup` appends two seed events and does not call `handleInit` or `handleTransition`. Thus the
 * fixture does not depend on HSM guard state.
 */
export const DELEGATE_PHASE_REHYDRATE_FIXTURE: ParityFixture = {
  name: 'delegate_phase_rehydrate',
  description:
    'rehydrate(featureId) on a feature workflow in `delegate` phase → v:3 envelope with composed phasePlaybook; CLI and MCP carriers must produce byte-equivalent ToolResults',
  async setup(ctx: DispatchContext) {
    const featureId = 'parity-rehydrate-delegate';
    await ctx.eventStore.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await ctx.eventStore.append(featureId, {
      type: 'workflow.transition',
      data: { from: '', to: 'delegate' },
    });
  },
  cliCall: {
    toolAlias: 'wf',
    action: 'rehydrate',
    flags: { featureId: 'parity-rehydrate-delegate' },
  },
  mcpCall: {
    tool: 'exarchos_workflow',
    args: { action: 'rehydrate', featureId: 'parity-rehydrate-delegate' },
  },
};

/**
 * The fixture holds the arguments for a `merge_orchestrate` call through the two carriers, on a
 * stream with no prior merge events. `setup` is empty, because the orchestrator opens the stream
 * itself.
 *
 * The fixture installs no dependency hooks, and the real preflight and executor run git.
 * `merge-orchestrate.parity-harness.test.ts` wraps the fixture in `stubCompositeHandler`, which
 * supplies deterministic adapters so the two arms give equal output.
 */
export const MERGE_ORCHESTRATE_PARITY_FIXTURE: ParityFixture = {
  name: 'merge_orchestrate_post_wave4',
  description:
    'merge_orchestrate(feature/x → main, squash) with passing preflight + completed executor — post Wave 4 two-event split. CLI and MCP carriers MUST project byte-equal ToolResults.',
  async setup(_ctx: DispatchContext) {
  },
  cliCall: {
    toolAlias: 'orch',
    action: 'merge_orchestrate',
    flags: {
      featureId: 'parity-merge-orchestrate-wave4',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      taskId: 'T44',
      strategy: 'squash',
    },
  },
  mcpCall: {
    tool: 'exarchos_orchestrate',
    args: {
      action: 'merge_orchestrate',
      featureId: 'parity-merge-orchestrate-wave4',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      taskId: 'T44',
      strategy: 'squash',
    },
  },
};

/**
 * The fixture requests the `plan` to `plan-review` transition with no `artifacts.plan`, so the
 * `planArtifactExists` guard fails. The structured error envelope must be equal across the CLI and
 * MCP carriers.
 *
 * `setup` imports the workflow handler lazily, because each parity test loads this module at cold
 * start.
 */
export const TRANSITION_GUARD_FAILURE_FIXTURE: ParityFixture = {
  name: 'transition_guard_failure',
  description:
    'transition({target:"plan-review"}) without required artifacts → GUARD_FAILED with structured envelope',
  async setup(ctx: DispatchContext) {
    const { handleInit } = await import('../../src/workflow/tools.js');
    await handleInit(
      { featureId: 'parity-guard-fail', workflowType: 'feature' },
      ctx.stateDir,
      ctx.eventStore,
    );
  },
  cliCall: {
    toolAlias: 'wf',
    action: 'transition',
    flags: { featureId: 'parity-guard-fail', target: 'plan-review' },
  },
  mcpCall: {
    tool: 'exarchos_workflow',
    args: { action: 'transition', featureId: 'parity-guard-fail', target: 'plan-review' },
  },
};
