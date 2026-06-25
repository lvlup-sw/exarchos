/**
 * Canonical rehydration document — v:3 (rehydration-machinery-refactor, T-01).
 *
 * T-01: Add PhasePlaybookSchema and v:3 envelope.
 * - Renames previous RehydrationDocumentSchema → RehydrationDocumentSchemaV2
 *   (read-back-only; consumed by upgrade.ts in T-02/T-03).
 * - Declares PhasePlaybookSchema mirroring SerializedPhasePlaybook from
 *   workflow/playbooks.ts.
 * - New RehydrationDocumentSchema uses v: literal(3) and carries
 *   phasePlaybook in VolatileSectionsSchema.
 * - Drops behavioralGuidance from StableSectionsSchema (was vestigial,
 *   never populated in production).
 *
 * T-50: BehavioralGuidanceSchema export removed; the zod literal is now
 * inlined into StableSectionsSchemaV2, the only remaining consumer.
 *
 * History:
 * T011 lands stable prefix; T012 adds volatile sections; T013 composes the
 * full envelope. T1 of the checkpoint-handoff bundle (#1240 + #1246) bumps
 * the envelope to v:2: it adds `latestHandoff` / `recentHandoffs` to the
 * volatile section, promotes `eventRef.sequence` from advisory to primary
 * key, and removes `eventRef.id` from the v:2 entry shape.
 */
import { z } from 'zod';

// ─── Phase Playbook Schema (T-01) ────────────────────────────────────────────

/**
 * Zod schema mirroring {@link SerializedPhasePlaybook} from
 * `workflow/playbooks.ts`. Used as the `phasePlaybook` field type in
 * {@link VolatileSectionsSchema}.
 *
 * Declared nullable so handlers can set `phasePlaybook: null` for terminal
 * phases or unknown (workflowType, phase) combinations where no playbook is
 * registered.
 *
 * TODO(T-01-refactor): If a zod schema (e.g. `SerializedPhasePlaybookSchema`)
 * is exported from `workflow/playbooks.ts`, import and use it here directly
 * as the single source of truth for the playbook shape. As of T-01 the
 * playbooks module only exports TypeScript interfaces, not zod validators.
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
    /**
     * Auto-emitted event surface for delegate-shaped phases (#1227, T6).
     * Phases without auto-emit leave this undefined — explicit absence (not
     * `[]`) keeps the contract minimal.
     */
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

// ─── Merge Orchestrator ───────────────────────────────────────────────────────

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
   * `executing` — executor is mid-merge (transient window between preflight
   * and terminal phase). Must be accepted here so a `handleGet` during this
   * window does not fail-closed and suppress `merge_orchestrate`.
   * `completed` / `rolled-back` / `aborted` — terminal; do not re-surface
   * `merge_orchestrate`.
   *
   * Mirrors the `phase` enum in `MergeOrchestratorStateSchema` (the canonical
   * write-side schema in `workflow/schemas.ts`). If those two drift again, the
   * `RehydrationMergeOrchestratorSchema_PhaseEnum_MatchesMergeOrchestratorStateSchema`
   * pin test in `next-actions-from-result.test.ts` will fail.
   */
  phase: z.enum(['pending', 'executing', 'completed', 'rolled-back', 'aborted']),
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

// ─── v:3 Stable Sections ─────────────────────────────────────────────────────

/**
 * Stable sections for v:3. behavioralGuidance dropped — it was vestigial,
 * never populated by any event. phasePlaybook is computed live at handler
 * time (T-20) and placed in VolatileSectionsSchema.
 */
export const StableSectionsSchema = z.object({
  workflowState: WorkflowStateSchema,
});

export type StableSections = z.infer<typeof StableSectionsSchema>;

// ─── v:2 Stable Sections (read-back-only) ────────────────────────────────────

/**
 * Stable sections for v:2 envelope read-back. Used by
 * RehydrationDocumentSchemaV2 only — not written by v:3 handlers.
 */
const StableSectionsSchemaV2 = z.object({
  behavioralGuidance: z.object({
    skill: z.string(),
    skillRef: z.string(),
    tools: z.unknown().optional(),
  }),
  workflowState: WorkflowStateSchema,
});

// ─── Volatile Section Entries ─────────────────────────────────────────────────

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
    /**
     * Provenance (#1242) — `'operator'` for an entry folded from a
     * `workflow.checkpoint` handoff (operator-authored), `'auto'` for one
     * folded from a `workflow.handoff_summarized` fallback. Drives the
     * operator-precedence rule in the reducer: a summarized handoff fills the
     * `latestHandoff` slot only when it is empty or already `'auto'`.
     *
     * Optional + additive: legacy v:2 snapshots written before #1242 carry no
     * `source` and are treated as operator-authored (the only writer pre-#1242
     * was the checkpoint handler), so the summary never overwrites them.
     */
    source: z.enum(['operator', 'auto']).optional(),
  })
  .strict();

