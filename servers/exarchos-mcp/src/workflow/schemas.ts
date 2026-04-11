import { z } from 'zod';
import { coercedStringArray } from '../coerce.js';

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
  metadata: z.record(z.unknown()).optional(),
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
  /** Completion status from SubagentStop hook */
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

const BUILT_IN_WORKFLOW_TYPES = ['feature', 'debug', 'refactor', 'oneshot'] as const;
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
  phase: z.string(),
  oneshot: z.object({
    synthesisPolicy: z.enum(['always', 'never', 'on-request']).default('on-request'),
    planSummary: z.string().optional(),
  }).optional(),
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
  CustomWorkflowStateSchema,
]);

// ─── Tool Input Schemas ─────────────────────────────────────────────────────

export const InitInputSchema = z.object({
  featureId: FeatureIdSchema,
  workflowType: WorkflowTypeSchema,
});

export const ListInputSchema = z.object({});

export const GetInputSchema = z.object({
  featureId: FeatureIdSchema,
  query: z.string().optional(),
  fields: coercedStringArray().optional(),
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
});

// ─── Tool Input Schema Map ──────────────────────────────────────────────────

export const ToolInputSchemas = {
  init: InitInputSchema,
  list: ListInputSchema,
  get: GetInputSchema,
  set: SetInputSchema,
  summary: SummaryInputSchema,
  reconcile: ReconcileInputSchema,
  'next-action': NextActionInputSchema,
  transitions: TransitionsInputSchema,
  cancel: CancelInputSchema,
  cleanup: CleanupInputSchema,
  checkpoint: CheckpointInputSchema,
} as const;

// ─── Error Codes ────────────────────────────────────────────────────────────

export const ErrorCode = {
  STATE_NOT_FOUND: 'STATE_NOT_FOUND',
  STATE_ALREADY_EXISTS: 'STATE_ALREADY_EXISTS',
  STATE_CORRUPT: 'STATE_CORRUPT',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  GUARD_FAILED: 'GUARD_FAILED',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
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
} as const;

// ─── Reserved Field Validation ──────────────────────────────────────────────

const IMMUTABLE_FIELDS = new Set([
  'phase',
  'workflowType',
  'featureId',
  'createdAt',
  'version',
]);

export function isReservedField(path: string): boolean {
  if (path === '') return false;
  const topLevel = path.split('.')[0];
  if (IMMUTABLE_FIELDS.has(topLevel)) return true;
  return path.startsWith('_') || path.split('.').some((part) => part.startsWith('_'));
}
