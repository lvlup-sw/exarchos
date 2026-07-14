// ─── Lifecycle verb: `inspect` — single-workflow projection (DR-4) ────────────
//
// The read leg of the worktree-lifecycle verb set that answers "what is the
// state of ONE workflow?" in a single composite call: it folds the feature's
// event stream ONCE and projects
//
//   • state          — phase / workflowType / timestamps, via the CANONICAL
//                       `resolveWorkflowState` path (SQLite event store is the
//                       only source of truth — NEVER `.state.json` presence);
//   • recentEvents   — the last N event summaries (type / timestamp / sequence);
//   • correlation    — the most recent dispatch's correlation tuple
//                       (operationId / correlationId / causationId);
//   • artifacts      — the projected artifact map (design / plan / pr);
//   • taskProgress   — task roster + counts-by-status.
//
// It rides `exarchos_view` as an ACTION (INV-5d — NO new visible tool; the
// visible composite-tool count stays 4). Pure read: it appends NOTHING, on any
// path.
//
// COLD-PROBE SIDE-EFFECT-FREE INVARIANT (RCA 2026-05-30-state-source-integrity,
// the CB-2 phantom-workflow class). `inspect` on an unknown / never-`init`'d
// featureId returns `workflowExists: false` and emits ZERO events. Existence is
// answered from the event log alone — a stream with no events does not exist —
// so a cold probe never materializes a phantom stream. The handler short-circuits
// on the empty stream BEFORE any further read, guaranteeing event-count invariance
// (events-before == events-after) for the unknown-featureId path.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { resolveWorkflowState } from '../../orchestrate/resolve-state.js';
import type { WorkflowStateView } from '../workflow-state-projection.js';
import { EnvelopeSchema } from '../../schemas/envelope.js';

// ─── Bounded-output default ───────────────────────────────────────────────────

/**
 * Default `recentEvents` window when the caller omits `limit`. The full stream
 * is folded regardless (state/artifacts/tasks are complete); only the
 * event-summary tail is bounded so a long-lived workflow's `inspect` stays
 * economical. A caller passing `limit` widens or narrows just this tail.
 */
const DEFAULT_RECENT_EVENTS = 20;

// ─── Local input helpers (kept private — never user-facing flags) ─────────────

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

// ─── Pure projections over the folded stream ──────────────────────────────────

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

/**
 * The correlation tuple of the MOST RECENT event that carries any tuple field —
 * the correlation context of the workflow's latest dispatch activity. Scans from
 * the tail so the newest boundary wins; returns `undefined` when no event in the
 * stream was stamped (pre-#1291 logs / un-stamped direct appends).
 */
function latestCorrelationTuple(events: readonly WorkflowEvent[]): CorrelationTuple | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
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

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * `inspect` — project a single workflow's state, recent events + correlation
 * tuple, artifacts, and task progress in one read.
 *
 * Pure read (INV-2 — the same DispatchContext + args project an identical
 * ToolResult on the CLI and MCP facades): folds the feature stream once and
 * appends nothing. The `follow` flag is schema-declared (imported from
 * `schema-fields.ts`) so its CLI flag auto-emits; the streaming behavior lands
 * in task-009 — this handler is the single-shot projection task-009 tails.
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

  // Existence is answered from the event log ALONE (RCA 2026-05-30): the SQLite
  // event store is the only source of truth, NEVER `.state.json` presence. One
  // pure read of the stream drives both the existence check and the projections
  // below.
  const events = await eventStore.query(featureId);
  const workflowExists = events.length > 0;

  // Cold-probe short-circuit: an unknown / never-`init`'d featureId returns
  // `workflowExists: false` and emits ZERO events. We return BEFORE any further
  // read (no `resolveWorkflowState` fold, no append) so the unknown-featureId
  // path is provably event-count-invariant (events-before == events-after) —
  // the CB-2 no-phantom-stream guarantee.
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

  // State via the CANONICAL event-store-first resolver (#1504). Pure fold — no
  // append. On a materialization failure the resolver's structured error is
  // returned verbatim (INV-2 facade parity).
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

// ─── Typed output schema (DR-1 — typed `data`, NOT `EnvelopeSchema(z.unknown())`) ──
//
// Derivation discipline (mirrors `orchestrate/worktree/schemas.ts`): the MCP
// adapter `safeParse`s the REAL handler output against this schema and, on a
// miss, REPLACES the result with an INTERNAL_ERROR — so a schema STRICTER than
// the real output breaks production. Every object is declared in strip mode with
// `.passthrough()` (future field additions tolerated) and fields that are absent
// on the cold-probe branch (`state` / `artifacts` / `taskProgress` /
// `correlation`) are `.optional()` so BOTH the exists and cold-probe shapes
// validate against one schema.

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

/** `inspect` success — the single-workflow projection. */
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
