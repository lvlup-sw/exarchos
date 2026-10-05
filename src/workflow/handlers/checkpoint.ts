import { buildValidatedEvent } from '../../events/event-factory.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { REHYDRATION_PROJECTION_ID, REHYDRATION_PROJECTION_VERSION } from '../../projections/rehydration/identity.js';
import { rehydrationReducer } from '../../projections/rehydration/reducer.js';
import type { RehydrationDocument } from '../../projections/rehydration/schema.js';
import type { SnapshotRecord } from '../../projections/snapshot-schema.js';
import { appendSnapshot } from '../../projections/store.js';
import { buildCheckpointMeta, resetCounter } from '../checkpoint.js';
import { type HandoffLintFinding, lintHandoff } from '../handoff-lint.js';
import { composePhasePlaybook } from '../playbooks.js';
import { hydrateFromSnapshotThenTail } from '../rehydrate.js';
import { CheckpointInputSchema, ErrorCode } from '../schemas.js';
import { readStateFile, StateStoreError, writeStateFile } from '../state-store.js';
import type { CheckpointInput, WorkflowState } from '../types.js';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * The per-call options of `handleCheckpoint` that are not part of the dispatch input.
 * In production, `handoffLint.hardFail` comes from `.exarchos.yml`. Tests pass it directly.
 */
export interface HandleCheckpointOptions {
  readonly handoffLint?: {
    readonly hardFail?: boolean;
  };
}

/**
 * Resets the checkpoint counter, appends `workflow.checkpoint`, and writes a rehydration snapshot when an event store exists.
 * The handler validates the input with `CheckpointInputSchema` before any I/O.
 * A handoff lint finding is a warning. With `options.handoffLint.hardFail`, it rejects the call before any write.
 *
 * The idempotency key of `workflow.checkpoint` holds `_version` and a handoff digest.
 * Thus a retry collapses, and a refined handoff gets a new event.
 * The snapshot `sequence`, `projectionSequence` and the written-event key use the absorbed stream position, not the reducer counter.
 * Unhandled events make the two values differ, and a later `rehydrate` queries from `sequence`.
 *
 * The state file write is last, because it advances `_version`. An earlier write gives a retry a new key and a duplicate event.
 * `phasePlaybook` is always present and null for an unregistered pair. Lint findings appear only when they exist.
 */
export async function handleCheckpoint(
  input: CheckpointInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: HandleCheckpointOptions,
): Promise<ToolResult> {
  const parsed = CheckpointInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: `Invalid checkpoint input: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      },
    };
  }
  const validated = parsed.data;

  let handoffLintFindings: HandoffLintFinding[] = [];
  if (validated.handoff) {
    handoffLintFindings = lintHandoff(validated.handoff);
    if (handoffLintFindings.length > 0 && options?.handoffLint?.hardFail === true) {
      return {
        success: false,
        error: {
          code: ErrorCode.INVALID_INPUT,
          message: `Handoff prose failed lint (${handoffLintFindings.length} finding${
            handoffLintFindings.length === 1 ? '' : 's'
          }); see data.findings for details`,
        },
        data: { findings: handoffLintFindings },
      };
    }
  }

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

  const mutableState = structuredClone(state) as Record<string, unknown>;

  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    state.phase,
    input.summary,
  );

  const handoff = validated.handoff;
  const handoffDigest = createHash('sha256')
    .update(JSON.stringify(handoff ?? {}))
    .digest('hex')
    .slice(0, 16);
  const checkpointIdempotencyKey =
    `${input.featureId}:checkpoint:${state.phase}:${state._version}:${handoffDigest}`;
  if (eventStore) {
    try {
      const validatedEvent = buildValidatedEvent(input.featureId, 1, {
        type: 'workflow.checkpoint' as import('../../events/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
        data: {
          counter: 0,
          phase: state.phase,
          featureId: input.featureId,
          ...(handoff !== undefined && { handoff }),
        },
      });
      await eventStore.appendValidated(input.featureId, validatedEvent, { idempotencyKey: checkpointIdempotencyKey });
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  let projectionSequence: number | undefined;
  if (eventStore) {
    let document: RehydrationDocument;
    let lastEventSequence: number;
    try {
      ({ state: document, lastEventSequence } = await hydrateFromSnapshotThenTail<
        RehydrationDocument,
        WorkflowEvent
      >(
        rehydrationReducer,
        eventStore,
        input.featureId,
        stateDir,
        REHYDRATION_PROJECTION_ID,
        REHYDRATION_PROJECTION_VERSION,
      ));
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.PROJECTION_REPLAY_FAILED,
          message: `hydrate-from-snapshot failed during checkpoint: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    projectionSequence = lastEventSequence;

    const snapshotRecord: SnapshotRecord = {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: lastEventSequence,
      state: document,
      timestamp: new Date().toISOString(),
    };

    const serialized = JSON.stringify(snapshotRecord);
    const byteSize = Buffer.byteLength(serialized, 'utf8');

    try {
      appendSnapshot(eventStore.getReadBackend(), input.featureId, snapshotRecord);
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.SNAPSHOT_WRITE_FAILED,
          message: `snapshot write failed during checkpoint: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    try {
      const validatedEvent = buildValidatedEvent(input.featureId, 1, {
        type: 'workflow.checkpoint_written' as import('../../events/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
        data: {
          projectionId: REHYDRATION_PROJECTION_ID,
          projectionSequence: lastEventSequence,
          byteSize,
        },
      });
      await eventStore.appendValidated(input.featureId, validatedEvent, {
        idempotencyKey: `${input.featureId}:checkpoint_written:${REHYDRATION_PROJECTION_ID}:${lastEventSequence}`,
      });
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Event append failed (workflow.checkpoint_written): ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();
  mutableState.updatedAt = new Date().toISOString();
  await writeStateFile(stateFile, mutableState as WorkflowState);

  const phasePlaybook = composePhasePlaybook(
    state.workflowType as string,
    state.phase,
  );

  const handoffWarnings: string[] = [];
  if (handoffLintFindings.length > 0) {
    const sources = Array.from(
      new Set(handoffLintFindings.map((f) => f.source)),
    ).sort();
    handoffWarnings.push(
      `handoff prose lint: ${handoffLintFindings.length} finding${
        handoffLintFindings.length === 1 ? '' : 's'
      } across ${sources.join(', ')}`,
    );
  }

  return {
    success: true,
    data: {
      phase: (mutableState._checkpoint as Record<string, unknown>).phase as string,
      ...(projectionSequence !== undefined && { projectionSequence }),
      phasePlaybook,
      ...(handoffLintFindings.length > 0 && { handoffLintFindings }),
    },
    ...(handoffWarnings.length > 0 && { warnings: handoffWarnings }),
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}
