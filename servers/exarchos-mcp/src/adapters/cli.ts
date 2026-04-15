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
import { listSchemas, resolveSchemaRef, resolveTopologyRef, resolveEmissionCatalog } from './schema-introspection.js';
import { createMcpServer } from './mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

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
    const toolCmd = program
      .command(tool.cli?.alias ?? toolName)
      .description(tool.description);

    for (const action of tool.actions) {
      const actionCmd = toolCmd
        .command(action.cli?.alias ?? action.name)
        .description(action.description);

      addFlagsFromSchema(actionCmd, action.schema, action.cli?.flags);

      actionCmd.action(async (opts: Record<string, unknown>) => {
        const { json, ...flagOpts } = opts;
        const isJson = Boolean(json);
        const format = action.cli?.format;

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
        let result: ToolResult;
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

        // ─── Emit + map to exit code ──────────────────────────────────────
        emitResult(result, isJson, format);
        process.exitCode = result.success
          ? CLI_EXIT_CODES.SUCCESS
          : CLI_EXIT_CODES.HANDLER_ERROR;
      });
    }
  }

  // ─── Schema introspection command ──────────────────────────────────────────

  program
    .command('schema [ref]')
    .description('Inspect action schemas. Without args, lists all. With "tool.action", shows JSON Schema.')
    .action(async (ref?: string) => {
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
      const result = resolveEmissionCatalog();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    });

  // ─── MCP server mode command ───────────────────────────────────────────────

  program
    .command('mcp')
    .description('Start Exarchos as an MCP server (stdio)')
    .action(async () => {
      const server = createMcpServer(ctx);
      const transport = new StdioServerTransport();
      await server.connect(transport);
    });

  // ─── Init scaffolding command ─────────────────────────────────────────────

  program
    .command('init')
    .description('Create an exarchos.config.ts scaffolding file')
    .action(async () => {
      const configPath = path.join(process.cwd(), 'exarchos.config.ts');

      if (fs.existsSync(configPath)) {
        process.stdout.write(`exarchos.config.ts already exists — not overwriting.\n`);
        return;
      }

      const template = `import { defineConfig } from '@lvlup-sw/exarchos';

export default defineConfig({
  // Define custom workflows here
  // workflows: {
  //   'my-workflow': {
  //     phases: ['start', 'implement', 'review', 'done'],
  //     initialPhase: 'start',
  //     transitions: [
  //       { from: 'start', to: 'implement', event: 'begin' },
  //       { from: 'implement', to: 'review', event: 'submit' },
  //       { from: 'review', to: 'done', event: 'approve' },
  //       { from: 'review', to: 'implement', event: 'request-changes' },
  //     ],
  //   },
  // },
});
`;

      fs.writeFileSync(configPath, template);
      process.stdout.write(`Created exarchos.config.ts\n`);
      process.stdout.write(`\nGetting started:\n`);
      process.stdout.write(`  1. Uncomment and customize the workflow definition\n`);
      process.stdout.write(`  2. Run \`exarchos wf init -f my-feature -t feature\` to start a workflow\n`);
      process.stdout.write(`  3. Run \`exarchos vw ls\` to see active workflows\n`);
    });

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
