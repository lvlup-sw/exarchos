/**
 * Channel emitter. It pushes workflow notifications through the MCP channel
 * `notifications/claude/channel`, and skips an event below the priority threshold.
 *
 * Every push returns a typed {@link DeliveryOutcome}. {@link ChannelEmitter.push}
 * returns a transport failure as a `failed` outcome. {@link ChannelEmitter.pushRequired}
 * throws a {@link RequiredDeliveryError} for a transport failure.
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
   * Best-effort push. Returns `skipped` below the threshold, `delivered` on
   * success, or `failed` with a typed error when the transport rejects.
   */
  async push(
    event: EventLike,
    priority: NotificationPriority,
  ): Promise<DeliveryOutcome> {
    return this.deliverNotification(event, priority, 'best-effort');
  }

  /**
   * Required push. Resolves to `delivered` or `skipped`. Rejects with a
   * {@link RequiredDeliveryError} when the transport fails.
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
