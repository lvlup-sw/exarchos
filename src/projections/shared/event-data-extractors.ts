/**
 * Shared event-data extractors for projection reducers.
 *
 * A `WorkflowEvent` carries its payload on the untyped `data` bag.
 * These extractors do the runtime type check, so the reducers stay equally tolerant of partial payloads on replay.
 * Each extractor is pure and does not throw.
 * A missing or wrong-typed value gives `undefined`, as does an empty string. Thus a reducer does not write an ill-typed value.
 */
import type { WorkflowEvent } from '../../events/schemas.js';

/** Return the non-empty string `taskId` from an event's `data` bag, or `undefined`. */
export function extractTaskId(data: WorkflowEvent['data']): string | undefined {
  if (!data) return undefined;
  const raw = data['taskId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Return the non-empty string field `key`, or `undefined`. */
export function extractString(
  data: WorkflowEvent['data'],
  key: string,
): string | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Extract a finite number, or `undefined` for missing / non-number / non-finite. */
export function extractNumber(
  data: WorkflowEvent['data'],
  key: string,
): number | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** Return the string entries of the array field `key`, or `undefined` when the field is not an array. */
export function extractStringArray(
  data: WorkflowEvent['data'],
  key: string,
): string[] | undefined {
  if (!data) return undefined;
  const raw = data[key];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === 'string');
}
