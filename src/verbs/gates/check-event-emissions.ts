/**
 * check_event_emissions: checks that the model-emitted events that the current
 * phase expects are in the event stream of the workflow. It returns a hint for
 * each missing event. For a phase with expected events, it records a
 * `gate.executed` event.
 *
 * `PHASE_EXPECTED_EVENTS` and `EVENT_DESCRIPTIONS` are projections of the phase
 * event contract in `workflow/topology/phase-events.ts`, so neither can drift
 * from the other. The verdict depends on each listed type, so each row is a
 * dependency.
 */

import type { EventType } from '../../events/schemas.js';
import { EVENT_DATA_SCHEMAS } from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { foldToTail } from '../../projections/fold-at-tail.js';
import { getOrCreateMaterializer } from '../../projections/views/tools.js';
import { WORKFLOW_STATE_VIEW } from '../../projections/views/workflow-state-projection.js';
import type { WorkflowStateView } from '../../projections/views/workflow-state-projection.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';
import {
  PHASE_EVENT_CONTRACTS,
  expectedEventsByPhase,
  hintDescriptions,
} from '../../workflow/topology/phase-events.js';

/** Phase → the model-emitted events the gate checks, in emission order. */
export const PHASE_EXPECTED_EVENTS: Readonly<Record<string, readonly EventType[]>> =
  expectedEventsByPhase(PHASE_EVENT_CONTRACTS);

/** The hint for a missing expected event. It has a row for each listed type. */
export const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> =
  hintDescriptions(PHASE_EVENT_CONTRACTS);

/**
 * Returns the hint for an expected event. Both tables project the same contract
 * rows, so a miss is a bug. It throws, because a generic hint reads as a
 * complete answer.
 */
function descriptionOf(eventType: EventType): string {
  const description = EVENT_DESCRIPTIONS[eventType];
  if (description === undefined) {
    throw new Error(
      `EVENT_DESCRIPTIONS has no row for expected event '${eventType}' — both tables derive ` +
        'from PHASE_EVENT_CONTRACTS, so this cannot happen at load.',
    );
  }
  return description;
}

interface CheckEventEmissionsArgs {
  readonly featureId: string;
  readonly workflowId?: string;
}

export interface EventEmissionHint {
  readonly eventType: EventType;
  readonly description: string;
  readonly requiredFields?: readonly string[];
}

export interface CheckEventEmissionsResult {
  readonly phase: string;
  readonly hints: readonly EventEmissionHint[];
  readonly complete: boolean;
  readonly checked: number;
  readonly missing: number;
}

/** Extracts required field names from a Zod object schema for an event type. */
function extractRequiredFields(eventType: EventType): string[] | undefined {
  const schema = EVENT_DATA_SCHEMAS[eventType];
  if (!schema) return undefined;
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape) return undefined;
  return Object.entries(shape)
    .filter(([, field]) => {
      const fieldDef = (field as { _def?: { typeName?: string } })._def;
      return fieldDef?.typeName !== 'ZodOptional';
    })
    .map(([name]) => name);
}

/**
 * Checks the expected events for the current phase. It folds the workflow-state
 * view to the durable tail to read the phase. It reads events only up to that
 * fold sequence, so events from a later phase cannot mark this phase complete.
 * A phase with no table row is complete with zero checks and records no gate event.
 */
export async function handleCheckEventEmissions(
  args: CheckEventEmissionsArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
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

  const store = eventStore;
  const materializer = getOrCreateMaterializer(stateDir);
  const streamId = args.workflowId ?? args.featureId;

  const { view, sequence } = await foldToTail<WorkflowStateView>(
    store,
    materializer,
    streamId,
    WORKFLOW_STATE_VIEW,
  );

  const phase = view.phase;
  const expectedEvents = PHASE_EXPECTED_EVENTS[phase];

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

  const events = (await store.query(streamId)).filter((e) => e.sequence <= sequence);
  const presentTypes = new Set(events.map((e) => e.type));

  const hints: EventEmissionHint[] = [];
  for (const eventType of expectedEvents) {
    if (!presentTypes.has(eventType)) {
      const requiredFields = extractRequiredFields(eventType);
      hints.push({
        eventType,
        description: descriptionOf(eventType),
        ...(requiredFields && requiredFields.length > 0 ? { requiredFields } : {}),
      });
    }
  }

  const checked = expectedEvents.length;
  const missing = hints.length;
  const complete = missing === 0;

  const carrier: ToolResult = {
    success: true,
    data: {
      phase,
      hints,
      complete,
      checked,
      missing,
    } satisfies CheckEventEmissionsResult,
  };

  const unrecorded = await requireGateEvent(
    store,
    streamId,
    'event-emissions',
    'observability',
    complete,
    carrier,
    {
      phase,
      checked,
      missing,
      missingTypes: hints.map((h) => h.eventType),
    },
    sameOperationGateKey('event-emissions'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
