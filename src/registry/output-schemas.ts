/**
 * The output schemas of some workflow and telemetry actions. Each action schema wraps
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

export { CappedDataSchema, withCappedShape } from '../output-schema-declaration.js';
