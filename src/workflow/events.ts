import type { Event, EventType } from './types.js';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
import { ADMISSION_EVENT_TYPE_VALUES } from './admission/types.js';

/** The cap of the event log. The `EVENT_LOG_MAX` environment variable sets it, and the default is 100. */
export const EVENT_LOG_MAX = (() => {
  const envVal = parseInt(process.env.EVENT_LOG_MAX || '', 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 100;
})();

/**
 * Appends an event to the log and increments the sequence number.
 * When the log exceeds the cap, the oldest events go first. The function returns a new array.
 */
export function appendEvent(
  events: readonly Event[],
  eventSequence: number,
  type: EventType,
  trigger: string,
  options?: { from?: string; to?: string; metadata?: Record<string, unknown> },
): { events: Event[]; eventSequence: number; event: Event } {
  const nextSequence = eventSequence + 1;

  const event: Event = {
    sequence: nextSequence,
    version: '1.0',
    timestamp: new Date().toISOString(),
    type,
    trigger,
    ...(options?.from !== undefined && { from: options.from }),
    ...(options?.to !== undefined && { to: options.to }),
    ...(options?.metadata !== undefined && { metadata: options.metadata }),
  };

  let newEvents = [...events, event];

  if (newEvents.length > EVENT_LOG_MAX) {
    newEvents = newEvents.slice(newEvents.length - EVENT_LOG_MAX);
  }

  return {
    events: newEvents,
    eventSequence: nextSequence,
    event,
  };
}

/** Counts the fix-cycle events of a compound state after its last compound-entry event. */
export function getFixCycleCount(events: readonly Event[], compoundStateId: string): number {
  let lastEntryIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt === undefined) continue;
    if (
      evt.type === 'compound-entry' &&
      evt.metadata?.compoundStateId === compoundStateId
    ) {
      lastEntryIndex = i;
      break;
    }
  }

  if (lastEntryIndex === -1) {
    return 0;
  }

  let count = 0;
  for (let i = lastEntryIndex + 1; i < events.length; i++) {
    const evt = events[i];
    if (evt === undefined) continue;
    if (
      evt.type === 'fix-cycle' &&
      evt.metadata?.compoundStateId === compoundStateId
    ) {
      count++;
    }
  }

  return count;
}

/** Returns the N most recent events from the log. */
export function getRecentEvents(events: readonly Event[], count: number): Event[] {
  if (count <= 0) return [];
  return events.slice(-count);
}

/**
 * Returns the duration of a phase in milliseconds, or null when the phase has no exit or entry transition.
 * The duration starts at the most recent entry at or before the most recent exit.
 */
export function getPhaseDuration(events: readonly Event[], phase: string): number | null {
  let entryTimestamp: string | null = null;
  let exitTimestamp: string | null = null;

  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt === undefined) continue;
    if (evt.type === 'transition' && evt.from === phase && exitTimestamp === null) {
      exitTimestamp = evt.timestamp;
    }
  }

  if (exitTimestamp === null) return null;

  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt === undefined) continue;
    if (evt.type === 'transition' && evt.to === phase) {
      if (evt.timestamp <= exitTimestamp) {
        entryTimestamp = evt.timestamp;
        break;
      }
    }
  }

  if (entryTimestamp === null) return null;

  return new Date(exitTimestamp).getTime() - new Date(entryTimestamp).getTime();
}

/**
 * Maps an internal event type of `_events` to its external event store type.
 * Phase-kind and admission types are canonical store types, so they pass unchanged.
 * Without these entries, the `workflow.${type}` fallback gives unregistered types, which the refine of `WorkflowEventBase` rejects.
 */
export function mapInternalToExternalType(internalType: string): string {
  const typeMap: Record<string, string> = {
    'transition': 'workflow.transition',
    'fix-cycle': 'workflow.fix-cycle',
    'guard-failed': 'workflow.guard-failed',
    'checkpoint': 'workflow.checkpoint',
    'compound-entry': 'workflow.compound-entry',
    'compound-exit': 'workflow.compound-exit',
    'circuit-open': 'workflow.circuit-open',
    'cancel': 'workflow.cancel',
    'cleanup': 'workflow.cleanup',
    'phase.entered': 'phase.entered',
    'phase.exited': 'phase.exited',
    'phase.blocked': 'phase.blocked',
  };

  for (const admissionType of ADMISSION_EVENT_TYPE_VALUES) {
    typeMap[admissionType] = admissionType;
  }

  return typeMap[internalType] ?? `workflow.${internalType}`;
}

/**
 * Maps an external event store type back to its internal `_events` type.
 * An unmapped type, such as `team.spawned`, returns unchanged.
 * The phase-kind and admission entries match that fallback, and they mirror {@link mapInternalToExternalType}.
 */
export function mapExternalToInternalType(externalType: string): string {
  const reverseMap: Record<string, string> = {
    'workflow.transition': 'transition',
    'workflow.fix-cycle': 'fix-cycle',
    'workflow.guard-failed': 'guard-failed',
    'workflow.checkpoint': 'checkpoint',
    'workflow.compound-entry': 'compound-entry',
    'workflow.compound-exit': 'compound-exit',
    'workflow.circuit-open': 'circuit-open',
    'workflow.cancel': 'cancel',
    'workflow.cleanup': 'cleanup',
    'phase.entered': 'phase.entered',
    'phase.exited': 'phase.exited',
    'phase.blocked': 'phase.blocked',
  };

  for (const admissionType of ADMISSION_EVENT_TYPE_VALUES) {
    reverseMap[admissionType] = admissionType;
  }

  return reverseMap[externalType] ?? externalType;
}

/** Counts, from the event store, the fix-cycle events of a compound state after its last compound-entry event. */
export async function getFixCycleCountFromStore(
  eventStore: EventStore,
  streamId: string,
  compoundStateId: string,
): Promise<number> {
  const fixCycleEvents = await eventStore.query(streamId, { type: 'workflow.fix-cycle' });
  const compoundEntries = await eventStore.query(streamId, { type: 'workflow.compound-entry' });

  const lastEntry = compoundEntries
    .filter(e => (e.data as Record<string, unknown>)?.compoundStateId === compoundStateId)
    .pop();

  if (!lastEntry) return 0;

  return fixCycleEvents.filter(e =>
    e.sequence > lastEntry.sequence &&
    (e.data as Record<string, unknown>)?.compoundStateId === compoundStateId
  ).length;
}

/** Returns the N most recent events from the event store. */
export async function getRecentEventsFromStore(
  eventStore: EventStore,
  streamId: string,
  count: number,
): Promise<Array<{ type: string; timestamp: string }>> {
  if (count <= 0) return [];
  const allEvents = await eventStore.query(streamId);
  const recent = allEvents.slice(-count);
  return recent.map(e => ({ type: e.type, timestamp: e.timestamp }));
}
