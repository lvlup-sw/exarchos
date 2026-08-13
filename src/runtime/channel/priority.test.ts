import { describe, it, expect } from 'vitest';
import { classifyPriority, shouldPush, PRIORITY_ORDER, type NotificationPriority } from './priority.js';

describe('classifyPriority', () => {
  // Info-level events (low noise)
  it('classifies task.progressed as info', () => {
    expect(classifyPriority('task.progressed')).toBe('info');
  });
  it('classifies workflow.event as info', () => {
    expect(classifyPriority('workflow.event')).toBe('info');
  });

  // Success events
  it('classifies task.completed as success', () => {
    expect(classifyPriority('task.completed')).toBe('success');
  });
  it('classifies workflow.completed as success', () => {
    expect(classifyPriority('workflow.completed')).toBe('success');
  });

  // Warning events
  it('classifies task.failed as warning', () => {
    expect(classifyPriority('task.failed')).toBe('warning');
  });
  it('classifies sync.conflict as warning', () => {
    expect(classifyPriority('sync.conflict')).toBe('warning');
  });

  // Action-required events
  it('classifies review.requested as action-required', () => {
    expect(classifyPriority('review.requested')).toBe('action-required');
  });
  it('classifies review.changes_requested as action-required', () => {
    expect(classifyPriority('review.changes_requested')).toBe('action-required');
  });

  // Critical events
  it('classifies workflow.failed as critical', () => {
    expect(classifyPriority('workflow.failed')).toBe('critical');
  });
  it('classifies circuit_breaker.tripped as critical', () => {
    expect(classifyPriority('circuit_breaker.tripped')).toBe('critical');
  });

  // Unknown events default to info
  it('classifies unknown event types as info', () => {
    expect(classifyPriority('some.unknown.event')).toBe('info');
  });
});

describe('shouldPush', () => {
  it('returns true when priority meets threshold', () => {
    expect(shouldPush('warning', 'warning')).toBe(true);
  });
  it('returns true when priority exceeds threshold', () => {
    expect(shouldPush('critical', 'warning')).toBe(true);
  });
  it('returns false when priority is below threshold', () => {
    expect(shouldPush('info', 'success')).toBe(false);
  });
  it('uses success as default threshold', () => {
    expect(shouldPush('success', 'success')).toBe(true);
    expect(shouldPush('info', 'success')).toBe(false);
  });
});

describe('PRIORITY_ORDER', () => {
  it('defines correct ordering', () => {
    expect(PRIORITY_ORDER.info).toBe(0);
    expect(PRIORITY_ORDER.success).toBe(1);
    expect(PRIORITY_ORDER.warning).toBe(2);
    expect(PRIORITY_ORDER['action-required']).toBe(3);
    expect(PRIORITY_ORDER.critical).toBe(4);
  });
});
