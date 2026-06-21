import { z } from 'zod';
import { coercedStringArray } from '../coerce.js';

// T4 (#1240) — handoff payload shape for the checkpoint dispatch input.
// This MIRRORS `event-store/schemas.ts:HandoffEntryData` exactly (same
// per-field byte caps, same optionality). It is intentionally redefined
// here rather than imported because `event-store/schemas.ts` already
// imports `WorkflowTypeSchema` from this file, and pulling
// `HandoffEntryData` from there would create a circular import. The two
// schemas describe the same data on two different surfaces (dispatch
// input vs persisted event payload). If one changes, the other must
// change with it — a co-located schemas.test.ts assertion (added in T1
// for the persisted side) plus the explicit cross-reference comment
// here are the load-bearing guard.
//
// CodeRabbit major on PR #1297: `z.strictObject()` rejects unknown
// keys instead of silently stripping them. A malformed payload — typo,
// future-version field a pre-#1240 client doesn't know to filter,
// structured-clone artifact — must surface as INVALID_INPUT rather
// than a silently-truncated persisted handoff.
//
// Exported (was const-internal) so the registry composite-tool schema
// and the legacy `exarchos_workflow_checkpoint` server.tool definition
// reuse one source of truth instead of declaring inline copies that
// can desync — same axiom-distill consolidation rationale as the
// CheckpointInputSchema reuse below.
export const CheckpointHandoffSchema = z.strictObject({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
});

// ─── Event Types ────────────────────────────────────────────────────────────

export const EventTypeSchema = z.enum([
  'transition',
  'checkpoint',
  'guard-failed',
  'compound-entry',
  'compound-exit',
  'fix-cycle',
  'circuit-open',
  'compensation',
  'cancel',
  'cleanup',
  'field-update',
]);

// ─── Event Schema ───────────────────────────────────────────────────────────

export const EventSchema = z.object({
  sequence: z.number().int().positive(),
  version: z.literal('1.0'),
  timestamp: z.string().datetime(),
  type: EventTypeSchema,
  from: z.string().optional(),
  to: z.string().optional(),
  trigger: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ─── Checkpoint Schemas ─────────────────────────────────────────────────────

export const CheckpointStateSchema = z.object({
  timestamp: z.string().datetime(),
  phase: z.string(),
  summary: z.string(),
  operationsSince: z.number().int().min(0),
  fixCycleCount: z.number().int().min(0),
  lastActivityTimestamp: z.string().datetime(),
  staleAfterMinutes: z.number().int().positive().default(120),
});

export const CheckpointMetaSchema = z.union([
  // Slim: no action needed
  z.object({
    checkpointAdvised: z.literal(false),
  }),
  // Full: action needed (checkpointAdvised or stale)
  z.object({
    checkpointAdvised: z.boolean(),
    operationsSinceCheckpoint: z.number().int().min(0),
    lastCheckpointPhase: z.string(),
    lastCheckpointTimestamp: z.string().datetime(),
    stale: z.boolean(),
    minutesSinceActivity: z.number().min(0),
  }),
]);

// ─── Phase Schemas ──────────────────────────────────────────────────────────

export const FeaturePhaseSchema = z.enum([
  'ideate',
  'plan',
  'plan-review',
  'delegate',
  'merge-pending',
  'review',
  'synthesize',
  'completed',
  'cancelled',
  'blocked',
]);

export const DebugPhaseSchema = z.enum([
  'triage',
  'investigate',
  'rca',
  'design',
  'synthesize',
  // Compound sub-state phases (thorough track)
  'debug-implement',
  'debug-validate',
  'debug-review',
  // Compound sub-state phases (hotfix track)
  'hotfix-implement',
  'hotfix-validate',
  'completed',
  'cancelled',
  'blocked',
]);

export const RefactorPhaseSchema = z.enum([
  'explore',
  'brief',
  // Polish track phases
  'polish-implement',
  'polish-validate',
  'polish-update-docs',
  // Overhaul track phases
  'overhaul-plan',
  'overhaul-plan-review',
  'overhaul-delegate',
  'overhaul-review',
  'overhaul-update-docs',
  'synthesize',
  'completed',
  'cancelled',
  'blocked',
]);

export const OneshotPhaseSchema = z.enum([
  'plan',
  'implementing',
  'synthesize',
  'completed',
  'cancelled',
]);

export const DiscoveryPhaseSchema = z.enum([
  'gathering',
  'synthesizing',
  'completed',
  'cancelled',
]);

export const SynthesisPolicySchema = z.enum(['always', 'never', 'on-request']);

// ─── Performance SLA Schema ────────────────────────────────────────────────

export const PerformanceSLASchema = z.object({
  metric: z.string(),
  threshold: z.number(),
  unit: z.enum(['ms', 'ops/s', 'MB']),
});

export type PerformanceSLA = z.infer<typeof PerformanceSLASchema>;

// ─── Testing Strategy Schema ───────────────────────────────────────────────

export const TestingStrategySchema = z.object({
  exampleTests: z.literal(true),
  propertyTests: z.boolean(),
  benchmarks: z.boolean(),
  properties: z.array(z.string()).optional(),
  performanceSLAs: z.array(PerformanceSLASchema).optional(),
});

export type TestingStrategy = z.infer<typeof TestingStrategySchema>;

// ─── Task Schema ────────────────────────────────────────────────────────────

export const TaskStatusSchema = z.preprocess(
  (val) => (val === 'completed' ? 'complete' : val),
  z.enum(['pending', 'in_progress', 'complete', 'failed']),
);

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  branch: z.string().nullable().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  nativeTaskId: z.string().optional(),
  teammateName: z.string().optional(),
  blockedBy: z.array(z.string()).default([]),
  worktreePath: z.string().optional(),
  testingStrategy: TestingStrategySchema.optional(),
  /** Agent ID for resume capability */
  agentId: z.string().optional(),
  /** Whether the fixer used resume vs fresh dispatch */
  agentResumed: z.boolean().optional(),
  /** Last exit reason recorded for the agent (resume bookkeeping) */
  lastExitReason: z.string().optional(),
});

