/**
 * CLI adapter. It builds the Commander command tree from the composite-tool registry and runs it.
 * The adapter does not import the runtime `dispatch`. Every action call goes through `invokeContractAction` with a contract ActionId.
 * The generated client rejects an id that the compiled contract does not hold, so the CLI and MCP run the same action.
 * The Commander tree holds only presentation: groups, command names, and flags.
 *
 * `./schema-introspection.js`, `../mcp/mcp.js` and `../../contract/sdk/seam.js` load only inside their sub-commands.
 * They pull several MB of modules, and the cold start of a CLI command such as `wf status` does not need them.
 */
import { Command, CommanderError } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFullRegistry } from '../../registry.js';
import type { CompositeTool, ToolAction } from '../../registry.js';
import { invokeContractAction } from '../../contract/cli/generated-client.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../../dispatch/caller-identity.js';
import type { ToolResult } from '../../format.js';
import { toEnvelope } from '../../format.js';
import { exitCodeForResult } from '../../contract/error-families.js';
import {
  addFlagsFromSchema,
  coerceFlags,
  validateRequiredBooleans,
  toKebab,
  formatValidationError,
  buildInvalidInput,
  VALIDATION_ERROR_CODE,
} from './schema-to-flags.js';
import { TIER1_HARNESSES } from '../../runtime/launcher/harness-registry.js';
import { runLauncherVerb, renderDryRunPlan, isDryRunPlan } from '../../runtime/launcher/verb.js';
import {
  makeLauncherLifecycleDeps,
  recoverBeforeLaunch,
  type LauncherWiringOverrides,
} from '../../runtime/launcher/production-deps.js';
import type { FollowSubcommand } from '../../cli/follow-formatter.js';
import { prettyPrint, printError, toCliResult } from './cli-format.js';

/**
 * Contract ActionIds of the hand-written top-level verbs.
 * Each `program.command(...)` callback below passes its literal id to `invokeContractAction`.
 * Every other action command derives its id in `registerActionCommand` as `<tool>.<action>`.
 * A conformance test checks each id against `deriveCliSurface(compileForCli())`, so a renamed action fails the build.
 * The table shrinks when a verb moves to a registry `cli.topLevel` hint, as `merge_orchestrate` did.
 *
 * `cli-derivation-guard.test.ts` needs at least one comment line with the call form `.command(`. Each such line must start with `*` or `//` and hold the call form once.
 */
export const CLI_PROMOTED_ACTION_IDS = Object.freeze({
  doctor: 'exarchos_orchestrate.doctor',
  feedback: 'exarchos_workflow.feedback',
  onboard: 'exarchos_orchestrate.onboard',
} as const);

/**
 * Exit codes of the CLI adapter. Parity tests import this table.
 * - SUCCESS (0): `ToolResult.success` is true.
 * - INVALID_INPUT (1): Zod validation or a required-flag check failed in the CLI, before dispatch.
 * - HANDLER_ERROR (2): dispatch returned `success: false`.
 * - UNCAUGHT_EXCEPTION (3): dispatch threw, and the CLI wrapped the error in a `ToolResult`.
 */
export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_INPUT: 1,
  HANDLER_ERROR: 2,
  UNCAUGHT_EXCEPTION: 3,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

/** Build the trusted CLI context from the configured local installation. */
export function createCliDispatchContext(ctx: DispatchContext): DispatchContext {
  return {
    ...ctx,
    callerIdentity: deriveLocalOperatorIdentity(ctx.stateDir),
  };
}

/**
 * Presentation table from `wait` error codes to exit codes. A shell caller can branch on the exit code alone.
 * - `WAIT_TIMEOUT` (17): the bounded `wait` expired before its predicate held.
 * - `WAIT_FAILED` (18): a terminal state that cannot satisfy the predicate arrived first.
 * The codes come from `projections/views/lifecycle/wait.ts`. They are above the generic band 0-3, so they never alias it.
 * {@link resolveExitCode} does not read this table. A test checks it against `CONTRACT_EXIT_CODES` in `contract/error-families.ts`.
 */
export const ERROR_CODE_EXIT_CODES: Readonly<Record<string, number>> = {
  WAIT_TIMEOUT: 17,
  WAIT_FAILED: 18,
};

