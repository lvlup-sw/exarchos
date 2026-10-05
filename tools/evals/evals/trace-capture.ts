import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { EvalCase } from './types.js';

export interface CaptureOptions {
  /** Filter events by skill/source. */
  skill?: string | undefined;
}

/** Event types that represent the start of an action (input). */
const INPUT_EVENT_TYPES = new Set([
  'workflow.started',
  'workflow.transition',
  'task.assigned',
  'task.claimed',
]);

/** Event types that represent the completion of an action (output). */
const OUTPUT_EVENT_TYPES = new Set([
  'task.completed',
  'task.failed',
  'workflow.cleanup',
  'workflow.cancel',
]);

/**
 * Extracts regression trace cases from workflow events. An output event pairs with the most recent
 * unpaired input event. An output with no unpaired input gives no case. A last input event with no
 * output becomes an `unmatched` case.
 */
export function captureTrace(
  events: WorkflowEvent[],
  options?: CaptureOptions,
): EvalCase[] {
  if (events.length === 0) return [];

  const filtered = options?.skill
    ? events.filter((e) => e.source === options.skill)
    : events;

  if (filtered.length === 0) return [];

  const cases: EvalCase[] = [];
  let pendingInput: WorkflowEvent | null = null;

  for (const event of filtered) {
    if (INPUT_EVENT_TYPES.has(event.type)) {
      pendingInput = event;
    } else if (OUTPUT_EVENT_TYPES.has(event.type) && pendingInput) {
      const caseId = `trace-${pendingInput.sequence}-${event.sequence}`;
      const skillLabel = options?.skill ?? event.source ?? 'unknown';

      cases.push({
        id: caseId,
        type: 'trace',
        description: `Captured trace from ${skillLabel}: ${pendingInput.type} -> ${event.type}`,
        input: {
          ...(pendingInput.data ?? {}),
          eventType: pendingInput.type,
        },
        expected: {
          ...(event.data ?? {}),
          eventType: event.type,
        },
        tags: ['captured'],
        layer: 'regression',
      });

      pendingInput = null;
    }
  }

  if (pendingInput) {
    const skillLabel = options?.skill ?? pendingInput.source ?? 'unknown';
    cases.push({
      id: `trace-${pendingInput.sequence}-unmatched`,
      type: 'trace',
      description: `Captured trace from ${skillLabel}: ${pendingInput.type} (unmatched)`,
      input: {
        ...(pendingInput.data ?? {}),
        eventType: pendingInput.type,
      },
      expected: {},
      tags: ['captured'],
      layer: 'regression',
    });
  }

  return cases;
}
