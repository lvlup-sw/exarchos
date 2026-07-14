// ─── Typed output schemas for the seven `surface: 'worktree'` actions (DR-1) ──
//
// The worktree "DR-10 surface" actions — acquire_worktree, release_worktree,
// prune_worktrees, serialize_merge (exarchos_orchestrate) and worktrees, ps,
// wait (exarchos_view) — used to advertise `EnvelopeSchema(z.unknown())`, an
// untyped `data` payload. This module promotes each to a TYPED envelope schema
// whose success `data` branch is shape-derived from the REAL handler return
// (`handlers.ts` / `merge-serializer.ts`), while the INV-5b error envelope
// (`validTargets` / `expectedShape` / `suggestedFix`) is modeled by the shared
// `ErrorEnvelopeSchema` inside {@link EnvelopeSchema}'s discriminated union.
//
// Derivation discipline (do NOT over-constrain): the MCP adapter `safeParse`s
// the REAL handler output against `outputSchema` and, on a miss, REPLACES the
// result with an INTERNAL_ERROR (`adapters/mcp.ts`). A schema STRICTER than the
// real output would therefore break production. Every data object is declared in
// Zod's default strip mode with `.passthrough()`, so a future field addition is
// tolerated, and fields that vary at runtime are `.optional()` / `.nullable()`.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { EnvelopeSchema } from '../../schemas/envelope.js';

// ─── Shared projection sub-schemas (mirror `projections/worktrees.ts`) ────────

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

/** One in-flight `prune_worktrees` GC pass (mirrors `InFlightPrune`). */
const InFlightPruneSchema = z
  .object({
    operationId: z.string(),
    repoRoot: z.string(),
    holderPid: z.number().nullable(),
    holderStartedAt: z.string().nullable(),
  })
  .passthrough();

/** One prune-candidate ladder verdict (mirrors `PruneClassification`). */
const PruneClassificationSchema = z.union([
  z.object({ action: z.literal('skip'), reason: z.string() }).passthrough(),
  z.object({ action: z.literal('orphan-unverifiable') }).passthrough(),
  z.object({ action: z.literal('delete-eligible') }).passthrough(),
]);

/** One prune-candidate report line (mirrors `PruneCandidateReport`). */
const PruneCandidateReportSchema = z
  .object({
    worktreeId: z.string(),
    path: z.string(),
    featureId: z.string().nullable(),
    state: z.enum(['adopted', 'reserved', 'released', 'orphan']),
    classification: PruneClassificationSchema,
    reclaimableBytes: z.number(),
    deleted: z.boolean(),
  })
  .passthrough();

// ─── Per-action success `data` schemas ────────────────────────────────────────

/** `acquire_worktree` success — adopt-then-reserve outcome (`handleAcquireWorktree`). */
const AcquireWorktreeData = z
  .object({
    worktreeId: z.string(),
    path: z.string(),
    featureId: z.string().nullable(),
    reserved: z.boolean(),
    adopted: z.boolean(),
  })
  .passthrough();

/** `release_worktree` success — the released-claim outcome (`handleReleaseWorktree`). */
const ReleaseWorktreeData = z
  .object({
    worktreeId: z.string(),
    released: z.boolean(),
  })
  .passthrough();

/** `prune_worktrees` success — the GC ladder report (`PruneResult`). */
const PruneWorktreesData = z
  .object({
    dryRun: z.boolean(),
    candidates: z.array(PruneCandidateReportSchema),
    deleted: z.array(z.string()),
    reclaimableBytes: z.number(),
    skipsByReason: z.record(z.string(), z.array(z.string())),
  })
  .passthrough();

/**
 * `serialize_merge` success — either the dry-run planned effect (DR-1 default,
 * Task 002) OR the executed-merge pass-through of `merge_orchestrate`'s data
 * annotated with the serializer's own `serializedMerge` lease metadata. The
 * composed `merge_orchestrate` payload is genuinely open (many success shapes),
 * so every field is optional and the object passes through — this is the "do
 * NOT over-constrain" seam that keeps the MCP adapter from replacing a real
 * merge result with an INTERNAL_ERROR.
 */
