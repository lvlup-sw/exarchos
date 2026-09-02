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

// ─── handleCheckpoint ──────────────────────────────────────────────────────

/**
 * Optional knobs threaded into `handleCheckpoint` that are not part of
 * the dispatch input itself. Today only `handoffLint` is wired (#1244);
 * future per-call overrides for things like staleness or counter reset
 * policy can join the same struct without re-shaping the signature.
 *
 * The production wiring source-of-truth is `.exarchos.yml`'s
 * `handoffLint.hardFail` flag (DR-1244). Tests pass this directly so
 * the hard-fail path can be exercised without yaml-fixture plumbing.
 */
export interface HandleCheckpointOptions {
  readonly handoffLint?: {
    readonly hardFail?: boolean;
  };
}

export async function handleCheckpoint(
  input: CheckpointInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: HandleCheckpointOptions,
): Promise<ToolResult> {
  // T4 (#1240) — validate the dispatch payload at the handler boundary
  // before any state-file I/O or event emission. The MCP tool registration
  // (`server.tool` below) only declares `featureId` and `summary` in its
  // raw shape, so a `handoff` value forwarded from the CLI/SDK reaches
  // here untyped. Re-parsing through `CheckpointInputSchema` enforces
  // `HandoffEntryData`'s per-field byte caps (DIM-7) and strips any
  // unknown keys before the value is digested into the idempotency key
  // or persisted on the event. Returning a structured INVALID_INPUT
  // failure (rather than throwing) matches the rest of the dispatch
  // surface and lets the counter stay un-reset on rejection.
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

  // #1244 — markdown-aware handoff lint. Runs over the validated payload
  // BEFORE any state-file read or event-store write so the hard-fail
  // path leaves the event stream untouched on rejection. The lint is
  // a no-op when `handoff` is absent (pre-#1240 callers) — `lintHandoff`
  // short-circuits on each empty field, so the cost is a few array
  // existence checks for the legacy shape.
  //
  // Soft-fail (default): findings surface on `data.handoffLintFindings`
  // and a human-readable summary lands on `warnings`. The checkpoint
  // event is still appended — the lint is advisory, not blocking.
  //
  // Hard-fail (`options.handoffLint.hardFail === true`, mirrored from
  // `.exarchos.yml`'s `handoffLint.hardFail`): the call rejects with
  // `INVALID_INPUT` and `data.findings` carries the structured
  // violations. No event is appended, so the operator can fix the
  // prose and retry without scrubbing a partial write.
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

  // Work with a deep copy to avoid shared reference mutation
  const mutableState = structuredClone(state) as Record<string, unknown>;

  // Reset checkpoint counter with current phase and optional summary
  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    state.phase,
    input.summary,
  );

  // Emit checkpoint event to external store (event-first, guaranteed).
  //
  // C3 (#1241): include a sha256 prefix of the `handoff` payload in the
  // idempotency key so refinement calls (same featureId+phase+version
  // but distinct handoff content) land as distinct events. T4 (#1240)
  // formalizes `handoff` on `CheckpointInputSchema` — `validated.handoff`
  // is now typed against `HandoffEntryData` and missing/undefined drops
  // through to the legacy `JSON.stringify({}) === '{}'` digest, keeping
  // dedup behaviour stable for pre-#1240 callers.
  const handoff = validated.handoff;
  const handoffDigest = createHash('sha256')
    .update(JSON.stringify(handoff ?? {}))
    .digest('hex')
    .slice(0, 16);
  const checkpointIdempotencyKey =
    `${input.featureId}:checkpoint:${state.phase}:${state._version}:${handoffDigest}`;
  if (eventStore) {
    try {
      // #1325 — route through buildValidatedEvent for defense-in-depth
      // Zod validation at the emission boundary.
      const validatedEvent = buildValidatedEvent(input.featureId, 1, {
        type: 'workflow.checkpoint' as import('../../events/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
        // T4 (#1240): persist the handoff payload on the event when the
        // caller supplied one. Spread-on-condition keeps `data.handoff`
        // absent for legacy callers — historical events on disk lacked
        // this key entirely, and the rehydration projection's `v:1`
        // tolerant schema relies on that absence rather than an explicit
        // `null` to flag pre-#1240 entries.
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

  // T034 (DR-6) — materialize the rehydration projection. Performed AFTER
  // the `workflow.checkpoint` event above is appended so the snapshot folds
  // that event into the projection too (the rehydration reducer treats
  // `workflow.checkpoint` as unhandled, so this is a no-op for sequence, but
  // the ordering keeps the invariant "snapshot reflects everything known as
  // of the checkpoint moment").
  //
  // We reuse `hydrateFromSnapshotThenTail` (T031) so the fold-from-latest-
  // snapshot-then-tail logic is identical to the rehydrate handler — same
  // trust boundary on `snapshot.state`, same empty-stream behaviour. When no
  // event store is configured this step is skipped entirely; the checkpoint
  // reset still takes effect but no projection is materialized.
  //
  // Hoisted out of the `if (eventStore)` scope so the return below can
  // surface `projectionSequence` in `data` (T035, DR-6) — the CLI adapter
  // renders this to let operators see at a glance how many events are
  // behind the new checkpoint.
  let projectionSequence: number | undefined;
  if (eventStore) {
    // The hydrate-then-write block is the I/O-heavy part of checkpoint:
    // event-store query, snapshot sidecar read, JSONL serialization,
    // atomic temp-file write, rename. Any of those can throw on a
    // healthy-looking process (transient EIO, EROFS, ENOSPC mid-fsync,
    // sidecar permissions race). Catch them all and surface a structured
    // failure rather than letting the exception bubble out of
    // `handleCheckpoint` — the workflow state file (counter reset) has
    // already been written above, so an unhandled throw here would leave
    // disk state divergent from the dispatch envelope. (Sentry HIGH on
    // PR #1178: tools.ts:1036 missing error handling around
    // hydrateFromSnapshotThenTail and appendSnapshot.)
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
    // The dispatch envelope's `projectionSequence` exposes a checkpoint-lag
    // signal to operators ("how far through the stream is this checkpoint")
    // and the CLI adapter renders it directly. The meaningful value here is
    // the absorbed event-store position (`lastEventSequence`), not the
    // reducer's internal handled-event counter (`document.projectionSequence`)
    // — those two values diverge whenever the stream contains unhandled
    // events, and the operator-facing meaning needs the stream position.
    // (CodeRabbit PR #1178 follow-up review.)
    projectionSequence = lastEventSequence;

    // SnapshotRecord.sequence is the highest event-store sequence absorbed
    // into `document` — NOT `document.projectionSequence`. The two values
    // diverge whenever the stream contains events the rehydration reducer
    // doesn't fold (e.g. `gate.executed` is unhandled by
    // `rehydrationReducer.apply`), and a later `rehydrate` call uses this
    // field as `sinceSequence` against `eventStore.query`. Storing the
    // projection sequence here would make the query under-skip, causing
    // already-absorbed events to be re-applied on every read. (Sentry HIGH
    // on PR #1178.)
    const snapshotRecord: SnapshotRecord = {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: lastEventSequence,
      state: document,
      timestamp: new Date().toISOString(),
    };

    // `byteSize` is the serialized payload size of this record. Pre-Wave-A
    // the snapshot store wrote one JSONL line per record and this metric
    // included the trailing `\n` delimiter (CodeRabbit PR #1178). Post-Wave-A
    // snapshots persist into the SQLite `projection_snapshots` table with no
    // newline framing, so we measure the JSON payload only. The
    // `workflow.checkpoint_written` event can still be emitted pre-write
    // because the payload bytes are independent of the substrate.
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
      // #1325 — route through buildValidatedEvent for defense-in-depth
      // Zod validation at the emission boundary.
      const validatedEvent = buildValidatedEvent(input.featureId, 1, {
        type: 'workflow.checkpoint_written' as import('../../events/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
        data: {
          projectionId: REHYDRATION_PROJECTION_ID,
          // The event payload's `projectionSequence` field carries the same
          // operator-facing checkpoint-lag signal the dispatch envelope does
          // — the absorbed stream position, not the reducer's handled-event
          // counter. Aligned with the envelope assignment above so observers
          // see one consistent number regardless of which surface they read.
          // (CodeRabbit PR #1178 follow-up review.)
          projectionSequence: lastEventSequence,
          byteSize,
        },
      });
      await eventStore.appendValidated(input.featureId, validatedEvent, {
        // Idempotency: one written event per (feature, projection, absorbed
        // sequence). `document.projectionSequence` only advances on events
        // the reducer handled, so two snapshots that absorbed different sets
        // of *unhandled* events would collide on the same key and the second
        // legitimate `workflow.checkpoint_written` would be silently
        // suppressed. Keying off `lastEventSequence` (the highest event-store
        // sequence absorbed into the snapshot — also stored as
        // `SnapshotRecord.sequence`) keeps each fresh on-disk snapshot
        // observable. (CodeRabbit PR #1178 review.)
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

  // CodeRabbit major on PR #1297 (tools.ts:930-960): the version-advancing
  // `writeStateFile` MUST be deferred until AFTER the snapshot fold and
  // `workflow.checkpoint_written` append both succeed. The idempotency
  // key for the `workflow.checkpoint` event above includes
  // `state._version`, and `writeStateFile` advances disk `_version` from
  // N to N+1 as a side effect of writing. If the write happened earlier
  // and any later step failed, the operator's retry would read N+1,
  // compute a different idempotency key, and the event-store dedup would
  // miss — duplicating the checkpoint event on the stream. Deferring the
  // write is the minimum-mutation fix that keeps retries collapsing onto
  // one checkpoint event by holding `_version` stable until the whole
  // bundle commits.
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();
  mutableState.updatedAt = new Date().toISOString();
  await writeStateFile(stateFile, mutableState as WorkflowState);

  // v2.11 substrate cut (#1082): sidecar fallback removed; no `sidecarPending`.
  // T-23 (rehydration-machinery-refactor) — compose `phasePlaybook` for the
  // dispatch envelope using the shared helper that `handleRehydrate` also
  // calls (T-20). After the `workflow.checkpoint` event has landed and
  // BEFORE we build the return value so the envelope reflects the same
  // (workflowType, phase) the checkpoint was recorded for. The helper
  // returns `null` for unregistered pairs (e.g. discovery/completed) and a
  // serialized `SerializedPhasePlaybook` for registered ones (e.g.
  // feature/delegate → skill: 'delegate'). The v:3 envelope schema
  // treats `phasePlaybook` as nullable, not optional, so we surface the
  // null explicitly rather than omitting the field — CLI/SDK renderers
  // spread the value without an `undefined` guard.
  const phasePlaybook = composePhasePlaybook(
    state.workflowType as string,
    state.phase,
  );

  // #1244 — soft-fail surfacing. Findings are only attached when
  // non-empty so the field's *presence* on the data envelope is itself
  // the signal to the caller. Clean handoffs produce no field, no
  // warnings entry; this keeps the response payload small for the
  // happy path. The summary on `warnings` carries a count + the
  // distinct source fields so operators see the shape without
  // unmarshalling `data.handoffLintFindings`.
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
      // T035, DR-6: surface the materialized projection's sequence so the
      // CLI adapter can render "N events behind this checkpoint" without
      // a follow-up query. Omitted when no event store is configured —
      // the materialization block above skips entirely in that mode.
      ...(projectionSequence !== undefined && { projectionSequence }),
      // T-23: present unconditionally (null for unregistered pairs) — the
      // v:3 envelope schema requires the field's presence, not just
      // truthiness. (#1082 sidecar field deleted in v2.11 substrate cut.)
      phasePlaybook,
      // #1244: only attach the findings array when non-empty so the
      // happy path stays slim and the field's presence is itself a
      // self-describing signal.
      ...(handoffLintFindings.length > 0 && { handoffLintFindings }),
    },
    ...(handoffWarnings.length > 0 && { warnings: handoffWarnings }),
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}
