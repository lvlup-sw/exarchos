/**
 * Typed output schemas for the `surface: 'worktree'` read actions. Each success `data` schema
 * follows the real handler return in `handlers.ts`. The shared
 * `ErrorEnvelopeSchema` inside {@link EnvelopeSchema} models the error branch. The MCP adapter
 * replaces output that fails its `outputSchema` with an `INTERNAL_ERROR`. A schema stricter than
 * the real output thus breaks production. For this reason, every data object uses `.passthrough()`,
 * and fields that vary at runtime are optional or nullable.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

/** Launcher-liveness marker carried on a {@link WorktreeEntrySchema}. */
const LaunchInFlightSchema = z
  .object({
    holderPid: z.number().nullable(),
    holderStartedAt: z.string().nullable(),
  })
  .passthrough();

/** One governed worktree (mirrors `WorktreeEntry`). */
const WorktreeEntrySchema = z
  .object({
    worktreeId: z.string(),
    path: z.string(),
    featureId: z.string().nullable(),
    state: z.enum(['adopted', 'reserved', 'released', 'orphan']),
    ownerPid: z.number().nullable(),
    ownerStartedAt: z.string().nullable(),
    launch: LaunchInFlightSchema.optional(),
  })
  .passthrough();

/** One in-flight serialized merge lease (mirrors `InFlightMerge`). */
const InFlightMergeSchema = z
  .object({
    integrationRef: z.string(),
    operationId: z.string(),
    sourceBranch: z.string(),
    holderPid: z.number().nullable(),
    holderStartedAt: z.string().nullable(),
    worktreeId: z.string().nullable(),
  })
  .passthrough();

/** One in-flight prune pass of the retired GC, read from history (mirrors `InFlightPrune`). */
const InFlightPruneSchema = z
  .object({
    operationId: z.string(),
    repoRoot: z.string(),
    holderPid: z.number().nullable(),
    holderStartedAt: z.string().nullable(),
  })
  .passthrough();

/** One folded workflow-summary row (mirrors `projections/views/lifecycle/workflow-fold.ts`
 *  `WorkflowFoldRow`) — the `ps` scope:'workflow'|'all' workflows section. */
const WorkflowFoldRowSchema = z
  .object({
    featureId: z.string(),
    workflowType: z.string(),
    phase: z.string(),
    status: z.string(),
    ageMs: z.number().nullable(),
  })
  .passthrough();

/** One folded in-flight liveness instance (mirrors `projections/views/lifecycle/operations-fold.ts`
 *  `InFlightOperation`) — the `ps` scope:'all' operations section. */
const InFlightOperationSchema = z
  .object({
    surface: z.string(),
    instanceKey: z.string(),
    streamScope: z.string(),
    startType: z.string(),
    startedAt: z.string().optional(),
    ageMs: z.number().nullable(),
  })
  .passthrough();

/**
 * `ps` success. One schema carries three shapes, selected by `scope`:
 *   - `worktree`: `inFlight`, `count`, `launches`, `launchCount`, `prunes`, `pruneCount`.
 *   - `workflow`: `workflows` and `workflowCount`.
 *   - `all`, the default: the `workflow` fields plus `operations` and `operationCount`.
 * The `workflow` and `all` shapes echo `scope`. No shape carries every field, so every field is
 * optional.
 */
const PsData = z
  .object({
    scope: z.string().optional(),
    inFlight: z.array(InFlightMergeSchema).optional(),
    count: z.number().optional(),
    launches: z.array(WorktreeEntrySchema).optional(),
    launchCount: z.number().optional(),
    prunes: z.array(InFlightPruneSchema).optional(),
    pruneCount: z.number().optional(),
    workflows: z.array(WorkflowFoldRowSchema).optional(),
    workflowCount: z.number().optional(),
    operations: z.array(InFlightOperationSchema).optional(),
    operationCount: z.number().optional(),
  })
  .passthrough();

/**
 * `wait` success. It always carries `resolved: true` and `waitedMs`. The worktree scope adds
 * `until` or `integrationRef`. The feature-scoped predicates add `predicate` and its target, and
 * can add a `perf` snapshot of the subscription. Every other field is optional.
 */
const WaitData = z
  .object({
    resolved: z.literal(true),
    waitedMs: z.number(),
    until: z.string().optional(),
    integrationRef: z.string().optional(),
    predicate: z.string().optional(),
    phase: z.string().optional(),
    status: z.string().optional(),
    operation: z.string().optional(),
    perf: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * `worktrees` success. A capped inventory returns a `summary` or a page with `total` and
 * `truncated`, so every field is optional.
 */
const WorktreesData = z
  .object({
    worktrees: z.array(WorktreeEntrySchema).optional(),
    count: z.number().optional(),
    summary: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    total: z.number().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

export const PsOutputSchema = EnvelopeSchema(PsData);
export const WaitOutputSchema = EnvelopeSchema(WaitData);
export const WorktreesOutputSchema = EnvelopeSchema(WorktreesData);

/**
 * True when an `outputSchema` types its success `data`, that is, when `data` is neither
 * `z.unknown()` nor `z.any()`. Both accept any payload and defeat the typed-output conformance
 * guard.
 */
export function envelopeDataSchemaIsTyped(outputSchema: z.ZodType): boolean {
  const dataSchema = extractEnvelopeDataSchema(outputSchema);
  if (dataSchema === undefined) return false;
  return !(dataSchema instanceof z.ZodUnknown) && !(dataSchema instanceof z.ZodAny);
}

/**
 * Returns the success `data` schema of an `EnvelopeSchema(...)` union, or `undefined` for any other
 * schema. It finds the success option by its `data` key, because the error option has none.
 */
export function extractEnvelopeDataSchema(
  outputSchema: z.ZodType,
): z.ZodType | undefined {
  if (!(outputSchema instanceof z.ZodDiscriminatedUnion)) return undefined;
  const options = outputSchema.options as ReadonlyArray<z.ZodObject<z.ZodRawShape>>;
  for (const option of options) {
    const shape = option.shape;
    if (shape !== undefined && 'data' in shape) {
      return shape.data as z.ZodType;
    }
  }
  return undefined;
}
