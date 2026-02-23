import type { WorkflowEvent } from '../event-store/schemas.js';
import type { EvalCase } from './types.js';

// ─── Options ────────────────────────────────────────────────────────────────

export interface CaptureOptions {
  /** Filter events by skill/source. */
  skill?: string;
}

// ─── Paired Event Types ─────────────────────────────────────────────────────

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

// ─── Core Capture Logic ─────────────────────────────────────────────────────

/**
 * Extract eval cases from a sequence of workflow events.
 *
 * Pairs input events (workflow.started, workflow.transition, task.assigned)
 * with their corresponding output events (task.completed, task.failed) to
 * create trace-type eval cases suitable for regression testing.
 */
export function captureTrace(
  events: WorkflowEvent[],
  options?: CaptureOptions,
): EvalCase[] {
  if (events.length === 0) return [];

  // Optionally filter events by skill/source
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
          eventType: pendingInput.type,
          ...(pendingInput.data ?? {}),
        },
        expected: {
          eventType: event.type,
          ...(event.data ?? {}),
        },
        tags: ['captured'],
      });

      pendingInput = null;
    }
  }

  // If there's a trailing input with no matching output, capture it
  if (pendingInput) {
    const skillLabel = options?.skill ?? pendingInput.source ?? 'unknown';
    cases.push({
      id: `trace-${pendingInput.sequence}-unmatched`,
      type: 'trace',
      description: `Captured trace from ${skillLabel}: ${pendingInput.type} (unmatched)`,
      input: {
        eventType: pendingInput.type,
        ...(pendingInput.data ?? {}),
      },
      expected: {},
      tags: ['captured'],
    });
  }

  return cases;
}
