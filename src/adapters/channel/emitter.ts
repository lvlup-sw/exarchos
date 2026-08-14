/**
 * Channel Emitter — push of workflow notifications via the MCP Channel.
 *
 * Receives events, applies priority filtering against a configurable threshold,
 * and pushes via `notifications/claude/channel` on the MCP Server instance.
 *
 * P04-01 — delivery is now **observable and typed**. Every push routes through
 * the {@link ./delivery.js} algebra and returns a {@link DeliveryOutcome}:
 *   - {@link ChannelEmitter.push} is `best-effort` — a transport failure is
 *     captured into a typed `failed` carrier (an inspectable value) instead of
 *     being discarded by an empty `catch`. The failure is observable; the caller
 *     decides.
 *   - {@link ChannelEmitter.pushRequired} is `required` — a transport failure
 *     throws a typed {@link RequiredDeliveryError} that propagates. It is
 *     structurally impossible to swallow a required delivery failure here.
 */

import type { NotificationPriority } from '../../events/channel/priority.js';
import { shouldPush } from '../../events/channel/priority.js';
import { formatNotification, type ChannelNotification } from './formatter.js';
import {
  deliver,
  skipped,
  type DeliveryOutcome,
  type DeliveryRequirement,
} from '../../events/channel/delivery.js';

interface ServerLike {
  notification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
}

interface EventLike {
  streamId: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface ChannelEmitterOptions {
  threshold?: NotificationPriority;
}

/** Stable channel identifier used in delivery outcomes and errors. */
export const CHANNEL_NAME = 'notifications/claude/channel';

export class ChannelEmitter {
  private readonly server: ServerLike;
  private readonly threshold: NotificationPriority;

  constructor(server: ServerLike, options?: ChannelEmitterOptions) {
    this.server = server;
    this.threshold = options?.threshold ?? 'success';
  }

  /**
   * Best-effort push. Returns a {@link DeliveryOutcome}: `skipped` when the
   * event is below threshold, `delivered` on success, or `failed` (carrying a
   * typed error) when the transport rejects. Never throws for a transport
   * failure — but the failure is a returned value, not a swallowed one.
   */
  async push(
    event: EventLike,
    priority: NotificationPriority,
  ): Promise<DeliveryOutcome> {
    return this.deliverNotification(event, priority, 'best-effort');
  }

  /**
   * Required push. Resolves to `delivered`/`skipped`, or REJECTS with a typed
   * {@link RequiredDeliveryError} when the transport fails — the failure
   * propagates and cannot be silently dropped.
   */
  async pushRequired(
    event: EventLike,
    priority: NotificationPriority,
  ): Promise<DeliveryOutcome> {
    return this.deliverNotification(event, priority, 'required');
  }

  private deliverNotification(
    event: EventLike,
    priority: NotificationPriority,
    requirement: DeliveryRequirement,
  ): Promise<DeliveryOutcome> {
    if (!shouldPush(priority, this.threshold)) {
      return Promise.resolve(
        skipped(
          CHANNEL_NAME,
          `priority '${priority}' below threshold '${this.threshold}'`,
        ),
      );
    }

    const notification = formatNotification(event, priority);
    return deliver<ChannelNotification>({
      channel: CHANNEL_NAME,
      requirement,
      payload: notification,
      transport: async (payload) => {
        await this.server.notification({
          method: CHANNEL_NAME,
          params: {
            content: payload.content,
            meta: payload.meta,
          },
        });
      },
    });
  }
}
