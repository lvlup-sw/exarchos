// ─── Sidecar Schemas (design.v1, plan.v1) — #1298 ────────────────────────────
//
// Machine-readable sidecar contracts consumed by the four authoring gates
// (`check_design_completeness`, `check_plan_coverage`, `check_provenance_chain`,
// `check_task_decomposition`). When a `<doc>.sidecar.yml` is present next to
// the markdown, gates parse it via these schemas and operate on structured
// input. When absent, gates fall back to the existing regex-scrape branch
// with a deprecation warning (scheduled for removal in v2.11).
//
// Schema-version is a literal (`design.v1` / `plan.v1`) so mismatched-version
// docs reject cleanly via `safeParse(...).success === false`.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ─── Design.v1 ──────────────────────────────────────────────────────────────

/**
 * A single design requirement, identified by its DR-N id with a title and the
 * design section it appears under.
 */
export const DesignRequirementSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  section: z.string(),
});

/**
 * An acceptance criterion entry, identified by id, references one or more DRs.
 */
export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  references: z.array(z.string()),
});

/**
 * Per-section presence flag. Gates that scan markdown for "is section X
 * present?" now read this directly. Extra section-specific scalars (like
 * `options.count`) live at the top-level alongside `sections`.
 */
export const DesignSectionEntrySchema = z.object({
  present: z.boolean(),
});

export const DesignSidecarV1 = z.object({
  schema: z.literal('design.v1'),
  sections: z.record(z.string(), DesignSectionEntrySchema),
  drs: z.array(DesignRequirementSchema),
  acceptance: z.array(AcceptanceCriterionSchema),
  options: z
    .object({
      count: z.number().int().nonnegative(),
    })
    .optional(),
});

export type DesignSidecarV1 = z.infer<typeof DesignSidecarV1>;

// ─── Plan.v1 ────────────────────────────────────────────────────────────────

export const PlanTaskPhaseSchema = z.enum(['RED', 'GREEN', 'REFACTOR']);
export type PlanTaskPhase = z.infer<typeof PlanTaskPhaseSchema>;

export const PlanTaskEntrySchema = z.object({
  id: z.string().min(1),
  phase: PlanTaskPhaseSchema,
  description: z.string(),
  files: z.array(z.string()),
});

export const PlanProvenanceEntrySchema = z.object({
  taskId: z.string().min(1),
  dr: z.string().min(1),
});

export const PlanSidecarV1 = z.object({
  schema: z.literal('plan.v1'),
  tasks: z.array(PlanTaskEntrySchema),
  // Maps DR id → task ids that cover that requirement.
  coverage: z.record(z.string(), z.array(z.string())),
  provenance: z.array(PlanProvenanceEntrySchema),
});

export type PlanSidecarV1 = z.infer<typeof PlanSidecarV1>;
