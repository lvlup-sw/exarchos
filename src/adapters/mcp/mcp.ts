import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  createV2McpServer,
  V2_ROOTS_LIST_CHANGED_NOTIFICATION_METHOD,
  type V2McpServer,
} from '../../contract/sdk/seam.js';
import {
  getFullRegistry,
  buildRegistrationSchema,
  buildToolDescription,
} from '../../registry.js';
import { appendCompactActionContracts } from '../../registry/schema-builders.js';
import type { ToolAction } from '../../registry.js';
import { toEnvelope } from '../../format.js';
import type { Envelope, ErrorEnvelope } from '../../format.js';
import { dispatch } from '../../dispatch/core/dispatch.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { handleRootsListChanged } from '../../mcp/notifications.js';
import { createElicitationClient } from '../../mcp/elicitation-method.js';
import type { RootsClient } from '../../runtime/workspace/discovery.js';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';
import { logger } from '../../logger.js';
import { EventSourcedTaskStore } from '../../projections/task-store/event-sourced-task-store.js';
import { attachTaskStoreToV2, describeTaskWireGap } from '../../projections/task-store/attach.js';
import type { NextAction } from '../../next-action.js';
import type { ToolResult } from '../../format.js';
import {
  deriveMcpCallerIdentity,
  type McpCallerRuntimeContext,
} from '../../dispatch/caller-identity.js';
import { assertBindingsAtStartup } from '../../contract/bindings/verify-bindings.js';

/**
 * The surface that the MCP server stamps onto `onboard` args. Off the `'cli'` surface, the core
 * `apply` router changes each `install` step into an advisory, and the other steps still run.
 * The reconciler core owns that gate. This adapter only declares the surface and shows the advisory.
 */
export const MCP_ONBOARD_SURFACE = 'any' as const;

/** Build the trusted MCP dispatch context from adapter-owned session state. */
export function createMcpDispatchContext(
  ctx: DispatchContext,
  runtime: McpCallerRuntimeContext,
): DispatchContext {
  return { ...ctx, callerIdentity: deriveMcpCallerIdentity(runtime) };
}

/** The composite action this surface split applies to. */
const ONBOARD_ACTION = 'onboard';

/**
 * Adds {@link MCP_ONBOARD_SURFACE} to args with no `surface` string when the action is `onboard`
 * or absent. It returns a new object and does not change the input. Args for another action pass
 * through unchanged.
 * The onboard parity suite calls this function as the MCP side.
 */