// ─── Worktree Schema ────────────────────────────────────────────────────────

export const WorktreeStatusSchema = z.enum(['active', 'merged', 'removed']);

export const WorktreeSchema = z.object({
  branch: z.string(),
  taskId: z.string().optional(),
  tasks: z.array(z.string()).optional(),
  status: WorktreeStatusSchema,
}).passthrough().refine(
  (wt) => wt.taskId !== undefined || (wt.tasks !== undefined && wt.tasks.length > 0),
  { message: 'Either taskId or tasks (non-empty) must be provided' },
);

// ─── Merge Orchestrator State Schema (DR-MO-1 / DR-MO-2) ───────────────────

/** Persisted shape of `mergeOrchestrator.preflight`. Mirrors
 * `MergePreflightResult` from `pure/merge-preflight.ts` at the field-presence
 * level; sub-result shapes are kept open so this schema doesn't have to
 * track every dispatch-guard tweak. The `.passthrough()` accommodates
 * forward-compatible additions emitted by newer composer versions. */
const MergeOrchestratorPreflightSchema = z.object({
  passed: z.boolean(),
  failureReasons: z.array(z.string()).optional(),
  ancestry: z.unknown().optional(),
  currentBranchProtection: z.unknown().optional(),
  worktree: z.unknown().optional(),
  drift: z.unknown().optional(),
}).passthrough();

