import type { Event, EventType } from './types.js';

/** Default event log cap — configurable via EVENT_LOG_MAX env var */
export const EVENT_LOG_MAX = (() => {
  const envVal = parseInt(process.env.EVENT_LOG_MAX || '', 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 100;
})();

/**
 * Append an event to the log, incrementing the sequence number and enforcing the cap.
 * Returns a new events array (does not mutate the input).
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

  // Enforce FIFO cap
  if (newEvents.length > EVENT_LOG_MAX) {
    newEvents = newEvents.slice(newEvents.length - EVENT_LOG_MAX);
  }

  return {
    events: newEvents,
    eventSequence: nextSequence,
    event,
  };
}

/**
 * Get count of fix-cycle events for a compound state since the last compound-entry
 * for that compound.
 */
export function getFixCycleCount(events: readonly Event[], compoundStateId: string): number {
  // Find the index of the most recent compound-entry for this compound
  let lastEntryIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
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

  // Count fix-cycle events after the last compound-entry for this compound
  let count = 0;
  for (let i = lastEntryIndex + 1; i < events.length; i++) {
    const evt = events[i];
    if (
      evt.type === 'fix-cycle' &&
      evt.metadata?.compoundStateId === compoundStateId
    ) {
      count++;
    }
  }

  return count;
}

/**
 * Get the N most recent events from the log.
 */
export function getRecentEvents(events: readonly Event[], count: number): Event[] {
  if (count <= 0) return [];
  return events.slice(-count);
}

/**
 * Get the duration of a phase in milliseconds, measured from the most recent
 * transition into the phase to the most recent transition out of it.
 * Returns null if the phase has no entry or exit transition.
 */
export function getPhaseDuration(events: readonly Event[], phase: string): number | null {
  // Find the most recent transition INTO the phase (to === phase)
  let entryTimestamp: string | null = null;
  let exitTimestamp: string | null = null;

  // Scan from the end to find the most recent exit (from === phase)
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type === 'transition' && evt.from === phase && exitTimestamp === null) {
      exitTimestamp = evt.timestamp;
    }
  }

  if (exitTimestamp === null) return null;

  // Find the most recent entry before or at the exit
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type === 'transition' && evt.to === phase) {
      // Ensure this entry is before the exit
      if (evt.timestamp <= exitTimestamp) {
        entryTimestamp = evt.timestamp;
        break;
      }
    }
  }

  if (entryTimestamp === null) return null;

  return new Date(exitTimestamp).getTime() - new Date(entryTimestamp).getTime();
}
