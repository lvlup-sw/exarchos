// ─── Check Event Emissions Composite Action ─────────────────────────────────
//
// Queries the event stream for a workflow and checks whether expected
// model-emitted events are present for the current phase. Returns structured
// hints for missing events and emits a gate.executed event for traceability.
// ────────────────────────────────────────────────────────────────────────────

import type { EventType } from '../event-store/schemas.js';
import { EVENT_EMISSION_REGISTRY } from '../event-store/schemas.js';
import type { ToolResult } from '../format.js';
import {
  getOrCreateEventStore,
  getOrCreateMaterializer,
  queryDeltaEvents,
} from '../views/tools.js';
import { WORKFLOW_STATE_VIEW } from '../views/workflow-state-projection.js';
import type { WorkflowStateView } from '../views/workflow-state-projection.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Phase-to-Expected-Events Registry ──────────────────────────────────────

export const PHASE_EXPECTED_EVENTS: Readonly<Record<string, readonly EventType[]>> = {
  'delegate': ['team.spawned', 'team.task.planned', 'team.teammate.dispatched', 'task.progressed'],
  'overhaul-delegate': ['team.spawned', 'team.task.planned', 'team.teammate.dispatched'],
  'review': ['team.spawned', 'team.task.planned', 'team.teammate.dispatched', 'team.disbanded', 'review.routed'],
  'overhaul-review': ['team.spawned', 'team.task.planned', 'team.teammate.dispatched', 'team.disbanded', 'review.routed'],
  'synthesize': ['team.spawned', 'team.disbanded', 'review.routed', 'stack.submitted', 'shepherd.iteration'],
  'overhaul-update-docs': ['team.spawned', 'team.disbanded', 'review.routed'],
};

// Compile-time assertion: every event in the registry must be model-emitted
for (const [, eventTypes] of Object.entries(PHASE_EXPECTED_EVENTS)) {
  for (const eventType of eventTypes) {
    if (EVENT_EMISSION_REGISTRY[eventType] !== 'model') {
      throw new Error(
        `PHASE_EXPECTED_EVENTS contains non-model event '${eventType}' (source: ${EVENT_EMISSION_REGISTRY[eventType]})`,
      );
    }
  }
}

// ─── Human-Readable Descriptions for Event Types ────────────────────────────

const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'team.spawned': 'Emit team.spawned via exarchos_event after creating the team',
  'team.task.planned': 'Emit team.task.planned via exarchos_event for each planned task',
  'team.teammate.dispatched': 'Emit team.teammate.dispatched via exarchos_event after dispatching subagents',
  'team.disbanded': 'Emit team.disbanded via exarchos_event after all teammates complete',
  'review.routed': 'Emit review.routed via exarchos_event after routing PRs to review',
  'stack.submitted': 'Emit stack.submitted via exarchos_event after submitting the PR stack',
  'shepherd.iteration': 'Emit shepherd.iteration via exarchos_event after each shepherd loop iteration',
  'task.progressed': 'Emit task.progressed via exarchos_event after each TDD phase transition (red/green/refactor)',
};

// ─── Types ─────────────────────────────────────────────────────────────────

interface CheckEventEmissionsArgs {
  readonly featureId: string;
  readonly workflowId?: string;
}

export interface EventEmissionHint {
  readonly eventType: EventType;
  readonly description: string;
}

export interface CheckEventEmissionsResult {
  readonly phase: string;
  readonly hints: readonly EventEmissionHint[];
  readonly complete: boolean;
  readonly checked: number;
  readonly missing: number;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleCheckEventEmissions(
  args: CheckEventEmissionsArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const SAFE_STREAM_ID = /^[a-z0-9-]+$/;
  if (!SAFE_STREAM_ID.test(args.featureId)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId must match /^[a-z0-9-]+$/' },
    };
  }
  if (args.workflowId && !SAFE_STREAM_ID.test(args.workflowId)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'workflowId must match /^[a-z0-9-]+$/' },
    };
  }

  const store = getOrCreateEventStore(stateDir);
  const materializer = getOrCreateMaterializer(stateDir);
  const streamId = args.workflowId ?? args.featureId;

  // Materialize workflow state view to get the current phase
  const stateEvents = await queryDeltaEvents(store, materializer, streamId, WORKFLOW_STATE_VIEW);
  const view = materializer.materialize<WorkflowStateView>(
    streamId,
    WORKFLOW_STATE_VIEW,
    stateEvents,
  );

  const phase = view.phase;
  const expectedEvents = PHASE_EXPECTED_EVENTS[phase];

  // Phase not in registry — no expectations, return empty
  if (!expectedEvents) {
    return {
      success: true,
      data: {
        phase,
        hints: [],
        complete: true,
        checked: 0,
        missing: 0,
      } satisfies CheckEventEmissionsResult,
    };
  }

  // Query all events from the stream
  const events = await store.query(streamId);
  const presentTypes = new Set(events.map((e) => e.type));

  // Check which expected events are missing
  const hints: EventEmissionHint[] = [];
  for (const eventType of expectedEvents) {
    if (!presentTypes.has(eventType)) {
      hints.push({
        eventType,
        description: EVENT_DESCRIPTIONS[eventType] ?? `Missing expected event: ${eventType}`,
      });
    }
  }

  const checked = expectedEvents.length;
  const missing = hints.length;
  const complete = missing === 0;

  // Emit gate.executed event (fire-and-forget)
  try {
    await emitGateEvent(store, streamId, 'event-emissions', 'observability', complete, {
      phase,
      checked,
      missing,
      missingTypes: hints.map((h) => h.eventType),
    });
  } catch { /* fire-and-forget */ }

  return {
    success: true,
    data: {
      phase,
      hints,
      complete,
      checked,
      missing,
    } satisfies CheckEventEmissionsResult,
  };
}
