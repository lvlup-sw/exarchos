import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Gate Names ────────────────────────────────────────────────────────────

const GATE_NAMES = [
  'typecheck',
  'lint',
  'test',
  'build',
  'coverage',
] as const;

const SKILLS = [
  'delegation',
  'review',
  'synthesis',
  'ideation',
  'planning',
] as const;

// ─── Gate Executed Event Factory ───────────────────────────────────────────

/**
 * Create a realistic `gate.executed` event for benchmarking.
 */
export function createGateExecutedEvent(
  sequence: number,
  streamId: string,
): WorkflowEvent {
  const gateName = GATE_NAMES[sequence % GATE_NAMES.length];
  const skill = SKILLS[sequence % SKILLS.length];
  const passed = sequence % 7 !== 0; // ~14% failure rate
  const duration = 50 + (sequence % 200);

  return {
    streamId,
    sequence,
    timestamp: new Date(Date.now() - (1000 - sequence) * 1000).toISOString(),
    type: 'gate.executed',
    schemaVersion: '1.0',
    data: {
      gateName,
      layer: 'unit',
      passed,
      duration,
      details: {
        skill,
        commit: `abc${sequence.toString(16).padStart(4, '0')}`,
        reason: passed ? undefined : 'assertion failure',
      },
    },
  };
}

// ─── Mixed Event Factories ─────────────────────────────────────────────────

const MIXED_EVENT_TYPES = [
  'workflow.started',
  'task.assigned',
  'task.completed',
  'task.failed',
  'gate.executed',
  'workflow.transition',
  'stack.position-filled',
  'benchmark.completed',
] as const;

type MixedEventType = typeof MIXED_EVENT_TYPES[number];

function createEventData(type: MixedEventType, sequence: number): Record<string, unknown> {
  switch (type) {
    case 'workflow.started':
      return { featureId: `feat-${sequence}`, workflowType: 'feature' };
    case 'task.assigned':
      return { taskId: `task-${sequence}`, title: `Task ${sequence}` };
    case 'task.completed':
      return { taskId: `task-${sequence}`, artifacts: [`file-${sequence}.ts`] };
    case 'task.failed':
      return { taskId: `task-${sequence}`, error: `Error at step ${sequence}` };
    case 'gate.executed':
      return {
        gateName: GATE_NAMES[sequence % GATE_NAMES.length],
        layer: 'unit',
        passed: sequence % 5 !== 0,
        duration: 30 + (sequence % 150),
        details: {
          skill: SKILLS[sequence % SKILLS.length],
          commit: `mix${sequence.toString(16).padStart(4, '0')}`,
        },
      };
    case 'workflow.transition':
      return { from: 'planning', to: 'implementing', trigger: 'auto', featureId: `feat-${sequence}` };
    case 'stack.position-filled':
      return { position: sequence % 10, taskId: `task-${sequence}`, branch: `branch-${sequence}` };
    case 'benchmark.completed':
      return {
        taskId: `bench-${sequence}`,
        results: [{
          operation: 'test-op',
          metric: 'p99',
          value: 1.5 + (sequence % 10) * 0.1,
          unit: 'ms',
          passed: true,
        }],
      };
    default:
      return {};
  }
}

/**
 * Create an array of mixed event types for benchmarking.
 * Events cycle through various types to simulate realistic workload.
 */
export function createMixedEvents(
  count: number,
  streamId: string,
): WorkflowEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const sequence = i + 1;
    const type = MIXED_EVENT_TYPES[i % MIXED_EVENT_TYPES.length];

    return {
      streamId,
      sequence,
      timestamp: new Date(Date.now() - (count - i) * 1000).toISOString(),
      type,
      schemaVersion: '1.0',
      data: createEventData(type, sequence),
    };
  });
}
