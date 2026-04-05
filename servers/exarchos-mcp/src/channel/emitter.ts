/**
 * Channel Emitter — fire-and-forget push of notifications via MCP Channel.
 *
 * Receives events, applies priority filtering against a configurable threshold,
 * and pushes via `notifications/claude/channel` on the MCP Server instance.
 * Errors are logged, never propagated.
 */

import type { NotificationPriority } from './priority.js';
import { shouldPush } from './priority.js';
import { formatNotification } from './formatter.js';

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

export class ChannelEmitter {
  private readonly server: ServerLike;
  private readonly threshold: NotificationPriority;

  constructor(server: ServerLike, options?: ChannelEmitterOptions) {
    this.server = server;
    this.threshold = options?.threshold ?? 'success';
  }

  async push(event: EventLike, priority: NotificationPriority): Promise<void> {
    if (!shouldPush(priority, this.threshold)) return;

    const notification = formatNotification(event, priority);

    try {
      await this.server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: notification.content,
          meta: notification.meta,
        },
      });
    } catch {
      // Fire-and-forget: errors are swallowed, never propagated
    }
  }
}