/**
 * Maps a dispatched {@link ToolResult} to its exit code. It delegates to {@link exitCodeForResult}, the one contract authority.
 * Thus the CLI and the MCP wire use the same function.
 * `success: false` never exits 0, also without an `error`, because `ToolResult` permits an error-less failure.
 * Named codes: INVALID_INPUT 1, the wait codes 17 and 18, PRESENTER_ERROR 3, and HANDLER_ERROR 2 for an unregistered code.
 */
export function resolveExitCode(result: ToolResult): number {
  return exitCodeForResult(result);
}

/**
 * Writes a ToolResult. With `--json` or `--format json`, stdout carries the envelope from `toCliResult(toEnvelope(...))`.
 * That envelope is the MCP `structuredContent` except for timestamps. Otherwise `prettyPrint` writes the result.
 */
function emitResult(result: ToolResult, json: boolean, format?: 'table' | 'json' | 'tree'): void {
  if (json || format === 'json') {
    toCliResult(toEnvelope(result), 'json');
    return;
  }
  prettyPrint(result, format);
}

/**
 * Interval between `[heartbeat]` stderr lines for long-running actions.
 * It is shorter than about 5 seconds, the time after which a person suspects a hang. Fast actions finish before the first heartbeat.
 */
const HEARTBEAT_INTERVAL_MS = 2000;

/**
 * Writes a `[heartbeat] ` line to stderr every {@link HEARTBEAT_INTERVAL_MS}. Consumers can match that prefix as a liveness signal.
 * The rest of the line is unstable, so consumers must not parse it.
 * Heartbeats go to stderr, so `--json` stdout stays one ToolResult line.
 *
 * It returns a disposer. Callers must call it on every exit path.
 */
function startHeartbeat(actionName: string): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    process.stderr.write(
      `[heartbeat] ${actionName} still running... ${elapsedSec}s elapsed\n`,
    );
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Build-time injected version. `tools/release/build-binary.ts` passes
 * `--define EXARCHOS_BUILD_VERSION="<version>"` to `bun build --compile`
 * so the compiled binary advertises the right version even though the
 * bundle has no on-disk `package.json` to walk up to. Stays `undefined`
 * for `bun run` / `node` invocations, which fall through to the runtime
 * `package.json` walk below.
 */
declare const EXARCHOS_BUILD_VERSION: string | undefined;

/**
 * Resolves the version of the running binary, in this order:
 *   1. The build-time `EXARCHOS_BUILD_VERSION` constant. It is the source for the compiled binary.
 *   2. The `version` field of the nearest `package.json` at or above this module.
 *   3. `'unknown'`.
 * `--version` and the `version` subcommand both use it, so they always agree.
 */
export function resolvePackageVersion(): string {
  if (
    typeof EXARCHOS_BUILD_VERSION === 'string' &&
    EXARCHOS_BUILD_VERSION.length > 0
  ) {
    return EXARCHOS_BUILD_VERSION;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          version?: unknown;
        };
        if (typeof parsed.version === 'string') return parsed.version;
        break;
      }
      const parent = path.resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return 'unknown';
}

/**
 * `exarchos_view` actions with a CLI `--follow` mode. The set controls the option and the `FollowSubcommand` label.
 * Each member must be a pure `ViewProjection` fold: no `eventStore.append`, no `emit`, no `*.polled` events.
 * Thus repeated polls from `--follow` or MCP `tasks/get` do not change the timeline that they observe.
 * `tests/unit/cli/cli-follow-expansion.test.ts` scans the handler sources for writes.
 * The set must match the `FollowSubcommand` union in `cli/follow-formatter.ts` exactly.
 */
export const VIEW_FOLLOW_ACTIONS: ReadonlySet<string> = new Set([
  'workflow_status',
  'shepherd_status',
  'pipeline',
  'convergence',
  'delegation_timeline',
]);

/**
 * Options for {@link buildCli}. Production callers pass none.
 * Tests use {@link BuildCliOptions.launcher} to inject OS-effect fakes, so a real launch runs deterministically through the production wiring.
 */
export interface BuildCliOptions {
  /** OS-effect / advanced overrides threaded into the `exarchos <harness>` launcher wiring. */
  readonly launcher?: LauncherWiringOverrides;
  /**
   * Test seam: the registry for the generated command tree and the top-level hoist loop. The default is {@link getFullRegistry}.
   * Tests stamp `cli.topLevel` on a real action to test the hoist and its collision check.
   */
  readonly registry?: readonly CompositeTool[];
}