export const MergeOrchestratorStateSchema = z.object({
  phase: z.enum(['pending', 'executing', 'completed', 'rolled-back', 'aborted']),
  // Branch fields are populated on every phase except the very first
  // pre-preflight `aborted` write — optional so the schema accepts that
  // edge case without rejection.
  sourceBranch: z.string().min(1).optional(),
  targetBranch: z.string().min(1).optional(),
  taskId: z.string().optional(),
  // Operator-selected merge strategy — set on `executing`/`completed`/
  // `rolled-back` writes via the executor.
  strategy: z.enum(['squash', 'rebase', 'merge']).optional(),
  recoveryPointSha: z.string().optional(),
  mergeSha: z.string().optional(),
  // Terminal-failure descriptors. `reason` and `recoveryErrorDetail` come from
  // the executor's rolled-back write; `abortReason` from the orchestrator's
  // preflight-fail abort write. Modeling them explicitly gives downstream
  // consumers strong typing instead of leaning on `.passthrough()`.
  reason: z.enum(['merge-failed', 'verification-failed', 'timeout']).optional(),
  recoveryErrorDetail: z.string().min(1).optional(),
  // INV-14 recovery-outcome discriminator on the executor's rolled-back write
  // (mirrors `MergeRollbackData.recoveryError`). Modeled explicitly rather than
  // leaning on `.passthrough()` so consumers get strong typing.
  recoveryError: z
    .enum(['reset-keep-blocked', 'reset-failed', 'unexpected-mid-merge-drift'])
    .optional(),
  abortReason: z.string().min(1).optional(),
  preflight: MergeOrchestratorPreflightSchema.optional(),
}).passthrough();

// ─── Synthesis Schema ───────────────────────────────────────────────────────

export const SynthesisSchema = z.object({
  integrationBranch: z.string().nullable(),
  mergeOrder: z.array(z.string()),
  mergedBranches: z.array(z.string()),
  prUrl: z.union([z.string(), z.array(z.string())]).nullable(),
  prFeedback: z.array(z.unknown()),
}).passthrough();

// ─── Artifacts Schema ───────────────────────────────────────────────────────

export const ArtifactsSchema = z.object({
  design: z.string().nullable(),
  plan: z.string().nullable(),
  pr: z.union([z.string(), z.array(z.string())]).nullable(),
}).passthrough();

// ─── Feature ID Schema ──────────────────────────────────────────────────────

export const FeatureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

// ─── Workflow Type ──────────────────────────────────────────────────────────

const BUILT_IN_WORKFLOW_TYPES = ['feature', 'debug', 'refactor', 'oneshot', 'discovery'] as const;
const customWorkflowTypes = new Set<string>();

export const WorkflowTypeSchema = z.string().refine(
  (val) => (BUILT_IN_WORKFLOW_TYPES as readonly string[]).includes(val) || customWorkflowTypes.has(val),
  { message: 'Invalid workflow type' },
);

/**
 * Extend the WorkflowTypeSchema to accept a custom workflow type name.
 * Validates that the name is non-empty, lowercase kebab-case, and not a built-in type.
 */
export function extendWorkflowTypeEnum(name: string): void {
  const trimmed = name.trim();
  if (!trimmed || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error(`Invalid custom workflow type name: '${name}'. Must be non-empty lowercase kebab-case.`);
  }
  if ((BUILT_IN_WORKFLOW_TYPES as readonly string[]).includes(trimmed)) {
    throw new Error(`Cannot extend built-in workflow type: '${trimmed}'`);
  }
  customWorkflowTypes.add(trimmed);
}

/**
 * Remove a custom workflow type from the schema. Used for test cleanup.
 */
export function unextendWorkflowTypeEnum(name: string): void {
  customWorkflowTypes.delete(name);
}

/**
 * Get all currently valid workflow type names (built-in + custom).
 */
export function getValidWorkflowTypes(): readonly string[] {
  return [...BUILT_IN_WORKFLOW_TYPES, ...customWorkflowTypes];
}

// ─── Base Workflow State (shared fields) ────────────────────────────────────

const BaseWorkflowStateSchema = z.object({
  version: z.string().default('1.1'),
  featureId: FeatureIdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  artifacts: ArtifactsSchema,
  tasks: z.array(TaskSchema),
  worktrees: z.record(z.string(), WorktreeSchema),
  reviews: z.record(z.string(), z.unknown()),
  integration: z.object({
    passed: z.boolean(),
  }).nullable().default(null),
  synthesis: SynthesisSchema,
  _esVersion: z.number().int().positive().optional(),
  _version: z.number().int().positive().default(1),
  _history: z.record(z.string(), z.string()).default({}),
  // _events and _eventSequence removed — events now live in external JSONL store
  _checkpoint: CheckpointStateSchema.default({
    timestamp: '1970-01-01T00:00:00Z',
    phase: 'init',
    summary: 'Initial state',
    operationsSince: 0,
    fixCycleCount: 0,
    lastActivityTimestamp: '1970-01-01T00:00:00Z',
    staleAfterMinutes: 120,
  }),
  _compensationCheckpoint: z.object({
    completedActions: z.array(z.string()),
  }).optional(),
}).passthrough();

