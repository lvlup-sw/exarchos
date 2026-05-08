/**
 * Canonical rehydration document — v:2 (DR-3 + #1240 + #1246).
 *
 * T011 lands stable prefix; T012 adds volatile sections; T013 composes the
 * full envelope. T1 of the checkpoint-handoff bundle (#1240 + #1246) bumps
 * the envelope to v:2: it adds `latestHandoff` / `recentHandoffs` to the
 * volatile section, promotes `eventRef.sequence` from advisory to primary
 * key, and removes `eventRef.id` from the v:2 entry shape. The v:1 entry
 * and envelope schemas are exported for the read-back path only (T3
 * consumes them via `loadRehydrationDocument`).
 */
import { z } from 'zod';

export const BehavioralGuidanceSchema = z.object({
  skill: z.string(),
  skillRef: z.string(),
  tools: z.unknown().optional(),
});

/**
 * Sub-state of the merge orchestrator surfaced on the rehydration envelope so
 * that `next_actions` consumers can decide whether to surface a
 * `merge_orchestrate` verb (idempotency-keyed) without querying the event
 * store directly. Set by the rehydration reducer when a worktree-bearing
 * `task.completed` is observed (#1208 / DR-MO-1) and updated on
 * `merge.executed` / `merge.rollback` / `merge.aborted`.
 */
export const RehydrationMergeOrchestratorSchema = z.object({
  /** Task whose worktree merge is pending / has terminated. */
  taskId: z.string(),
  /**
   * `pending` — merge has been requested but not yet executed.
   * `completed` / `rolled-back` / `aborted` — terminal; do not re-surface
   * `merge_orchestrate`.
   */
  phase: z.enum(['pending', 'completed', 'rolled-back', 'aborted']),
});

export const WorkflowStateSchema = z.object({
  featureId: z.string(),
  phase: z.string(),
  workflowType: z.string(),
  /**
   * Merge orchestrator sub-state (see {@link RehydrationMergeOrchestratorSchema}).
   * Optional — only present once a worktree-bearing task.completed has been
   * folded. Read by `nextActionsFromResult` to drive the
   * `merge_orchestrate` verb surfacing.
   */
  mergeOrchestrator: RehydrationMergeOrchestratorSchema.optional(),
});

export const StableSectionsSchema = z.object({
  behavioralGuidance: BehavioralGuidanceSchema,
  workflowState: WorkflowStateSchema,
});

export type StableSections = z.infer<typeof StableSectionsSchema>;

/**
 * Volatile sections — T012 (DR-3).
 * Schemas are intentionally permissive (shape-level) in this task; downstream
 * tasks tighten individual sub-fields. `.strict()` at the top level rejects
 * unknown sibling keys to keep the envelope forward-compatible only via
 * explicit schema revs.
 */
export const TaskProgressEntrySchema = z.object({
  id: z.string(),
  status: z.string(),
}).passthrough();

export const DecisionEntrySchema = z.record(z.string(), z.unknown());

export const ArtifactsSchema = z.record(z.string(), z.string());

export const BlockerEntrySchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
]);

/**
 * Thin local NextAction shape — T012 is intentionally self-contained. T015
 * already exports a canonical NextAction schema; a later task unifies.
 */
export const VolatileNextActionSchema = z.object({
  verb: z.string(),
  reason: z.string(),
});

/**
 * Handoff entry — v:1 advisory contract (#1246 read-back path only).
 *
 * Used solely by the read-side migration in T3 (`loadRehydrationDocument`)
 * to parse legacy v:1 snapshots and upgrade them to v:2 in memory. Writers
 * never construct v:1 entries after this PR. `eventRef.id` is the primary
 * key in v:1; `eventRef.sequence` was advisory and may be absent on
 * pre-#1230 entries (the case T3 fail-opens via `HandoffEntryUpgradeError`).
 */
export const HandoffEntrySchemaV1 = z.object({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
  eventRef: z.object({
    id: z.string(),
    timestamp: z.string(),
    sequence: z.number().int().optional(),
  }),
});

/**
 * Handoff entry — v:2 contract (#1246 production write path).
 *
 * `eventRef.sequence` is primary (nonneg int) and `eventRef.id` is removed
 * entirely (DR-Q-V2 strict deprecation). The inner `eventRef` is `.strict()`
 * to reject stray `id` keys at the schema boundary — without that, a v:1
 * entry could silently leak into a v:2 envelope and the verification
 * checklist's "no mixed-version output" invariant would not hold.
 */
