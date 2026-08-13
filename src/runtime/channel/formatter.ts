/**
 * Event-to-notification content formatter.
 *
 * Converts workflow events into Channel notification payloads with
 * human-readable content and structured meta attributes.
 * Meta keys conform to Channel spec: `[a-zA-Z0-9_]` only.
 */

import type { NotificationPriority } from './priority.js';

export interface ChannelNotification {
  content: string;
  meta: Record<string, string>;
}

interface EventLike {
  streamId: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export function formatNotification(
  event: EventLike,
  priority: NotificationPriority,
): ChannelNotification {
  const meta: Record<string, string> = {
    type: event.type,
    priority,
    workflow_id: event.streamId,
  };

  const data = event.data;
  if (typeof data.taskId === 'string') meta.task_id = data.taskId;
  if (typeof data.branch === 'string') meta.branch = data.branch;

  const content = buildContent(event, data);

  return { content, meta };
}

function buildContent(
  event: EventLike,
  data: Record<string, unknown>,
): string {
  const prefix = `[${event.streamId}] ${event.type}`;

  // Error/failure events: include the error reason
  const error = data.error ?? data.reason;
  if (typeof error === 'string') {
    return `${prefix}: ${error}`;
  }

  // Success events with summary
  const summary = data.summary ?? data.message;
  if (typeof summary === 'string') {
    return `${prefix}: ${summary}`;
  }

  return prefix;
}
