/**
 * Canonical rehydration document — v1 stable sections (DR-3).
 * T011 lands stable prefix only; T012 adds volatile sections and T013 composes the full envelope.
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