const SerializeMergeData = z
  .object({
    // Dry-run planned-effect fields (Task 002 default).
    dryRun: z.boolean().optional(),
    integrationRef: z.string().optional(),
    sourceBranch: z.string().optional(),
    strategy: z.string().optional(),
    featureId: z.string().optional(),
    integrationHead: z.string().nullable().optional(),
    // Executed-merge lease annotation (present on a real merge success).
    serializedMerge: z
      .object({
        integrationRef: z.string(),
        operationId: z.string(),
        integrationHead: z.string().nullable(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** One folded workflow-summary row (mirrors `views/lifecycle/workflow-fold.ts`
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

/** One folded in-flight liveness instance (mirrors `views/lifecycle/operations-fold.ts`
 *  `InFlightOperation`) — the `ps` scope:'all' operations section. */
const InFlightOperationSchema = z
  .object({
    surface: z.string(),
    instanceKey: z.string(),
    streamScope: z.string(),
    startType: z.string(),
    startedAt: z.string().optional(),
    ageMs: z.number().optional(),
  })
  .passthrough();

/**
 * `ps` success — the DR-3 scope-parameterized fold. THREE shapes ride ONE
 * `.passthrough()` schema, selected by `scope`:
 *   - scope:'worktree' (WLM-6, unchanged): inFlight/count/launches/launchCount/
 *     prunes/pruneCount, plus probe/reconcile/mergeReconcile on `probe: true`;
 *   - scope:'workflow': workflows/workflowCount (+ echoed `scope`);
 *   - scope:'all' (default): workflows/workflowCount + operations/operationCount.
 * Every field is therefore optional — no single scope carries all of them — so a
 * response for any scope validates against this one schema (the MCP adapter
 * safeParses real output against it; an over-strict shape would break production).
 */
const PsData = z
  .object({
    // Scope discriminator (echoed on the workflow/all shapes; absent on the raw
    // WLM-6 worktree shape, which predates the scope field).
    scope: z.string().optional(),
    // Worktree scope (WLM-6) — now optional, present only for scope:'worktree'.
    inFlight: z.array(InFlightMergeSchema).optional(),
    count: z.number().optional(),
    launches: z.array(WorktreeEntrySchema).optional(),
    launchCount: z.number().optional(),
    prunes: z.array(InFlightPruneSchema).optional(),
    pruneCount: z.number().optional(),
    probe: z.record(z.string(), z.unknown()).optional(),
    reconcile: z.record(z.string(), z.unknown()).optional(),
    mergeReconcile: z.record(z.string(), z.unknown()).optional(),
    // Workflows section (scope:'workflow'|'all').
    workflows: z.array(WorkflowFoldRowSchema).optional(),
    workflowCount: z.number().optional(),
    // Operations section (scope:'all').
    operations: z.array(InFlightOperationSchema).optional(),
    operationCount: z.number().optional(),
  })
  .passthrough();

/**
 * `wait` success — the resolved outcome (DR-5). ALWAYS carries `resolved: true`
 * + `waitedMs`. The worktree scope stamps `until`/`integrationRef`; the generic
 * feature-scoped predicates stamp `predicate` (`phase`/`status`/`operation`) with
 * the matched target, plus an optional `perf` snapshot of the DR-1 subscription's
 * Tier-2 floor telemetry (surfaced when resolution rode a floor tick). All
 * optional + passthrough so every success shape validates against one schema.
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
 * `worktrees` success — the governed-worktree fold. Task 006 adds a `summary`
 * variant + `limit`/`offset` echo when the inventory is capped, so those fields
 * are modeled optional here and the per-item detail (`worktrees`/`count`) is
 * likewise optional so the summary shape validates.
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

// ─── Public per-action envelope output schemas ────────────────────────────────
//
// Each is `EnvelopeSchema(<data>)` — a `success` discriminated union whose
// `true` branch types `data` and whose `false` branch is the shared
// `ErrorEnvelopeSchema` (models `validTargets` / `suggestedFix` and passes
// `expectedShape` through the error block — the INV-5b error envelope).

export const AcquireWorktreeOutputSchema = EnvelopeSchema(AcquireWorktreeData);
export const ReleaseWorktreeOutputSchema = EnvelopeSchema(ReleaseWorktreeData);
export const PruneWorktreesOutputSchema = EnvelopeSchema(PruneWorktreesData);
export const SerializeMergeOutputSchema = EnvelopeSchema(SerializeMergeData);
export const PsOutputSchema = EnvelopeSchema(PsData);
export const WaitOutputSchema = EnvelopeSchema(WaitData);
export const WorktreesOutputSchema = EnvelopeSchema(WorktreesData);

// ─── Introspection helper (shared by the schema + parity conformance suites) ──

/**
 * Does a `surface: 'worktree'` action's `outputSchema` advertise a TYPED
 * `data` payload (i.e. NOT `EnvelopeSchema(z.unknown())` or `EnvelopeSchema(z.any())`)?
 * Extracts the success branch of the `success`-discriminated envelope union and
 * inspects its `data` field: a typed schema is anything other than the two
 * structural escape hatches `z.unknown()` and `z.any()` — BOTH accept an
 * arbitrary payload, so either one would defeat the typed-output conformance guard.
 *
 * Robust to Zod v4's union internals — the success option is located by the
 * presence of a `data` key in its object shape (the error branch has none).
 */
export function envelopeDataSchemaIsTyped(outputSchema: z.ZodType): boolean {
  const dataSchema = extractEnvelopeDataSchema(outputSchema);
  if (dataSchema === undefined) return false;
  return !(dataSchema instanceof z.ZodUnknown) && !(dataSchema instanceof z.ZodAny);
}

/**
 * Pull the success-branch `data` sub-schema out of an `EnvelopeSchema(...)`
 * discriminated union, or `undefined` when the shape is not a recognizable
 * envelope union (e.g. a bare schema).
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