export const HandoffEntrySchemaV2 = z
  .object({
    context: z.string().max(2048).optional(),
    nextSteps: z.array(z.string().max(256)).max(10).optional(),
    suggestions: z.array(z.string().max(256)).max(10).optional(),
    eventRef: z
      .object({
        sequence: z.number().int().nonnegative(),
        timestamp: z.string(),
      })
      .strict(),
  })
  .strict();

export type HandoffEntryV1 = z.infer<typeof HandoffEntrySchemaV1>;
export type HandoffEntryV2 = z.infer<typeof HandoffEntrySchemaV2>;

export const VolatileSectionsSchema = z
  .object({
    taskProgress: z.array(TaskProgressEntrySchema),
    decisions: z.array(DecisionEntrySchema),
    artifacts: ArtifactsSchema,
    blockers: z.array(BlockerEntrySchema),
    nextAction: VolatileNextActionSchema.optional(),
    /**
     * Most recent handoff entry, if any. Updated by the reducer on each
     * non-empty `workflow.checkpoint` event; cleared only on stream reset.
     */
    latestHandoff: HandoffEntrySchemaV2.optional(),
    /**
     * Bounded sliding window (max 3) of the most recent handoff entries,
     * most-recent first. The cap caps token cost in the rehydration
     * envelope; older entries naturally fall off as new checkpoints land.
     */
    recentHandoffs: z.array(HandoffEntrySchemaV2).max(3).default([]),
  })
  .strict();

/**
 * v:1 volatile sections — used by `RehydrationDocumentSchemaV1` for read-back
 * of legacy snapshots. Mirrors the pre-#1240 / pre-#1246 shape: no
 * `latestHandoff` / `recentHandoffs` fields, but tolerates v:1 entries on
 * those keys via the V1 entry schema if they were written by an earlier
 * spike branch. The strict boundary still rejects unknown sibling keys so
 * snapshot corruption surfaces as a parse error rather than silent drop.
 */
export const VolatileSectionsSchemaV1 = z
  .object({
    taskProgress: z.array(TaskProgressEntrySchema),
    decisions: z.array(DecisionEntrySchema),
    artifacts: ArtifactsSchema,
    blockers: z.array(BlockerEntrySchema),
    nextAction: VolatileNextActionSchema.optional(),
    latestHandoff: HandoffEntrySchemaV1.optional(),
    recentHandoffs: z.array(HandoffEntrySchemaV1).max(3).optional(),
  })
  .strict();

export type VolatileSections = z.infer<typeof VolatileSectionsSchema>;

/**
 * Top-level rehydration document envelope — T013 (DR-3) + T1 (#1246 v:2 bump).
 *
 * Composes the stable prefix (T011) and volatile sections (T012) under a
 * versioned envelope:
 *   - `v: 2` is the current literal version. The bundle's design (DR-Q-REV)
 *     does a single bump for both #1240 (handoff fields) and #1246
 *     (eventRef.sequence promotion) so readers know v:2 implies both.
 *   - `projectionSequence` pins the document to a specific point in the
 *     projection log and must be a non-negative integer.
 *
 * Read-side compatibility: legacy v:1 snapshots are parsed via
 * {@link RehydrationDocumentSchemaV1} (T3 read-back path); new writes always
 * produce v:2. There is intentionally no union here — writers never produce
 * v:1, so a union would invite mixed-version output (DR-Q-V2 strict
 * deprecation).
 */
export const RehydrationDocumentSchema = z
  .object({
    v: z.literal(2),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchema)
  .merge(VolatileSectionsSchema);

export type RehydrationDocument = z.infer<typeof RehydrationDocumentSchema>;

/**
 * Frozen v:1 envelope — read-back / migration path only (#1246, T3).
 *
 * Exported so `loadRehydrationDocument` can probe `v` and route legacy
 * snapshots through this schema before applying the per-entry upgrade
 * (`upgradeHandoffEntryV1toV2`). Retirement criterion documented on the
 * design doc (out-of-scope #1296): retire once on-disk v:1 doc count == 0.
 *
 * Writers MUST NOT use this schema. There is no public type alias for the
 * v:1 envelope to discourage accidental construction.
 */
export const RehydrationDocumentSchemaV1 = z
  .object({
    v: z.literal(1),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchema)
  .merge(VolatileSectionsSchemaV1);
