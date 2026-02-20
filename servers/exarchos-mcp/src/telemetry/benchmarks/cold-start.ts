import type { WorkflowEvent } from '../../event-store/schemas.js';

type WorkflowEventType =
  | 'workflow.started'
  | 'workflow.transition'
  | 'task.assigned'
  | 'task.completed'
  | 'task.failed';

const PHASES = ['ideate', 'plan', 'plan-review', 'delegate', 'review', 'synthesize'];

/**
 * Generate N realistic workflow events with a mix of types
 * that the WorkflowStatusProjection can process.
 */
export function generateWorkflowEvents(
  streamId: string,
  count: number,
): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  let taskCounter = 0;

  for (let seq = 1; seq <= count; seq++) {
    const baseEvent = {
      streamId,
      sequence: seq,
      timestamp: new Date(Date.now() + seq * 1000).toISOString(),
      schemaVersion: '1.0' as const,
    };

    if (seq === 1) {
      // First event is always workflow.started
      events.push({
        ...baseEvent,
        type: 'workflow.started' as const,
        data: {
          featureId: streamId,
          workflowType: 'feature',
        },
      });
      continue;
    }

    // Distribute remaining events across types
    const bucket = seq % 5;
    let type: WorkflowEventType;
    let data: Record<string, unknown>;

    switch (bucket) {
      case 0: {
        // workflow.transition
        type = 'workflow.transition';
        const phaseIndex = seq % PHASES.length;
        data = {
          featureId: streamId,
          from: PHASES[(phaseIndex - 1 + PHASES.length) % PHASES.length],
          to: PHASES[phaseIndex],
          trigger: 'auto',
        };
        break;
      }
      case 1: {
        // task.assigned
        type = 'task.assigned';
        taskCounter++;
        data = {
          taskId: `task-${taskCounter}`,
          title: `Task ${taskCounter}`,
          branch: `feat/${streamId}-task-${taskCounter}`,
        };
        break;
      }
      case 2: {
        // task.completed
        type = 'task.completed';
        data = {
          taskId: `task-${taskCounter || 1}`,
          artifacts: ['file.ts'],
          duration: 5000,
        };
        break;
      }
      case 3: {
        // task.failed (occasional)
        type = 'task.failed';
        data = {
          taskId: `task-${taskCounter || 1}`,
          error: 'Test failure in benchmark scenario',
        };
        break;
      }
      default: {
        // workflow.transition (extra transitions)
        type = 'workflow.transition';
        const idx = seq % PHASES.length;
        data = {
          featureId: streamId,
          from: PHASES[(idx - 1 + PHASES.length) % PHASES.length],
          to: PHASES[idx],
          trigger: 'manual',
        };
        break;
      }
    }

    events.push({ ...baseEvent, type, data });
  }

  return events;
}
