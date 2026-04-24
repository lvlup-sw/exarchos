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

export const WorkflowStateSchema = z.object({
  featureId: z.string(),
  phase: z.string(),
  workflowType: z.string(),
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
