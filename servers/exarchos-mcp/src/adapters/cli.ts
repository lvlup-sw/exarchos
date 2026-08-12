import { Command, CommanderError } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFullRegistry } from '../registry.js';
import type { CompositeTool, ToolAction } from '../registry.js';
// DR-25 / governing INV-2 — this adapter does NOT import the runtime `dispatch`
// value. Every api-action call site addresses its action by contract ActionId
// through the generated client (`invokeContractAction`), the ONE
// contract-derived dispatch site on the CLI side: an id the compiled contract
// does not contain cannot be addressed, so CLI/MCP agreement on WHICH action
// runs is constructed, not hand-coordinated. The Commander tree below remains
// hand-authored PRESENTATION (groups, command names, flags); addressing and
// behavior live behind the seam.
import { invokeContractAction } from '../contract/cli/generated-client.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../dispatch/caller-identity.js';
import type { ToolResult } from '../format.js';
import { toEnvelope } from '../format.js';
import { exitCodeForError } from '../contract/error-families.js';
import {
  addFlagsFromSchema,
  coerceFlags,
  validateRequiredBooleans,
  toKebab,
  formatValidationError,
  buildInvalidInput,
  VALIDATION_ERROR_CODE,
} from './schema-to-flags.js';
import { TIER1_HARNESSES } from '../launcher/harness-registry.js';
import { runLauncherVerb, renderDryRunPlan, isDryRunPlan } from '../launcher/verb.js';
import {
  makeLauncherLifecycleDeps,
  recoverBeforeLaunch,
  type LauncherWiringOverrides,
} from '../launcher/production-deps.js';
import type { FollowSubcommand } from '../cli/follow-formatter.js';
import { prettyPrint, printError, toCliResult } from './cli-format.js';
// NOTE: `./schema-introspection.js` is intentionally NOT imported at the top
// level. It pulls `zod-to-json-schema`, the state-machine topology serializer,
// and the playbook renderer — several MB of transitive graph that CLI
// cold-start for `wf status` etc. never needs. We lazy-import inside the
// `schema`, `topology`, and `emissions` sub-commands below.
// NOTE: `./mcp.js` and `../sdk/seam.js` (DR-26's owned SDK seam, which holds
// the transport constructor this command needs) are intentionally NOT imported
// at module top-level. They are dynamically imported
// inside the `mcp` sub-command action below so that cold-start for CLI mode
// (e.g. `exarchos wf status`) does not pay the cost of loading the full MCP
// SDK + tool-registration graph. See DR-5 / task 021 cold-start benchmark.

// ─── DR-25: contract-derived action addressing ──────────────────────────────

/**
 * The hard-wired top-level promotions' contract ActionIds. Each is the literal
 * id its `program.command(...)` action callback below hands to
 * `invokeContractAction`; every OTHER api-action command derives its id from
 * the registry inside `registerActionCommand` (`<tool>.<action>`).
 *
 * Exported as a machine-readable list so the DR-25 conformance test
 * (`Cli_EveryAddressedActionId_ExistsInDerivedSurface`) can assert each id
 * exists in `deriveCliSurface(compileForCli())` — a renamed or removed action
 * reddens the build here instead of surfacing as a runtime
 * `UnknownContractActionError`.
 *
 * This table SHRINKS as DR-5 pays the hand-written promotions down. Task 076
 * removed `mergeOrchestrate` from it: `merge_orchestrate` is now hoisted from
 * its registry `cli.topLevel` hint, so its ActionId is derived inside
 * `registerActionCommand` like every other action's and has no hard-wired
 * entry to keep in sync. The remaining three are the still-hand-written
 * promotions. Nothing reads this table's SIZE — the conformance test iterates
 * whatever is here — so a paydown that empties an entry cannot break it.
 */
export const CLI_PROMOTED_ACTION_IDS = Object.freeze({
  doctor: 'exarchos_orchestrate.doctor',
  feedback: 'exarchos_workflow.feedback',
  onboard: 'exarchos_orchestrate.onboard',
} as const);

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

/** Build the trusted CLI context from the configured local installation. */
export function createCliDispatchContext(ctx: DispatchContext): DispatchContext {
  return {
    ...ctx,
    callerIdentity: deriveLocalOperatorIdentity(ctx.stateDir),
  };
}

// ─── DR-7: generic errorCode → exit-code map (presentation only) ─────────────

/**
 * Generic `errorCode → exit-code` table (DR-7). This is PRESENTATION metadata,
 * NOT business logic: it lets a shell caller branch on a `wait` outcome by exit
 * code alone (`$? == 17`) without parsing the JSON envelope. The map is a plain
 * lookup consulted by {@link resolveExitCode} BEFORE the generic
 * INVALID_INPUT/HANDLER_ERROR fallback, so it is purely additive — any error
 * code NOT listed here keeps the pre-DR-7 mapping.
 *
 * - `WAIT_TIMEOUT` → 17: the bounded `wait` expired before its predicate held.
 * - `WAIT_FAILED`  → 18: a terminal that can never satisfy the predicate arrived
 *   first (e.g. a failed/cancelled workflow while waiting for `completed`).
 *
 * The codes ride `result.error.code` from the `wait` handler
 * (`projections/views/lifecycle/wait.ts`); the exit codes (17/18) sit above the 0-3 generic
 * band so they never alias SUCCESS/INVALID_INPUT/HANDLER_ERROR/UNCAUGHT.
 */
