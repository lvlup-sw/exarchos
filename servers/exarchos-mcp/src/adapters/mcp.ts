import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  getFullRegistry,
  buildRegistrationSchema,
  buildToolDescription,
} from '../registry.js';
import type { ToolAction } from '../registry.js';
import { toEnvelope } from '../format.js';
import type { Envelope, ErrorEnvelope } from '../format.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleRootsListChanged } from '../mcp/notifications.js';
import { createElicitationClient } from '../mcp/elicitation-method.js';
import type { RootsClient } from '../workspace/discovery.js';
import { EnvelopeSchema } from '../schemas/envelope.js';
import { logger } from '../logger.js';
import { EventSourcedTaskStore } from '../task-store/event-sourced-task-store.js';
import type { NextAction } from '../next-action.js';
import type { ToolResult } from '../format.js';

// ─── DR-6: onboard CLI/MCP parity split — surface stamp + advisory carrier ───
//
// The onboard pipeline's INSTALL step (skills bundle + project deps) shells
// `npx` and writes `~/.claude/`, so it is gated CLI-only (DR-6). The gate is a
// property of the plan step's `surface` tag + the run's capability surface —
// NOT an `if (adapter === 'mcp') skip step 4` branch. The MCP server is, by
// construction, the NON-CLI surface, so this adapter:
//
//   1. stamps a non-`'cli'` surface onto the dispatched `onboard` args so the
//      core `apply` install router downgrades the cli-only step to a structured
//      Advisory (server-side install never runs, never a silent no-op); and
//   2. surfaces that advisory in the returned `ToolResult` with a `next_actions`
//      pointer at the CLI (INV-5b/INV-12) so the caller knows where to finish
//      the install.
//
// This is a surface DECLARATION + advisory presentation, both of which live in
// the adapter (presentation) layer; the gating BEHAVIOR stays in the reconciler
// core (INV-2). The CLI adapter (task 011) passes `surface: 'cli'`, so the
// install step runs there.

/**
 * The capability surface the MCP server runs onboard steps on. Any value other
 * than `'cli'` makes the core `apply` install router downgrade a `cli-only`
 * step to an advisory; `'any'` is the most permissive non-CLI surface (config /
 * generate / hook steps still execute).
 */
export const MCP_ONBOARD_SURFACE = 'any' as const;

/** The composite action this surface split applies to. */
const ONBOARD_ACTION = 'onboard';

/**
 * Stamp the MCP (non-`'cli'`) surface onto an `onboard` action's args when the
 * caller did not supply one explicitly. Idempotent and non-mutating: returns a
 * fresh object so the caller's payload is untouched. Non-onboard args pass
 * through unchanged.
 *
 * Exported for the DR-6 parity suite, which drives this exact stamp as the MCP
 * arm's surface (onboard is not yet a registered composite action — task 011).
 */
export function stampOnboardSurface(
  args: Record<string, unknown>,
): Record<string, unknown> {
  // Only the onboard action consults `surface`; leave everything else alone so
  // the generic dispatch path is not perturbed.
  if (args.action !== undefined && args.action !== ONBOARD_ACTION) return args;
  // Respect an explicit surface (e.g. a caller forcing `'cli'`); otherwise
  // stamp the MCP non-CLI surface so the core advisory path fires.
  if (typeof args.surface === 'string') return args;
  return { ...args, surface: MCP_ONBOARD_SURFACE };
}

/**
 * A cli-only advisory carried on an onboard apply result. Mirrors the
 * `Advisory` shape the reconciler emits (`surface`, `message`, `commands?`).
 */
interface OnboardAdvisoryLike {
  readonly surface: string;
  readonly message: string;
  readonly commands?: readonly string[];
}

/** Extract the apply-result advisories from an onboard `ToolResult`, if any. */
function readOnboardAdvisories(result: ToolResult): readonly OnboardAdvisoryLike[] {
  const data = result.data;
  if (typeof data !== 'object' || data === null) return [];
  const applyResult = (data as { result?: unknown }).result;
  if (typeof applyResult !== 'object' || applyResult === null) return [];
  const advisories = (applyResult as { advisories?: unknown }).advisories;
  if (!Array.isArray(advisories)) return [];
  return advisories.filter(
    (a): a is OnboardAdvisoryLike =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as { surface?: unknown }).surface === 'string' &&
      typeof (a as { message?: unknown }).message === 'string',
  );
}

