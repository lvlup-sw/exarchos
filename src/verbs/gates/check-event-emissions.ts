// ─── Check Event Emissions Composite Action ─────────────────────────────────
//
// Queries the event stream for a workflow and checks whether expected
// model-emitted events are present for the current phase. Returns structured
// hints for missing events and emits a gate.executed event for traceability.
// ────────────────────────────────────────────────────────────────────────────

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

// ─── Phase-to-Expected-Events Table ─────────────────────────────────────────
//
// Both tables below are PROJECTIONS of the phase event contract
// (`workflow/topology/phase-events.ts`): the phase → expected-events map and
// the hint the gate returns for a missing one. Neither is authored here, so
// neither can drift from the playbooks or from each other. The refusals that
// used to fire at this load site — a non-model expectation, a retired one, an
// empty row, a hint no expectation reaches — fire where the contract loads.
//
// A row here is a dependency: the gate's complete/incomplete verdict is a
// function of every listed type's presence. That is why a type leaving
// governance under the event-authority charter deletes its contract row in the
// same commit, and why re-adding one is a re-promotion that needs a
// gate-expectation witness in the partition.

/** Phase → the model-emitted events the gate checks, in emission order. */
export const PHASE_EXPECTED_EVENTS: Readonly<Record<string, readonly EventType[]>> =
  expectedEventsByPhase(PHASE_EVENT_CONTRACTS);

/** The hint returned for a missing expected event; total over every listed type. */
export const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> =
  hintDescriptions(PHASE_EVENT_CONTRACTS);

/**
 * Total over every expected event, because both tables project the same
 * contract rows. A miss here means the tables changed after load; it is a
 * bug, and it throws rather than substituting a generic hint that would read
 * as a complete answer.
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

// ─── Types ─────────────────────────────────────────────────────────────────

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

// ─── Zod Schema Introspection ─────────────────────────────────────────────

/** Extracts required field names from a Zod object schema for an event type. */
function extractRequiredFields(eventType: EventType): string[] | undefined {
  const schema = EVENT_DATA_SCHEMAS[eventType];
  if (!schema) return undefined;
  // Use Zod's public .shape getter (available on all z.object() schemas)
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape) return undefined;
  return Object.entries(shape)
    .filter(([, field]) => {
      const fieldDef = (field as { _def?: { typeName?: string } })._def;
      return fieldDef?.typeName !== 'ZodOptional';
    })
    .map(([name]) => name);
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleCheckEventEmissions(
  args: CheckEventEmissionsArgs,
  stateDir: string,
  eventStore: EventStore,
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

  const store = eventStore;
  const materializer = getOrCreateMaterializer(stateDir);
  const streamId = args.workflowId ?? args.featureId;

  // Fold the workflow-state view to the durable tail to read the current
  // phase. This is one of the folds #1855 was about: it lands in the shared
  // view materializer and no `exarchos_view` action refreshes it, so before
  // the seam it was the entry that went stale and stayed stale.
  const { view, sequence } = await foldToTail<WorkflowStateView>(
    store,
    materializer,
    streamId,
    WORKFLOW_STATE_VIEW,
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

  // The phase came from a fold covering `sequence`; the evidence for that
  // phase must stop there too. An unbounded read would let events appended
  // after the fold answer for a phase that predates them — reporting a phase
  // complete on emissions belonging to the next one.
  const events = (await store.query(streamId)).filter((e) => e.sequence <= sequence);
  const presentTypes = new Set(events.map((e) => e.type));

  // Check which expected events are missing
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