export const ERROR_CODE_EXIT_CODES: Readonly<Record<string, number>> = {
  WAIT_TIMEOUT: 17,
  WAIT_FAILED: 18,
};

/**
 * Map a dispatched {@link ToolResult} to its process exit code.
 *
 * P03-05: the CLI is a GENERATED in-process client over the same contract, so
 * its exit codes are no longer a bespoke adapter table — they are DERIVED from
 * the frozen P03-02 exit-code authority via {@link exitCodeForError}. Both the
 * CLI and the MCP wire resolve a failure's exit code from that single registry,
 * so the two surfaces agree by construction (differential-fixtures proof).
 *
 * Resolution:
 *   1. success              → SUCCESS (0)
 *   2. otherwise            → exitCodeForError(result.error.code)
 *
 * `exitCodeForError` is a strict superset of the pre-P03-05 mapping for every
 * handler-reachable code (success 0, INVALID_INPUT 1, the wait codes 17/18, and
 * the generic HANDLER_ERROR 2 fallback for any unregistered code — matching the
 * old ERROR_CODE_EXIT_CODES/INVALID_INPUT/HANDLER_ERROR ladder). It ADDS the
 * codes the adapter previously flattened to 2: the protocol family
 * (PROTOCOL_ERROR / UNSUPPORTED_PROTOCOL_VERSION / VERSION_INCOMPATIBLE) → 1 and
 * PRESENTER_ERROR → 3. Those refinements are not reachable from the dispatch
 * failure branch in CLI mode today, so this is behaviour-preserving for live
 * flows while making the exit contract complete against the registry.
 *
 * {@link ERROR_CODE_EXIT_CODES} is retained as the DR-7 presentation table that
 * `error-families.test.ts` and `lifecycle-verbs.parity.test.ts` pin against; its
 * two entries are now subsumed by (and cross-checked against) the registry.
 */
export function resolveExitCode(result: ToolResult): number {
  if (result.success) return CLI_EXIT_CODES.SUCCESS;
  return exitCodeForError(result.error?.code);
}

// ─── Error-Shape Helpers ────────────────────────────────────────────────────

/**
 * Emit a ToolResult using the adapter's output convention:
 * - `--json` or `--format json`: route through `toCliResult(toEnvelope(...))`
 *   so stdout carries the envelope shape (byte-equal to MCP `structuredContent`
 *   modulo timestamps). Honors the `EXARCHOS_CLI_ENVELOPE=0` opt-out (one
 *   preview cycle, dropped in v2.11.0).
 * - otherwise: prettyPrint (handles errors via printError).
 */
