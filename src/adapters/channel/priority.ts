export type NotificationPriority = 'info' | 'success' | 'warning' | 'action-required' | 'critical';

export const PRIORITY_ORDER: Readonly<Record<NotificationPriority, number>> = {
  'info': 0,
  'success': 1,
  'warning': 2,
  'action-required': 3,
  'critical': 4,
};

const EVENT_PRIORITY_MAP: Record<string, NotificationPriority> = {
  // Success
  'task.completed': 'success',
  'workflow.completed': 'success',
  'review.approved': 'success',
  'synthesis.merged': 'success',

  // Warning
  'task.failed': 'warning',
  'sync.conflict': 'warning',
  'review.rejected': 'warning',

  // Action required
  'review.requested': 'action-required',
  'review.changes_requested': 'action-required',

  // Critical
  'workflow.failed': 'critical',
  'circuit_breaker.tripped': 'critical',
};

export function classifyPriority(eventType: string): NotificationPriority {
  return EVENT_PRIORITY_MAP[eventType] ?? 'info';
}

export function shouldPush(
  priority: NotificationPriority,
  threshold: NotificationPriority = 'success',
): boolean {
  return PRIORITY_ORDER[priority] >= PRIORITY_ORDER[threshold];
}
