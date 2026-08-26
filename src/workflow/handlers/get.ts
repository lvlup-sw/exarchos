import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { resolveAsOfEvents } from '../../projections/cursor.js';
import { foldToTail } from '../../projections/fold-at-tail.js';
import { WORKFLOW_STATE_VIEW, type WorkflowStateView } from '../../projections/views/workflow-state-projection.js';
import { getOrCreateMaterializer } from '../../projections/views/tools.js';
import { buildCheckpointMeta } from '../checkpoint.js';
import { getPlaybook } from '../playbooks.js';
import { ErrorCode } from '../schemas.js';
import { readStateFile, StateStoreError } from '../state-store.js';
import type { GetInput, WorkflowState } from '../types.js';
import * as path from 'node:path';
import { resolveDotPath } from './dot-path.js';
import { isEventSourced, mergeFileOwnedFields, stripInternalFields } from './shared.js';

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
  // `!= null` deliberately, not `!== null`: the parameter is typed
  // `EventStore | null`, but callers reach this through loosely-typed adapters
  // and an `undefined` store used to be harmless — the path was gated on a
  // materializer that was never set, so it never ran. Now that it does run,
  // letting `undefined` through means folding against nothing.
  const useEventSource = isEventSourced(state) && eventStore != null;

  if (useEventSource) {
    return handleGetFromEvents(input, state, eventStore, stateDir);
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
  stateDir: string,
): Promise<ToolResult> {
  const materializer = getOrCreateMaterializer(stateDir);

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
    const bounded = resolveAsOfEvents(await eventStore.query(input.featureId), input.asOf);
    materialized = materializer.materializeFresh<WorkflowStateView>(
      WORKFLOW_STATE_VIEW,
      bounded,
    );
  } else {
    // #1855 — the live read folds to the stream's durable tail before it
    // answers. This is the surface the wedge was observed on: `workflow get`
    // held no cursor of its own, so it could only consult a durable verdict
    // published elsewhere and refuse. It now establishes its own coverage.
    materialized = (await foldToTail<WorkflowStateView>(
      eventStore,
      materializer,
      input.featureId,
      WORKFLOW_STATE_VIEW,
    )).view;
  }

  const materializedRecord = materialized as unknown as Record<string, unknown>;
  // Checkpoint meta comes from state file (not materialized) since it's the
  // authoritative source for checkpoint tracking.
  const meta = buildCheckpointMeta(fileState._checkpoint);
  // Both arms merge, including the bounded one. A bound past the tip excludes
  // nothing, so it IS the live read and must answer identically — differing
  // there would be an artifact of which branch ran, not a fact about the
  // stream. And the merged fields carry no history to distort: the projection
  // models no `_version` at any sequence, `_esVersion` is a format marker
  // rather than state, and the file's `_checkpoint` already reaches a bounded
  // response through `_meta` above regardless of this branch.
  return projectState(input, mergeFileOwnedFields(materializedRecord, fileState), meta);
}

/**
 * Legacy read path: read directly from state file (v1 workflows, or no event
 * store). Not the ES v2 path — that folds the log and merges the file's own
 * fields on top; see `handleGetFromEvents`.
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
