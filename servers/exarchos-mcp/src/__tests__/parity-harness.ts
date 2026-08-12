// ─── Shared CLI/MCP Parity Test Harness ─────────────────────────────────────
//
// Extracted from the 5 parity test suites (task 024 follow-up F-024 #8).
//
// Each parity test in the codebase needs three primitives:
//   • `callCli(ctx, toolAlias, action, flags)` — parse Commander in-process,
//      capture the JSON line from stdout, return the parsed ToolResult.
//   • `callMcp(ctx, tool, args)` — invoke the MCP dispatch() directly with
//      the same `{ action, ...args }` shape the MCP SDK would produce.
//   • `normalize(payload, opts)` — strip wall-clock / UUID / `_perf`
//      fields so two arm invocations produce byte-equal trees.
//
// Previously each suite defined its own copies with subtle drift (different
// placeholders, different key sets, slightly different regex). This module
// is the single source of truth. Suites pass `normalize` options to select
// the placeholder vocabulary and per-key transforms their fixtures need.
// ────────────────────────────────────────────────────────────────────────────

import { vi } from 'vitest';
import { CommanderError } from 'commander';

import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { dispatch } from '../dispatch/core/dispatch.js';
import type { ToolResult, Envelope, ErrorEnvelope } from '../format.js';
import { toEnvelope } from '../format.js';
import {
  buildCli,
  commanderErrorToResult,
  applyExitOverrideRecursively,
  type CliExitCode,
} from '../adapters/cli.js';

// ─── Callers ────────────────────────────────────────────────────────────────

/** Options governing CLI-call behaviour. Mostly knobs for edge cases. */
export interface CliCallOptions {
  /**
   * When set, Commander errors that escape our action callback are funneled
   * through `commanderErrorToResult` and the parsed result is returned
   * instead of re-thrown. Required for malformed-args tests that want to
   * assert on the CLI's INVALID_INPUT contract for Commander-thrown cases
   * (unknown subcommand, missing mandatory option, etc.).
   */
  readonly captureCommanderErrors?: boolean;
}

/** Return shape from {@link callCli}.
 *
 * Post-PR-B (W2 / #1368): `result` is the carrier-bound envelope
 * (`Envelope<unknown> | ErrorEnvelope`) because `emitResult` now routes
 * `--json` through `toCliResult(toEnvelope(...))`. The shape exposes the
 * same `success` / `error.code` / `data` access paths as the pre-envelope
 * `ToolResult`, so existing assertions on those fields continue to work
 * without code-changes; what changes is the deep-equal envelope shape
 * (extra `next_actions`, always-present `_meta` / `_perf`).
 */
export interface CliCallResult {
  readonly result: Envelope<unknown> | ErrorEnvelope;
  readonly exitCode: number;
}

/**
 * Invoke a CLI action via Commander in-process. Captures the single JSON
 * line emitted by `--json` mode, parses it, and returns the ToolResult.
 *
 * `flags` may contain any mix of primitives and objects; objects are
 * JSON-stringified and booleans become their `--flag` / `--no-flag`
 * Commander counterparts. Keys are camelCase and converted to kebab-case.
 *
 * When `options.captureCommanderErrors` is true, a Commander-thrown error
 * (e.g. missing mandatory option) is mapped through
 * `commanderErrorToResult` — the same mapping the production binary uses.
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
      // Restore process.exitCode before bubbling — the CLI parseAsync()
      // may have set it to a non-zero value during validation, and leaking
      // that into subsequent tests corrupts their exit-code assertions.
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
    // Post-PR-B (#1368): the adapter emits a pretty-printed JSON envelope
    // (`toCliResult(toEnvelope(...), 'json')` → `JSON.stringify(env, null, 2)`),
    // which spans multiple lines. The pre-envelope harness sliced by the
    // first newline to grab a single-line JSON document; that breaks under
    // pretty output (first newline lands immediately after the opening `{`).
    // Parse from the first `{` to end-of-stdout instead — `JSON.parse`
    // tolerates trailing whitespace and stops at the matching brace.
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
    // PR-B (#1368): wrap the legacy ToolResult into an envelope so the
    // commander-error branch matches the success/stdout branch's return
    // shape (both arms of the harness now surface envelopes).
    const { result, exitCode: mappedExit } = commanderErrorToResult(commanderError);
    return { result: toEnvelope(result), exitCode: mappedExit };
  }

  throw new Error(
    `CLI emitted no stdout for ${toolAlias} ${actionFlag} ${JSON.stringify(flags)} — exit code ${exitCode}`,
  );
}

/**
 * Invoke a composite tool action through the MCP dispatch entry point.
 * This is what the MCP SDK calls after arg validation; we skip the stdio
 * transport since it only affects wire formatting, not the payload.
 *
 * The `args` object must already include `action` (matching MCP's JSON-RPC
 * shape). Suites that prefer a separate `action` parameter should wrap
 * this helper themselves — the canonical shape keeps the harness honest
 * about what the MCP dispatch contract actually accepts.
 */
