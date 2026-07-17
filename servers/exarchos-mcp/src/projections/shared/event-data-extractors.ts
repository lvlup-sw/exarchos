/**
 * Shared event-data extractors for projection reducers (DR-10 dedup).
 *
 * Every projection reducer folds `WorkflowEvent`s whose payload lives on the
 * opaque `data` bag (typed `Record<string, unknown> | undefined` by the
 * event-store base schema). Pulling a typed field off that bag requires the
 * runtime check the type system cannot perform, and the rehydration
 * (`projections/rehydration/reducer.ts`) and task-store
 * (`projections/taskstore/reducer.ts`) reducers previously carried byte-identical
 * private copies of these primitives. This module is their single home so both
 * reducers (and any future one) stay symmetrically lax about partial payloads —
 * a load-bearing property for replay tolerance (DR-1).
 *
 * All extractors are pure: no I/O, no mutation, no throws. Each returns
 * `undefined` for a missing / wrong-typed / empty value so a caller can
 * short-circuit a malformed event into no-op handling without ever writing an
 * ill-typed value into a schema-validated projection.
 */
import type { WorkflowEvent } from '../../event-store/schemas.js';

/**
 * Pull a non-empty string `taskId` off an event's opaque `data` bag. Returns
 * `undefined` for missing, non-string, or empty values so callers can
 * short-circuit malformed task events into no-op handling.
 */
export function extractTaskId(data: WorkflowEvent['data']): string | undefined {
  if (!data) return undefined;
  const raw = data['taskId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Extract a non-empty string field, or `undefined`. The general-purpose sibling
 * of {@link extractTaskId} for arbitrary string-typed fields (e.g. `featureId`,
 * `workflowType`, `to`, `title`, `branch`). Missing / non-string / empty values
 * yield `undefined` so a reducer never writes `undefined` into a schema-validated
 * document.
 */
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

/**
 * Extract a `string[]`, filtering non-string entries. Returns `undefined` for
 * a missing field or a non-array value.
 */
export function extractStringArray(
  data: WorkflowEvent['data'],
  key: string,
): string[] | undefined {
  if (!data) return undefined;
  const raw = data[key];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === 'string');
}
