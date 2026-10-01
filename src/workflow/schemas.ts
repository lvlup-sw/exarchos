import { z } from 'zod';
import { coercedStringArray } from '../coerce.js';

/**
 * The handoff payload of the checkpoint dispatch input. It matches `HandoffEntryData` in `events/schemas.ts`.
 * A change to one needs the same change to the other. This file cannot import it, because `events/schemas.ts` imports this file.
 * `z.strictObject` rejects unknown keys, so a malformed payload fails validation and is not truncated silently.
 */
export const CheckpointHandoffSchema = z.strictObject({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
});

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
  /** The slim form: no action is necessary. */
  z.object({
    checkpointAdvised: z.literal(false),
  }),
  /** The full form: a checkpoint is advised, or the state is stale. */
  z.object({
    checkpointAdvised: z.boolean(),
    operationsSinceCheckpoint: z.number().int().min(0),
    lastCheckpointPhase: z.string(),
    lastCheckpointTimestamp: z.string().datetime(),
    stale: z.boolean(),
    minutesSinceActivity: z.number().min(0),
  }),
]);

export const FEATURE_PHASES = [
  'plan',
  'plan-review',
  'delegate',
  'merge-pending',
  'review',
  'synthesize',
  'completed',
  'cancelled',
  'blocked',
] as const;

/**
 * Feature workflows start at `plan` and never produce `ideate`.
 * The schema reads a persisted `ideate` phase as `plan`, so a historical feature state still parses.
 */
export const FeaturePhaseSchema = z.preprocess(
  (val) => (val === 'ideate' ? 'plan' : val),
  z.enum(FEATURE_PHASES),
);

/** Debug workflow phases. The `debug-*` phases are the compound sub-states of the thorough track, and the `hotfix-*` phases those of the hotfix track. */
export const DebugPhaseSchema = z.enum([
  'triage',
  'investigate',
  'rca',
  'design',
  'synthesize',
  'debug-implement',
  'debug-validate',
  'debug-review',
  'hotfix-implement',
  'hotfix-validate',
  'completed',
  'cancelled',
  'blocked',
]);

/** Refactor workflow phases. The `polish-*` phases belong to the polish track, and the `overhaul-*` phases to the overhaul track. */
export const RefactorPhaseSchema = z.enum([
  'explore',
  'brief',
  'polish-implement',
  'polish-validate',
  'polish-update-docs',
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

export const PerformanceSLASchema = z.object({
  metric: z.string(),
  threshold: z.number(),
  unit: z.enum(['ms', 'ops/s', 'MB']),
});

export type PerformanceSLA = z.infer<typeof PerformanceSLASchema>;

export const TestingStrategySchema = z.object({
  exampleTests: z.literal(true),
  propertyTests: z.boolean(),
  benchmarks: z.boolean(),
  properties: z.array(z.string()).optional(),
  performanceSLAs: z.array(PerformanceSLASchema).optional(),
});

export type TestingStrategy = z.infer<typeof TestingStrategySchema>;

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
  /** Whether the fixer resumed the agent or dispatched a fresh one. */
  agentResumed: z.boolean().optional(),
  /** Last exit reason recorded for the agent (resume bookkeeping) */
  lastExitReason: z.string().optional(),
});

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

/**
 * The persisted shape of `mergeOrchestrator.preflight`. It has the fields of `MergePreflightResult` in `verbs/pure/merge-preflight.ts`.
 * The sub-results stay open, and `.passthrough()` accepts fields that a newer composer adds.
 */
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
  /** Optional, because the first `aborted` write comes before preflight and has no branch fields. */
  sourceBranch: z.string().min(1).optional(),
  targetBranch: z.string().min(1).optional(),
  taskId: z.string().optional(),
  /** The merge strategy that the operator selected. */
  strategy: z.enum(['squash', 'rebase', 'merge']).optional(),
  recoveryPointSha: z.string().optional(),
  mergeSha: z.string().optional(),
  /** A terminal-failure descriptor. Explicit fields give consumers strong types, so they do not depend on `.passthrough()`. */
  reason: z.enum(['merge-failed', 'verification-failed', 'timeout']).optional(),
  recoveryErrorDetail: z.string().min(1).optional(),
  /** The recovery outcome of a rolled-back merge, with the values of `MergeRollbackData.recoveryError`. */
  recoveryError: z
    .enum(['reset-keep-blocked', 'reset-failed', 'unexpected-mid-merge-drift'])
    .optional(),
  abortReason: z.string().min(1).optional(),
  preflight: MergeOrchestratorPreflightSchema.optional(),
}).passthrough();

