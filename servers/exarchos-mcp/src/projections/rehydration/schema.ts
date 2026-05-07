/**
 * Canonical rehydration document — v1 (DR-3).
 * T011 lands stable prefix; T012 adds volatile sections; T013 composes the full envelope.
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

export const VolatileSectionsSchema = z
  .object({
    taskProgress: z.array(TaskProgressEntrySchema),
    decisions: z.array(DecisionEntrySchema),
    artifacts: ArtifactsSchema,
    blockers: z.array(BlockerEntrySchema),
    nextAction: VolatileNextActionSchema.optional(),
  })
  .strict();

export type VolatileSections = z.infer<typeof VolatileSectionsSchema>;

/**
 * Top-level rehydration document envelope — T013 (DR-3).
 *
 * Composes the stable prefix (T011) and volatile sections (T012) under a
 * versioned envelope:
 *   - `v: 1` is a literal version discriminator; future schema revs bump this.
 *   - `projectionSequence` pins the document to a specific point in the
 *     projection log and must be a non-negative integer.
 */
export const RehydrationDocumentSchema = z
  .object({
    v: z.literal(1),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchema)
  .merge(VolatileSectionsSchema);

export type RehydrationDocument = z.infer<typeof RehydrationDocumentSchema>;
