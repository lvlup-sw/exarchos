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

import type { DispatchContext } from '../core/dispatch.js';
import { dispatch } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
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

/** Return shape from {@link callCli}. */
export interface CliCallResult {
  readonly result: ToolResult;
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
    // Adapter writes exactly one JSON line for `--json` mode; extract the
    // first complete object so any preceding noise (should be none) doesn't
    // derail the parse.
    const firstBrace = stdoutText.indexOf('{');
    if (firstBrace < 0) {
      throw new Error(
        `CLI produced non-JSON stdout for ${toolAlias} ${actionFlag}: ${stdoutText}`,
      );
    }
    const newlineIdx = stdoutText.indexOf('\n', firstBrace);
    const jsonText = newlineIdx > 0 ? stdoutText.slice(firstBrace, newlineIdx) : stdoutText.slice(firstBrace);
    const parsed = JSON.parse(jsonText) as ToolResult;
    return { result: parsed, exitCode };
  }

  if (commanderError) {
    const { result, exitCode: mappedExit } = commanderErrorToResult(commanderError);
    return { result, exitCode: mappedExit };
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
): Promise<ToolResult> {
  return dispatch(tool, args, ctx);
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