// ─── Workflow-Type-Specific State Schemas ───────────────────────────────────

export const FeatureWorkflowStateSchema = BaseWorkflowStateSchema.extend({
  workflowType: z.literal('feature'),
  phase: FeaturePhaseSchema,
  mergeOrchestrator: MergeOrchestratorStateSchema.optional(),
});

export const DebugWorkflowStateSchema = BaseWorkflowStateSchema.extend({
  workflowType: z.literal('debug'),
  phase: DebugPhaseSchema,
});

export const RefactorWorkflowStateSchema = BaseWorkflowStateSchema.extend({
  workflowType: z.literal('refactor'),
  phase: RefactorPhaseSchema,
});

export const OneshotWorkflowStateSchema = BaseWorkflowStateSchema.extend({
  workflowType: z.literal('oneshot'),
  phase: OneshotPhaseSchema,
  oneshot: z.object({
    synthesisPolicy: SynthesisPolicySchema.default('on-request'),
    planSummary: z.string().optional(),
  }).optional(),
});

export const DiscoveryWorkflowStateSchema = BaseWorkflowStateSchema.extend({
  workflowType: z.literal('discovery'),
  phase: DiscoveryPhaseSchema,
});

// ─── Custom Workflow State Schema ───────────────────────────────────────────

export const CustomWorkflowStateSchema = BaseWorkflowStateSchema.extend({
  workflowType: z.string().refine(
    (val) => !(BUILT_IN_WORKFLOW_TYPES as readonly string[]).includes(val) && customWorkflowTypes.has(val),
    { message: 'Must be a registered custom workflow type' },
  ),
  phase: z.string(), // Custom workflows define their own phases via config
});

// ─── Union of All Workflow States ───────────────────────────────────────────

export const WorkflowStateSchema = z.union([
  FeatureWorkflowStateSchema,
  DebugWorkflowStateSchema,
  RefactorWorkflowStateSchema,
  OneshotWorkflowStateSchema,
  DiscoveryWorkflowStateSchema,
  CustomWorkflowStateSchema,
]);

// ─── Tool Input Schemas ─────────────────────────────────────────────────────

export const InitInputSchema = z.object({
  featureId: FeatureIdSchema,
  workflowType: WorkflowTypeSchema,
  /**
   * Initial synthesis policy for oneshot workflows. Silently ignored for
   * non-oneshot workflow types. Defaults (when omitted) to `on-request`
   * via {@link OneshotWorkflowStateSchema}.
   */
  synthesisPolicy: SynthesisPolicySchema.optional(),
});

export const ListInputSchema = z.object({});

// ─── As-Of Bound Schema (#1555 bounded-fold primitive) ──────────────────────
//
// `asOf` bounds a read to `events[0..N]` — a time-travel projection over the
// immutable log. The two ceilings are MUTUALLY EXCLUSIVE: a value carries
// either `untilSequence` (a stream-sequence ceiling) or `untilTimestamp` (an
// ISO-8601 timestamp ceiling), never both. Exclusion is enforced here at the
// schema via `.refine` so the CLI and MCP carriers reject a both-bounds value
// identically (INV-2) before it reaches the dispatch core.
//
// This field shape mirrors `AsOfBound` in `projections/cursor.ts`; the
// dispatch core (Task 7) folds the bounded event list through `boundEvents`.
//
// Zod-v4 note: `.refine()` on a `ZodObject` returns a `ZodObject` (the check
// is stored in `def.checks`, not wrapped in a `ZodEffects`/pipe as in Zod v3).
// So `AsOfSchema` still classifies as `'object'` in
// `adapters/schema-to-flags.ts::resolveType`, and the CLI `--as-of` string is
// JSON-parsed identically to the MCP object payload (CLI↔MCP parity, Task 8).
// The single source of truth lives here; `get`/`view` registry actions and
// `GetInputSchema` all reference this one definition.
// `untilTimestamp` is constrained to the EXACT storage format — UTC `Z`,
// millisecond precision (`new Date().toISOString()`, the event store's stamp).
// `boundEvents` compares timestamps LEXICOGRAPHICALLY, which only matches
// chronological order when every string has uniform width; `z.string().datetime()`
// would admit variable fractional-second precision (e.g. `…01Z`, `…01.5Z`) and
// silently break the `<=` ceiling. Constrain at the schema (INV-5a), not in prose.
const UTC_MILLIS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const AsOfSchema = z
  .object({
    untilSequence: z.number().int().nonnegative().optional(),
    untilTimestamp: z
      .string()
      .regex(
        UTC_MILLIS_ISO,
        'asOf.untilTimestamp must be a UTC ISO-8601 timestamp with millisecond precision (e.g. 2026-06-20T00:00:01.123Z)',
      )
      .optional(),
  })
  .refine(
    (v) => !(v.untilSequence !== undefined && v.untilTimestamp !== undefined),
    {
      message:
        'asOf must carry exactly one of untilSequence or untilTimestamp, not both',
    },
  );

