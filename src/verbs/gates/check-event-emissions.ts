// ─── Check Event Emissions Composite Action ─────────────────────────────────
//
// Queries the event stream for a workflow and checks whether expected
// model-emitted events are present for the current phase. Returns structured
// hints for missing events and emits a gate.executed event for traceability.
// ────────────────────────────────────────────────────────────────────────────

import type { EventType } from '../../events/schemas.js';
import { EVENT_DATA_SCHEMAS, EVENT_EMISSION_REGISTRY } from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { foldToTail } from '../../projections/fold-at-tail.js';
import { getOrCreateMaterializer } from '../../projections/views/tools.js';
import { WORKFLOW_STATE_VIEW } from '../../projections/views/workflow-state-projection.js';
import type { WorkflowStateView } from '../../projections/views/workflow-state-projection.js';
import { emitGateEvent } from './gate-utils.js';
import { getRegisteredEventTypes } from '../../projections/rehydration/reducer.js';

// ─── Phase-to-Expected-Events Registry ──────────────────────────────────────
//
// Source-of-truth for the delegate / overhaul-delegate phases is the
// rehydration reducer (Fix 3 / #1180, DIM-3) — `getRegisteredEventTypes`
// returns the canonical event set the reducer recognises for each phase,
// and the playbook events list derives from the same accessor. Both
// surfaces filter the SoT to model-emitted events here (auto-emitted
// task.completed / task.failed are recognised by the reducer for state
// folding but never appear in hints/playbook because the model never emits
// them directly). Other phases continue to declare their expected-events
// inline because the reducer does not yet model them.

/**
 * Filter a SoT event-type list to only those whose emission source is `model`.
 * Throws on any input event name that isn't registered in EVENT_EMISSION_REGISTRY,
 * so a typo in the reducer's SoT registry can never silently disappear from the
 * derived phase-expected-events list (which would mask drift between SoT and
 * the registry — exactly the DIM-3 contract violation #1180 was filed against).
 *
 * A `retired` source also throws rather than filters. Filtering is for events
 * the runtime emits so the model is not nagged for them; a retired event is
 * emitted by NOBODY, so an expectation naming one is stale prose, and dropping
 * it silently is how a demotion empties an expectation list while every check
 * over that list stays green. Retiring the event and deleting its expectation
 * belong in the same change, and this throw is what couples them.
 *
 * The registry is injectable for the same reason the audits in `src/events`
 * take theirs as parameters: the throw paths must be provable with a seeded
 * registry, not just believed about the live one. It is a map because the
 * registry's key union does not carry a string index signature, and a cast
 * here would trade the type system away to avoid one `Object.entries`.
 */
const LIVE_EMISSION_SOURCES: ReadonlyMap<string, string> = new Map(
  Object.entries(EVENT_EMISSION_REGISTRY),
);

export function modelEmittedOnly(
  types: readonly string[],
  registry: ReadonlyMap<string, string> = LIVE_EMISSION_SOURCES,
): readonly EventType[] {
  const out: EventType[] = [];
  for (const t of types) {
    const source = registry.get(t);
    if (source === undefined) {
      throw new Error(
        `modelEmittedOnly: '${t}' is not registered in EVENT_EMISSION_REGISTRY — ` +
          `register it (or fix the typo at the SoT) so phase-expected-events stays consistent.`,
      );
    }
    if (source === 'retired') {
      throw new Error(
        `modelEmittedOnly: '${t}' is retired and still expected — nobody emits a retired event, ` +
          `so this expectation can never be met. Delete the expectation in the same change that ` +
          `retires the event.`,
      );
    }
    if (source === 'model') out.push(t as EventType);
  }
  return out;
}

// RC2 (#1395): `review.routed` was removed from every phase entry below — it is
// now auto-emitted by handleReviewTriage (review/tools.ts), so the model is no
// longer nagged for it. The surviving team.* / stack.submitted / shepherd.*
// entries stay model-emitted (Category C): their transition is a model-walked
// runbook step bracketing a `native:` harness tool, so auto-emission needs a
// runbook-executor seam (deferred to v2.11 / #1258). Re-adding an `'auto'`
// event here will trip the compile-time assertion immediately below.
export const PHASE_EXPECTED_EVENTS: Readonly<Record<string, readonly EventType[]>> = {
  'delegate': modelEmittedOnly(getRegisteredEventTypes('delegate')),
  'overhaul-delegate': modelEmittedOnly(getRegisteredEventTypes('overhaul-delegate')),
  'review': ['team.spawned', 'team.task.planned', 'team.teammate.dispatched', 'team.disbanded'],
  'overhaul-review': ['team.spawned', 'team.task.planned', 'team.teammate.dispatched', 'team.disbanded'],
  'synthesize': ['team.spawned', 'team.disbanded', 'stack.submitted', 'shepherd.iteration'],
  'overhaul-update-docs': ['team.spawned', 'team.disbanded'],
};

