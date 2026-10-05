/**
 * The `inspect` lifecycle verb, an action of `exarchos_view`. It returns the state, recent events, last correlation tuple, artifacts and task progress of one workflow.
 * It appends no event on any path. Existence comes from the event log alone, never from a `.state.json` file.
 * For an unknown featureId, it returns `workflowExists: false` before any other read. Thus a cold probe creates no phantom stream.
 */

import { z } from 'zod';

import type { DispatchContext } from '../../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../../format.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import { resolveWorkflowState } from '../../../verbs/resolve-state.js';
import type { WorkflowStateView } from '../workflow-state-projection.js';
import { EnvelopeSchema } from '../../../contract/schemas/envelope.js';

/** Size of the `recentEvents` tail when the caller omits `limit`. The handler reads the full stream, and only this tail has a bound. */
const DEFAULT_RECENT_EVENTS = 20;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parse a positive integer (>= 1) from a number or numeric string (coerced flags). */
function optionalPosInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return n >= 1 ? n : undefined;
  }
  return undefined;
}

function invalidInput(message: string, expectedShape?: Record<string, unknown>): ToolResult {
  return {
    success: false,
    error: { code: 'INVALID_INPUT', message, ...(expectedShape ? { expectedShape } : {}) },
  };
}

/** Compact event-summary line for the `recentEvents` tail. */
interface EventSummary {
  readonly type: string;
  readonly timestamp: string;
  readonly sequence: number;
  readonly source?: string;
}

function summarizeEvent(event: WorkflowEvent): EventSummary {
  return {
    type: event.type,
    timestamp: event.timestamp,
    sequence: event.sequence,
    ...(typeof event.source === 'string' ? { source: event.source } : {}),
  };
}

/** The dispatch-boundary correlation tuple (#1291). */
interface CorrelationTuple {
  readonly operationId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/** Returns the correlation tuple of the newest event that has a tuple field, or `undefined` when no event has one. */
function latestCorrelationTuple(events: readonly WorkflowEvent[]): CorrelationTuple | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.operationId !== undefined || ev.correlationId !== undefined || ev.causationId !== undefined) {
      return {
        ...(ev.operationId !== undefined ? { operationId: ev.operationId } : {}),
        ...(ev.correlationId !== undefined ? { correlationId: ev.correlationId } : {}),
        ...(ev.causationId !== undefined ? { causationId: ev.causationId } : {}),
      };
    }
  }
  return undefined;
}

/** Task-progress roll-up: full roster + counts-by-status. */
interface TaskProgress {
  readonly total: number;
  readonly byStatus: Record<string, number>;
  readonly tasks: ReadonlyArray<Record<string, unknown>>;
}

function projectTaskProgress(state: WorkflowStateView): TaskProgress {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const byStatus: Record<string, number> = {};
  for (const t of tasks) {
    const status = typeof t.status === 'string' ? t.status : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    total: tasks.length,
    byStatus,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      ...(t.branch !== undefined ? { branch: t.branch } : {}),
      ...(t.worktreePath !== undefined ? { worktreePath: t.worktreePath } : {}),
      ...(t.completedAt !== undefined ? { completedAt: t.completedAt } : {}),
    })),
  };
}

/**
 * Returns the `inspect` projection of one workflow. A `resolveWorkflowState` error returns unchanged.
 * The CLI implements `--follow` in `cli/follow-loop.ts`, and this handler is the one-shot read.
 */
export async function handleViewInspect(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const featureId = optionalString(args.featureId);
  if (!featureId) {
    return invalidInput('inspect requires featureId: string', { featureId: 'string' });
  }

  const { eventStore } = ctx;

  const events = await eventStore.query(featureId);
  const workflowExists = events.length > 0;

  if (!workflowExists) {
    return {
      success: true,
      data: {
        featureId,
        workflowExists: false,
        recentEvents: [],
        eventCount: 0,
      },
      _meta: { workflowExists: false },
    };
  }

  const resolved = await resolveWorkflowState({ featureId, eventStore });
  if ('error' in resolved) {
    return resolved.error;
  }
  const state = resolved.state as unknown as WorkflowStateView;

  const limit = optionalPosInt(args.limit) ?? DEFAULT_RECENT_EVENTS;
  const recentEvents = events.slice(-limit).map(summarizeEvent);
  const correlation = latestCorrelationTuple(events);

  return {
    success: true,
    data: {
      featureId,
      workflowExists: true,
      state: {
        phase: state.phase,
        workflowType: state.workflowType,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      },
      artifacts: state.artifacts,
      taskProgress: projectTaskProgress(state),
      recentEvents,
      ...(correlation !== undefined ? { correlation } : {}),
      eventCount: events.length,
    },
    _meta: { workflowExists: true },
  };
}

const EventSummarySchema = z
  .object({
    type: z.string(),
    timestamp: z.string(),
    sequence: z.number(),
    source: z.string().optional(),
  })
  .passthrough();

const CorrelationTupleSchema = z
  .object({
    operationId: z.string().optional(),
    correlationId: z.string().optional(),
    causationId: z.string().optional(),
  })
  .passthrough();

const InspectStateSchema = z
  .object({
    phase: z.string(),
    workflowType: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const TaskProgressSchema = z
  .object({
    total: z.number(),
    byStatus: z.record(z.string(), z.number()),
    tasks: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

/**
 * The `data` schema of an `inspect` success. The MCP adapter checks the real output against it, and replaces a mismatch with `INTERNAL_ERROR`.
 * Thus each object uses `.passthrough()`, and the fields that the cold-probe branch omits are optional.
 */
const InspectData = z
  .object({
    featureId: z.string(),
    workflowExists: z.boolean(),
    recentEvents: z.array(EventSummarySchema),
    eventCount: z.number(),
    state: InspectStateSchema.optional(),
    artifacts: z.record(z.string(), z.unknown()).optional(),
    taskProgress: TaskProgressSchema.optional(),
    correlation: CorrelationTupleSchema.optional(),
  })
  .passthrough();

export const InspectOutputSchema = EnvelopeSchema(InspectData);