export const GetInputSchema = z.object({
  featureId: FeatureIdSchema,
  query: z.string().optional(),
  fields: coercedStringArray().optional(),
  // #1555 — optional bounded-fold (time-travel) read. Omitted ⇒ live tip.
  asOf: AsOfSchema.optional(),
});

export const SetInputSchema = z.object({
  featureId: FeatureIdSchema,
  updates: z.record(z.string(), z.unknown()).optional(),
  phase: z.string().optional(),
});

export const SummaryInputSchema = z.object({
  featureId: FeatureIdSchema,
});

export const ReconcileInputSchema = z.object({
  featureId: FeatureIdSchema,
});

export const NextActionInputSchema = z.object({
  featureId: FeatureIdSchema,
});

export const TransitionsInputSchema = z.object({
  workflowType: WorkflowTypeSchema,
  fromPhase: z.string().optional(),
});

export const CancelInputSchema = z.object({
  featureId: FeatureIdSchema,
  reason: z.string().optional(),
  dryRun: z.boolean().optional(),
});

export const CleanupInputSchema = z.object({
  featureId: FeatureIdSchema,
  mergeVerified: z.boolean(),
  prUrl: z.union([z.string(), z.array(z.string())]).optional(),
  mergedBranches: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
});

export const CheckpointInputSchema = z.object({
  featureId: FeatureIdSchema,
  summary: z.string().optional(),
  // T4 (#1240) — optional handoff payload validated with per-field byte
  // caps (DIM-7). Mirrors `event-store/schemas.ts:HandoffEntryData`
  // exactly; see the `CheckpointHandoffSchema` declaration above for
  // the cycle-avoidance rationale. Backward compat: pre-#1240 callers
  // that omit this field continue to work unchanged.
  handoff: CheckpointHandoffSchema.optional(),
});

// ─── Error Codes ────────────────────────────────────────────────────────────

export const ErrorCode = {
  STATE_NOT_FOUND: 'STATE_NOT_FOUND',
  STATE_ALREADY_EXISTS: 'STATE_ALREADY_EXISTS',
  STATE_CORRUPT: 'STATE_CORRUPT',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  GUARD_FAILED: 'GUARD_FAILED',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  /**
   * Fail-closed at the phase-kind gate-set boundary: `executeTransition`
   * refused the transition because the target kind's obligation could not be
   * resolved (DR-7/DR-10, epic #1546). Distinct from GUARD_FAILED so the
   * substrate-integrity semantic survives to the MCP caller (INV-5b) instead of
   * collapsing into a generic guard fault.
   */
  PHASE_BLOCKED: 'PHASE_BLOCKED',
  INVALID_INPUT: 'INVALID_INPUT',
  RESERVED_FIELD: 'RESERVED_FIELD',
  ALREADY_CANCELLED: 'ALREADY_CANCELLED',
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
  COMPENSATION_PARTIAL: 'COMPENSATION_PARTIAL',
  FILE_IO_ERROR: 'FILE_IO_ERROR',
  EVENT_APPEND_FAILED: 'EVENT_APPEND_FAILED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  EVENT_MIGRATION_FAILED: 'EVENT_MIGRATION_FAILED',
  EVENT_STORE_NOT_CONFIGURED: 'EVENT_STORE_NOT_CONFIGURED',
  /**
   * Snapshot sidecar write failed mid-checkpoint (atomic temp-file write,
   * rename, or fsync). Retryable: the next checkpoint call repeats the
   * fold and write. Surfaced by `handleCheckpoint` so the dispatch
   * envelope reports a structured failure instead of an unhandled throw.
   */
  SNAPSHOT_WRITE_FAILED: 'SNAPSHOT_WRITE_FAILED',
  /**
   * Projection replay (snapshot fold + tail query) failed mid-checkpoint.
   * Distinct from `EVENT_APPEND_FAILED` because the failure is upstream
   * of any write. Surfaced so observers can distinguish "couldn't read
   * the projection state" from "read fine, but couldn't persist".
   */
  PROJECTION_REPLAY_FAILED: 'PROJECTION_REPLAY_FAILED',
} as const;