/**
 * Load-time assertions over an expectation table: every listed event is
 * model-emitted, and no phase's list is EMPTY. The emptiness arm exists
 * because the derived rows go through a filter — demote every event a phase
 * expects and the row silently becomes `[]`, after which the gate reads
 * "nothing expected" as "nothing missing" and reports complete over a hole.
 * An empty expectation row is a phase with no oracle, and that is a decision
 * to record by deleting the row, never a state to drift into.
 *
 * Exported with an injectable registry so both throw paths are provable with
 * seeded fixtures rather than trusted.
 */
export function assertExpectationsLive(
  expectations: Readonly<Record<string, readonly EventType[]>>,
  registry: ReadonlyMap<string, string> = LIVE_EMISSION_SOURCES,
): void {
  for (const [phase, eventTypes] of Object.entries(expectations)) {
    if (eventTypes.length === 0) {
      throw new Error(
        `PHASE_EXPECTED_EVENTS['${phase}'] is empty — a phase with no expected events has no ` +
          `oracle, and the gate would report it complete unconditionally. Delete the row if the ` +
          `phase genuinely expects nothing; do not leave an empty list.`,
      );
    }
    for (const eventType of eventTypes) {
      if (registry.get(eventType) !== 'model') {
        throw new Error(
          `PHASE_EXPECTED_EVENTS contains non-model event '${eventType}' (source: ${registry.get(eventType)})`,
        );
      }
    }
  }
}

assertExpectationsLive(PHASE_EXPECTED_EVENTS);

// ─── Human-Readable Descriptions for Event Types ────────────────────────────

const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'team.spawned': 'Emit team.spawned via exarchos_event after creating the team',
  'team.task.planned': 'Emit team.task.planned via exarchos_event for each planned task',
  'team.teammate.dispatched': 'Emit team.teammate.dispatched via exarchos_event after dispatching subagents',
  'team.disbanded': 'Emit team.disbanded via exarchos_event after all teammates complete',
  // review.routed description removed in RC2 (#1395): now auto-emitted, never a
  // model-emitted hint, so its description is dead. DIM-5 hygiene.
  'stack.submitted': 'Emit stack.submitted via exarchos_event after submitting the PR stack',
  'shepherd.iteration': 'Emit shepherd.iteration via exarchos_event after each shepherd loop iteration',
  'task.progressed': 'Emit task.progressed via exarchos_event after each TDD phase transition (red/green/refactor)',
};

/**
 * Load-time assertion over the description table: every key names a
 * registered, model-emitted event. Each description is an instruction to the
 * model to emit the event, so a key whose event was demoted or retired is a
 * standing instruction to emit something the catalog says the model does not
 * emit — stale prose the registry's own checks cannot see, because nothing
 * else joins this table back to the catalog. Exported with an injectable
 * registry so the throw path is provable with a seeded fixture.
 */
export function assertDescriptionsLive(
  descriptions: Readonly<Record<string, string>>,
  registry: ReadonlyMap<string, string> = LIVE_EMISSION_SOURCES,
): void {
  for (const eventType of Object.keys(descriptions)) {
    const source = registry.get(eventType);
    if (source !== 'model') {
      throw new Error(
        `EVENT_DESCRIPTIONS instructs the model to emit '${eventType}', whose emission source ` +
          `is ${source === undefined ? 'unregistered' : `'${source}'`} — the model does not emit ` +
          `it, so the instruction is stale. Delete the entry in the same change that moved the ` +
          `event.`,
      );
    }
  }
}

assertDescriptionsLive(EVENT_DESCRIPTIONS);

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
        description: EVENT_DESCRIPTIONS[eventType] ?? `Missing expected event: ${eventType}`,
        ...(requiredFields && requiredFields.length > 0 ? { requiredFields } : {}),
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
