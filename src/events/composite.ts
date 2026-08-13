import { type ToolResult } from '../format.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from './tools.js';
import { handleEventDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { classifyPriority } from '../adapters/channel/priority.js';
import { deliver } from '../adapters/channel/delivery.js';
import type { WorkflowEvent } from '../hooks/config-hooks.js';
import { envelopeWrap } from '../envelope-wrap.js';

const VALID_ACTIONS = ['append', 'query', 'batch_append', 'describe'] as const;
type EventAction = (typeof VALID_ACTIONS)[number];

const eventActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_event')!.actions;

/**
 * Channel identifier for the best-effort post-append config-hook delivery
 * (P04-01). The channel push carries its own identifier inside `ChannelEmitter`.
 */
const POST_APPEND_HOOK_CHANNEL = 'post-append:config-hook';

/**
 * Fire the config hook runner after a successful event append.
 *
 * P04-01 — the post-append hook is an explicit BEST-EFFORT delivery: it routes
 * through the typed {@link deliver} algebra, so a hook failure is captured as an
 * observable `failed` outcome instead of being discarded by an empty `catch`,
 * and it never blocks the event pipeline. Requirement is `best-effort` by design
 * — a hook is advisory, not on the durable path.
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
 * Push a successfully-appended event to the Channel Emitter (if configured).
 *
 * P04-01 — BEST-EFFORT delivery: {@link ChannelEmitter.push} routes through the
 * typed delivery algebra and returns an observable `DeliveryOutcome` — it never
 * throws, so there is no `catch` to swallow and no failure is lost. The event
 * pipeline is never blocked by a channel outage.
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

// HATEOAS envelope wrapping is the shared `envelopeWrap` (../envelope-wrap.ts).
// Event-store responses (append ACKs, query results, describe) carry no
// workflow state, so `next_actions` derives to `[]`; the call is retained for
// architectural symmetry across the four composites. Hook/channel
// side-effects still observe the raw `ToolResult` shape because wrapping
// happens after those best-effort typed deliveries (P04-01).

/** Composite handler that routes `action` to the appropriate event-store handler. */
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
          // Fire hooks — best-effort typed delivery (P04-01): a hook failure is
          // an observable outcome, never an empty-catch swallow.
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
          // Push to channel — best-effort; push never throws and returns an
          // observable outcome, so no catch is needed.
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