export function stampOnboardSurface(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (args.action !== undefined && args.action !== ONBOARD_ACTION) return args;
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
 * Puts a `next_actions` pointer at the CLI first when an onboard result carries a `cli-only`
 * advisory. Otherwise it returns the result unchanged. It keeps the existing `next_actions`, and it
 * adds no pointer when an `onboard` entry is already present.
 */
export function surfaceOnboardCliAdvisory(result: ToolResult): ToolResult {
  const cliOnly = readOnboardAdvisories(result).filter((a) => a.surface === 'cli-only');
  if (cliOnly.length === 0) return result;

  const existing: readonly NextAction[] = result.next_actions ?? [];
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

/**
 * The output schema that each visible tool advertises in `tools/list`: the
 * `EnvelopeSchema(z.unknown())` union of the success and error envelopes. The handler checks the
 * per-action schemas on each call, so the manifest stays small.
 */
const LCD_OUTPUT_SCHEMA = EnvelopeSchema(z.unknown());

/**
 * Builds the MCP `content` block from the envelope as one text block of `JSON.stringify(env)`.
 * `structuredContent` is the contract, and `content` is a presentation of it. A shorter rendering
 * waits for evidence of how each runtime puts `content` into the model context. Economy logic
 * stays in the dispatch core.
 */
function renderContent(
  env: Envelope<unknown> | ErrorEnvelope,
): { type: 'text'; text: string }[] {
  return [{ type: 'text' as const, text: JSON.stringify(env) }];
}

/**
 * Maps an envelope onto the MCP `CallToolResult` carrier. `structuredContent` carries the envelope,
 * and `content` carries the same JSON as text for clients that read `content[0].text`. The envelope
 * types have no string index signature, so the cast is necessary at the SDK boundary.
 */
export function toMcpResult(env: Envelope<unknown> | ErrorEnvelope) {
  return {
    content: renderContent(env),
    structuredContent: env as unknown as { [x: string]: unknown },
    isError: env.success === false,
  };
}
/**
 * The server identity. It copies `SERVER_NAME` and `SERVER_VERSION` from `src/index.ts`, because
 * an import pulls the full index graph into this adapter. `tools/release/sync-versions.sh` writes
 * both versions, and tests compare them.
 */
const SERVER_NAME = 'exarchos-mcp';
const SERVER_VERSION = '2.12.1';

/**
 * Combines the per-action annotations into one tool-level `ToolAnnotations` record for
 * `tools/list`. The read-only and idempotent hints are true only when every action has them. The
 * destructive and open-world hints are true when one or more actions have them.
 */
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

/**
 * Checks a dispatch envelope against the `outputSchema` of the action that `args.action` names.
 * On a violation, it returns an `INTERNAL_ERROR` envelope with the Zod issues in
 * `_meta.outputSchemaViolation`. If `args.action` is absent or names no action of the tool, it
 * returns the envelope unchanged, so a dispatch error stays as dispatch reported it.
 * The check runs on every call, because it costs less than a millisecond. If that changes, the
 * planned switch is an `EXARCHOS_OUTPUT_VALIDATE` env var. Doctor recognizes that name, but no
 * code reads it yet.
 */
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

/**
 * Creates the MCP server, which routes each visible tool call through the dispatch layer. It
 * throws before it registers a tool if a contract action does not resolve to exactly one binding.
 *
 * The server keeps one `EventSourcedTaskStore` over `ctx.eventStore` and logs the task wire gap at
 * warn level. The `tasks` capability advertises only the `tools/call` augmentation, which dispatch
 * serves from `ctx.taskStore`. The v2 SDK answers `tasks/list` and `tasks/cancel` with `-32601`,
 * so the server does not advertise them.
 *
 * A `hidden` tool stays out of `tools/list`, but the CLI can still reach it. Each handler
 * dispatches the call, checks the envelope against the action `outputSchema`, and maps it with
 * {@link toMcpResult}. A thrown dispatch error becomes an `INTERNAL_ERROR` envelope with no schema
 * check. Only an `onboard` result gets the CLI advisory pointer.
 */
export function createMcpServer(ctx: DispatchContext): V2McpServer {
  assertBindingsAtStartup();

  const mcpSessionId = randomUUID();
  let mcpRuntimeContext: McpCallerRuntimeContext = { sessionId: mcpSessionId };
  const taskAttachment = attachTaskStoreToV2(
    new EventSourcedTaskStore(ctx.eventStore),
  );
  const taskStore = taskAttachment.store;

  const taskWireGap = describeTaskWireGap(taskAttachment);
  if (taskWireGap !== undefined) {
    logger
      .child({ subsystem: 'mcp-tasks' })
      .warn({ hostMustServe: taskAttachment.hostMustServe }, taskWireGap);
  }

  const server = createV2McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
        },
        tasks: {
          requests: {
            tools: { call: {} },
          },
        },
      },
    },
  );

  const rootsClient: RootsClient = {
    list: async () => {
      const result = await server.server.listRoots();
      return result.roots.map((r) => ({ uri: r.uri }));
    },
  };

  const elicitationClient = createElicitationClient({
    elicitInput: async (params) => {
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
        const clientInfo = server.server.getClientVersion();
        mcpRuntimeContext = clientInfo === undefined
          ? { sessionId: mcpSessionId }
          : {
              sessionId: mcpSessionId,
              clientInfo: { name: clientInfo.name, version: clientInfo.version },
            };
      } catch (err) {
        logger.child({ subsystem: 'mcp-handshake' }).warn(
          { error: err instanceof Error ? err.message : String(err) },
          'capability resolver snapshot failed during MCP initialize',
        );
      }
    };
    server.server.setNotificationHandler(
      V2_ROOTS_LIST_CHANGED_NOTIFICATION_METHOD,
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
    if (tool.hidden) continue;
    const inputSchema = buildRegistrationSchema(tool.actions);
    const slim = ctx.slimRegistration === true;
    const description = slim
      ? buildToolDescription(tool, true)
      : appendCompactActionContracts(buildToolDescription(tool, false), tool.actions);

    const toolName = tool.name;

    const mcpHandler = async (args: Record<string, unknown>) => {
      const dispatchArgs = stampOnboardSurface(args);
      let env: Envelope<unknown> | ErrorEnvelope;
      try {
        let result = await dispatch(
          toolName,
          dispatchArgs,
          createMcpDispatchContext(dispatchCtx, mcpRuntimeContext),
        );
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
        return toMcpResult(env);
      }

      env = validateAgainstActionSchema(toolName, tool.actions, args, env);
      return toMcpResult(env);
    };

    const annotations = aggregateToolAnnotations(tool.actions);
    server.registerTool(
      tool.name,
      { description, inputSchema, outputSchema: LCD_OUTPUT_SCHEMA, annotations },
      mcpHandler,
    );
  }

  return server;
}