export async function callMcp(
  ctx: DispatchContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<Envelope<unknown> | ErrorEnvelope> {
  // PR-B (#1368): The production MCP server path runs the dispatch result
  // through `toEnvelope` before handing it to `toMcpResult` (see
  // `src/adapters/mcp.ts`). Mirror that here so the parity arm returns the
  // same carrier shape as the CLI arm. This is the inverse of the CLI
  // adapter's `toCliResult(toEnvelope(result), 'json')` route — both arms
  // surface envelopes so deep-equal comparisons are well-defined.
  const result = await dispatch(tool, args, ctx);
  return toEnvelope(result);
}

// ─── Normalization ──────────────────────────────────────────────────────────

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
  /** Placeholder to use for ISO timestamps. Default `<TS>`. */
  readonly timestampPlaceholder?: string;
  /** Placeholder to use for UUIDs. Default `<UUID>`. */
  readonly uuidPlaceholder?: string;
  /** Placeholder to use for commit SHAs. Default `<SHA>`. Set `null` to skip SHA detection. */
  readonly shaPlaceholder?: string | null;
  /** Placeholder to use for tmp paths. Default `<TMP_PATH>`. Set `null` to skip. */
  readonly tmpPathPlaceholder?: string | null;
  /** UUID regex to apply. Default `UUID_V4_RE` (strict). Pass `UUID_ANY_RE` for legacy. */
  readonly uuidRegex?: RegExp;
  /** Keys whose values should be replaced with a placeholder (keyed transform). */
  readonly timestampKeys?: ReadonlySet<string>;
  /** Keys whose values should be replaced with the UUID placeholder. */
  readonly uuidKeys?: ReadonlySet<string>;
  /**
   * Keys whose values should be replaced with a stable string placeholder
   * (e.g. `minutesSinceActivity` → `<MINUTES>`). Map key → placeholder.
   */
  readonly keyPlaceholders?: Readonly<Record<string, string>>;
  /**
   * Keys to drop entirely from object nodes (telemetry-derived fields that
   * are wholly non-deterministic).
   */
  readonly dropKeys?: ReadonlySet<string>;
  /**
   * When true, any string field whose value matches an ISO timestamp or
   * UUID regex is dropped from its parent object rather than replaced.
   * Matches the event-store harness convention; incompatible with
   * placeholder replacement.
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
 * Recursively replace wall-clock / UUID / telemetry fields with stable
 * placeholders so two independent arm invocations produce byte-equal
 * trees. Configurable via {@link NormalizeOptions}; defaults match the
 * workflow parity suite (task 014) so existing tests migrate with no
 * behavioural change.
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

// ─── Re-exports for convenience ──────────────────────────────────────────────

export { applyExitOverrideRecursively, commanderErrorToResult, type CliExitCode };

// ─── Parity Fixtures (T42, DR-5) ────────────────────────────────────────────
//
// Self-contained fixture descriptors for the parity harness. Each fixture
// describes a scenario both CLI and MCP arms must execute identically; the
// `setup` callback primes the `DispatchContext` (state + events), and the
// `act` callbacks invoke the action through each carrier. Suites import
// the fixture and feed it into the equivalent of `expect(normalize(cli))
// .toEqual(normalize(mcp))`.
//
// First fixture covers a transition-guard-failure case for DR-5: the
// structured error envelope (validTargets / expectedShape / suggestedFix)
// must be byte-equivalent across carriers. Adding more fixtures here keeps
// the carrier-equivalence contract test-driven from a single source.

export interface ParityFixture {
  /** Stable identifier so suites can reference a single fixture. */
  readonly name: string;
  /** Human-readable description for failure messages. */
  readonly description: string;
  /**
   * Prime a {@link DispatchContext} for the fixture (init workflow, append
   * fixture events, etc.). Called once per arm with fresh context.
   */
  readonly setup: (ctx: DispatchContext) => Promise<void>;
  /** CLI arm — invoked through {@link callCli}. */
  readonly cliCall: {
    readonly toolAlias: string;
    readonly action: string;
    readonly flags: Record<string, unknown>;
  };
  /** MCP arm — invoked through {@link callMcp}. */
  readonly mcpCall: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
}

