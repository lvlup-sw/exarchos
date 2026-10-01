// Helpers that several workflow handlers share.
// This module also re-exports the cancel and query handlers for existing importers.

export { handleCancel } from '../cancel.js';
export { handleSummary, handleReconcile, handleTransitions } from '../query.js';

const INTERNAL_FIELDS = ['_events', '_eventSequence', '_history'] as const;

export function stripInternalFields(state: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...state };
  for (const field of INTERNAL_FIELDS) {
    delete stripped[field];
  }
  return stripped;
}

export const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
export function isEventSourced(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  if (!('_esVersion' in state)) return false;
  return state._esVersion === CURRENT_ES_VERSION;
}

import {
  workflowStateProjection,
} from '../../projections/views/workflow-state-projection.js';
import type { WorkflowState } from '../types.js';

/**
 * The fields that the state file owns and the event log cannot rebuild.
 * `_version` is the optimistic-lock counter of the file. The projection holds a fixed `1` that CAS rejects.
 * Events set only some `_checkpoint` fields, so the fold holds default values for the others.
 */
export const FILE_OWNED_FIELDS: ReadonlySet<string> = new Set(['_version', '_checkpoint']);

/**
 * Merges the event fold with the facts that only the state file knows.
 * The fold is the base. The file supplies {@link FILE_OWNED_FIELDS} and each key that the projection does not model.
 * The modeled keys come from `workflowStateProjection.init()`, so a new state field is not lost.
 * `handleGet` uses this merge, so a read keeps the file-owned fields.
 */
export function mergeFileOwnedFields(
  materialized: Record<string, unknown>,
  fileState: WorkflowState,
): Record<string, unknown> {
  const modelled = new Set(Object.keys(workflowStateProjection.init()));
  const merged: Record<string, unknown> = { ...materialized };
  for (const [key, value] of Object.entries(fileState)) {
    if (!modelled.has(key) || FILE_OWNED_FIELDS.has(key)) merged[key] = value;
  }
  return merged;
}
