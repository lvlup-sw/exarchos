/**
 * The output schemas of some workflow, telemetry and event actions. Each action schema wraps
 * `EnvelopeSchema`. The module also re-exports `CappedDataSchema` and `withCappedShape` from
 * `output-schema-declaration.ts`, which keeps the brand mint private. Thus `withCappedShape` is the
 * only constructor of a substantive `outputSchema`.
 */

import { EnvelopeSchema } from '../contract/schemas/envelope.js';
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
 * The `outputSchema` of `exarchos_workflow.transition`: the envelope plus the typed
 * `_meta.deprecation` constraint. The action does not emit the slot. The schema declares it for
 * contract introspection.
 *
 * @deprecated Use `EnvelopeSchema(dataSchema)` from `contract/schemas/envelope.ts`, with the
 * success-data shape of the action. The removal target is v2.12.
 */
export const WorkflowTransitionOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * The `outputSchema` of `exarchos_workflow.update`. It is the envelope without the
 * `_meta.deprecation` constraint, because `update` is not deprecated.
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

export { CappedDataSchema, withCappedShape } from '../output-schema-declaration.js';