/**
 * Surface a cli-only install advisory from an onboard `ToolResult`: when the
 * apply result carries a `surface: 'cli-only'` advisory (the MCP arm's
 * downgraded INSTALL step), prepend a `next_actions` pointer at the CLI so the
 * caller knows to finish the install there. Returns the result unchanged when
 * there is no cli-only advisory (e.g. the CLI arm, which ran the install).
 *
 * Non-destructive: preserves existing `next_actions` (the success-path `doctor`
 * pointer) and is idempotent — re-running it does not duplicate the CLI hint.
 */
export function surfaceOnboardCliAdvisory(result: ToolResult): ToolResult {
  const cliOnly = readOnboardAdvisories(result).filter((a) => a.surface === 'cli-only');
  if (cliOnly.length === 0) return result;

  const existing: readonly NextAction[] = result.next_actions ?? [];
  // Idempotent: don't stack a second CLI pointer on repeat application.
  if (existing.some((a) => a.verb === ONBOARD_ACTION)) return result;

  const commands = cliOnly.flatMap((a) => a.commands ?? []);
  const cliHint: NextAction = {
    verb: ONBOARD_ACTION,
    reason:
      'the skills/deps install step is CLI-only; finish it by running onboard from the Exarchos CLI',
    hint:
      commands.length > 0
        ? `run \`${commands[0]}\` from the Exarchos CLI to apply the cli-only install step`
        : 'run `exarchos onboard` from the Exarchos CLI to apply the cli-only install step',
  };
  return { ...result, next_actions: [cliHint, ...existing] };
}

// ─── D.4: LCD outputSchema advertised to MCP clients ────────────────────────
//
// Single advertised carrier schema (design §2.2, #1287). Every visible tool
// registers this LCD as its `outputSchema`; tightly-typed per-action schemas
// are enforced downstream in the call path (D.5) rather than in the
// tools/list manifest. This keeps the static surface compact and lets the
// per-call validator emit issue-pathed diagnostics.
//
// The LCD is the canonical `EnvelopeSchema(z.unknown())` discriminated union
// (success/error branches keyed on the `success` boolean literal). This
// was previously a passthrough-ZodObject workaround because the SDK's
// `normalizeObjectSchema` (`zod-compat.ts:79-121`) only accepted plain
// `ZodObject` and returned `undefined` for `ZodDiscriminatedUnion`,
// silently dropping the outputSchema from `tools/list` and crashing
// `validateToolOutput` on every successful call. PR #1366 fixes both gaps
// via `patches/@modelcontextprotocol+sdk+1.29.0.patch` and the upstream
// issues at modelcontextprotocol/typescript-sdk#2084 (tools/list draft-7
// → 2020-12 to admit `z.discriminatedUnion`'s `anyOf` JSON-Schema form)
// and #1308 (DU acceptance in `normalizeObjectSchema`). Once those
// upstream fixes ship in a stable SDK release, the patch drops; the LCD
// stays as-is.
const LCD_OUTPUT_SCHEMA = EnvelopeSchema(z.unknown());

// ─── D.1: Envelope → MCP CallToolResult carrier mapping ────────────────────

/**
 * Map an Exarchos envelope onto the MCP `CallToolResult` carrier.
 *
 * MCP 2025-11-25 §Tools / Structured Content: SHOULD also return the
 * serialized JSON in a TextContent block for backwards compatibility.
 * We honour that — clients reading `content[0].text` keep working; the
 * new validated payload rides `structuredContent`.
 *
 * Envelope construction lives in `format.ts` (`toEnvelope`); this adapter
 * only handles the carrier mapping. `createMcpServer` (this file's main
 * export, below) wires `toMcpResult` into the per-tool MCP handler — that
 * cutover landed in D.7.
 *
 * Design §2.3. Issue #1287.
 */
export function toMcpResult(env: Envelope<unknown> | ErrorEnvelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env) }],
    // The SDK's `CallToolResult` types `structuredContent` as
    // `{[x: string]: unknown} | undefined` (an index-signatured object).
    // Our envelope types use named-readonly fields — semantically a JSON
    // object, but without an explicit string index signature. Cast through
    // `unknown` so the carrier crosses the SDK boundary without leaking a
    // structural mismatch into call sites.
    structuredContent: env as unknown as { [x: string]: unknown },
    isError: env.success === false,
  };
}
// Server identity constants. These must stay in lock-step with the canonical
// SERVER_NAME / SERVER_VERSION exports in src/index.ts — task 1.6's compiled
// binary integration test asserts that the version advertised over MCP's
// initialize handshake matches the index.ts export, so drift here is caught
// in CI. A static `import { SERVER_VERSION } from '../index.js'` would pull
// the full index graph (event-store, backend init, hooks, CLI) into every
// caller of this adapter, so the values are duplicated intentionally; the
// integration test pins them together.
const SERVER_NAME = 'exarchos-mcp';
const SERVER_VERSION = '2.11.0-preview.4';

