import { z } from 'zod';

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

export const CheckpointMetaSchema = z.object({
  checkpointAdvised: z.boolean(),
  operationsSinceCheckpoint: z.number().int().min(0),
  lastCheckpointPhase: z.string(),
  lastCheckpointTimestamp: z.string().datetime(),
  stale: z.boolean(),
  minutesSinceActivity: z.number().min(0),
});

// ─── Phase Schemas ──────────────────────────────────────────────────────────

export const FeaturePhaseSchema = z.enum([
  'ideate',
  'plan',
  'plan-review',
  'delegate',
  'integrate',
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
  'implement',
  'validate',
  'review',
  'synthesize',
  'completed',
  'cancelled',
  'blocked',
]);

export const RefactorPhaseSchema = z.enum([
  'explore',
  'brief',
  'plan',
  'delegate',
  'integrate',
  'review',
  'implement',
  'validate',
  'update-docs',
  'synthesize',
  'completed',
  'cancelled',
  'blocked',
]);

// ─── Task Schema ────────────────────────────────────────────────────────────

export const TaskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'complete',
  'failed',
]);

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  branch: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});

// ─── Worktree Schema ────────────────────────────────────────────────────────

export const WorktreeStatusSchema = z.enum(['active', 'merged', 'removed']);

export const WorktreeSchema = z.object({
  branch: z.string(),
  taskId: z.string(),
  status: WorktreeStatusSchema,
}).passthrough();

// ─── Synthesis Schema ───────────────────────────────────────────────────────

export const SynthesisSchema = z.object({
  integrationBranch: z.string().nullable(),
  mergeOrder: z.array(z.string()),
  mergedBranches: z.array(z.string()),
  prUrl: z.string().nullable(),
  prFeedback: z.array(z.unknown()),
});

// ─── Artifacts Schema ───────────────────────────────────────────────────────

export const ArtifactsSchema = z.object({
  design: z.string().nullable(),
  plan: z.string().nullable(),
  pr: z.string().nullable(),
});

// ─── Feature ID Schema ──────────────────────────────────────────────────────

export const FeatureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

// ─── Workflow Type ──────────────────────────────────────────────────────────

export const WorkflowTypeSchema = z.enum(['feature', 'debug', 'refactor']);

// ─── Base Workflow State (shared fields) ────────────────────────────────────

const BaseWorkflowStateSchema = z.object({
  version: z.string().default('1.1'),
  featureId: FeatureIdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  artifacts: ArtifactsSchema,
  tasks: z.array(TaskSchema),
  worktrees: z.record(z.string(), WorktreeSchema),
  julesSessions: z.record(z.string(), z.unknown()),
  reviews: z.record(z.string(), z.unknown()),
  integration: z.object({
    passed: z.boolean(),
  }).nullable().default(null),
  synthesis: SynthesisSchema,
  _history: z.record(z.string(), z.string()).default({}),
  _events: z.array(EventSchema).default([]),
  _eventSequence: z.number().int().min(0).default(0),
  _checkpoint: CheckpointStateSchema.default({
    timestamp: '1970-01-01T00:00:00Z',
    phase: 'init',
    summary: 'Initial state',
    operationsSince: 0,
    fixCycleCount: 0,
    lastActivityTimestamp: '1970-01-01T00:00:00Z',
    staleAfterMinutes: 120,
  }),
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

// ─── Discriminated Union of All Workflow States ─────────────────────────────

export const WorkflowStateSchema = z.discriminatedUnion('workflowType', [
  FeatureWorkflowStateSchema,
  DebugWorkflowStateSchema,
  RefactorWorkflowStateSchema,
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
  COMPENSATION_PARTIAL: 'COMPENSATION_PARTIAL',
  FILE_IO_ERROR: 'FILE_IO_ERROR',
} as const;

// ─── Reserved Field Validation ──────────────────────────────────────────────

export function isReservedField(path: string): boolean {
  if (path === '') return false;
  return path.startsWith('_') || path.split('.').some((part) => part.startsWith('_'));
}