export const SynthesisSchema = z.object({
  integrationBranch: z.string().nullable(),
  mergeOrder: z.array(z.string()),
  mergedBranches: z.array(z.string()),
  prUrl: z.union([z.string(), z.array(z.string())]).nullable(),
  prFeedback: z.array(z.unknown()),
}).passthrough();

/**
 * The intent that `extract-intent.ts` derives from the diff and the transcript on the code-review path.
 * A `state.patched` event persists it to `artifacts.intent`. `.passthrough()` accepts later enrichment fields.
 */
export const WorkflowIntentSchema = z.object({
  source: z.enum(['diff', 'diff+transcript']),
  changedFiles: z.array(z.string()),
  surfaces: z.array(z.string()),
  summary: z.string(),
  transcriptSummary: z.string().optional(),
}).passthrough();

export type WorkflowIntent = z.infer<typeof WorkflowIntentSchema>;

export const ArtifactsSchema = z.object({
  design: z.string().nullable(),
  plan: z.string().nullable(),
  pr: z.union([z.string(), z.array(z.string())]).nullable(),
  /** Absent for a workflow that never extracted an intent. */
  intent: WorkflowIntentSchema.optional(),
}).passthrough();

export const FeatureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

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

export const CustomWorkflowStateSchema = BaseWorkflowStateSchema.extend({
  workflowType: z.string().refine(
    (val) => !(BUILT_IN_WORKFLOW_TYPES as readonly string[]).includes(val) && customWorkflowTypes.has(val),
    { message: 'Must be a registered custom workflow type' },
  ),
  /** A custom workflow defines its own phases in its configuration. */
  phase: z.string(),
});

export const WorkflowStateSchema = z.union([
  FeatureWorkflowStateSchema,
  DebugWorkflowStateSchema,
  RefactorWorkflowStateSchema,
  OneshotWorkflowStateSchema,
  DiscoveryWorkflowStateSchema,
  CustomWorkflowStateSchema,
]);

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

/**
 * The storage format of an event timestamp: UTC `Z` with millisecond precision, as `toISOString()` writes it.
 * `boundEvents` compares timestamps as strings, so all widths must be equal. `z.string().datetime()` accepts other precisions.
 */
const UTC_MILLIS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Bounds a read to a prefix of the event log: a stream-sequence ceiling or a timestamp ceiling, never both.
 * The schema enforces the exclusion, so the CLI and MCP carriers reject a value with both bounds in the same way.
 * In Zod v4, `.refine()` keeps a `ZodObject`, so the CLI `--as-of` flag still parses as JSON. The shape matches `AsOfBound` in `projections/cursor.ts`.
 */
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
  /** An optional bounded read. When it is absent, the read sees the live tip. */
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
  /** The optional handoff payload, with the per-field size caps of `CheckpointHandoffSchema`. */
  handoff: CheckpointHandoffSchema.optional(),
});

export const ErrorCode = {
  STATE_NOT_FOUND: 'STATE_NOT_FOUND',
  STATE_ALREADY_EXISTS: 'STATE_ALREADY_EXISTS',
  STATE_CORRUPT: 'STATE_CORRUPT',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  GUARD_FAILED: 'GUARD_FAILED',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  /**
   * `executeTransition` refused the transition, because the obligation of the target phase kind did not resolve.
   * It is separate from `GUARD_FAILED`, so the MCP caller sees a substrate-integrity fault and not a generic guard fault.
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

/**
 * The keys that `applyDotPath` rejects with `ErrorCode.RESERVED_FIELD`, and the alternate write path for each.
 * `exarchos_workflow.describe` and the `data` block of a `RESERVED_FIELD` error show it to the caller.
 * `isReservedField` takes its top-level set from `topLevelImmutable`, so the descriptor and the guard cannot drift.
 * `resolveAlternateWritePath` in `state-mutation.ts` matches the `alternateWritePaths` keys. All underscore paths share the `^_.*` key.
 */
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

/** The top-level immutable keys from the descriptor, so the describe output and the guard share one list. */
const IMMUTABLE_FIELDS = new Set<string>(RESERVED_FIELDS_DESCRIPTOR.topLevelImmutable);

export function isReservedField(path: string): boolean {
  if (path === '') return false;
  const topLevel = path.split('.')[0] ?? '';
  if (IMMUTABLE_FIELDS.has(topLevel)) return true;
  return path.startsWith('_') || path.split('.').some((part) => part.startsWith('_'));
}
