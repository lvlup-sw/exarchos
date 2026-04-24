import { Command, CommanderError } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFullRegistry } from '../registry.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  addFlagsFromSchema,
  coerceFlags,
  validateRequiredBooleans,
  toKebab,
  formatValidationError,
  buildInvalidInput,
  VALIDATION_ERROR_CODE,
} from './schema-to-flags.js';
import { prettyPrint, printError } from './cli-format.js';
// NOTE: `./schema-introspection.js` is intentionally NOT imported at the top
// level. It pulls `zod-to-json-schema`, the state-machine topology serializer,
// and the playbook renderer — several MB of transitive graph that CLI
// cold-start for `wf status` etc. never needs. We lazy-import inside the
// `schema`, `topology`, and `emissions` sub-commands below.
// NOTE: `./mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js` are
// intentionally NOT imported at module top-level. They are dynamically imported
// inside the `mcp` sub-command action below so that cold-start for CLI mode
// (e.g. `exarchos wf status`) does not pay the cost of loading the full MCP
// SDK + tool-registration graph. See DR-5 / task 021 cold-start benchmark.

// ─── Exit-Code Contract (DR-3: CLI/MCP Parity) ──────────────────────────────

/**
 * Canonical exit-code mapping for the CLI adapter. Downstream parity tests
 * (tasks 014-017) import this table directly to assert that CLI exit codes
 * align with the MCP ToolResult success/error discriminator.
 *
 * - SUCCESS (0): ToolResult.success === true.
 * - INVALID_INPUT (1): Zod validation or required-flag check failed at the
 *   CLI layer, before dispatch was invoked.
 * - HANDLER_ERROR (2): dispatch returned ToolResult.success === false.
 * - UNCAUGHT_EXCEPTION (3): dispatch threw; error was normalized into a
 *   ToolResult shape for output parity.
 */
export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_INPUT: 1,
  HANDLER_ERROR: 2,
  UNCAUGHT_EXCEPTION: 3,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

// ─── Error-Shape Helpers ────────────────────────────────────────────────────

/**
 * Emit a ToolResult using the adapter's output convention:
 * - `--json`: raw single-line JSON to stdout (no pretty-printing, no wrapping).
 * - otherwise: prettyPrint (handles errors via printError).
 */
function emitResult(result: ToolResult, json: boolean, format?: 'table' | 'json' | 'tree'): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    prettyPrint(result, format);
  }
}

// Note: Zod-error formatting lives in schema-to-flags.ts
// (`formatValidationError`) so the CLI and MCP adapters share a single
// source of truth for validation-error payloads (DR-5).

// ─── Long-running Progress Discipline (DR-5) ────────────────────────────────

/**
 * Interval between `[heartbeat]` stderr lines for long-running actions.
 * Chosen to be short enough that a caller notices progress before they
 * suspect the process hung (~5s is the typical human threshold), but long
 * enough that fast actions never emit a heartbeat at all.
 */
const HEARTBEAT_INTERVAL_MS = 2000;

/**
 * Emits a `[heartbeat]` prefix line to stderr every `HEARTBEAT_INTERVAL_MS`.
 *
 * Contract (stable):
 *   - The literal prefix `[heartbeat] ` MAY be pattern-matched by consumers
 *     (hooks, CI log scrapers, parent processes) to detect a "process is
 *     alive" signal.
 *   - The suffix (action name, elapsed seconds, wording) is UNSTABLE and
 *     may change between minor releases — do not parse it.
 *   - Heartbeats go to stderr; `--json` stdout remains a single ToolResult
 *     line so machine consumers can still do one-shot JSON.parse.
 *   - Only invoked for actions that are (a) flagged `longRunning` in the
 *     registry AND (b) running under `--json`. Interactive pretty-print
 *     mode is left alone — a progress spinner belongs to a future UX layer.
 *
 * Returns a disposer that clears the interval; callers must invoke it on
 * every exit path (success, handler error, thrown exception).
 */
