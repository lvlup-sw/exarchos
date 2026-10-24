/**
 * The output schemas of some workflow, sync, telemetry and event actions. Each action schema wraps
 * `EnvelopeSchema`. The module also re-exports `CappedDataSchema` and `withCappedShape` from
 * `output-schema-declaration.ts`, which keeps the brand mint private. Thus `withCappedShape` is the
 * only constructor of a substantive `outputSchema`.
 */

import { EnvelopeSchema } from '../contract/schemas/envelope.js';
import { PhasePlaybookSchema, RehydrationDocumentSchema } from '../projections/rehydration/schema.js';
import { z } from 'zod';

/**
 * The typed `_meta.deprecation` sub-shape. `since` and `removeIn` are non-empty semver strings.
 * `replacement` names the canonical action that replaces the deprecated one.
 */
export const MetaDeprecationSchema = z.object({
  since: z.string().min(1).describe('Version when this action was deprecated (semver)'),
  removeIn: z.string().min(1).describe('Version when this action is removed (semver)'),
  replacement: z.string().min(1).describe('Canonical action name that supersedes this one'),
});

/**
 * When `_meta` carries a `deprecation` slot, the slot must match {@link MetaDeprecationSchema}. The
 * slot is optional. `_meta` uses `passthrough()`, so the other `_meta` keys of the envelope survive
 * the intersection.
 */