function emitResult(result: ToolResult, json: boolean, format?: 'table' | 'json' | 'tree'): void {
  if (json || format === 'json') {
    toCliResult(toEnvelope(result), 'json');
    return;
  }
  prettyPrint(result, format);
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

// ─── Package Version Resolution (Bug #1216) ─────────────────────────────────

/**
 * Build-time injected version. `scripts/build-binary.ts` passes
 * `--define EXARCHOS_BUILD_VERSION="<version>"` to `bun build --compile`
 * so the compiled binary advertises the right version even though the
 * bundle has no on-disk `package.json` to walk up to. Stays `undefined`
 * for `bun run` / `node` invocations, which fall through to the runtime
 * `package.json` walk below.
 */
declare const EXARCHOS_BUILD_VERSION: string | undefined;

/**
 * Resolve the running binary's version.
 *
 * Strategy (in order):
 *   1. Build-time `EXARCHOS_BUILD_VERSION` constant injected by
 *      `scripts/build-binary.ts` via `bun build --define`. This is the
 *      authoritative source for the compiled binary.
 *   2. Walk upward from this module to find a `package.json` and read
 *      its `version` field. Works from `src/`, `dist/`, and any
 *      `bun run` / `node` invocation that has the source tree on disk.
 *   3. Fall back to `'unknown'` so failure modes stay symmetric across
 *      `--version` and the `version` subcommand.
 *
 * Bug context: previously the `version` subcommand printed the literal
 * `'2.8.3'`, drifting from `program.version()` as the package bumped. The
 * resolver keeps both surfaces in lockstep with `npm version`. See #1216.
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
    // fall through
  }
  return 'unknown';
}

// ─── CLI Command Tree Generator ─────────────────────────────────────────────

/**
 * The set of `exarchos_view` action.names that the CLI exposes a `--follow`
 * streaming mode for. Membership drives BOTH the predicate that registers
 * the `--follow` Commander option (`buildCli` registration loop) and the
 * dispatch ternary that maps `action.name` → `FollowSubcommand` label
 * (the `subcommand` value threaded into `runFollowLoop`).
 *
 * Invariant (INV-2 — CLI `--follow` and MCP `tasks/get` polling produce
 * byte-equivalent transitions): every member MUST be backed by a pure
 * `ViewProjection` fold — no `eventStore.append`, no `emit`, no
 * `*.polled` events. Repeated polls must be a no-op against the
 * EventStore so the polling cadence under `--follow` (and the
 * MCP-side `tasks/get` retry path) doesn't mutate the timeline they
 * are observing.
 *
 * Audit (#1440 Op 1 / T1, orchestrator-inline 2026-05-17): all five
 * underlying handlers verified pure folds — see `workflow-status-view.ts`,
 * `shepherd-status-view.ts`, `pipeline-view.ts`, `convergence-view.ts`,
 * `delegation-timeline-view.ts`. The source-file idempotency cross-check
 * for the three NEW members lives in `cli/cli-follow-expansion.test.ts`
 * so any future write-surface regression fails CI before landing.
 *
 * Keep this set in lockstep with the `FollowSubcommand` union in
 * `cli/follow-formatter.ts` — the union's literal members must mirror
 * this set exactly.
 */
export const VIEW_FOLLOW_ACTIONS: ReadonlySet<string> = new Set([
  'workflow_status',
  'shepherd_status',
  'pipeline',
  'convergence',
  'delegation_timeline',
]);

/**
 * Options for {@link buildCli}. Production callers pass none; the launcher-wiring
 * DI seam ({@link BuildCliOptions.launcher}) lets the CLI-surface tests inject an
 * OS-effect fake (spawn / signal registrar / startup recovery) at the production
 * boundary so a real non-dry-run launch is exercised deterministically WITHOUT
 * re-implementing the wiring the CLI action runs.
 */
export interface BuildCliOptions {
  /** OS-effect / advanced overrides threaded into the `exarchos <harness>` launcher wiring. */
  readonly launcher?: LauncherWiringOverrides;
  /**
   * DR-7 test seam — override the composite-tool registry the auto-generated
   * command tree (and the top-level promotion hoist loop) is built from.
   * Production callers pass none and the full registry ({@link getFullRegistry})
   * is used. Tests stamp `cli.topLevel` onto a REAL registry action to exercise
   * the promotion mechanism + its collision guard without hand-mocking the
   * registry. Mirrors the `launcher` seam: a DI point at the production boundary,
   * not a divergent code path.
   */
  readonly registry?: readonly CompositeTool[];
}

/**
 * Builds a Commander program from the TOOL_REGISTRY.
 *
 * Each composite tool becomes a top-level command (with `exarchos_` prefix stripped),
 * and each action becomes a subcommand with flags auto-generated from Zod schemas.
 *
 * Also registers the `schema` introspection command and `mcp` server mode.
 */
export function buildCli(ctx: DispatchContext, options?: BuildCliOptions): Command {
  ctx = createCliDispatchContext(ctx);
  const packageVersion = resolvePackageVersion();
  const program = new Command('exarchos')
    .description('Agent governance for AI coding — event-sourced SDLC workflows')
    .version(packageVersion);

  // ─── Auto-generated tool commands ──────────────────────────────────────────

  const cliRegistry = options?.registry ?? getFullRegistry();

  for (const tool of cliRegistry) {
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
      registerActionCommand(
        toolCmd,
        tool,
        action,
        action.cli?.alias ?? action.name,
        ctx,
      );
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
  // used by other compat-aware call sites, so there is exactly one source
  // of truth for the compat policy.
  //
  // The subcommand is intentionally thin: it dispatches to
  // `handleVersionCheck`, which already prints and returns an exit code.
  // We assign the return value to `process.exitCode` to preserve the
  // DR-3 exit-code contract (0 = ok, 1 = drift detected).
  //
  // NOTE: Commander's top-level `.version(packageVersion)` above registers
  // `--version` as a flag on the root program; this `version` subcommand
  // is distinct because it takes the `--check-plugin-root <path>` option.
  program
    .command('version')
    .description('Print version and (optionally) verify plugin-root compatibility')
    .option('--check-plugin-root <path>', 'Check plugin.json minBinaryVersion against the running binary')
    .action(async (opts: { checkPluginRoot?: string }) => {
      if (!opts.checkPluginRoot) {
        // Plain `exarchos version` — print the version string and exit.
        // Bug #1216: source from package.json so this stays in lockstep
        // with `--version` (registered via `program.version()` above).
        process.stdout.write(`${packageVersion}\n`);
        process.exitCode = CLI_EXIT_CODES.SUCCESS;
        return;
      }

      const { handleVersionCheck } = await import('../lifecycle/version.js');
      const exitCode = await handleVersionCheck({
        pluginRoot: opts.checkPluginRoot,
        binaryVersion: packageVersion,
      });
      process.exitCode = exitCode;
    });

  // ─── Top-level `exarchos feedback "<message>"` command ───────────────────
  //
  // #1319 — the friction back-channel is promoted to a top-level verb with a
  // POSITIONAL message so an agent (or operator) types the documented
  // `exarchos feedback "<message>"` instead of `exarchos wf feedback
  // --message "..."`. Under the hood it dispatches the SAME
  // `exarchos_workflow.feedback` action through the shared dispatch core, so
  // the CLI and MCP paths share one handler + one validation gate (INV-2).
  // The auto-generated `exarchos wf feedback --message ...` form remains
  // available for scripting / power-user parity.
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

        // Coerce through the canonical action schema (same path the auto
        // `wf feedback` subcommand uses) so `--session-context '{...}'` is
        // JSON-parsed identically to the MCP wire (governing INV-2 — the
        // registered contract schema is the single authority both clients
        // coerce against; agreement is constructed, not witnessed by a
        // parity fixture).
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

  // ─── Schema introspection command ──────────────────────────────────────────

  program
    .command('schema [ref]')
    .description('Inspect action schemas. Without args, lists all. With "tool.action", shows JSON Schema.')
    .action(async (ref?: string) => {
      const { listSchemas, resolveSchemaRef } = await import('./schema-introspection.js');
      if (!ref) {
        // The CLI surface intentionally lists the FULL registry — including
        // tools that the MCP adapter hides from `tools/list` (e.g.
        // `exarchos_sync`). We append `(hidden)` so users can see at a
        // glance which entries are operator-only and not part of the
        // model-facing contract. See bug #1218 and
        // `schema-introspection.ts:listSchemas` for the tier-model
        // rationale.
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
      const [
        { createMcpServer },
        { createV2StdioServerTransport, connectV2Server },
      ] = await Promise.all([import('./mcp.js'), import('../contract/sdk/seam.js')]);
      const server = createMcpServer(ctx);
      // DR-26: the transport is drawn through the seam and the PAIRING goes
      // through `connectV2Server`, which is where the generation brand is
      // enforced — `server.connect(t)` would accept either generation's
      // transport because the SDK's own parameter is unbranded.
      await connectV2Server(server, createV2StdioServerTransport());
    });

  // ─── Top-level `exarchos onboard` command (DR-2/DR-5, task 011) ─────────
  //
  // Onboard is the consolidated first-run verb (superseding `init` +
  // `install-skills`) and is promoted to a top-level verb (like doctor /
  // init) so an operator types `exarchos onboard` instead of
  // `exarchos orch onboard`. Under the hood it dispatches through
  // exarchos_orchestrate so the CLI and MCP paths share one handler
  // (`handleOnboard`) and one validation gate (governing INV-2 — behavior
  // lives in the contract handler; this client carries presentation only).
  //
  // Flags auto-emit from the registered Zod schema via addFlagsFromSchema —
  // no hand-written flag table to drift. `surface` is NOT a flag here: the
  // CLI is the `'cli'` surface, so the (future) composite.ts dispatch branch
  // injects it; the operator never sets it.
  //
  // Exit-code mapping (DR-2 contract; mirrors the handler's INV-5b carrier):
  //   - VERIFY clean / dry-run plan  → SUCCESS (exit 0)
  //   - Residual blocking Fail       → HANDLER_ERROR (exit 2)  (handler returns
  //                                     success:false with a structured envelope)
  //   - Zod validation at CLI        → INVALID_INPUT (exit 1)
  //   - Dispatch failure             → HANDLER_ERROR (exit 2)
  //   - Uncaught throw               → UNCAUGHT_EXCEPTION (exit 3)
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

      // Parse coerced args through the schema so bad inputs surface as
      // INVALID_INPUT before dispatch runs.
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
          // `surface` is adapter-injected: the CLI runs the full install step,
          // so it dispatches as the `'cli'` surface.
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

      // Onboard exit mapping: the handler already collapses a residual blocking
      // Fail into success:false with a structured INV-5b error envelope, so a
      // failed result is a HANDLER_ERROR (or INVALID_INPUT if a validation gate
      // rejected it). A clean VERIFY (or a dry-run plan) is SUCCESS.
      process.exitCode = result.success
        ? CLI_EXIT_CODES.SUCCESS
        : result.error?.code === VALIDATION_ERROR_CODE
          ? CLI_EXIT_CODES.INVALID_INPUT
          : CLI_EXIT_CODES.HANDLER_ERROR;
    });
  }

  // ─── Top-level `exarchos init` command ──────────────────────────────────
  //
  // `init` is RENAMED to `onboard` (DR-5, design §7 / line 322). It is now a
  // one-release **error stub**: it prints `renamed → use 'exarchos onboard'`
  // and exits non-zero (NOT "command not found"), running NO onboarding side
  // effect. Removed entirely at v3.0. The stub is registered UNCONDITIONALLY
  // (the `init` action no longer exists in the registry, so there is nothing to
  // dispatch to) — keeping the verb present preserves the actionable rename
  // message instead of Commander's bare unknown-command error.
  //
  // The `init` action, handler (`handleInitWithWriters`), and `init.executed`
  // event were fully removed in DR-5 (task 018) — `onboard` reproduces init's
  // outputs through the reconciler's GENERATE step (the same `getAllWriters()`
  // list). Only this rename stub remains until v3.0.
  program
    .command('init')
    .description("[renamed] use 'exarchos onboard' — init was consolidated into the onboard verb (DR-5)")
    // Tolerate ANY legacy flags/args (e.g. the old `--runtime <id>`,
    // `--non-interactive`, `--json`, positional values) so the rename message
    // always prints instead of Commander erroring on an unknown option. The
    // stub ignores them all — there is no init action to dispatch to.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[ignored...]', 'legacy init arguments (ignored by the rename stub)')
    .action(() => {
      process.stderr.write(
        "exarchos init: renamed → use 'exarchos onboard'\n",
      );
      // Non-zero so scripts and CI surface the rename instead of silently
      // continuing; HANDLER_ERROR (2) rather than a "command not found" exit.
      process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
    });

  // ─── `exarchos merge-orchestrate` — hoisted, not hand-written (DR-5) ────
  //
  // The hand-written top-level `merge-orchestrate` block that used to sit here
  // was DELETED by task 076. `merge_orchestrate` was declared twice — once as a
  // registry action carrying `posture: 'shared-mutating'`, and once by hand
  // here — and that duplication is exactly the multiply-owned representation
  // DR-5 exists to eliminate. G1's kill fixture refuses to exempt the name, so
  // deletion was the only remedy the guard accepts.
  //
  // NOTE TO FUTURE AUTHORS: this comment deliberately does NOT write the
  // deleted call's syntax out. The guard parses rather than greps, so prose
  // would not fool IT — but `cli-derivation-guard.test.ts` pins the gap between
  // a naive text scan and the parse (exactly ONE prose occurrence of the call
  // form, in the `CLI_PROMOTED_ACTION_IDS` docblock), and a second one here
  // reddens that assertion. Describe the deleted call; do not transcribe it.
  //
  // The verb did NOT go away. `merge_orchestrate` now carries
  // `cli: { topLevel: 'merge-orchestrate' }` in the registry, and the DR-7
  // hoist loop at the bottom of `buildCli` registers it through
  // `registerActionCommand` — the same schema, handler, flag generation and
  // exit-code ladder the old block reimplemented by hand. `exarchos
  // merge-orchestrate …` is byte-for-byte the same operator surface, so no
  // rename stub is owed here (contrast `init`, immediately above, which really
  // was renamed).
  //
  // Exit-code mapping is now `resolveExitCode`'s registry-backed ladder rather
  // than the local three-arm copy: success → 0, VALIDATION_ERROR → 1, every
  // handler code the orchestrator actually returns (PREFLIGHT_FAILED,
  // MERGE_ROLLED_BACK, …) → 2 via the generic fallback. Identical for every
  // reachable outcome; see `resolveExitCode`'s note on the superset property.

  // ─── Top-level `exarchos install-skills` command (DR-5, task 018) ───────
  //
  // `install-skills` is RENAMED to `onboard` (DR-5, design §7). Onboard's
  // reconciler now owns skills install: the GENERATE step writes runtime config
  // + MCP registration ONCE, and the CLI install step (`verbs/onboard/
  // install.ts`) copies the skills bundle through the SAME `installSkills`
  // seam — so a standalone `install-skills` verb is dead. It is now a
  // one-release **error stub**: it prints `renamed → use 'exarchos onboard'`
  // and exits non-zero (NOT "command not found"), running NO install side
  // effect (the bridge is never reached). Removed entirely at v3.0. Mirrors the
  // `init` rename stub above.
  program
    .command('install-skills')
    .description("[renamed] use 'exarchos onboard' — install-skills was consolidated into the onboard verb (DR-5)")
    // Tolerate ANY legacy flags/args (e.g. the old `--agent <id>`, `--json`,
    // positional values) so the rename message always prints instead of
    // Commander erroring on an unknown option. The stub ignores them all —
    // there is no installer to dispatch to.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[ignored...]', 'legacy install-skills arguments (ignored by the rename stub)')
    .action(() => {
      process.stderr.write(
        "exarchos install-skills: renamed → use 'exarchos onboard'\n",
      );
      // Non-zero so scripts and CI surface the rename instead of silently
      // continuing; HANDLER_ERROR (2) rather than a "command not found" exit.
      process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
    });

  // ─── Top-level `exarchos <harness>` launcher verbs (DR-1) ────────────────
  //
  // A CLI-only process-supervisor verb (the stdio MCP surface can't own a
  // child's lifecycle), registered as ONE top-level command per Tier-1
  // harness so an operator types `exarchos claude-code --dry-run` — the
  // Aspire-style `exarchos <harness>` surface. The harness enum, path
  // derivation, dry-run event plan, and the non-dry-run lifecycle seam all
  // live in `launcher/verb.ts`; this block is a thin Commander adapter over
  // `runLauncherVerb`.
  //
  // `--dry-run` prints the derived worktree path + event plan (human-readable
  // via `renderDryRunPlan`, or the raw envelope under `--json`) WITHOUT
  // creating a worktree or spawning. A NON-dry-run launch composes a REAL
  // lifecycle substrate from the dispatch context (`makeLauncherLifecycleDeps`
  // — event store + fail-closed teardown + signal handlers) and hands it to the
  // verb as `lifecycleDeps`, so the launch actually spawns → places → observes →
  // tears down (DR-6). Before spawning it self-heals any prior crashed launch
  // (`recoverBeforeLaunch`) so no orphaned half-created worktree survives.
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

        // Trap any rejection from startup recovery, lifecycle-deps wiring, or the
        // verb so a non-Commander failure becomes the same UNCAUGHT_EXCEPTION
        // envelope + exit-3 mapping every other top-level verb uses — rather than
        // escaping `runCli` (which normalizes only CommanderError) as an uncaught
        // rejection. INV-2: the adapter shapes the error into the envelope;
        // behavior stays in the verb.
        try {
          // A real launch self-heals crashed prior launches, then runs the wired
          // lifecycle. Dry-run mutates nothing, so it skips recovery entirely.
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

          // Dry-run success in human mode → render the plan; JSON mode falls
          // through to the shared envelope emitter so machine consumers get one
          // shape (INV-2 facade equivalence).
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

  // ─── DR-7: top-level CLI promotion (hoist loop) ──────────────────────────
  //
  // For each action carrying `cli.topLevel`, register a TOP-LEVEL command that
  // dispatches through the SAME `registerActionCommand` path — same Zod schema,
  // same handler — as its `<tool> <action>` subcommand form (no divergent
  // parsing). Runs AFTER every other top-level command is registered so the
  // collision guard below sees the full top-level namespace (tool groups,
  // standalone verbs, harness launchers) plus any earlier hoist in this loop.
  //
  // Collision guard: a `topLevel` name clashing with an existing top-level
  // command NAME or ALIAS throws HERE, at registration (build time) — never at
  // runtime — so a bad promotion can't ship silently. The subcommand form is
  // untouched and keeps working regardless.
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
 * Registers a single composite-tool action as a Commander command under
 * `parent` with `commandName`, wiring flags from the action's Zod schema and
 * the shared dispatch handler. Extracted (DR-7) so the auto-generated
 * `<tool> <action>` subcommand form AND the top-level promotion hoist loop go
 * through ONE code path — same schema, same handler, no divergent parsing.
 * `parent` is the tool group for a subcommand, or the root `program` for a
 * promoted top-level command.
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

  // The contract ActionId this command addresses (DR-25). Both dispatch
  // branches below hand it to `invokeContractAction`, which verifies it
  // against the compiled contract surface before anything runs — the
  // registry-derived id and the compiled contract cannot silently disagree.
  const actionId = `${tool.name}.${action.name}`;

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

  // T33 (#1273) / Wave C PR 3 — the `exarchos view` actions listed in
  // `VIEW_FOLLOW_ACTIONS` gain a `--follow` flag that drives the
  // dispatch-core `EventSourcedTaskStore` polling loop (see
  // `cli/follow-loop.ts`). #1440 Op 1 (T7) expanded the set from the
  // original two-arm disjunction (workflow_status, shepherd_status) to
  // include three more pure-projection view actions (pipeline,
  // convergence, delegation_timeline). Like the event-query `--follow`,
  // this flag is registered outside `addFlagsFromSchema` so the MCP
  // tool schema for the underlying action stays one-shot — the
  // Tasks-augmented branch for the MCP arm is gated by the SDK
  // `task: { ttl }` request parameter, not by a tool-schema field (C2).
  const isViewFollow =
    tool.name === 'exarchos_view' && VIEW_FOLLOW_ACTIONS.has(action.name);
  if (isViewFollow) {
    actionCmd.option(
      '--follow',
      'Stream task lifecycle transitions to stdout until terminal status or SIGINT',
    );
  }

  // DR-4 (task-009): `view inspect --follow` tails ONE workflow's event stream
  // live as NDJSON frames over the DR-1 cursor-pump subscription (a DIFFERENT
  // carrier from the `VIEW_FOLLOW_ACTIONS` Tasks-polling loop above). No option
  // is registered here — inspect's `follow` field is schema-declared (DR-8 SoT),
  // so `addFlagsFromSchema` already emits `--follow`; this predicate only routes
  // the dispatch branch below.
  const isInspectFollow =
    tool.name === 'exarchos_view' && action.name === 'inspect';

  // T5 (#1240): convenience flags on `wf checkpoint` so agents emit a
  // structured handoff payload without having to type nested JSON.
  // The flags map to the `handoff` field on the dispatch surface
  // (which `addFlagsFromSchema` already exposes as
  // `--handoff <json-or-csv>` for power-user / scripting parity).
  // `--context` accepts inline strings only — the `@<path>` substitution
  // sugar is OUT OF SCOPE here (#1245, scheduled v2.12.0). The
  // variadic syntax `<step...>` lets agents repeat `--next-steps a
  // --next-steps b` to build the array, mirroring how the MCP arm
  // would receive `nextSteps: ['a', 'b']`.
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

    // ─── T5 (#1240): convenience-flag → handoff reshape ───────────────
    // Done BEFORE `coerceFlags` / `safeParse` so the synthesised
    // `handoff` is the value that hits both schema validation and
    // dispatch. Critical contract: when NONE of the convenience
    // flags are present, `handoff` MUST stay ABSENT — not be set
    // to `{ context: undefined, nextSteps: undefined, ... }`. The
    // C3 (#1241) digest is `sha256(handoff ?? {})`, and an
    // all-undefined object stringifies to `{}` only by coincidence;
    // explicit absence keeps the digest stable for pre-T5 callers
    // and for the parity contract with the MCP arm (which passes
    // `handoff` undefined when the caller didn't populate it).
    if (isWorkflowCheckpoint) {
      const ctxOpt = flagOpts.context;
      const nextStepsOpt = flagOpts.nextSteps;
      const suggestionsOpt = flagOpts.suggestions;
      const hasContext = typeof ctxOpt === 'string';
      const hasNextSteps = Array.isArray(nextStepsOpt) && nextStepsOpt.length > 0;
      const hasSuggestions =
        Array.isArray(suggestionsOpt) && suggestionsOpt.length > 0;

      // Reject the conflict where the operator passes both the raw
      // `--handoff '{...}'` JSON flag AND any convenience flag. Without
      // this guard the reshape block below would silently overwrite
      // the JSON-supplied handoff with the synthesized convenience
      // object — losing data the operator explicitly supplied. The
      // two surfaces are mutually exclusive: `--handoff` is the full
      // shape, the convenience flags are field-level sugar.
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
        // Synthesize `handoff` from the convenience flags. Spread-on-
        // condition keeps the shape minimal so the rehydration
        // projection's `latestHandoff` snapshot only carries what
        // the operator actually supplied (e.g. `{ context: 'x' }`
        // and not `{ context: 'x', nextSteps: undefined,
        // suggestions: undefined }`). The handler's
        // `CheckpointInputSchema.handoff` is a Zod object with all
        // three fields optional, so omitting them is valid input.
        flagOpts.handoff = {
          ...(hasContext ? { context: ctxOpt as string } : {}),
          ...(hasNextSteps ? { nextSteps: nextStepsOpt as string[] } : {}),
          ...(hasSuggestions
            ? { suggestions: suggestionsOpt as string[] }
            : {}),
        };
      }
      // Strip the convenience-flag aliases so they don't leak into
      // dispatch args (the schema doesn't declare them; they'd be
      // silently ignored, but cleaning them up here keeps the
      // dispatched payload shaped exactly like the MCP arm's).
      delete flagOpts.context;
      delete flagOpts.nextSteps;
      delete flagOpts.suggestions;
    }

    // ─── T33 (#1273): view `--follow` Tasks polling branch ────────────
    //
    // Wave C PR 3 — the CLI equivalent of the MCP `tasks/get` polling
    // loop. The dispatch creates a task via the dispatch-core
    // `runTasksAugmented` path (synthetic `task: {}` augmentation
    // threaded through dispatch args), pulls out the resulting
    // `taskId`, then drives `runFollowLoop` against the same
    // `EventSourcedTaskStore` the MCP arm consumes (INV-2 facade
    // equivalence). SIGINT during the loop emits `task.cancelled`
    // via the dispatch-core `cancelTask` surface.
    if (isViewFollow && follow === true) {
      if (!ctx.taskStore) {
        const err = buildInvalidInput(
          `${tool.name}/${action.name}: --follow requires a wired EventSourcedTaskStore; none present on this context`,
        );
        emitResult({ success: false, error: err }, isJson, format);
        process.exitCode = CLI_EXIT_CODES.HANDLER_ERROR;
        return;
      }

      // Parse the action args first so a `--workflow-id` typo surfaces
      // as INVALID_INPUT before we cut a task envelope.
      const followCoerced = coerceFlags(flagOpts, action.schema);
      const followParse = action.schema.safeParse(followCoerced);
      if (!followParse.success) {
        const errCtx = `${tool.name}/${action.name}`;
        const err = formatValidationError(followParse.error, errCtx);
        emitResult({ success: false, error: err }, isJson, format);
        process.exitCode = CLI_EXIT_CODES.INVALID_INPUT;
        return;
      }

      // Resolve poll cadence: CLI override (none yet — reserved for a
      // future `--poll-interval-ms` flag) > `.exarchos.yml`
      // `cli.followPollIntervalMs` > module default. The loader runs
      // synchronously and tolerates a missing file (returns null).
      let pollIntervalMs: number | undefined;
      try {
        const { loadExarchosConfig } = await import(
          '../config/load-exarchos-config.js'
        );
        const loaded = loadExarchosConfig(process.cwd());
        pollIntervalMs = loaded?.config.cli?.followPollIntervalMs;
      } catch {
        // Malformed `.exarchos.yml` is surfaced by the broader CLI
        // load path; in `--follow` we degrade to the default cadence
        // rather than abort the polling session.
        pollIntervalMs = undefined;
      }

      // Wire SIGINT → AbortController. The handler MUST NOT call
      // `process.exit` — the polling loop awaits `cancelTask` before
      // returning, then we let the action callback fall through to
      // its normal return so the event-loop drains cleanly (project-
      // memory caution).
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once('SIGINT', onSigint);

      try {
        const { runFollowLoop } = await import('../cli/follow-loop.js');
        // #1440 Op 1 (T7): the routing now flows directly from
        // `action.name` since `VIEW_FOLLOW_ACTIONS` and the
        // `FollowSubcommand` union are kept in lockstep — both
        // describe the same five-element set. The cast is the
        // bridge from the registry's `string` field to the
        // narrower literal union; the `isViewFollow` guard above
        // proves membership before we reach this point.
        const subcommand = action.name as FollowSubcommand;

        // Dispatch the underlying action through the Tasks-augmented
        // path so the lifecycle is recorded in the same
        // `EventSourcedTaskStore` projection the MCP arm reads. The
        // `task: {}` field is the augmentation signal per C1's
        // `isTaskAugmented` predicate (presence of a plain object is
        // sufficient; no `ttl` here means an unbounded task lifetime,
        // appropriate for an interactive CLI follow session).
        const createResult = await invokeContractAction(
          actionId,
          { ...followParse.data, task: {} },
          ctx,
        );

        // Extract taskId from the CreateTaskResult envelope. Dispatch
        // wraps the Tasks-augmented response under
        // `{ success: true, data: { task: { taskId, ... } } }` (see
        // `runTasksAugmented`'s return shape in C1).
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
          // The underlying dispatch already serialised a meaningful
          // error envelope; surface it untouched.
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

        // Cancellation is a clean exit — the user asked for it. Map
        // it to SUCCESS so a wrapping shell script doesn't treat ^C
        // as an error (matches `exarchos event query --follow`'s
        // SIGINT-on-close discipline).
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
          '../lifecycle/event-query.js'
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

    // ─── DR-4 (task-009): `view inspect --follow` NDJSON carrier ──────
    //
    // Tails ONE workflow's event stream live over the DR-1 cursor-pump
    // subscription, framing each delivered event as an NDJSON `event`
    // frame (deduped by sequence) with heartbeat frames on silence. The
    // MCP Tasks arm (`mcp/tasks-methods.ts#tasksFollow`) drives the SAME
    // `runInspectFollow` core over the SAME subscription contract, so the
    // two facades stream byte-identical frames (INV-2). Disposal is
    // AbortSignal-driven: SIGINT aborts the controller → the carrier
    // disposes the subscription and writes a terminal `end` frame.
    if (isInspectFollow && follow === true) {
      // Parse the action args first so a bad/missing featureId surfaces as
      // INVALID_INPUT before we open a subscription.
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

      // Wire SIGINT → AbortController (no POSIX-only signal semantics reach
      // the carrier). The handler MUST NOT call `process.exit` — awaiting
      // `handle.done` lets the carrier dispose the subscription and flush the
      // `end` frame, then the action returns and the event loop drains.
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once('SIGINT', onSigint);
      try {
        const { runInspectFollow, defaultFollowClock } = await import(
          '../cli/follow-loop.js'
        );
        const { NdjsonEncoder } = await import('../ndjson/encoder.js');
        const encoder = new NdjsonEncoder(process.stdout);
        const handle = runInspectFollow({
          subscribe: (filter, onEvent, options) =>
            ctx.eventStore.subscribe(filter, onEvent, options),
          featureId,
          // `0` so the follow stream is self-contained: existing events
          // (initial drain) followed by the live tail.
          fromSequence: 0,
          onFrame: (frame) => encoder.write(frame),
          signal: controller.signal,
          clock: defaultFollowClock(),
        });
        await handle.done;
        // Abort (SIGINT) is a clean exit — the user asked for it.
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
        result = await invokeContractAction(actionId, parseResult.data, ctx);
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
    // P03-05: `resolveExitCode` now delegates to the frozen P03-02 exit-code
    // authority (`exitCodeForError`), the SAME registry the MCP wire resolves
    // against — so the CLI client and the MCP surface assign identical exit
    // codes to a given result by construction (differential-fixtures proof).
    // The registry is a superset of the pre-P03-05 ladder for every
    // handler-reachable code: success 0, INVALID_INPUT 1, WAIT_TIMEOUT 17 /
    // WAIT_FAILED 18, and HANDLER_ERROR 2 for any other handler error. The SAME
    // site serves both the `vw <verb>` subcommand and the top-level promotion
    // (both route through this one registerActionCommand handler).
    emitResult(result, isJson, format);
    process.exitCode = resolveExitCode(result);
  });

  return actionCmd;
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
  //
  // Three Commander codes land here:
  //   - `commander.helpDisplayed` — `--help` / `-h` flag was used
  //   - `commander.help`          — the `help` subcommand was invoked, OR
  //                                 the program was invoked with no args
  //                                 and Commander auto-displayed help
  //   - `commander.version`       — `--version` / `-V` flag was used
  // Without `commander.help` in this set, plain `exarchos` (no args) prints
  // help correctly but then surfaces "Error [UNCAUGHT_EXCEPTION]: (outputHelp)"
  // after the help text.
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
        // INV-2 facade equivalence: route the CommanderError result
        // through the same envelope path as handler-driven failures
        // (`emitResult`), so programmatic `--json` consumers see one
        // shape regardless of whether the call failed at Commander
        // parse time or inside dispatch (CodeRabbit MAJOR on PR #1369).
        // `toCliResult` also honors `EXARCHOS_CLI_ENVELOPE=0`.
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