// ─── Reserved Field Validation (#1360) ─────────────────────────────────────
//
// `RESERVED_FIELDS_DESCRIPTOR` is the single source of truth for the keys
// that `applyDotPath` / `handleSet` reject with `ErrorCode.RESERVED_FIELD`.
// It is surfaced through `exarchos_workflow.describe({actions:['update']})`
// and embedded in the structured `data` block on `RESERVED_FIELD` error
// envelopes, so callers can discover the boundary and the alternate write
// path (e.g. use `transition` for phase) without trial-and-error.
//
// The runtime guard `isReservedField` derives its top-level immutable set
// from `topLevelImmutable` below, so changing the descriptor changes the
// behavior — doc and guard cannot drift.
//
// `alternateWritePaths` keys are matched via `resolveAlternateWritePath` in
// `state-store.ts`. Underscore-prefixed paths share a single guidance
// string keyed on the regex `^_.*` (event-store-managed, not directly
// writable).
export const RESERVED_FIELDS_DESCRIPTOR = {
  topLevelImmutable: [
    'phase',
    'workflowType',
    'featureId',
    'createdAt',
    'version',
  ],
  underscorePrefixRule:
    'Any dot-path whose top-level key, or any segment, begins with `_` is reserved for projection/event-store metadata and is not directly writable.',
  examples: [
    '_version',
    '_esVersion',
    '_history',
    '_checkpoint.summary',
    '_eventHints',
    '_compensationCheckpoint',
  ],
  alternateWritePaths: {
    phase: 'Use `exarchos_workflow` with `action: "transition"` and `target: "<phase>"` — phase changes are HSM-validated and emit transition events.',
    workflowType: 'Immutable after init. Create a new workflow with `exarchos_workflow.init` if a different type is needed.',
    featureId: 'Immutable identity field. The featureId is fixed at init.',
    createdAt: 'Immutable timestamp. Set by `exarchos_workflow.init`.',
    version: 'Schema version. Bumped only by the migration pipeline.',
    '^_.*': 'Event-store/projection metadata. Emit a typed event via `exarchos_event.append` (e.g. `checkpoint`, `state.patched`) instead of writing the underscore field directly.',
  },
} as const;

export const ReservedFieldsDescriptorSchema = z.object({
  topLevelImmutable: z.array(z.string()).min(1),
  underscorePrefixRule: z.string().min(1),
  examples: z.array(z.string()).min(1),
  alternateWritePaths: z.record(z.string(), z.string()),
});

// Derived from `RESERVED_FIELDS_DESCRIPTOR.topLevelImmutable` so the doc
// surface and the runtime guard share one canonical list — see #1360.
const IMMUTABLE_FIELDS = new Set<string>(RESERVED_FIELDS_DESCRIPTOR.topLevelImmutable);

export function isReservedField(path: string): boolean {
  if (path === '') return false;
  const topLevel = path.split('.')[0];
  if (IMMUTABLE_FIELDS.has(topLevel)) return true;
  return path.startsWith('_') || path.split('.').some((part) => part.startsWith('_'));
}