function startHeartbeat(actionName: string): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    process.stderr.write(
      `[heartbeat] ${actionName} still running... ${elapsedSec}s elapsed\n`,
    );
  }, HEARTBEAT_INTERVAL_MS);
  // Don't let the heartbeat keep the event loop alive after dispatch returns.
  timer.unref?.();
  return () => clearInterval(timer);
}

// ─── CLI Command Tree Generator ─────────────────────────────────────────────

/**
 * Builds a Commander program from the TOOL_REGISTRY.
 *
 * Each composite tool becomes a top-level command (with `exarchos_` prefix stripped),
 * and each action becomes a subcommand with flags auto-generated from Zod schemas.
 *
 * Also registers the `schema` introspection command and `mcp` server mode.
 */
export function buildCli(ctx: DispatchContext): Command {
  const program = new Command('exarchos')
    .description('Agent governance for AI coding — event-sourced SDLC workflows')
    .version('2.4.0');

  // ─── Auto-generated tool commands ──────────────────────────────────────────

  for (const tool of getFullRegistry()) {
    const toolName = tool.name.replace(/^exarchos_/, '');
    const cliName = tool.cli?.alias ?? toolName;
    const toolCmd = program
      .command(cliName)
      .description(tool.description);

    // Register the full tool name as an alias when the CLI uses a short alias
    // (e.g. `wf` → add `workflow` as alias). This keeps both forms working so
    // `{{CALL exarchos_workflow ...}}` renders to `Bash(exarchos workflow ...)`
    // without needing the renderer to know about CLI aliases.
    if (cliName !== toolName) {
      toolCmd.alias(toolName);
    }

    for (const action of tool.actions) {
      const actionCmd = toolCmd
        .command(action.cli?.alias ?? action.name)
        .description(action.description);

      addFlagsFromSchema(actionCmd, action.schema, action.cli?.flags);

      // T042 / DR-9: the `exarchos event query` action gains a streaming
      // `--follow` mode that emits NDJSON frames via the dedicated
      // `runEventQueryFollow` handler instead of the one-shot dispatch path.
      // The flag is intentionally registered outside `addFlagsFromSchema` so
      // the MCP tool schema (which only describes one-shot query args) is
      // not affected.
      const isEventQuery =
        tool.name === 'exarchos_event' && action.name === 'query';
      if (isEventQuery) {
        actionCmd.option('--follow', 'Stream events as NDJSON frames until the source closes');
      }

      actionCmd.action(async (opts: Record<string, unknown>) => {
        const { json, follow, ...flagOpts } = opts;
        const isJson = Boolean(json);
        const format = action.cli?.format;

        // ─── T042: `--follow` streaming branch ─────────────────────────────
        if (isEventQuery && follow === true) {
          const streamFlag = typeof flagOpts.stream === 'string' ? flagOpts.stream : undefined;
          if (!streamFlag) {
            const err = buildInvalidInput(
              `${tool.name}/${action.name}: required option(s) not specified: stream`,
            );
            emitResult({ success: false, error: err }, isJson, format);
            process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
            return;
          }
          try {
            const { runEventQueryFollow, pollingEventSource } = await import(
              '../cli-commands/event-query.js'
            );
            const source = pollingEventSource({
              store: ctx.eventStore,
              streamId: streamFlag,
            });
            await runEventQueryFollow({ source, sink: process.stdout });
            process.exitCode = CLI_EXIT_CODES.SUCCESS;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emitResult(
              { success: false, error: { code: 'UNCAUGHT_EXCEPTION', message } },
              isJson,
              format,
            );
            process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
          }
          return;
        }

        // ─── INVALID_INPUT (exit 1): required-flag check ──────────────────
        // Commander can't enforce --flag vs --no-flag for required booleans.
        const missingBools = validateRequiredBooleans(flagOpts, action.schema);
        if (missingBools.length > 0) {
          const err = buildInvalidInput(
            `${tool.name}/${action.name}: required option(s) not specified: ${missingBools.join(', ')}`,
          );
          const errResult: ToolResult = { success: false, error: err };
          emitResult(errResult, isJson, format);
          process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
          return;
        }

        // ─── INVALID_INPUT (exit 1): Zod validation at CLI layer ──────────
        // Parse coerced args through the action schema so bad inputs are
        // surfaced before dispatch runs. DR-5: this funnels through the
        // shared `formatValidationError` so the MCP adapter emits the same
        // error.code and an equivalent error.message for the same input.
        const coerced = coerceFlags(flagOpts, action.schema);
        const parseResult = action.schema.safeParse(coerced);
        if (!parseResult.success) {
          const context = `${tool.name}/${action.name}`;
          const err = formatValidationError(parseResult.error, context);
          const errResult: ToolResult = { success: false, error: err };
          emitResult(errResult, isJson, format);
          process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
          return;
        }

        // ─── Dispatch ─────────────────────────────────────────────────────
        // Dispatch may return a handler-reported error (exit 2) or throw
        // an unexpected exception (exit 3). Normalize both into ToolResult.
        //
        // DR-5: for actions flagged `longRunning` in the registry, emit
        // stderr heartbeats under --json so a multi-second silence doesn't
        // look like a hung process.  Interactive pretty-print mode stays
        // untouched — a progress spinner belongs to a future UX layer.
        const heartbeatEnabled = isJson && action.longRunning === true;
        const stopHeartbeat = heartbeatEnabled
          ? startHeartbeat(action.name)
          : null;
        let result: ToolResult;
        try {
          try {
            result = await dispatch(
              tool.name,
              { action: action.name, ...parseResult.data },
              ctx,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // F-024 dead-code: inlined single-use ToolResult shape — was
            // previously a `toErrorResult(code, message)` helper used only
            // from this branch.
            const errResult: ToolResult = {
              success: false,
              error: { code: 'UNCAUGHT_EXCEPTION', message },
            };
            emitResult(errResult, isJson, format);
            process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
            return;
          }
        } finally {
          // F-023-1: cleanup runs on success, handler-reported errors, AND
          // uncaught exceptions — a single site so future edits can't leak
          // timers.
          stopHeartbeat?.();
        }

        // ─── Emit + map to exit code ──────────────────────────────────────
        // Preserve INVALID_INPUT when the handler reports a validation
        // failure — collapsing every non-success into HANDLER_ERROR loses
        // parity with the pre-dispatch INVALID_INPUT path (e.g. a bad arg
        // that slips past Zod at the CLI layer but is caught by a handler
        // guard should still report exit 1, not exit 2).
        emitResult(result, isJson, format);
        if (result.success) {
          process.exitCode = CLI_EXIT_CODES.SUCCESS;
        } else if (result.error?.code === VALIDATION_ERROR_CODE) {
          process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        } else {
          process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
        }
      });
    }
  }

  // ─── Top-level `exarchos doctor` command ─────────────────────────────────
  //
  // Doctor is promoted to a top-level verb so an operator types
  // `exarchos doctor` instead of `exarchos orch doctor` — it is a
  // diagnostic front door, not a mid-workflow orchestration action.
  // Under the hood it still dispatches through exarchos_orchestrate so
  // the CLI and MCP paths share one handler + one validation gate.
  //
  // Exit-code mapping (DR-3 contract):
  //   - Any Fail in the summary → HANDLER_ERROR (exit 2)
  //   - Warnings-only           → SUCCESS (exit 0) — warnings are advisory
  //   - Dispatch failure        → HANDLER_ERROR (exit 2)
  //   - Uncaught throw          → UNCAUGHT_EXCEPTION (exit 3)
  const orchestrateTool = getFullRegistry().find((t) => t.name === 'exarchos_orchestrate');
  const doctorAction = orchestrateTool?.actions.find((a) => a.name === 'doctor');
  if (doctorAction) {
    const doctorCmd = program
      .command('doctor')
      .description(doctorAction.description);
    addFlagsFromSchema(doctorCmd, doctorAction.schema, doctorAction.cli?.flags);

    doctorCmd.action(async (opts: Record<string, unknown>) => {
      const { json, ...flagOpts } = opts;
      const isJson = Boolean(json);
      const defaultFormat = doctorAction.cli?.format;

      // Parse coerced args through the schema so bad inputs surface as
      // INVALID_INPUT before dispatch runs.
      const coerced = coerceFlags(flagOpts, doctorAction.schema);
      const parsed = doctorAction.schema.safeParse(coerced);
      if (!parsed.success) {
        const err = formatValidationError(parsed.error, 'exarchos_orchestrate/doctor');
        emitResult({ success: false, error: err }, isJson, defaultFormat);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }

      const format =
        (parsed.data as { format?: 'table' | 'json' }).format ?? defaultFormat;

      let result: ToolResult;
      try {
        result = await dispatch(
          'exarchos_orchestrate',
          { action: 'doctor', ...parsed.data },
          ctx,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errResult: ToolResult = {
          success: false,
          error: { code: 'UNCAUGHT_EXCEPTION', message },
        };
        emitResult(errResult, isJson, format);
        process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
        return;
      }

      emitResult(result, isJson, format);

      // Doctor-specific exit mapping: any Fail in the summary is a
      // handler error; warnings alone are non-fatal.
      if (!result.success) {
        process.exitCode = result.error?.code === VALIDATION_ERROR_CODE
          ? CLI_EXIT_CODES.INVALID_INPUT
          : CLI_EXIT_CODES.HANDLER_ERROR;
        return;
      }
      const data = result.data as { summary?: { failed?: number } } | undefined;
      const failed = data?.summary?.failed ?? 0;
      process.exitCode = failed > 0
        ? CLI_EXIT_CODES.HANDLER_ERROR
        : CLI_EXIT_CODES.SUCCESS;
    });
  }

  // ─── Top-level `exarchos version` command ──────────────────────────────
  //
  // Standalone diagnostic that compares the running binary version
  // against the plugin root's declared `metadata.compat.minBinaryVersion`
  // (task 2.3). Shares the same `checkPluginRootCompatibility()` library
  // as the session-start wiring, so there is exactly one source of truth
  // for the compat policy.
  //
  // The subcommand is intentionally thin: it dispatches to
  // `handleVersionCheck`, which already prints and returns an exit code.
  // We assign the return value to `process.exitCode` to preserve the
  // DR-3 exit-code contract (0 = ok, 1 = drift detected).
  //
  // NOTE: Commander's top-level `.version('2.4.0')` above registers
  // `--version` as a flag on the root program; this `version` subcommand
  // is distinct because it takes the `--check-plugin-root <path>` option.
  program
    .command('version')
    .description('Print version and (optionally) verify plugin-root compatibility')
    .option('--check-plugin-root <path>', 'Check plugin.json minBinaryVersion against the running binary')
    .action(async (opts: { checkPluginRoot?: string }) => {
      if (!opts.checkPluginRoot) {
        // Plain `exarchos version` — print the version string and exit.
        process.stdout.write('2.4.0\n');
        process.exitCode = CLI_EXIT_CODES.SUCCESS;
        return;
      }

      const { handleVersionCheck } = await import('../cli-commands/version.js');
      const exitCode = await handleVersionCheck({
        pluginRoot: opts.checkPluginRoot,
        binaryVersion: '2.4.0',
      });
      process.exitCode = exitCode;
    });

  // ─── Schema introspection command ──────────────────────────────────────────

  program
    .command('schema [ref]')
    .description('Inspect action schemas. Without args, lists all. With "tool.action", shows JSON Schema.')
    .action(async (ref?: string) => {
      const { listSchemas, resolveSchemaRef } = await import('./schema-introspection.js');
      if (!ref) {
        const schemas = listSchemas();
        for (const tool of schemas) {
          process.stdout.write(`\n${tool.tool}:\n`);
          for (const action of tool.actions) {
            process.stdout.write(`  ${action.name} — ${action.description}\n`);
          }
        }
      } else {
        try {
          const schema = resolveSchemaRef(ref);
          process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
        } catch (err) {
          printError({
            code: 'INVALID_SCHEMA_REF',
            message: err instanceof Error ? err.message : String(err),
          });
          process.exitCode = 1;
        }
      }
    });

  // ─── Topology introspection command ──────────────────────────────────────────

  program
    .command('topology [type]')
    .description('Show HSM topology. Without type, lists all workflow types.')
    .action(async (type?: string) => {
      try {
        const { resolveTopologyRef } = await import('./schema-introspection.js');
        const result = resolveTopologyRef(type || undefined);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } catch (err) {
        printError({
          code: 'INVALID_TOPOLOGY_REF',
          message: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
      }
    });

  // ─── Emissions catalog command ──────────────────────────────────────────────

  program
    .command('emissions')
    .description('Show event emission catalog grouped by source.')
    .action(async () => {
      const { resolveEmissionCatalog } = await import('./schema-introspection.js');
      const result = resolveEmissionCatalog();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    });

  // ─── MCP server mode command ───────────────────────────────────────────────

  program
    .command('mcp')
    .description('Start Exarchos as an MCP server (stdio)')
    .action(async () => {
      // Dynamic imports: MCP SDK + registration graph are only needed when the
      // user actually invokes `exarchos mcp`. Keeps cold-start for `wf status`
      // and other CLI subcommands under the DR-5 latency budget.
      const [{ createMcpServer }, { StdioServerTransport }] = await Promise.all([
        import('./mcp.js'),
        import('@modelcontextprotocol/sdk/server/stdio.js'),
      ]);
      const server = createMcpServer(ctx);
      const transport = new StdioServerTransport();
      await server.connect(transport);
    });

  // ─── Top-level `exarchos init` command ──────────────────────────────────
  //
  // Init is promoted to a top-level verb (like doctor) so an operator
  // types `exarchos init` instead of `exarchos orch init` — it is a
  // first-run configuration command, not a mid-workflow action.
  // Under the hood it dispatches through exarchos_orchestrate so the
  // CLI and MCP paths share one handler + one validation gate.
  //
  // Exit-code mapping (DR-3 contract):
  //   - All writes succeeded    → SUCCESS (exit 0)
  //   - Any write failed        → HANDLER_ERROR (exit 2)
  //   - Dispatch failure        → HANDLER_ERROR (exit 2)
  //   - Uncaught throw          → UNCAUGHT_EXCEPTION (exit 3)
  const initAction = orchestrateTool?.actions.find((a) => a.name === 'init');
  if (initAction) {
    const initCmd = program
      .command('init')
      .description(initAction.description);
    addFlagsFromSchema(initCmd, initAction.schema, initAction.cli?.flags);

    initCmd.action(async (opts: Record<string, unknown>) => {
      const { json, ...flagOpts } = opts;
      const isJson = Boolean(json);
      const defaultFormat = initAction.cli?.format;

      // Parse coerced args through the schema so bad inputs surface as
      // INVALID_INPUT before dispatch runs.
      const coerced = coerceFlags(flagOpts, initAction.schema);
      const parsed = initAction.schema.safeParse(coerced);
      if (!parsed.success) {
        const err = formatValidationError(parsed.error, 'exarchos_orchestrate/init');
        emitResult({ success: false, error: err }, isJson, defaultFormat);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }

      const format =
        (parsed.data as { format?: 'table' | 'json' }).format ?? defaultFormat;

      let result: ToolResult;
      try {
        result = await dispatch(
          'exarchos_orchestrate',
          { action: 'init', ...parsed.data },
          ctx,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errResult: ToolResult = {
          success: false,
          error: { code: 'UNCAUGHT_EXCEPTION', message },
        };
        emitResult(errResult, isJson, format);
        process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
        return;
      }

      emitResult(result, isJson, format);

      // Init-specific exit mapping: any failed writer in the runtimes
      // array is a handler error.
      if (!result.success) {
        process.exitCode = result.error?.code === VALIDATION_ERROR_CODE
          ? CLI_EXIT_CODES.INVALID_INPUT
          : CLI_EXIT_CODES.HANDLER_ERROR;
        return;
      }
      const data = result.data as { runtimes?: Array<{ status?: string }> } | undefined;
      const hasFailed = data?.runtimes?.some((r) => r.status === 'failed') ?? false;
      process.exitCode = hasFailed
        ? CLI_EXIT_CODES.HANDLER_ERROR
        : CLI_EXIT_CODES.SUCCESS;
    });
  }

  return program;
}

// ─── Commander-Error → INVALID_INPUT (DR-5) ────────────────────────────────

/**
 * Convert a Commander parsing error (e.g. unknown subcommand, unknown
 * option) into a canonical INVALID_INPUT ToolResult. Other CommanderError
 * codes pass through with their original code prefixed — these indicate
 * conditions (e.g. `commander.helpDisplayed`, `commander.version`) that
 * are not validation failures.
 *
 * Exported so the parity-test harness and the production entry point
 * share one mapping table.
 */
export function commanderErrorToResult(err: CommanderError): {
  result: ToolResult;
  exitCode: CliExitCode;
} {
  // Success-ish Commander signals (help, version) — surface as success so
  // `exarchos --help` from a script doesn't read as a failure.
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
    return {
      result: { success: true },
      exitCode: CLI_EXIT_CODES.SUCCESS,
    };
  }

  // Validation-ish Commander signals — missing mandatory option, unknown
  // subcommand, unknown option, bad option argument, missing argument,
  // conflicting options, and the legacy `invalidOptionArgument` code
  // (emitted by older Commander paths for `<value>` type-mismatches;
  // current Commander reuses `invalidArgument`, but the older code may
  // still surface from custom Argument `argParser` throw sites and
  // downstream plugins — keeping it in the set guards future drift).
  // All become INVALID_INPUT so the CLI reports the same `error.code` as
  // the MCP dispatch path for equivalent bad input.
  const invalidCodes = new Set([
    'commander.missingMandatoryOptionValue',
    'commander.missingArgument',
    'commander.optionMissingArgument',
    'commander.invalidArgument',
    'commander.invalidOptionArgument',
    'commander.unknownCommand',
    'commander.unknownOption',
    'commander.excessArguments',
    'commander.conflictingOption',
  ]);
  if (invalidCodes.has(err.code)) {
    return {
      result: {
        success: false,
        error: { code: VALIDATION_ERROR_CODE, message: err.message },
      },
      exitCode: CLI_EXIT_CODES.INVALID_INPUT,
    };
  }

  // Anything else — treat as an uncaught exception so exit-code table (task 013)
  // remains correct.
  return {
    result: {
      success: false,
      error: { code: 'UNCAUGHT_EXCEPTION', message: err.message },
    },
    exitCode: CLI_EXIT_CODES.UNCAUGHT_EXCEPTION,
  };
}

/**
 * Apply `exitOverride()` to a Commander command and every nested
 * subcommand so malformed input surfaces as a thrown `CommanderError`
 * instead of a silent `process.exit()`.
 *
 * F-024 #3: earlier code iterated exactly 3 levels (program, sub, action)
 * because the current tool tree maxes out there. The recursive form is
 * DRY across production and test harnesses and is safe for arbitrary
 * future depth (custom tools, sub-subcommands).
 *
 * Exported so parity test harnesses share one source of truth with
 * `runCli` and don't redrift to the old hand-rolled pattern.
 */
export function applyExitOverrideRecursively(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) {
    applyExitOverrideRecursively(sub);
  }
}

/**
 * Parse-and-run entry point used by the production binary. Installs
 * `exitOverride` on the program so Commander errors surface as
 * exceptions, then converts them through {@link commanderErrorToResult}
 * so malformed CLI input produces the same INVALID_INPUT contract that
 * the MCP dispatch path emits for equivalent malformed args.
 */
export async function runCli(program: Command, argv: readonly string[]): Promise<void> {
  // Install exitOverride recursively so Commander doesn't call process.exit.
  applyExitOverrideRecursively(program);

  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    if (err instanceof CommanderError) {
      const { result, exitCode } = commanderErrorToResult(err);
      // Detect --json in argv so we emit the raw JSON line (matches the
      // adapter's normal output convention for programmatic callers).
      const isJson = argv.includes('--json');
      if (result.success && exitCode === CLI_EXIT_CODES.SUCCESS) {
        // Help/version already wrote to stdout via Commander; nothing else to emit.
        process.exitCode = exitCode;
        return;
      }
      if (isJson) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else if (!result.success && result.error) {
        printError(result.error);
      }
      process.exitCode = exitCode;
      return;
    }
    throw err;
  }
}
