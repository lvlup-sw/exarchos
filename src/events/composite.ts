import { type ToolResult } from '../format.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from './tools.js';
import { handleEventDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { classifyPriority } from './channel/priority.js';
import { deliver } from './channel/delivery.js';
import type { WorkflowEvent } from '../hooks/config-hooks.js';
import { envelopeWrap } from '../envelope-wrap.js';

const VALID_ACTIONS = ['append', 'query', 'batch_append', 'describe'] as const;
type EventAction = (typeof VALID_ACTIONS)[number];

const eventActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_event')!.actions;

/**
 * Channel identifier for the best-effort post-append config-hook delivery.
 * The channel push carries its own identifier inside `ChannelEmitter`.
 */
const POST_APPEND_HOOK_CHANNEL = 'post-append:config-hook';

/**
 * Fire the config hook runner after a successful event append. The hook is a
 * best-effort {@link deliver}, because a hook is advisory. A hook failure becomes
 * a `failed` outcome and never blocks the event pipeline.
 */
async function fireHookIfConfigured(
  ctx: DispatchContext,
  appendArgs: Record<string, unknown>,
  result: ToolResult,
): Promise<void> {
  const hookRunner = ctx.hookRunner;
  if (!hookRunner || !result.success) return;
  const event = appendArgs.event as Record<string, unknown> | undefined;
  const data = result.data as Record<string, unknown> | undefined;
  const workflowEvent: WorkflowEvent = {
    type: (event?.type as string) ?? '',
    data: (event?.data as Record<string, unknown>) ?? {},
    featureId: (appendArgs.stream as string) ?? '',
    timestamp: (data?.timestamp as string) ?? new Date().toISOString(),
  };
  await deliver<WorkflowEvent>({
    channel: POST_APPEND_HOOK_CHANNEL,
    requirement: 'best-effort',
    payload: workflowEvent,
    transport: (e) => hookRunner(e),
  });
}

/**
 * Push a successfully-appended event to the Channel Emitter, if one is configured.
 * {@link ChannelEmitter.push} is a best-effort delivery that returns a
 * `DeliveryOutcome` and never throws.
 */
async function pushToChannelIfConfigured(
  ctx: DispatchContext,
  appendArgs: Record<string, unknown>,
  result: ToolResult,
): Promise<void> {
  const emitter = ctx.channelEmitter;
  if (!emitter || !result.success) return;
  const event = appendArgs.event as Record<string, unknown> | undefined;
  const data = result.data as Record<string, unknown> | undefined;
  const eventType = (event?.type as string) ?? '';
  await emitter.push(
    {
      streamId: (appendArgs.stream as string) ?? '',
      sequence: (data?.sequence as number) ?? 0,
      type: eventType,
      data: (event?.data as Record<string, unknown>) ?? {},
      timestamp: (data?.timestamp as string) ?? new Date().toISOString(),
    },
    classifyPriority(eventType),
  );
}

/**
 * Composite handler that routes `action` to the matching event-store handler.
 *
 * Event-store responses carry no workflow state, so `envelopeWrap` derives empty
 * `next_actions`. The wrap runs after the hook and channel deliveries, so those
 * deliveries see the raw `ToolResult`.
 */
export async function handleEvent(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
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
      return envelopeWrap(result, startedAt);
    }
    case 'query': {
      const { action: _, ...rest } = args;
      const result = await handleEventQuery(
        rest as Parameters<typeof handleEventQuery>[0],
        stateDir,
        eventStore,
      );
      return envelopeWrap(result, startedAt);
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
          if (event === undefined) continue;
          const ack = resultData?.[i];
          const hookRunner = ctx.hookRunner;
          if (hookRunner) {
            await deliver<WorkflowEvent>({
              channel: POST_APPEND_HOOK_CHANNEL,
              requirement: 'best-effort',
              payload: {
                type: (event.type as string) ?? '',
                data: (event.data as Record<string, unknown>) ?? {},
                featureId: (batchArgs.stream as string) ?? '',
                timestamp: new Date().toISOString(),
              },
              transport: (e) => hookRunner(e),
            });
          }
          const emitter = ctx.channelEmitter;
          if (emitter) {
            const eventType = (event.type as string) ?? '';
            await emitter.push(
              {
                streamId: (batchArgs.stream as string) ?? '',
                sequence: (ack?.sequence as number) ?? 0,
                type: eventType,
                data: (event.data as Record<string, unknown>) ?? {},
                timestamp: (ack?.timestamp as string) ?? new Date().toISOString(),
              },
              classifyPriority(eventType),
            );
          }
        }
      }
      return envelopeWrap(result, startedAt);
    }
    case 'describe': {
      const { action: _, ...rest } = args;
      const result = await handleEventDescribe(
        rest as { actions?: string[]; eventTypes?: string[]; emissionGuide?: boolean },
        eventActions,
      );
      return envelopeWrap(result, startedAt);
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
