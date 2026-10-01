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

/**
 * Reads a workflow state, a field projection, or a dot-path query.
 * Every query, a scalar query too, uses one resolution. With an event store, an ES v2 workflow answers from the event fold.
 * The state file gives the version marker, and it is the fallback for a legacy workflow or a missing event store.
 * The check is `eventStore != null`, so an `undefined` store from a loosely typed adapter also takes the fallback.
 */
export async function handleGet(
  input: GetInput,
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

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

  const useEventSource = isEventSourced(state) && eventStore != null;

  if (useEventSource) {
    return handleGetFromEvents(input, state, eventStore, stateDir);
  }

  return handleGetFromStateFile(input, state);
}

/**
 * The ES v2 read path. It materializes the state from events.
 *
 * An `asOf` read uses `materializeFresh`, which never reads or writes the cache.
 * With a bounded list, the cached `materialize` can return live state and pollute the cache.
 * A live read folds to the durable tail of the stream before it answers.
 * Both arms merge the file-owned fields, so a bound past the tip gives the same answer as a live read.
 * The checkpoint meta comes from the state file, which is the authority for checkpoint tracking.
 */
async function handleGetFromEvents(
  input: GetInput,
  fileState: WorkflowState,
  eventStore: EventStore,
  stateDir: string,
): Promise<ToolResult> {
  const materializer = getOrCreateMaterializer(stateDir);

  let materialized: WorkflowStateView;
  if (input.asOf !== undefined) {
    const bounded = resolveAsOfEvents(await eventStore.query(input.featureId), input.asOf);
    materialized = materializer.materializeFresh<WorkflowStateView>(
      WORKFLOW_STATE_VIEW,
      bounded,
    );
  } else {
    materialized = (await foldToTail<WorkflowStateView>(
      eventStore,
      materializer,
      input.featureId,
      WORKFLOW_STATE_VIEW,
    )).view;
  }

  const materializedRecord = materialized as unknown as Record<string, unknown>;
  const meta = buildCheckpointMeta(fileState._checkpoint);
  return projectState(input, mergeFileOwnedFields(materializedRecord, fileState), meta);
}

/** The legacy read path. It reads the state file directly, for a v1 workflow or when no event store exists. */
function handleGetFromStateFile(
  input: GetInput,
  state: WorkflowState,
): ToolResult {
  const meta = buildCheckpointMeta(state._checkpoint);
  return projectState(input, state as unknown as Record<string, unknown>, meta);
}

/**
 * Applies a field projection, returns the full state without internal fields, or resolves a dot-path query.
 * The `playbook` field is virtual. It comes from the workflow type and the phase.
 */
function projectState(
  input: GetInput,
  stateObj: Record<string, unknown>,
  meta: ReturnType<typeof buildCheckpointMeta>,
): ToolResult {
  if (input.fields && !input.query) {
    const projected: Record<string, unknown> = {};
    for (const field of input.fields) {
      if (field.startsWith('_')) continue;
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

  if (!input.query) {
    const strippedState = stripInternalFields(stateObj);
    return {
      success: true,
      data: strippedState,
      _meta: meta,
    };
  }

  const value = resolveDotPath(stateObj, input.query);
  return {
    success: true,
    data: value,
    _meta: meta,
  };
}