// ─── D.6: Aggregate ActionAnnotations into tools/list ToolAnnotations ─────
//
// MCP `tools/list` carries ToolAnnotations as advisory hints (per the spec
// these are explicitly client-untrusted unless the server itself is
// trusted). We aggregate the per-action `ActionAnnotations` records into a
// single tool-level record using the design's logical rules:
//
//   readOnlyHint    — true iff EVERY action is read-only. Conservative AND:
//                     one mutating action poisons the read-only label.
//   destructiveHint — true iff ANY action is destructive. Surfaces the
//                     worst-case safety so clients can prompt for confirm.
//   idempotentHint  — true iff EVERY action is documented/safe to re-run.
//   openWorldHint   — true iff ANY action touches an external world
//                     (network, git, etc.).
//
// Design §2.4, issue #1289.
function aggregateToolAnnotations(
  actions: readonly ToolAction[],
): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  return {
    readOnlyHint: actions.every(a => a.annotations.readOnly),
    destructiveHint: actions.some(a => a.annotations.destructive),
    idempotentHint: actions.every(a => a.annotations.idempotent),
    openWorldHint: actions.some(a => a.annotations.openWorld),
  };
}

// ─── D.5: Per-call output schema validation ────────────────────────────────
//
// Locates the dispatched action by the canonical `args.action` discriminator
// and validates the post-dispatch envelope against the action's per-action
// `outputSchema`. On violation, returns a replacement INTERNAL_ERROR
// envelope carrying the Zod issue list under `_meta.outputSchemaViolation`
// (path + message tuples). On success, returns the input envelope unchanged.
//
// When the action discriminator is absent or unresolved (custom tools
// without a registered action, malformed args, etc.), validation is skipped
// — the dispatch boundary surfaces its own structured error in those cases,
// and double-wrapping would mask the original failure path.
//
// Design §2.2 / §3, issue #1287. Validation cost is sub-millisecond in
// practice (small Zod schemas, no I/O); if a future regression flips that,
// gate behind an `EXARCHOS_OUTPUT_VALIDATE` env var.
function validateAgainstActionSchema(
  toolName: string,
  actions: readonly ToolAction[],
  args: Record<string, unknown>,
  env: Envelope<unknown> | ErrorEnvelope,
): Envelope<unknown> | ErrorEnvelope {
  const actionName =
    typeof args === 'object' && args !== null && typeof args.action === 'string'
      ? (args.action as string)
      : undefined;
  if (actionName === undefined) {
    return env;
  }
  const action = actions.find(a => a.name === actionName);
  if (action === undefined) {
    return env;
  }
  const parsed = action.outputSchema.safeParse(env);
  if (parsed.success) {
    return env;
  }
  const outputSchemaViolation = parsed.error.issues.map(issue => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return toEnvelope({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: `Output schema violation for action '${toolName}.${actionName}'`,
    },
    _meta: { outputSchemaViolation },
  });
}

// ─── MCP Server Adapter ────────────────────────────────────────────────────

/**
 * Creates an MCP server instance that routes tool calls through the
 * transport-agnostic dispatch layer.
 *
 * Each registered tool handler:
 * 1. Calls dispatch() with the tool name, args, and context
 * 2. Converts the ToolResult to an Envelope via `toEnvelope`
 * 3. Validates the envelope against the per-action outputSchema (D.5)
 * 4. Maps the envelope onto the MCP CallToolResult carrier via
 *    `toMcpResult` so both `content[0].text` (legacy SHOULD per MCP spec)
 *    and `structuredContent` (the typed envelope payload) ride together.
 */
