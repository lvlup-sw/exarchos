import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { resolveAsOfEvents } from '../../projections/cursor.js';
import { WORKFLOW_STATE_VIEW, type WorkflowStateView } from '../../projections/views/workflow-state-projection.js';
import { buildCheckpointMeta } from '../checkpoint.js';
import { getPlaybook } from '../playbooks.js';
import { ErrorCode } from '../schemas.js';
import { readStateFile, StateStoreError } from '../state-store.js';
import type { GetInput, WorkflowState } from '../types.js';
import * as path from 'node:path';
import { resolveDotPath } from './dot-path.js';
import { isEventSourced, moduleViewMaterializer, stripInternalFields } from './shared.js';

// ─── handleGet ──────────────────────────────────────────────────────────────

export async function handleGet(
  input: GetInput,
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  // #1504 — there is no scalar fast path off the `.state.json` file. The file
  // is a derived stamp that goes stale (and, once the write-path is removed,
  // absent), so a top-level scalar query (`query: 'phase'`) must fold the
  // authoritative event log exactly like a full read does — events win over a
  // stale on-disk scalar. All queries (scalar, dot-path, field-projection)
  // route through the shared resolution below, which materializes from events
  // for ES v2 workflows (`handleGetFromEvents`) and reads the file only on the
  // legacy / no-event-store degradation path (`handleGetFromStateFile`).

  // Read state file — needed for version check and as fallback for legacy path
  let state: WorkflowState;
  try {
    state = await readStateFile(stateFile);
  } catch (err) {
    if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_NOT_FOUND,
          message: `State not found for feature: ${input.featureId}`,
        },
      };
    }
    throw err;
  }

  // Version discriminator: ES v2 workflows materialize from events
  const useEventSource = isEventSourced(state)
    && eventStore !== null
    && moduleViewMaterializer !== null;

  if (useEventSource) {
    return handleGetFromEvents(input, state, eventStore!);
  }

  // Legacy path: read directly from state file
  return handleGetFromStateFile(input, state);
}

/**
 * ES v2 read path: materialize state from events via ViewMaterializer.
 */
async function handleGetFromEvents(
  input: GetInput,
  fileState: WorkflowState,
  eventStore: EventStore,
): Promise<ToolResult> {
  const allEvents = await eventStore.query(input.featureId);

  // #1555 — an `asOf` (bounded-fold) read folds `events[0..N]` through the
  // cache-bypassing fresh fold. This is load-bearing: `materialize` is
  // hwm-cache-based (it folds only events past the cached high-water mark and
  // writes the cache), so handing it a BOUNDED list would (a) return the
  // cached LIVE state when a warm cache already sits past N, and (b) pollute
  // the cache for later live reads. `materializeFresh` folds from
  // `projection.init()` over the bounded list and never reads/writes the LRU.
  // The live path keeps the cached `materialize`. Both bound through the
  // shared `resolveAsOfEvents` seam; the CLI/MCP adapters only pass `asOf`
  // through (INV-2).
  let materialized: WorkflowStateView;
  if (input.asOf !== undefined) {
    const bounded = resolveAsOfEvents(allEvents, input.asOf);
    materialized = moduleViewMaterializer!.materializeFresh<WorkflowStateView>(
      WORKFLOW_STATE_VIEW,
      bounded,
    );
  } else {
    materialized = moduleViewMaterializer!.materialize<WorkflowStateView>(
      input.featureId,
      WORKFLOW_STATE_VIEW,
      allEvents,
    );
  }

  const materializedRecord = materialized as unknown as Record<string, unknown>;
  // Checkpoint meta comes from state file (not materialized) since it's the
  // authoritative source for checkpoint tracking.
  const meta = buildCheckpointMeta(fileState._checkpoint);
  return projectState(input, materializedRecord, meta);
}

/**
 * Legacy read path: read directly from state file (v1 workflows or missing dependencies).
 */
function handleGetFromStateFile(
  input: GetInput,
  state: WorkflowState,
): ToolResult {
  const meta = buildCheckpointMeta(state._checkpoint);
  return projectState(input, state as unknown as Record<string, unknown>, meta);
}

/**
 * Shared projection logic: apply field projection, strip internals, or resolve dot-path query.
 */
function projectState(
  input: GetInput,
  stateObj: Record<string, unknown>,
  meta: ReturnType<typeof buildCheckpointMeta>,
): ToolResult {
  // Fields projection
  if (input.fields && !input.query) {
    const projected: Record<string, unknown> = {};
    for (const field of input.fields) {
      if (field.startsWith('_')) continue;
      // Special handling for 'playbook' virtual field
      if (field === 'playbook') {
        const wfType = typeof stateObj.workflowType === 'string' ? stateObj.workflowType : '';
        const phase = typeof stateObj.phase === 'string' ? stateObj.phase : '';
        const playbook = getPlaybook(wfType, phase);
        if (playbook !== null) {
          projected.playbook = playbook;
        }
        continue;
      }
      const value = resolveDotPath(stateObj, field);
      if (value !== undefined) {
        projected[field] = value;
      }
    }
    return { success: true, data: projected, _meta: meta };
  }

  // Full state (no query, no fields)
  if (!input.query) {
    const strippedState = stripInternalFields(stateObj);
    return {
      success: true,
      data: strippedState,
      _meta: meta,
    };
  }

  // Dot-path query
  const value = resolveDotPath(stateObj, input.query);
  return {
    success: true,
    data: value,
    _meta: meta,
  };
}
