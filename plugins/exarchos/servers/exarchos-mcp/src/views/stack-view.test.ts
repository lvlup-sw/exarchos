import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from './materializer.js';
import {
  stackViewProjection,
  STACK_VIEW,
} from './stack-view.js';
import type { StackViewState } from './stack-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

function makeEvent(
  seq: number,
  type: string,
  data?: Record<string, unknown>,
  streamId = 'wf-001',
): WorkflowEvent {
  return {
    streamId,
    sequence: seq,
    timestamp: new Date().toISOString(),
    type,
    schemaVersion: '1.0',
    data,
  };
}

describe('StackView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(STACK_VIEW, stackViewProjection);
  });

  it('stackViewProjection_Init_ReturnsEmptyPositions', () => {
    const view = materializer.materialize<StackViewState>(
      'wf-001',
      STACK_VIEW,
      [],
    );

    expect(view.positions).toEqual([]);
  });

  it('stackViewProjection_Apply_StackPositionFilled_AddsPosition', () => {
    const events = [
      makeEvent(1, 'stack.position-filled', {
        position: 1,
        taskId: 't1',
        branch: 'feat/t1',
        prUrl: 'https://github.com/pr/1',
      }),
    ];

    const view = materializer.materialize<StackViewState>(
      'wf-001',
      STACK_VIEW,
      events,
    );

    expect(view.positions).toHaveLength(1);
    expect(view.positions[0]).toEqual({
      position: 1,
      taskId: 't1',
      branch: 'feat/t1',
      prUrl: 'https://github.com/pr/1',
    });
  });

  it('stackViewProjection_Apply_MultiplePositions_AccumulatesAll', () => {
    const events = [
      makeEvent(1, 'stack.position-filled', { position: 1, taskId: 't1', branch: 'feat/t1' }),
      makeEvent(2, 'stack.position-filled', { position: 2, taskId: 't2', branch: 'feat/t2' }),
      makeEvent(3, 'stack.position-filled', { position: 3, taskId: 't3' }),
    ];

    const view = materializer.materialize<StackViewState>(
      'wf-001',
      STACK_VIEW,
      events,
    );

    expect(view.positions).toHaveLength(3);
    expect(view.positions[0].position).toBe(1);
    expect(view.positions[1].position).toBe(2);
    expect(view.positions[2].position).toBe(3);
    expect(view.positions[2].taskId).toBe('t3');
  });

  it('stackViewProjection_Apply_UnrelatedEvent_ReturnsUnchanged', () => {
    const events = [
      makeEvent(1, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      makeEvent(2, 'task.completed', { taskId: 't1' }),
    ];

    const view = materializer.materialize<StackViewState>(
      'wf-001',
      STACK_VIEW,
      events,
    );

    expect(view.positions).toEqual([]);
  });
});