export function createMcpServer(ctx: DispatchContext): McpServer {
  // #1272 — canonical TaskStore wiring. The SDK's `InMemoryTaskStore`
  // is demo-only (state lost on restart); EventSourcedTaskStore is the
  // event-sourced production replacement that projects task lifecycle
  // from the same event store the rest of dispatch writes to (INV-1).
  // The store is created per-server because `EventSourcedTaskStore`
  // owns a per-task in-memory cache that needs to live as long as the
  // MCP session; the underlying durable substrate (`ctx.eventStore`)
  // is shared across sessions.
  const taskStore = new EventSourcedTaskStore(ctx.eventStore);

  // ─── #1273 / C2 (T30) — thread the local TaskStore onto the dispatch ctx
  // so the C1 task-augmented branch fires when `tools/call` params carry
  // `task: { ttl? }`. Without this, dispatch sees `ctx.taskStore === undefined`
  // and silently falls back to the legacy one-shot path even when the
  // adapter has a TaskStore wired into the SDK's `tasks/*` surface — the
  // exact split-brain the augmentation contract is meant to forbid.
  //
  // We re-bind ctx (rather than mutating the caller's literal) so the
  // augmentation is scoped to this server instance; callers that
  // construct their own ctx with a different TaskStore (tests) keep
  // theirs intact when they call `dispatch()` directly.
  //
  // NOTE: the final `dispatchCtx` constructed further below folds the
  // taskStore + rootsClient + elicitationClient into a single object
  // that the handler closure consumes. Defining the taskStore here
  // (early) is intentional: the McpServer constructor below needs the
  // same instance for its SDK-level `tasks/*` wiring.

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
        },
        // #1273 / T32 — advertise tasks capability so clients see the
        // server supports request-augmented `tools/call` (per-tool
        // `execution.taskSupport: 'optional'`) and the explicit
        // `tasks/{get,result,cancel,list}` methods (the SDK's
        // setRequestHandler wiring installs these automatically when
        // `taskStore` is supplied to the constructor below).
        tasks: {
          list: {},
          cancel: {},
          requests: {
            tools: { call: {} },
          },
        },
      },
      taskStore,
    },
  );

  // ─── #1290 — Roots-based workspace discovery wiring (Sentry HIGH #1423) ──
  // The capability resolver is constructed up in index.ts / context.ts but
  // the MCP handshake observers — initialize callback + roots/list_changed
  // notification handler + RootsClient adapter — must be wired here, after
  // the McpServer is constructed, because they all depend on
  // `server.server` (the underlying low-level Server instance).
  //
  // Pre-fix, none of these were wired: `resolver.snapshot()` was never
  // called, so `isRootsDeclared()` stayed `false` forever and the
  // dispatch-side check at dispatch.ts:504 always fell back to cwd-walk.
  // `ctx.rootsClient` was never set, so even if isRootsDeclared() had
  // flipped, the discovery branch would have skipped roots entirely.
  // The notification handler defined in mcp/notifications.ts was unused.
  //
  // The augmented `dispatchCtx` below threads the rootsClient adapter
  // through to dispatch; the resolver snapshot fires on the client's
  // `initialized` notification (fully-handshaken state).
  const rootsClient: RootsClient = {
    list: async () => {
      const result = await server.server.listRoots();
      return result.roots.map((r) => ({ uri: r.uri }));
    },
  };

  // CodeRabbit MAJOR #1424: `createElicitationClient` previously had no
  // production caller, so the dispatch-side `ctx.elicitationClient !==
  // undefined` guard never fired and the elicitation hand-off always fell
  // back to INVALID_INPUT outside tests. Wire the adapter here against
  // `server.server.elicitInput` so the dispatch branch lights up whenever
  // the client declared the `elicitation` capability.
  const elicitationClient = createElicitationClient({
    elicitInput: async (params) => {
      // The SDK's `elicitInput` types `requestedSchema` as the spec's
      // form-mode envelope (`{ type: 'object', properties: { ... } }`)
      // with a discriminated-union value shape. The dispatcher passes a
      // structurally compatible JSON-Schema-shaped Record derived from
      // the action schema's `.pick({field: true})`. Cast at the carrier
      // boundary so the local structural `Record<string, unknown>`
      // contract stays decoupled from the SDK's narrow nominal type —
      // the wire-level validation still runs on the SDK side.
      const result = await server.server.elicitInput(
        params as unknown as Parameters<typeof server.server.elicitInput>[0],
      );
      return {
        action: result.action,
        ...(result.content !== undefined ? { content: result.content } : {}),
      };
    },
  });

  const dispatchCtx: DispatchContext = {
    ...ctx,
    // #1273 / C2 (T30) — thread the local TaskStore so the C1
    // task-augmented branch in dispatch fires when `tools/call` carries
    // `task: { ttl? }`. Folded into the same ctx as rootsClient /
    // elicitationClient so the handler closure consumes a single
    // unified DispatchContext.
    taskStore,
    rootsClient,
    elicitationClient,
  };

  if (ctx.capabilityResolver !== undefined) {
    const resolver = ctx.capabilityResolver;
    server.server.oninitialized = () => {
      try {
        const capabilities = server.server.getClientCapabilities();
        resolver.snapshot({ capabilities });
      } catch (err) {
        // Snapshot must never throw out of an MCP lifecycle hook —
        // failure here only degrades discovery to the cwd-walk fallback.
        logger.child({ subsystem: 'mcp-handshake' }).warn(
          { error: err instanceof Error ? err.message : String(err) },
          'capability resolver snapshot failed during MCP initialize',
        );
      }
    };
    server.server.setNotificationHandler(
      RootsListChangedNotificationSchema,
      async () => {
        try {
          handleRootsListChanged(resolver);
        } catch (err) {
          logger.child({ subsystem: 'mcp-handshake' }).warn(
            { error: err instanceof Error ? err.message : String(err) },
            'roots/list_changed handler failed; cache may be stale',
          );
        }
      },
    );
  }

  for (const tool of getFullRegistry()) {
    // Tier model — INTENTIONAL asymmetry between MCP and CLI surfaces.
    //
    // `hidden: true` means the tool is excluded from MCP `tools/list` (so it
    // is not advertised to model-side agents and does not consume their
    // context budget) but remains reachable via the CLI for operators,
    // scripts, and introspection (`exarchos schema`, `exarchos sy ...`).
    //
    // The companion CLI introspection path (`listSchemas()` in
    // `./schema-introspection.ts`) deliberately returns the FULL registry
    // and tags hidden tools so users can see they exist while understanding
    // they are internal / not part of the model-facing contract.
    //
    // See bug #1218 for the triage that fixed this asymmetry as
    // intentional, and registry.ts:`CompositeTool.hidden` for the field
    // contract.
    if (tool.hidden) continue;
    const inputSchema = buildRegistrationSchema(tool.actions);
    const description = buildToolDescription(tool, ctx.slimRegistration ?? false);

    const toolName = tool.name;

    // MCP handler: dispatch → toEnvelope → per-action schema validation
    // → toMcpResult. The `toEnvelope` + `toMcpResult` carriers replace the
    // pre-D.7 single-carrier path and add per-call enforcement of the
    // per-action outputSchema (D.5).
    const mcpHandler = async (args: Record<string, unknown>) => {
      // DR-6 — stamp the MCP (non-CLI) surface onto the onboard action so the
      // core `apply` install router downgrades the cli-only INSTALL step to a
      // structured advisory (never a server-side `~/.claude/` write). No-op for
      // every other action / when the caller supplied an explicit surface.
      const dispatchArgs = stampOnboardSurface(args);
      let env: Envelope<unknown> | ErrorEnvelope;
      try {
        let result = await dispatch(toolName, dispatchArgs, dispatchCtx);
        // DR-6 — surface the cli-only install advisory with a CLI pointer in
        // next_actions (INV-5b/INV-12). Gated to the onboard action: another
        // action that happens to return `data.result.advisories` with a
        // `surface: 'cli-only'` entry must NOT have an `onboard` verb prepended
        // to its next_actions — that would publish a false affordance (INV-12).
        if (dispatchArgs.action === ONBOARD_ACTION) {
          result = surfaceOnboardCliAdvisory(result);
        }
        env = toEnvelope(result);
      } catch (error) {
        env = toEnvelope({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message:
              error instanceof Error ? error.message : 'Unhandled MCP dispatch error',
          },
        });
        // Skip per-action validation on the unhandled-throw path — there is
        // no action contract to enforce against an out-of-band crash.
        return toMcpResult(env);
      }

      // D.5 — per-action output schema enforcement. Looks up the action via
      // the canonical `args.action` discriminator and re-validates the
      // envelope shape; surface the violation as an INTERNAL_ERROR envelope
      // carrying the Zod issue list under `_meta.outputSchemaViolation` so
      // callers can self-diagnose contract drift without re-running.
      env = validateAgainstActionSchema(toolName, tool.actions, args, env);
      return toMcpResult(env);
    };

    // Use registerTool() so the strict ZodObject is passed as inputSchema
    // directly, preserving .strict() validation that rejects unrecognized keys.
    const annotations = aggregateToolAnnotations(tool.actions);
    server.registerTool(
      tool.name,
      { description, inputSchema, outputSchema: LCD_OUTPUT_SCHEMA, annotations },
      mcpHandler,
    );
  }

  return server;
}
