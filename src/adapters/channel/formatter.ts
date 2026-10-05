/**
 * Converts workflow events into Channel notification payloads.
 * Meta keys use only the characters `[a-zA-Z0-9_]`, as the Channel spec requires.
 */

import type { NotificationPriority } from '../../events/channel/priority.js';

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

/**
 * Appends `data.error ?? data.reason` to the `[streamId] type` prefix when that value is a string.
 * Otherwise it appends `data.summary ?? data.message` when that value is a string.
 */
function buildContent(
  event: EventLike,
  data: Record<string, unknown>,
): string {
  const prefix = `[${event.streamId}] ${event.type}`;

  const error = data.error ?? data.reason;
  if (typeof error === 'string') {
    return `${prefix}: ${error}`;
  }

  const summary = data.summary ?? data.message;
  if (typeof summary === 'string') {
    return `${prefix}: ${summary}`;
  }

  return prefix;
}