const MetaDeprecationConstraint = z.object({
  _meta: z.object({
    deprecation: MetaDeprecationSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * The `outputSchema` of the `exarchos_workflow.set` action, which the registry does not declare.
 * No registry action uses this constant.
 *
 * @deprecated Use `EnvelopeSchema(dataSchema)` from `contract/schemas/envelope.ts`. The removal
 * target is v2.12.
 */
export const WorkflowSetOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * The old `outputSchema` of `exarchos_workflow.transition`: the envelope plus the typed
 * `_meta.deprecation` constraint. No registry action uses this constant. The action now declares
 * {@link WorkflowStateWriteOutputSchema}.
 *
 * @deprecated Use `EnvelopeSchema(dataSchema)` from `contract/schemas/envelope.ts`, with the
 * success-data shape of the action. The removal target is v2.12.
 */
export const WorkflowTransitionOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * The old `outputSchema` of `exarchos_workflow.update`: the envelope without the
 * `_meta.deprecation` constraint. No registry action uses this constant. The action now declares
 * {@link WorkflowStateWriteOutputSchema}.
 *
 * @deprecated Use `EnvelopeSchema(dataSchema)` from `contract/schemas/envelope.ts`. The removal
 * target is v2.12.
 */
export const WorkflowUpdateOutputSchema = EnvelopeSchema(z.unknown());

/**
 * One tool entry of the `exarchos_view.telemetry` output. `actionErrors` and `actionErrorBreakdown`
 * are required, so consumers can rely on them. The entry uses `.passthrough()`, because the full
 * view adds the `durations`, `sizes`, and `tokenEstimates` arrays, which a strict object rejects.
 */
const TelemetryToolEntrySchema = z.object({
  tool: z.string(),
  invocations: z.number().nonnegative(),
  errors: z.number().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  p50DurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
  p50Bytes: z.number().nonnegative(),
  p95Bytes: z.number().nonnegative(),
  p50Tokens: z.number().nonnegative(),
  p95Tokens: z.number().nonnegative(),
  /** The count of action-level failures. */
  actionErrors: z.number().nonnegative(),
  actionErrorBreakdown: z.record(z.string(), z.number().nonnegative()),
}).passthrough();

const TelemetryViewDataSchema = z.object({
  session: z.object({
    start: z.string(),
    totalInvocations: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  }),
  tools: z.array(TelemetryToolEntrySchema),
  hints: z.array(z.unknown()),
}).passthrough();

export const TelemetryViewOutputSchema = EnvelopeSchema(TelemetryViewDataSchema);

/**
 * The acknowledgement of one appended event, as `toEventAck` returns it. An idempotent replay
 * returns the acknowledgement of the stored event, so the shape is the same. The `type` is a
 * string, so a new event type needs no schema edit.
 */
const EventAckDataSchema = z
  .object({
    streamId: z.string(),
    sequence: z.number(),
    type: z.string(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_event.append`: the acknowledgement of the event. */
export const EventAppendOutputSchema = EnvelopeSchema(EventAckDataSchema);

/** The `outputSchema` of `exarchos_event.batch_append`: one acknowledgement for each appended event. */
export const EventBatchAppendOutputSchema = EnvelopeSchema(z.array(EventAckDataSchema));

/** The paging metadata of `exarchos_event.query`. It mirrors `EventQueryPage` in `events/tools.ts`. */
const EventQueryPageDataSchema = z
  .object({
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    hasMore: z.boolean(),
  })
  .passthrough();

/**
 * One event row of `exarchos_event.query`. A `fields` projection keeps only the keys that the caller
 * names, so each field is optional. A field that is present must have its stored type.
 */
const EventQueryRowDataSchema = z
  .object({
    streamId: z.string().optional(),
    sequence: z.number().optional(),
    type: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

/** The success data of `exarchos_event.query`: the event rows of one page and the paging metadata. */
const EventQueryDataSchema = z
  .object({
    events: z.array(EventQueryRowDataSchema),
    page: EventQueryPageDataSchema,
  })
  .passthrough();

/** The `outputSchema` of `exarchos_event.query`: one page of event rows and its paging metadata. */
export const EventQueryOutputSchema = EnvelopeSchema(EventQueryDataSchema);

/**
 * The success data of `exarchos_workflow.get`. Each mode of `handleGet` returns an object. The modes
 * are a field projection, the full state without internal fields, and the one-key projection of a
 * query. A projection omits each key that resolves to nothing, so each field is optional. A field
 * that is present must have its stored type. Thus a bare scalar, an array, `null` and a non-string
 * `phase` fail the parse.
 */
const WorkflowGetDataSchema = z
  .object({
    featureId: z.string().optional(),
    workflowType: z.string().optional(),
    phase: z.string().optional(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_workflow.get`: an object in each read mode. */
export const WorkflowGetOutputSchema = EnvelopeSchema(WorkflowGetDataSchema);

/**
 * The success data of `exarchos_workflow.init`: the identity of the new workflow, its first phase
 * and its first phase attempt id. An idempotent retry returns the persisted attempt id.
 */
const WorkflowInitDataSchema = z
  .object({
    featureId: z.string(),
    workflowType: z.string(),
    phase: z.string(),
    phaseAttemptId: z.string(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_workflow.init`: the identity and the first phase of the workflow. */
export const WorkflowInitOutputSchema = EnvelopeSchema(WorkflowInitDataSchema);

/**
 * The success data of `exarchos_workflow.transition` and `exarchos_workflow.update`. Both handlers
 * return the result of `handleSet`, which has two arms. A write returns the phase, the workflow type
 * and the time of the write. A self-transition without updates writes nothing, and returns
 * `idempotent: true` and no workflow type. A state from before v2.12 holds no phase attempt id, so
 * that key is optional in both arms.
 */
const WorkflowStateWriteDataSchema = z.union([
  z
    .object({
      phase: z.string(),
      workflowType: z.string(),
      updatedAt: z.string(),
      phaseAttemptId: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      phase: z.string(),
      updatedAt: z.string(),
      idempotent: z.literal(true),
      phaseAttemptId: z.string().optional(),
    })
    .passthrough(),
]);

/**
 * The `outputSchema` of `exarchos_workflow.transition` and `exarchos_workflow.update`. It has no
 * `_meta.deprecation` constraint, because neither action emits that slot.
 */
export const WorkflowStateWriteOutputSchema = EnvelopeSchema(WorkflowStateWriteDataSchema);

/** One compensation step of `exarchos_workflow.cancel`, as `executeCompensation` reports it. */
const CompensationActionDataSchema = z
  .object({
    actionId: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .passthrough();

/**
 * The success data of `exarchos_workflow.cancel`. A dry run changes nothing. It returns the
 * compensation steps and the phase that a real cancel goes to. A real cancel returns the steps, the
 * phase before the cancel and the new phase attempt id.
 */
const WorkflowCancelDataSchema = z.union([
  z
    .object({
      dryRun: z.literal(true),
      actions: z.array(CompensationActionDataSchema),
      currentPhase: z.string(),
      wouldTransitionTo: z.literal('cancelled'),
    })
    .passthrough(),
  z
    .object({
      phase: z.literal('cancelled'),
      actions: z.array(CompensationActionDataSchema),
      previousPhase: z.string(),
      phaseAttemptId: z.string(),
    })
    .passthrough(),
]);

/** The `outputSchema` of `exarchos_workflow.cancel`: the dry-run arm or the cancelled arm. */
export const WorkflowCancelOutputSchema = EnvelopeSchema(WorkflowCancelDataSchema);

/**
 * The success data of `exarchos_workflow.cleanup`. A dry run changes nothing. It returns the phase
 * that a real cleanup goes to and the synthesis inputs that it backfills. An absent input is `null`.
 * A real cleanup returns the phase before the cleanup and the new phase attempt id.
 */
const WorkflowCleanupDataSchema = z.union([
  z
    .object({
      dryRun: z.literal(true),
      currentPhase: z.string(),
      wouldTransitionTo: z.literal('completed'),
      synthesisBackfill: z
        .object({
          prUrl: z.union([z.string(), z.array(z.string())]).nullable(),
          mergedBranches: z.array(z.string()).nullable(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      phase: z.literal('completed'),
      previousPhase: z.string(),
      phaseAttemptId: z.string(),
    })
    .passthrough(),
]);

/** The `outputSchema` of `exarchos_workflow.cleanup`: the dry-run arm or the completed arm. */
export const WorkflowCleanupOutputSchema = EnvelopeSchema(WorkflowCleanupDataSchema);

/** The success data of `exarchos_workflow.reconcile`: the count of events that the fold applied. */
const WorkflowReconcileDataSchema = z
  .object({
    reconciled: z.boolean(),
    eventsApplied: z.number().int().nonnegative(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_workflow.reconcile`. */
export const WorkflowReconcileOutputSchema = EnvelopeSchema(WorkflowReconcileDataSchema);

/** One finding of the handoff prose lint, as `lintHandoff` returns it. */
const HandoffLintFindingDataSchema = z
  .object({
    pattern: z.string(),
    line: z.number(),
    excerpt: z.string(),
    source: z.string(),
  })
  .passthrough();

/**
 * The success data of `exarchos_workflow.checkpoint`. The playbook is `null` when the workflow type
 * and the phase have no playbook. A checkpoint with an event store adds the snapshot sequence. A
 * handoff with lint findings adds them.
 */
const WorkflowCheckpointDataSchema = z
  .object({
    phase: z.string(),
    projectionSequence: z.number().int().nonnegative().optional(),
    phasePlaybook: PhasePlaybookSchema,
    handoffLintFindings: z.array(HandoffLintFindingDataSchema).optional(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_workflow.checkpoint`. */
export const WorkflowCheckpointOutputSchema = EnvelopeSchema(WorkflowCheckpointDataSchema);

/**
 * The success data of `exarchos_workflow.feedback`: the recorded event and the upstream delivery
 * status. `configuredEndpoint` is `null` when no upstream endpoint is configured.
 */
const WorkflowFeedbackDataSchema = z
  .object({
    recorded: z.literal(true),
    stream: z.string(),
    sequence: z.number().int().nonnegative(),
    message: z.string(),
    upstreamConfigured: z.boolean(),
    configuredEndpoint: z.string().nullable(),
    upstreamDelivered: z.boolean(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_workflow.feedback`. */
export const WorkflowFeedbackOutputSchema = EnvelopeSchema(WorkflowFeedbackDataSchema);

/**
 * The `outputSchema` of `exarchos_workflow.rehydrate`. The fresh path and the degraded path both
 * return a v:4 rehydration document. The document schema is strict, so an unknown key fails the parse.
 */
export const WorkflowRehydrateOutputSchema = EnvelopeSchema(RehydrationDocumentSchema);

/** The drain result of one outbox stream, as `Outbox.drain` returns it. */
const SyncStreamResultDataSchema = z
  .object({
    streamId: z.string(),
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * The success data of `exarchos_sync.now`: the count of outbox streams and a message. A drain with a
 * sender adds one result for each stream. Local mode and an empty outbox add no results.
 */
const SyncNowDataSchema = z
  .object({
    streams: z.number().int().nonnegative(),
    message: z.string(),
    results: z.array(SyncStreamResultDataSchema).optional(),
  })
  .passthrough();

/** The `outputSchema` of `exarchos_sync.now`. */
export const SyncNowOutputSchema = EnvelopeSchema(SyncNowDataSchema);

export { CappedDataSchema, withCappedShape } from '../output-schema-declaration.js';