export type HandoffEntryV1 = z.infer<typeof HandoffEntrySchemaV1>;
export type HandoffEntryV2 = z.infer<typeof HandoffEntrySchemaV2>;

// ─── v:3 Volatile Sections ────────────────────────────────────────────────────

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
    /**
     * Live phase playbook derived from the playbook registry at handler time
     * (T-20). Null for terminal phases or unknown (workflowType, phase) pairs.
     * Nullable — not undefined — so consumers can distinguish "no playbook
     * for this phase" from "field was not populated" (the latter would be a
     * schema violation on v:3 documents).
     */
    phasePlaybook: PhasePlaybookSchema,
  })
  .strict();

// ─── v:2 Volatile Sections (read-back-only) ──────────────────────────────────

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

/**
 * v:2 volatile sections — used by RehydrationDocumentSchemaV2 for read-back
 * of v:2 snapshots. Mirrors the pre-T-01 shape: no phasePlaybook field.
 */
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

// ─── v:4 Top-Level Envelope ───────────────────────────────────────────────────

/**
 * Top-level rehydration document envelope — v:4 (#1359 / PR4 T12,
 * projection-drift fix).
 *
 * Breaking changes vs v:3:
 * - `v: 4` literal (was `v: 3`)
 * - `taskProgress[].status` aligned with canonical `TaskSchema.status`
 *   vocabulary (`pending|in_progress|complete|failed`). Pre-#1359 the
 *   reducer renamed `'complete' → 'completed'` and
 *   `'in_progress' → 'assigned'`, which let agents reading the rehydration
 *   document re-dispatch already-complete work because their comparison
 *   against canonical `tasks[].status` never matched.
 *
 * The on-disk shape is identical between v:3 and v:4 (the schema widens
 * `status` to `z.string()` so the structural envelope hasn't changed); the
 * version bump reflects a *vocabulary* contract change and lets
 * `loadRehydrationDocument` route v:3 documents through the
 * `upgradeRehydrationDocumentV3toV4` rename pass.
 *
 * Read-side compatibility chain: v:1 → v:2 → v:3 → v:4. Each upgrader is
 * pure (no I/O) and exposed from `upgrade.ts`.
 */
export const RehydrationDocumentSchema = z
  .object({
    v: z.literal(4),
    projectionSequence: z.number().int().nonnegative(),
  })
  .merge(StableSectionsSchema)
  .merge(VolatileSectionsSchema);

/**
 * Alias for the v:4 envelope inferred type.
 * Prefer this name in new code for clarity.
 */
export type RehydrationDocumentV4 = z.infer<typeof RehydrationDocumentSchema>;

/**
 * v:3 envelope — read-back-only post-#1359 / PR4 T12. Used by
 * `loadRehydrationDocument` to parse legacy snapshots before applying the
 * v:3 → v:4 vocabulary rename. Mirrors the v:3 envelope frozen by T-01.
 *
 * Writers MUST NOT use this schema — emit v:4 directly via
 * `RehydrationDocumentSchema`. Retirement criterion: on-disk v:3 doc count == 0.
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
 * Union of v:3 and v:4 envelope shapes — used as the public
 * `RehydrationDocument` type so call sites in `upgrade.ts` / `serialize.ts`
 * can read either shape during the v:3 → v:4 migration window. Writers of
 * new documents should use `RehydrationDocumentV4` or constrain to
 * `{ v: 4 }` explicitly.
 *
 * @deprecated Prefer `RehydrationDocumentV4` for new code. This union will be
 * narrowed to v:4-only once on-disk v:3 doc count == 0.
 */
export type RehydrationDocument = RehydrationDocumentV4 | RehydrationDocumentV3;

// ─── v:2 Envelope (read-back-only) ───────────────────────────────────────────

/**
 * Frozen v:2 envelope — read-back / migration path only (T-01 rename from
 * the previous `RehydrationDocumentSchema`).
 *
 * Writers MUST NOT use this schema. Use {@link RehydrationDocumentSchema}
 * (v:3) for all new writes. This is the read-back path for snapshots written
 * before the T-01 envelope bump; upgrade.ts (T-02/T-03) consumes it.
 *
 * Retirement criterion: retire once on-disk v:2 doc count == 0.
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
  .merge(StableSectionsSchemaV2)
  .merge(VolatileSectionsSchemaV1);
