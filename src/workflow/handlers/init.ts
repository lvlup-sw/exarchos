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

// ─── handleInit ─────────────────────────────────────────────────────────────

/**
 * Initialize a new workflow state file.
 *
 * **Event-first contract:** When an event store is configured, the
 * `workflow.started` event is appended BEFORE the state file is created.
 * If the event append fails, no state file is written and an error is
 * returned. When no event store is configured, the state file is created
 * with `_eventSequence = 0` for graceful degradation.
 *
 * **Repo identity (DR-5):** an optional `repoKey` — supplied by the composite
 * layer (`deriveRepoKey(ctx.cwd ?? process.cwd())`) — is stamped onto the
 * `workflow.started` event data as `repoRoot`. Absent ⇒ the event carries no
 * `repoRoot`, exactly today's shape (direct handler calls stay unscoped by
 * construction). The parameter is threaded, never read from `process.cwd()`
 * here, so identity is adapter-independent.
 */
export async function handleInit(
  input: InitInput,
  stateDir: string,
  eventStore: EventStore | null,
  repoKey?: string,
): Promise<ToolResult> {
  try {
    // Marten R-1 (#1313): handler-boundary input validation. The MCP
    // registration declares `workflowType` as required, so requests
    // routed through the server are pre-validated. Direct callers
    // (internal helpers, future CLI invocations, test fixtures
    // bypassing the MCP surface) can still land here with a malformed
    // input — re-validate so they receive an explicit INVALID_INPUT
    // rather than a downstream STATE_CORRUPT / EVENT_APPEND_FAILED
    // whose error code suggests a different remediation path.
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

    // Guard: check if state file already exists BEFORE appending any event.
    // This prevents orphan events when handleInit is called twice with the
    // same featureId — without this check, the event would be appended and
    // then initStateFile would fail with STATE_ALREADY_EXISTS.
    const existingStateFile = path.join(stateDir, `${input.featureId}.state.json`);
    try {
      await fs.access(existingStateFile);
      // State already exists — return error without appending event
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_ALREADY_EXISTS,
          message: `State already exists for feature: ${input.featureId}`,
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // File doesn't exist — proceed with init
    }

    // Event-first: append workflow.started event BEFORE creating state file.
    // For oneshot workflows with an explicit `synthesisPolicy`, include it on
    // the event data so ES v2 rematerialization reconstructs the policy —
    // without this, rehydrating a state from events alone silently reverts
    // the workflow to the schema default (`on-request`), losing an
    // init-time decision that drives the choice-state guard at finalize.
    const isOneshotWithPolicy =
      input.workflowType === 'oneshot' && input.synthesisPolicy !== undefined;
    let eventSequence = 0;
    // Initial entry has no predecessor/version decision to key from, so mint an
    // opaque ID and persist it on workflow.started. The persisted event remains
    // canonical if concurrent init callers hit the idempotency cache.
    let phaseAttemptId = allocateInitialPhaseAttemptId();
    if (eventStore) {
      try {
        // #1325 — route through buildValidatedEvent for defense-in-depth
        // Zod validation at the emission boundary.
        const validatedEvent = buildValidatedEvent(input.featureId, 1, {
          type: 'workflow.started' as import('../../events/schemas.js').EventType,
          correlationId: input.featureId,
          source: 'workflow',
          data: {
            featureId: input.featureId,
            workflowType: input.workflowType,
            ...(isOneshotWithPolicy ? { synthesisPolicy: input.synthesisPolicy } : {}),
            // DR-5: repo identity, present only when the composite supplied it.
            // Absent ⇒ exactly today's event shape (unscoped legacy behavior).
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
        // Event-first: if event append fails, do NOT create state file
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      // Marten R-1 (#1313): register the stream's typed row immediately
      // after the workflow.started event lands. Ordering matters — if the
      // event append fails we already returned above; if registerStream
      // throws we still proceed to state-file creation since the registry
      // is an observability/filtering aid (v2.12 ps), not load-bearing for
      // the workflow.started → state.json sequence. INSERT OR IGNORE makes
      // this idempotent against handleInit retries.
      try {
        eventStore.registerStream(input.featureId, input.workflowType);
      } catch {
        // Swallow registry write errors. The streams table is a read-side
        // index for filtered queries; failing to register a stream produces
        // a missing row in v2.12's ps view, not a broken workflow.
      }
    }

    // Oneshot-only: thread `synthesisPolicy` into the initial state under
    // `state.oneshot`. For non-oneshot workflow types the field is silently
    // dropped — the `InitInputSchema` accepts it for uniformity but only the
    // oneshot state shape has a `.oneshot.synthesisPolicy` slot.
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

    // v2.11 Phase 1: sidecar fallback (#1082) is gone — the event-store
    // either writes through the SQLite WAL or hard-throws on lock
    // contention. The `sidecarPending` envelope ack is no longer emitted.
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