/**
 * T-24 (rehydration-machinery-refactor) — delegate-phase rehydrate fixture.
 *
 * Drives a feature workflow into the `delegate` phase via two seed events
 * (`workflow.started` then `workflow.transition` to `delegate`) so that
 * `handleRehydrate` composes a non-null `phasePlaybook` (delegation skill,
 * per the L4 registry — see `workflow/playbooks.ts`). Used by
 * `workflow/parity.test.ts` to pin INV-2 — the v:3 rehydration envelope
 * (including `phasePlaybook`) must be byte-equivalent across the CLI and
 * MCP carriers. If a future change makes one carrier compose
 * `phasePlaybook` differently than the other, the parity assertion fails.
 *
 * Seed via `eventStore.append` rather than `handleInit` + `handleTransition`
 * so the fixture is independent of HSM guard state — the goal is to land
 * the document in `delegate` phase, not to exercise the transition pipeline.
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
 * Wave 4 / Task 4.4 — merge-orchestrate parity fixture (post-migration).
 *
 * Drives `exarchos_orchestrate { action: 'merge_orchestrate' }` via both
 * carriers (CLI's auto-generated `orch merge_orchestrate` and the MCP
 * dispatch entry point) on a feature stream that has NOT been primed
 * with prior merge events. The setup is intentionally empty — the
 * orchestrator opens the stream itself by emitting `merge.preflight`,
 * Phase A's `merge.requested`, and the executor's `merge.executed` in
 * order. The fixture's `cliCall` / `mcpCall` shape is the canonical
 * post-Wave-4 invocation surface.
 *
 * Note: this fixture descriptor does NOT install the DI hooks the
 * happy-path test needs (real `preflightFn` / `executeMergeFn` would
 * shell out to git). The consumer test
 * (`merge-orchestrate.parity-harness.test.ts`) wraps the fixture in a
 * `stubCompositeHandler` that provides the deterministic adapters so
 * two arms produce byte-equal output. Splitting the descriptor from the
 * stub keeps the fixture's argv shape declarative (matching the other
 * fixtures here) while letting tests handle the carrier-specific stub
 * setup imperatively.
 *
 * Verifies the Wave 4 reference migration (audit §F1.2) preserves
 * carrier equivalence: both `exarchos merge_orchestrate` surfaces must
 * project byte-identical ToolResults after the two-event split insertion.
 */
export const MERGE_ORCHESTRATE_PARITY_FIXTURE: ParityFixture = {
  name: 'merge_orchestrate_post_wave4',
  description:
    'merge_orchestrate(feature/x → main, squash) with passing preflight + completed executor — post Wave 4 two-event split. CLI and MCP carriers MUST project byte-equal ToolResults.',
  async setup(_ctx: DispatchContext) {
    // No event-store priming needed — the orchestrator opens the stream
    // itself. The test's `stubCompositeHandler` injects the deterministic
    // preflight/executor adapters that make the orchestrator's stream
    // writes reproducible across arms.
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
 * T42 / DR-5 — transition-guard-failure fixture. Drives an `ideate → plan`
 * transition WITHOUT the required `artifacts.design` field, so the HSM
 * primitive's composite guard fails. The structured error envelope
 * (validTargets / expectedShape / suggestedFix) must be byte-equivalent
 * across CLI and MCP carriers.
 */
export const TRANSITION_GUARD_FAILURE_FIXTURE: ParityFixture = {
  name: 'transition_guard_failure',
  description:
    'transition({target:"plan-review"}) without required artifacts → GUARD_FAILED with structured envelope',
  async setup(ctx: DispatchContext) {
    // Lazy-import the workflow handler so this module's import cost is
    // bounded — parity-harness is loaded on every parity-test cold start.
    const { handleInit } = await import('../workflow/tools.js');
    await handleInit(
      { featureId: 'parity-guard-fail', workflowType: 'feature' },
      ctx.stateDir,
      ctx.eventStore,
    );
    // DR-4 (#1581): plan is initial. Deliberately NOT priming `artifacts.plan`
    // so the plan→plan-review guard (planArtifactExists) fails.
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
