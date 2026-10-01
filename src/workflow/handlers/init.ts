import { buildValidatedEvent } from '../../events/event-factory.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { buildCheckpointMeta } from '../checkpoint.js';
import { allocateInitialPhaseAttemptId } from '../phase-attempt-id.js';
import { ErrorCode, InitInputSchema } from '../schemas.js';
import { initStateFile, StateStoreError } from '../state-store.js';
import type { InitInput } from '../types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CURRENT_ES_VERSION } from './shared.js';

/**
 * Initialize a new workflow state file. Input is validated again for direct callers.
 *
 * The handler refuses an existing state file before it appends, so a repeated init
 * does not leave an orphan event. With an event store, `workflow.started` is appended first, and an append
 * failure writes no state file. The event carries `repoKey` as `repoRoot` and the
 * oneshot `synthesisPolicy`, so a rebuild from events keeps them. On an idempotent
 * retry, the persisted `phaseAttemptId` wins. A failed stream registration does not
 * stop init, because the streams table is only a read index.
 */
export async function handleInit(
  input: InitInput,
  stateDir: string,
  eventStore: EventStore | null,
  repoKey?: string,
): Promise<ToolResult> {
  try {
    const parsed = InitInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: ErrorCode.INVALID_INPUT,
          message: `Invalid init input: ${parsed.error.message}`,
        },
      };
    }

    const existingStateFile = path.join(stateDir, `${input.featureId}.state.json`);
    try {
      await fs.access(existingStateFile);
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_ALREADY_EXISTS,
          message: `State already exists for feature: ${input.featureId}`,
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const isOneshotWithPolicy =
      input.workflowType === 'oneshot' && input.synthesisPolicy !== undefined;
    let eventSequence = 0;
    let phaseAttemptId = allocateInitialPhaseAttemptId();
    if (eventStore) {
      try {
        const validatedEvent = buildValidatedEvent(input.featureId, 1, {
          type: 'workflow.started' as import('../../events/schemas.js').EventType,
          correlationId: input.featureId,
          source: 'workflow',
          data: {
            featureId: input.featureId,
            workflowType: input.workflowType,
            ...(isOneshotWithPolicy ? { synthesisPolicy: input.synthesisPolicy } : {}),
            ...(repoKey !== undefined ? { repoRoot: repoKey } : {}),
            phaseAttemptId,
          },
        });
        const event = await eventStore.appendValidated(input.featureId, validatedEvent, {
          idempotencyKey: `${input.featureId}:workflow.started`,
        });
        eventSequence = event.sequence;
        const persistedPhaseAttemptId = (
          event.data as Record<string, unknown> | undefined
        )?.phaseAttemptId;
        if (typeof persistedPhaseAttemptId === 'string') {
          phaseAttemptId = persistedPhaseAttemptId as typeof phaseAttemptId;
        }
      } catch (err) {
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      try {
        eventStore.registerStream(input.featureId, input.workflowType);
      } catch {
      }
    }

    const extraFields: Record<string, unknown> = {
      _eventSequence: eventSequence,
      _esVersion: CURRENT_ES_VERSION,
      phaseAttemptId,
    };
    if (input.workflowType === 'oneshot' && input.synthesisPolicy !== undefined) {
      extraFields.oneshot = { synthesisPolicy: input.synthesisPolicy };
    }

    const { state } = await initStateFile(
      stateDir,
      input.featureId,
      input.workflowType,
      extraFields,
    );

    return {
      success: true,
      data: {
        featureId: state.featureId,
        workflowType: state.workflowType,
        phase: state.phase,
        phaseAttemptId,
      },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  } catch (err) {
    if (err instanceof StateStoreError) {
      return {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
      };
    }
    throw err;
  }
}
