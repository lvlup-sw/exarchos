import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from './tools.js';
import { handleEventDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { classifyPriority } from '../channel/priority.js';

const VALID_ACTIONS = ['append', 'query', 'batch_append', 'describe'] as const;
type EventAction = (typeof VALID_ACTIONS)[number];

const eventActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_event')!.actions;

/**
 * Fire hook runner after a successful event append.
 * Constructs a WorkflowEvent shape from the append args and result data,
 * then calls the hook runner in a fire-and-forget manner.
 */
async function fireHookIfConfigured(
  ctx: DispatchContext,
  appendArgs: Record<string, unknown>,
  result: ToolResult,
): Promise<void> {
  if (!ctx.hookRunner || !result.success) return;
  try {
    const event = appendArgs.event as Record<string, unknown> | undefined;
    const data = result.data as Record<string, unknown> | undefined;
    await ctx.hookRunner({
      type: (event?.type as string) ?? '',
      data: (event?.data as Record<string, unknown>) ?? {},
      featureId: (appendArgs.stream as string) ?? '',
      timestamp: (data?.timestamp as string) ?? new Date().toISOString(),
    });
  } catch {
    // Hooks are fire-and-forget — never block the event pipeline
  }
}

/**
 * Push a successfully-appended event to the Channel Emitter (if configured).
 * Priority is derived from the event type. Fire-and-forget — errors are
 * swallowed so the event pipeline is never blocked.
 */
async function pushToChannelIfConfigured(
  ctx: DispatchContext,
  appendArgs: Record<string, unknown>,
  result: ToolResult,
): Promise<void> {
  if (!ctx.channelEmitter || !result.success) return;
  try {
    const event = appendArgs.event as Record<string, unknown> | undefined;
    const data = result.data as Record<string, unknown> | undefined;
    const eventType = (event?.type as string) ?? '';
    const priority = classifyPriority(eventType);
    await ctx.channelEmitter.push(
      {
        streamId: (appendArgs.stream as string) ?? '',
        sequence: (data?.sequence as number) ?? 0,
        type: eventType,
        data: (event?.data as Record<string, unknown>) ?? {},
        timestamp: (data?.timestamp as string) ?? new Date().toISOString(),
      },
      priority,
    );
  } catch {
    // Channel push is fire-and-forget — never block the event pipeline
  }
}

/** Composite handler that routes `action` to the appropriate event-store handler. */
export async function handleEvent(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const { stateDir, eventStore } = ctx;
  const action = args.action as string | undefined;

  switch (action as EventAction) {
    case 'append': {
      const { action: _, ...rest } = args;
      const result = await handleEventAppend(
        rest as Parameters<typeof handleEventAppend>[0],
        stateDir,
        eventStore,
      );
      await fireHookIfConfigured(ctx, rest, result);
      await pushToChannelIfConfigured(ctx, rest, result);
      return result;
    }
    case 'query': {
      const { action: _, ...rest } = args;
      return handleEventQuery(
        rest as Parameters<typeof handleEventQuery>[0],
        stateDir,
        eventStore,
      );
    }
    case 'batch_append': {
      const { action: _, ...rest } = args;
      const result = await handleBatchAppend(
        rest as Parameters<typeof handleBatchAppend>[0],
        stateDir,
        eventStore,
      );
      if (result.success) {
        const batchArgs = rest as { stream?: string; events?: Array<Record<string, unknown>> };
        const events = batchArgs.events ?? [];
        const resultData = result.data as Array<Record<string, unknown>> | undefined;
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          const ack = resultData?.[i];
          // Fire hooks
          if (ctx?.hookRunner) {
            try {
              await ctx.hookRunner({
                type: (event.type as string) ?? '',
                data: (event.data as Record<string, unknown>) ?? {},
                featureId: (batchArgs.stream as string) ?? '',
                timestamp: new Date().toISOString(),
              });
            } catch {
              // Hooks are fire-and-forget — never block the event pipeline
            }
          }
          // Push to channel
          if (ctx.channelEmitter) {
            try {
              const eventType = (event.type as string) ?? '';
              const priority = classifyPriority(eventType);
              await ctx.channelEmitter.push(
                {
                  streamId: (batchArgs.stream as string) ?? '',
                  sequence: (ack?.sequence as number) ?? 0,
                  type: eventType,
                  data: (event.data as Record<string, unknown>) ?? {},
                  timestamp: (ack?.timestamp as string) ?? new Date().toISOString(),
                },
                priority,
              );
            } catch {
              // Channel push is fire-and-forget — never block the event pipeline
            }
          }
        }
      }
      return result;
    }
    case 'describe': {
      const { action: _, ...rest } = args;
      return handleEventDescribe(
        rest as { actions?: string[]; eventTypes?: string[]; emissionGuide?: boolean },
        eventActions,
      );
    }
    default:
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${action}. Valid actions: ${VALID_ACTIONS.join(', ')}`,
        },
      };
  }
}
