import { describe, it, expect } from 'vitest';
import { formatNotification, type ChannelNotification } from './formatter.js';

describe('formatNotification', () => {
  const baseEvent = {
    streamId: 'my-feature',
    sequence: 5,
    type: 'task.completed',
    data: { taskId: 'task-003', summary: 'Implemented auth handler' },
    timestamp: '2026-04-05T12:00:00Z',
  };

  it('formats task.completed with taskId and summary', () => {
    const result = formatNotification(baseEvent, 'success');
    expect(result.content).toContain('task.completed');
    expect(result.content).toContain('my-feature');
  });

  it('formats task.failed with error reason', () => {
    const event = {
      ...baseEvent,
      type: 'task.failed',
      data: { taskId: 'task-003', error: 'Test assertion failed' },
    };
    const result = formatNotification(event, 'warning');
    expect(result.content).toContain('task.failed');
    expect(result.content).toContain('Test assertion failed');
  });

  it('includes workflow_id from streamId in meta', () => {
    const result = formatNotification(baseEvent, 'success');
    expect(result.meta.workflow_id).toBe('my-feature');
  });

  it('includes type and priority in meta', () => {
    const result = formatNotification(baseEvent, 'success');
    expect(result.meta.type).toBe('task.completed');
    expect(result.meta.priority).toBe('success');
  });

  it('includes task_id in meta when present in data', () => {
    const result = formatNotification(baseEvent, 'success');
    expect(result.meta.task_id).toBe('task-003');
  });

  it('omits task_id from meta when not in data', () => {
    const event = { ...baseEvent, data: {} };
    const result = formatNotification(event, 'info');
    expect(result.meta.task_id).toBeUndefined();
  });

  it('includes branch in meta when present in data', () => {
    const event = { ...baseEvent, data: { ...baseEvent.data, branch: 'feat/auth' } };
    const result = formatNotification(event, 'success');
    expect(result.meta.branch).toBe('feat/auth');
  });

  it('ensures all meta keys are alphanumeric/underscore only', () => {
    const result = formatNotification(baseEvent, 'success');
    const keyPattern = /^[a-zA-Z0-9_]+$/;
    for (const key of Object.keys(result.meta)) {
      expect(key).toMatch(keyPattern);
    }
  });

  it('returns ChannelNotification shape with content and meta', () => {
    const result = formatNotification(baseEvent, 'success');
    expect(typeof result.content).toBe('string');
    expect(typeof result.meta).toBe('object');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('formats workflow.failed with critical details', () => {
    const event = {
      ...baseEvent,
      type: 'workflow.failed',
      data: { error: 'CI pipeline broken', phase: 'synthesize' },
    };
    const result = formatNotification(event, 'critical');
    expect(result.content).toContain('workflow.failed');
    expect(result.content).toContain('CI pipeline broken');
  });

  it('handles events with minimal data gracefully', () => {
    const event = { streamId: 'wf-1', sequence: 1, type: 'workflow.started', data: {}, timestamp: '2026-04-05T00:00:00Z' };
    const result = formatNotification(event, 'info');
    expect(result.content).toBeTruthy();
    expect(result.meta.workflow_id).toBe('wf-1');
  });
});
