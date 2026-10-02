/**
 * Zod schemas for the rehydration document. Writers emit envelope v:4 through `RehydrationDocumentSchema`.
 * The v:1, v:2 and v:3 schemas parse old snapshots for the upgrade chain in `upgrade.ts`.
 */
import { z } from 'zod';

/**
 * Zod copy of {@link SerializedPhasePlaybook}. `workflow/playbooks.ts` exports only TypeScript interfaces, so this schema repeats the shape.
 * It is nullable, because no playbook exists for some (workflowType, phase) pairs.
 */
export const PhasePlaybookSchema = z
  .object({
    skill: z.string(),
    skillRef: z.string(),
    tools: z.array(
      z
        .object({
          tool: z.string(),
          action: z.string(),
          purpose: z.string(),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          type: z.string(),
          when: z.string(),
          fields: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    /** The runtime-emitted events of the phase. A phase without them leaves the field absent, not `[]`. */
    autoEmittedEvents: z
      .array(
        z
          .object({
            type: z.string(),
            when: z.string(),
            fields: z.array(z.string()).optional(),
            source: z.literal('auto'),
            emittedBy: z.string(),
          })
          .strict(),
      )
      .optional(),
    transitionCriteria: z.string(),
    guardPrerequisites: z.string(),
    validationScripts: z.array(z.string()),
    humanCheckpoint: z.boolean(),
    compactGuidance: z.string(),
  })
  .strict()
  .nullable();

export type PhasePlaybook = z.infer<typeof PhasePlaybookSchema>;

/**
 * Merge orchestrator state on the envelope. With it, a `next_actions` consumer decides on the `merge_orchestrate` verb without an event store query.
 * The reducer sets it on a `task.completed` with a worktree. `merge.executed`, `merge.recovered`, `merge.rollback` and `merge.aborted` update it.
 */
export const RehydrationMergeOrchestratorSchema = z.object({
  /** The task that owns the worktree merge. */
  taskId: z.string(),
  /**
   * `completed`, `rolled-back` and `aborted` are terminal, and do not surface `merge_orchestrate` again.
   * The schema accepts `executing`, so a `handleGet` during a merge does not fail closed.
   * It must match the `phase` enum of `MergeOrchestratorStateSchema` in `workflow/schemas.ts`. A test in `next-actions-from-result.test.ts` pins this.
   */
  phase: z.enum(['pending', 'executing', 'completed', 'rolled-back', 'aborted']),
});

export const WorkflowStateSchema = z.object({
  featureId: z.string(),
  phase: z.string(),
  workflowType: z.string(),
  /** Absent until the reducer folds a `task.completed` with a worktree. `nextActionsFromResult` reads it. */
  mergeOrchestrator: RehydrationMergeOrchestratorSchema.optional(),
});

/** Stable sections for v:3 and v:4. The handler composes `phasePlaybook`, which is in {@link VolatileSectionsSchema}. */
export const StableSectionsSchema = z.object({
  workflowState: WorkflowStateSchema,
});

export type StableSections = z.infer<typeof StableSectionsSchema>;

/** Stable sections of the v:1 and v:2 envelopes, for read-back only. */
const StableSectionsSchemaV2 = z.object({
  behavioralGuidance: z.object({
    skill: z.string(),
    skillRef: z.string(),
    tools: z.unknown().optional(),
  }),
  workflowState: WorkflowStateSchema,
});

/** A `taskProgress` entry. It checks only `id` and `status`, and keeps other keys. */
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

/** A local next-action shape for the envelope. It is separate from the `NextAction` schema in `src/next-action.ts`. */
export const VolatileNextActionSchema = z.object({
  verb: z.string(),
  reason: z.string(),
});

/**
 * Handoff entry of the v:1 envelope, for read-back only. `eventRef.id` is the key, and `eventRef.sequence` is optional.
 * An entry without a usable sequence makes `upgradeHandoffEntryV1toV2` throw `HandoffEntryUpgradeError`.
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
 * Handoff entry that writers emit. `eventRef.sequence` is the key, and `eventRef` holds no `id`.
 * The inner `eventRef` is `.strict()`, so a v:1 entry with an `id` cannot enter a v:2 or later envelope.
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
    /**
     * `'operator'` for an entry from a `workflow.checkpoint` handoff, `'auto'` for one from `workflow.handoff_summarized`.
     * A summarized handoff fills `latestHandoff` only when the slot is empty or `'auto'`.
     * The reducer treats an absent `source` as `'operator'`.
     */
    source: z.enum(['operator', 'auto']).optional(),
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
    /** The most recent handoff entry, if any. */
    latestHandoff: HandoffEntrySchemaV2.optional(),
    /** The last three handoff entries, newest first. The cap limits the token cost of the envelope. */
    recentHandoffs: z.array(HandoffEntrySchemaV2).max(3).default([]),
    /**
     * The handler composes this playbook from the registry. It is `null` when no playbook exists for the phase.
     * It is nullable and not optional, so an absent field is a schema error.
     */
    phasePlaybook: PhasePlaybookSchema,
  })
  .strict();

/**
 * Volatile sections of the v:1 envelope, for read-back only. The handoff keys are optional and hold v:1 entries.
 * `.strict()` makes an unknown key a parse error, not a silent drop.
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

/** Volatile sections of the v:2 envelope, for read-back only. They hold no `phasePlaybook`. */
const VolatileSectionsSchemaV2 = z
  .object({
    taskProgress: z.array(TaskProgressEntrySchema),
    decisions: z.array(DecisionEntrySchema),
    artifacts: ArtifactsSchema,
    blockers: z.array(BlockerEntrySchema),
    nextAction: VolatileNextActionSchema.optional(),
    latestHandoff: HandoffEntrySchemaV2.optional(),
    recentHandoffs: z.array(HandoffEntrySchemaV2).max(3).default([]),
  })
  .strict();

export type VolatileSections = z.infer<typeof VolatileSectionsSchema>;

/**
 * The rehydration document envelope, v:4. Writers use this schema.
 * The v:4 shape is the same as v:3. In v:4, `taskProgress[].status` uses the words of the canonical `TaskSchema.status`.
 * Thus a reader can compare it with `tasks[].status`. `upgradeRehydrationDocumentV3toV4` renames the v:3 words.
 */
export const RehydrationDocumentSchema = z
  .object({
    v: z.literal(4),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchema)
  .merge(VolatileSectionsSchema);

/** The v:4 envelope type. Use this name in new code. */
export type RehydrationDocumentV4 = z.infer<typeof RehydrationDocumentSchema>;

/**
 * The v:3 envelope, for read-back only. Writers must not use it.
 * Retire it when no v:3 document stays on disk.
 */
export const RehydrationDocumentSchemaV3 = z
  .object({
    v: z.literal(3),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchema)
  .merge(VolatileSectionsSchema);

export type RehydrationDocumentV3 = z.infer<typeof RehydrationDocumentSchemaV3>;

/**
 * The v:3 or v:4 envelope, so `upgrade.ts` and `serialize.ts` can read both.
 *
 * @deprecated Use `RehydrationDocumentV4` in new code. This union becomes v:4 only when no v:3 document stays on disk.
 */
export type RehydrationDocument = RehydrationDocumentV4 | RehydrationDocumentV3;

/**
 * The v:2 envelope, for read-back only. Writers must not use it.
 * Retire it when no v:2 document stays on disk.
 */
export const RehydrationDocumentSchemaV2 = z
  .object({
    v: z.literal(2),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchemaV2)
  .merge(VolatileSectionsSchemaV2);

export type RehydrationDocumentV2 = z.infer<typeof RehydrationDocumentSchemaV2>;

/**
 * The v:1 envelope, for read-back only. Writers must not use it.
 * No public type alias exists, so code does not build a v:1 document by accident. Retire it when no v:1 document stays on disk.
 */
export const RehydrationDocumentSchemaV1 = z
  .object({
    v: z.literal(1),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchemaV2)
  .merge(VolatileSectionsSchemaV1);