/**
 * Builds the Commander program. Each composite tool is a command group without the `exarchos_` prefix.
 * Each action is a subcommand with flags from its Zod schema. A tool with a short alias also accepts its full name.
 *
 * The hand-written verbs `doctor`, `feedback` and `onboard` dispatch the same registry action as their subcommand form.
 * `doctor` exits 2 when its summary has a failed check. Warnings alone exit 0.
 * `onboard` adds `surface: 'cli'`, because the CLI runs the full install step.
 *
 * `init` and `install-skills` are rename stubs. They accept any arguments, print the new name `onboard`, and exit 2.
 * Each Tier-1 harness gets a launcher verb. A real launch first recovers crashed launches. `--dry-run` changes nothing.
 *
 * The `cli.topLevel` hoist runs last, so its collision check sees every top-level name and alias. A collision throws.
 */
export function buildCli(ctx: DispatchContext, options?: BuildCliOptions): Command {
  ctx = createCliDispatchContext(ctx);
  const packageVersion = resolvePackageVersion();
  const program = new Command('exarchos')
    .description('Agent governance for AI coding — event-sourced SDLC workflows')
    .version(packageVersion);

  const cliRegistry = options?.registry ?? getFullRegistry();

  for (const tool of cliRegistry) {
    const toolName = tool.name.replace(/^exarchos_/, '');
    const cliName = tool.cli?.alias ?? toolName;
    const toolCmd = program
      .command(cliName)
      .description(tool.description);

    if (cliName !== toolName) {
      toolCmd.alias(toolName);
    }

    for (const action of tool.actions) {
      registerActionCommand(
        toolCmd,
        tool,
        action,
        action.cli?.alias ?? action.name,
        ctx,
      );
    }
  }

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
        result = await invokeContractAction(CLI_PROMOTED_ACTION_IDS.doctor, parsed.data, ctx);
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

  program
    .command('version')
    .description('Print version and (optionally) verify plugin-root compatibility')
    .option('--check-plugin-root <path>', 'Check plugin.json minBinaryVersion against the running binary')
    .action(async (opts: { checkPluginRoot?: string }) => {
      if (!opts.checkPluginRoot) {
        process.stdout.write(`${packageVersion}\n`);
        process.exitCode = CLI_EXIT_CODES.SUCCESS;
        return;
      }

      const { handleVersionCheck } = await import('../../lifecycle/version.js');
      const exitCode = await handleVersionCheck({
        pluginRoot: opts.checkPluginRoot,
        binaryVersion: packageVersion,
      });
      process.exitCode = exitCode;
    });

  const workflowTool = getFullRegistry().find((t) => t.name === 'exarchos_workflow');
  const feedbackAction = workflowTool?.actions.find((a) => a.name === 'feedback');
  if (feedbackAction) {
    program
      .command('feedback <message>')
      .description('File an agent→runtime friction report (records feedback.recorded; optional upstream POST).')
      .option('--session-context <json>', 'Optional provenance JSON: { workflow?, action?, errorCode? }')
      .option('--json', 'Output raw JSON')
      .action(async (message: string, opts: Record<string, unknown>) => {
        const isJson = Boolean(opts.json);

        const flagOpts: Record<string, unknown> = { message };
        if (opts.sessionContext !== undefined) flagOpts.sessionContext = opts.sessionContext;
        const coerced = coerceFlags(flagOpts, feedbackAction.schema);
        const parsed = feedbackAction.schema.safeParse(coerced);
        if (!parsed.success) {
          const err = formatValidationError(parsed.error, 'exarchos_workflow/feedback');
          emitResult({ success: false, error: err }, isJson);
          process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
          return;
        }

        let result: ToolResult;
        try {
          result = await invokeContractAction(CLI_PROMOTED_ACTION_IDS.feedback, parsed.data, ctx);
        } catch (err) {
          const messageStr = err instanceof Error ? err.message : String(err);
          emitResult(
            { success: false, error: { code: 'UNCAUGHT_EXCEPTION', message: messageStr } },
            isJson,
          );
          process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
          return;
        }

        emitResult(result, isJson);
        process.exitCode = result.success
          ? CLI_EXIT_CODES.SUCCESS
          : result.error?.code === VALIDATION_ERROR_CODE
            ? CLI_EXIT_CODES.INVALID_INPUT
            : CLI_EXIT_CODES.HANDLER_ERROR;
      });
  }

  program
    .command('schema [ref]')
    .description('Inspect action schemas. Without args, lists all. With "tool.action", shows JSON Schema.')
    .action(async (ref?: string) => {
      const { listSchemas, resolveSchemaRef } = await import('./schema-introspection.js');
      if (!ref) {
        const schemas = listSchemas();
        for (const tool of schemas) {
          const marker = tool.hidden ? ' (hidden)' : '';
          process.stdout.write(`\n${tool.tool}${marker}:\n`);
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

  program
    .command('emissions')
    .description('Show event emission catalog grouped by source.')
    .action(async () => {
      const { resolveEmissionCatalog } = await import('./schema-introspection.js');
      const result = resolveEmissionCatalog();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    });

  program
    .command('mcp')
    .description('Start Exarchos as an MCP server (stdio)')
    .action(async () => {
      const [
        { createMcpServer },
        { createV2StdioServerTransport, connectV2Server },
      ] = await Promise.all([import('../mcp/mcp.js'), import('../../contract/sdk/seam.js')]);
      const server = createMcpServer(ctx);
      await connectV2Server(server, createV2StdioServerTransport());
    });

  const onboardAction = orchestrateTool?.actions.find((a) => a.name === 'onboard');
  if (onboardAction) {
    const onboardCmd = program
      .command('onboard')
      .description(onboardAction.description);
    addFlagsFromSchema(onboardCmd, onboardAction.schema, onboardAction.cli?.flags);

    onboardCmd.action(async (opts: Record<string, unknown>) => {
      const { json, ...flagOpts } = opts;
      const isJson = Boolean(json);
      const defaultFormat = onboardAction.cli?.format;

      const coerced = coerceFlags(flagOpts, onboardAction.schema);
      const parsed = onboardAction.schema.safeParse(coerced);
      if (!parsed.success) {
        const err = formatValidationError(parsed.error, 'exarchos_orchestrate/onboard');
        emitResult({ success: false, error: err }, isJson, defaultFormat);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }

      const format =
        (parsed.data as { format?: 'table' | 'json' }).format ?? defaultFormat;

      let result: ToolResult;
      try {
        result = await invokeContractAction(
          CLI_PROMOTED_ACTION_IDS.onboard,
          { surface: 'cli', ...parsed.data },
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

      process.exitCode = result.success
        ? CLI_EXIT_CODES.SUCCESS
        : result.error?.code === VALIDATION_ERROR_CODE
          ? CLI_EXIT_CODES.INVALID_INPUT
          : CLI_EXIT_CODES.HANDLER_ERROR;
    });
  }

  program
    .command('init')
    .description("[renamed] use 'exarchos onboard' — init was consolidated into the onboard verb (DR-5)")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[ignored...]', 'legacy init arguments (ignored by the rename stub)')
    .action(() => {
      process.stderr.write(
        "exarchos init: renamed → use 'exarchos onboard'\n",
      );
      process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
    });

  program
    .command('install-skills')
    .description("[renamed] use 'exarchos onboard' — install-skills was consolidated into the onboard verb (DR-5)")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[ignored...]', 'legacy install-skills arguments (ignored by the rename stub)')
    .action(() => {
      process.stderr.write(
        "exarchos install-skills: renamed → use 'exarchos onboard'\n",
      );
      process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
    });

  const launcherOverrides = options?.launcher;
  const launcherBase = launcherOverrides?.base ?? process.cwd();
  const launcherRepoRoot = launcherOverrides?.repoRoot ?? launcherBase;
  for (const harness of TIER1_HARNESSES) {
    program
      .command(harness)
      .description(
        `Launch the ${harness} harness through the Exarchos lifecycle (spawn → place → observe → teardown). Use --dry-run to preview the derived worktree path + event plan.`,
      )
      .option('--feature <id>', 'Feature id to associate with the launch worktree')
      .option(
        '--dry-run',
        'Print the derived worktree path + event plan without creating a worktree or spawning a process',
      )
      .option('--json', 'Output raw JSON')
      .action(async (opts: Record<string, unknown>) => {
        const isJson = Boolean(opts.json);
        const feature = typeof opts.feature === 'string' ? opts.feature : undefined;
        const dryRun = Boolean(opts.dryRun);

        try {
          if (!dryRun) {
            await recoverBeforeLaunch(ctx, launcherRepoRoot, launcherOverrides);
          }

          const result = await runLauncherVerb(
            { harness, feature, dryRun },
            {
              base: launcherBase,
              lifecycleDeps: makeLauncherLifecycleDeps(ctx, launcherOverrides),
            },
          );

          if (result.success && !isJson && isDryRunPlan(result.data)) {
            process.stdout.write(`${renderDryRunPlan(result.data)}\n`);
            process.exitCode = CLI_EXIT_CODES.SUCCESS;
            return;
          }

          emitResult(result, isJson);
          if (result.success) {
            process.exitCode = CLI_EXIT_CODES.SUCCESS;
          } else if (result.error?.code === VALIDATION_ERROR_CODE) {
            process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
          } else {
            process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitResult(
            { success: false, error: { code: 'UNCAUGHT_EXCEPTION', message } },
            isJson,
          );
          process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
        }
      });
  }

  for (const tool of cliRegistry) {
    for (const action of tool.actions) {
      const topLevel = action.cli?.topLevel;
      if (topLevel === undefined) continue;
      const clash = program.commands.find(
        (c) => c.name() === topLevel || c.aliases().includes(topLevel),
      );
      if (clash) {
        throw new Error(
          `buildCli: CliActionHints.topLevel '${topLevel}' on action ` +
            `'${tool.name}/${action.name}' collides with the existing top-level ` +
            `command '${clash.name()}'. Choose a non-colliding top-level name ` +
            `or drop the promotion.`,
        );
      }
      registerActionCommand(program, tool, action, topLevel, ctx);
    }
  }

  return program;
}

/**
 * Registers one action as a command under `parent`, with flags from its Zod schema. `parent` is a tool group or the root program.
 * The subcommand form and the top-level hoist both use it, so both parse the same way.
 * `invokeContractAction` checks the id `<tool>.<action>` against the compiled contract before anything runs.
 *
 * `event query --follow` streams NDJSON events, and the {@link VIEW_FOLLOW_ACTIONS} views poll a task with `--follow`.
 * These two options are outside the schema, so the MCP schema stays one-shot. The `follow` flag of `view inspect` is in its schema.
 * A follow handler does not call `process.exit`. It awaits the follow loop, so the loop finishes its cleanup first.
 * A SIGINT ends a view or inspect follow session with exit 0.
 *
 * On `wf checkpoint`, `--context`, `--next-steps` and `--suggestions` build `handoff`, and they conflict with `--handoff`.
 * Without them, `handoff` stays absent, so the digest `sha256(handoff ?? {})` does not change.
 */
function registerActionCommand(
  parent: Command,
  tool: CompositeTool,
  action: ToolAction,
  commandName: string,
  ctx: DispatchContext,
): Command {
  const actionCmd = parent
    .command(commandName)
    .description(action.description);

  const actionId = `${tool.name}.${action.name}`;

  addFlagsFromSchema(actionCmd, action.schema, action.cli?.flags);

  const isEventQuery =
    tool.name === 'exarchos_event' && action.name === 'query';
  if (isEventQuery) {
    actionCmd.option('--follow', 'Stream events as NDJSON frames until the source closes');
  }

  const isViewFollow =
    tool.name === 'exarchos_view' && VIEW_FOLLOW_ACTIONS.has(action.name);
  if (isViewFollow) {
    actionCmd.option(
      '--follow',
      'Stream task lifecycle transitions to stdout until terminal status or SIGINT',
    );
  }

  const isInspectFollow =
    tool.name === 'exarchos_view' && action.name === 'inspect';

  const isWorkflowCheckpoint =
    tool.name === 'exarchos_workflow' && action.name === 'checkpoint';
  if (isWorkflowCheckpoint) {
    actionCmd.option(
      '--context <string>',
      'Handoff context (single inline string, max 2KB). Maps to handoff.context.',
    );
    actionCmd.option(
      '--next-steps <step...>',
      'Repeatable handoff next-step entry; pass once per entry. Maps to handoff.nextSteps.',
    );
    actionCmd.option(
      '--suggestions <suggestion...>',
      'Repeatable handoff suggestion entry; pass once per entry. Maps to handoff.suggestions.',
    );
  }

  actionCmd.action(async (opts: Record<string, unknown>) => {
    const { json, follow, ...flagOpts } = opts;
    const isJson = Boolean(json);
    const format = action.cli?.format;

    if (isWorkflowCheckpoint) {
      const ctxOpt = flagOpts.context;
      const nextStepsOpt = flagOpts.nextSteps;
      const suggestionsOpt = flagOpts.suggestions;
      const hasContext = typeof ctxOpt === 'string';
      const hasNextSteps = Array.isArray(nextStepsOpt) && nextStepsOpt.length > 0;
      const hasSuggestions =
        Array.isArray(suggestionsOpt) && suggestionsOpt.length > 0;

      if (
        flagOpts.handoff !== undefined &&
        (hasContext || hasNextSteps || hasSuggestions)
      ) {
        const err = buildInvalidInput(
          `${tool.name}/${action.name}: --handoff is mutually exclusive with --context/--next-steps/--suggestions; pass either the full --handoff JSON or the convenience flags, not both`,
        );
        emitResult({ success: false, error: err }, isJson, format);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }

      if (hasContext || hasNextSteps || hasSuggestions) {
        flagOpts.handoff = {
          ...(hasContext ? { context: ctxOpt as string } : {}),
          ...(hasNextSteps ? { nextSteps: nextStepsOpt as string[] } : {}),
          ...(hasSuggestions
            ? { suggestions: suggestionsOpt as string[] }
            : {}),
        };
      }
      delete flagOpts.context;
      delete flagOpts.nextSteps;
      delete flagOpts.suggestions;
    }

    if (isViewFollow && follow === true) {
      if (!ctx.taskStore) {
        const err = buildInvalidInput(
          `${tool.name}/${action.name}: --follow requires a wired EventSourcedTaskStore; none present on this context`,
        );
        emitResult({ success: false, error: err }, isJson, format);
        process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
        return;
      }

      const followCoerced = coerceFlags(flagOpts, action.schema);
      const followParse = action.schema.safeParse(followCoerced);
      if (!followParse.success) {
        const errCtx = `${tool.name}/${action.name}`;
        const err = formatValidationError(followParse.error, errCtx);
        emitResult({ success: false, error: err }, isJson, format);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }

      let pollIntervalMs: number | undefined;
      try {
        const { loadExarchosConfig } = await import(
          '../../config/load-exarchos-config.js'
        );
        const loaded = loadExarchosConfig(process.cwd());
        pollIntervalMs = loaded?.config.cli?.followPollIntervalMs;
      } catch {
        pollIntervalMs = undefined;
      }

      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once('SIGINT', onSigint);

      try {
        const { runFollowLoop } = await import('../../cli/follow-loop.js');
        const subcommand = action.name as FollowSubcommand;

        const createResult = await invokeContractAction(
          actionId,
          { ...followParse.data, task: {} },
          ctx,
        );

        const dataCandidate = (createResult as { data?: unknown }).data;
        const taskCandidate =
          dataCandidate && typeof dataCandidate === 'object'
            ? (dataCandidate as { task?: { taskId?: unknown } }).task
            : undefined;
        const taskId =
          taskCandidate && typeof taskCandidate.taskId === 'string'
            ? taskCandidate.taskId
            : undefined;
        if (!createResult.success || !taskId) {
          emitResult(createResult, isJson, format);
          process.exitCode = createResult.success
            ? CLI_EXIT_CODES.HANDLER_ERROR
            : createResult.error?.code === VALIDATION_ERROR_CODE
              ? CLI_EXIT_CODES.INVALID_INPUT
              : CLI_EXIT_CODES.HANDLER_ERROR;
          return;
        }

        const loopResult = await runFollowLoop({
          taskStore: ctx.taskStore,
          taskId,
          pollIntervalMs,
          stdout: process.stdout,
          subcommand,
          signal: controller.signal,
        });

        process.exitCode =
          loopResult.terminalStatus === 'failed'
            ? CLI_EXIT_CODES.HANDLER_ERROR
            : CLI_EXIT_CODES.SUCCESS;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitResult(
          { success: false, error: { code: 'UNCAUGHT_EXCEPTION', message } },
          isJson,
          format,
        );
        process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
      } finally {
        process.off('SIGINT', onSigint);
      }
      return;
    }

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
          '../../lifecycle/event-query.js'
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

    if (isInspectFollow && follow === true) {
      const followCoerced = coerceFlags(flagOpts, action.schema);
      const followParse = action.schema.safeParse(followCoerced);
      if (!followParse.success) {
        const errCtx = `${tool.name}/${action.name}`;
        const err = formatValidationError(followParse.error, errCtx);
        emitResult({ success: false, error: err }, isJson, format);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }
      const featureId =
        typeof followParse.data.featureId === 'string'
          ? followParse.data.featureId
          : undefined;
      if (!featureId) {
        const err = buildInvalidInput(
          `${tool.name}/${action.name}: --follow requires featureId`,
        );
        emitResult({ success: false, error: err }, isJson, format);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }

      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once('SIGINT', onSigint);
      try {
        const { runInspectFollow, defaultFollowClock } = await import(
          '../../cli/follow-loop.js'
        );
        const { NdjsonEncoder } = await import('../../ndjson/encoder.js');
        const encoder = new NdjsonEncoder(process.stdout);
        const handle = runInspectFollow({
          subscribe: (filter, onEvent, options) =>
            ctx.eventStore.subscribe(filter, onEvent, options),
          featureId,
          fromSequence: 0,
          onFrame: (frame) => encoder.write(frame),
          signal: controller.signal,
          clock: defaultFollowClock(),
        });
        await handle.done;
        process.exitCode = CLI_EXIT_CODES.SUCCESS;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitResult(
          { success: false, error: { code: 'UNCAUGHT_EXCEPTION', message } },
          isJson,
          format,
        );
        process.exitCode = CLI_EXIT_CODES.UNCAUGHT_EXCEPTION;
      } finally {
        process.off('SIGINT', onSigint);
      }
      return;
    }

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

    const heartbeatEnabled = isJson && action.longRunning === true;
    const stopHeartbeat = heartbeatEnabled
      ? startHeartbeat(action.name)
      : null;
    let result: ToolResult;
    try {
      try {
        result = await invokeContractAction(actionId, parseResult.data, ctx);
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
    } finally {
      stopHeartbeat?.();
    }

    emitResult(result, isJson, format);
    process.exitCode = resolveExitCode(result);
  });

  return actionCmd;
}

/**
 * Converts a Commander error into a ToolResult and an exit code. Parity tests and {@link runCli} share this table.
 *
 * Help and version codes give success, so `exarchos --help` in a script is not a failure.
 * `commander.help` is in that set, because plain `exarchos` with no arguments shows help through that code.
 * Parse errors give INVALID_INPUT, the same `error.code` as the MCP path. Other codes give UNCAUGHT_EXCEPTION.
 * The parse-error set keeps the older `commander.invalidOptionArgument`, because custom argument parsers can still throw it.
 */
export function commanderErrorToResult(err: CommanderError): {
  result: ToolResult;
  exitCode: CliExitCode;
} {
  if (
    err.code === 'commander.helpDisplayed' ||
    err.code === 'commander.help' ||
    err.code === 'commander.version'
  ) {
    return {
      result: { success: true },
      exitCode: CLI_EXIT_CODES.SUCCESS,
    };
  }

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

  return {
    result: {
      success: false,
      error: { code: 'UNCAUGHT_EXCEPTION', message: err.message },
    },
    exitCode: CLI_EXIT_CODES.UNCAUGHT_EXCEPTION,
  };
}

/**
 * Applies `exitOverride()` to a command and to every nested subcommand, at any depth.
 * Thus bad input throws a `CommanderError` and does not call `process.exit()`. Parity test harnesses and {@link runCli} share it.
 */
export function applyExitOverrideRecursively(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) {
    applyExitOverrideRecursively(sub);
  }
}

/**
 * Parse-and-run entry point of the production binary. Commander errors go through {@link commanderErrorToResult}.
 * Thus bad CLI input gives the same INVALID_INPUT contract as the MCP path.
 * Under `--json`, a Commander error goes through the same envelope path as a dispatch failure, so consumers see one shape.
 */
export async function runCli(program: Command, argv: readonly string[]): Promise<void> {
  applyExitOverrideRecursively(program);

  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    if (err instanceof CommanderError) {
      const { result, exitCode } = commanderErrorToResult(err);
      const isJson = argv.includes('--json');
      if (result.success && exitCode === CLI_EXIT_CODES.SUCCESS) {
        process.exitCode = exitCode;
        return;
      }
      if (isJson) {
        toCliResult(toEnvelope(result), 'json');
      } else if (!result.success && result.error) {
        printError(result.error);
      }
      process.exitCode = exitCode;
      return;
    }
    throw err;
  }
}
