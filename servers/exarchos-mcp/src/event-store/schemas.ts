import { z } from 'zod';
import { WorkflowTypeSchema } from '../workflow/schemas.js';

// ─── Event Type Discriminated Union ─────────────────────────────────────────

export const EventTypes = [
  'workflow.started',
  'task.assigned',
  'task.claimed',
  'task.progressed',
  'task.completed',
  'task.failed',
  'gate.executed',
  'state.patched',
  'stack.position-filled',
  'stack.restacked',
  'stack.enqueued',
  'workflow.transition',
  'workflow.fix-cycle',
  'workflow.guard-failed',
  'workflow.checkpoint',
  'workflow.compound-entry',
  'workflow.compound-exit',
  'workflow.cancel',
  'workflow.cleanup',
  'workflow.compensation',
  'workflow.circuit-open',
  'tool.invoked',
  'tool.completed',
  'tool.errored',
  'benchmark.completed',
  'team.spawned',
  'team.task.assigned',
  'team.task.completed',
  'team.task.failed',
  'team.disbanded',
  'team.context.injected',
  'team.task.planned',
  'team.teammate.dispatched',
  'quality.regression',
  'workflow.cas-failed',
  'review.routed',
  'review.finding',
  'review.escalated',
  'quality.hint.generated',
  'eval.run.started',
  'eval.case.completed',
  'eval.run.completed',
  'eval.judge.calibrated',
  'shepherd.started',
  'shepherd.iteration',
  'shepherd.approval_requested',
  'shepherd.completed',
  'remediation.attempted',
  'remediation.succeeded',
  'quality.refinement.suggested',
  'session.tagged',
  'worktree.created',
  'worktree.baseline',
  'test.result',
  'typecheck.result',
  'stack.submitted',
  'ci.status',
  'comment.posted',
  'comment.resolved',
] as const;

export type EventType = typeof EventTypes[number];

// ─── Extensible Event Type Registry ──────────────────────────────────────────

const BUILT_IN_EVENT_TYPES = new Set<string>(EventTypes);
const customEventTypes = new Set<string>();

/** Name format: lowercase with hyphens, must contain at least one dot separator. */
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Register a custom event type at runtime.
 * Built-in event types cannot be overridden and duplicate custom registrations are rejected.
 */
export function registerEventType(
  name: string,
  options: { source: 'auto' | 'model' | 'hook'; schema?: z.ZodSchema },
): void {
  if (!name) {
    throw new Error('Event type name must not be empty');
  }
  if (name !== name.toLowerCase()) {
    throw new Error(
      `Invalid event type name '${name}': must be lowercase with hyphens and dot separators (e.g., 'deploy.started')`,
    );
  }
  if (!EVENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid event type name '${name}': must contain a dot separator and use lowercase with hyphens (e.g., 'deploy.started')`,
    );
  }
  if (BUILT_IN_EVENT_TYPES.has(name)) {
    throw new Error(
      `Cannot register '${name}': collides with built-in event type`,
    );
  }
  if (customEventTypes.has(name)) {
    throw new Error(
      `Cannot register '${name}': custom event type already registered`,
    );
  }

  customEventTypes.add(name);

  // Register source in emission registry (cast to allow string indexing)
  (EVENT_EMISSION_REGISTRY as Record<string, EventEmissionSource>)[name] = options.source;

  // Register schema if provided
  if (options.schema) {
    (EVENT_DATA_SCHEMAS as Record<string, z.ZodSchema>)[name] = options.schema;
  }
}

/**
 * Remove a custom event type. Only custom (non-built-in) types can be removed.
 * Used for test cleanup.
 */
export function unregisterEventType(name: string): void {
  if (BUILT_IN_EVENT_TYPES.has(name)) {
    throw new Error(`Cannot unregister built-in event type: '${name}'`);
  }
  customEventTypes.delete(name);
  delete (EVENT_EMISSION_REGISTRY as Record<string, EventEmissionSource>)[name];
  delete (EVENT_DATA_SCHEMAS as Record<string, z.ZodSchema>)[name];
}

/**
 * Returns all valid event types: built-in + custom.
 */
export function getValidEventTypes(): string[] {
  return [...EventTypes, ...customEventTypes];
}

/**
 * Check if a name is a built-in event type.
 */
export function isBuiltInEventType(name: string): boolean {
  return BUILT_IN_EVENT_TYPES.has(name);
}

// ─── Event Emission Source ───────────────────────────────────────────────────

export type EventEmissionSource = 'auto' | 'model' | 'hook' | 'planned';

export const EVENT_EMISSION_REGISTRY: Record<EventType, EventEmissionSource> = {
  // auto — emitted by MCP server handlers (deterministic)
  'workflow.started': 'auto',
  'workflow.transition': 'auto',
  'workflow.fix-cycle': 'auto',
  'workflow.guard-failed': 'auto',
  'workflow.checkpoint': 'auto',
  'workflow.compound-entry': 'auto',
  'workflow.compound-exit': 'auto',
  'workflow.cancel': 'auto',
  'workflow.cleanup': 'auto',
  'workflow.compensation': 'auto',
  'workflow.circuit-open': 'auto',
  'workflow.cas-failed': 'auto',
  'task.claimed': 'auto',
  'task.completed': 'auto',
  'task.failed': 'auto',
  'gate.executed': 'auto',
  'state.patched': 'auto',
  'tool.invoked': 'auto',
  'tool.completed': 'auto',
  'tool.errored': 'auto',
  'quality.hint.generated': 'auto',
  'quality.refinement.suggested': 'auto',
  'stack.position-filled': 'auto',
  'stack.restacked': 'auto',
  'stack.enqueued': 'auto',

  // model — must be emitted explicitly by the model via exarchos_event
  'team.spawned': 'model',
  'team.task.assigned': 'model',
  'team.task.completed': 'model',
  'team.task.failed': 'model',
  'team.disbanded': 'model',
  'team.task.planned': 'model',
  'team.teammate.dispatched': 'model',
  'review.routed': 'model',
  'review.finding': 'model',
  'review.escalated': 'model',
  'remediation.attempted': 'model',
  'remediation.succeeded': 'model',
  'session.tagged': 'model',
  'worktree.created': 'model',
  'worktree.baseline': 'model',
  'test.result': 'model',
  'typecheck.result': 'model',
  'stack.submitted': 'model',
  'ci.status': 'model',
  'comment.posted': 'model',
  'comment.resolved': 'model',
  'shepherd.iteration': 'model',
  'quality.regression': 'model',
  'task.assigned': 'model',
  'task.progressed': 'model',

  // hook — emitted by Claude Code hooks
  'benchmark.completed': 'hook',

  // planned — schema exists, not yet emitted in production
  'team.context.injected': 'planned',
  'shepherd.started': 'planned',
  'shepherd.approval_requested': 'planned',
  'shepherd.completed': 'planned',
  'eval.run.started': 'planned',
  'eval.case.completed': 'planned',
  'eval.run.completed': 'planned',
  'eval.judge.calibrated': 'planned',
};

// ─── Base Event Schema ──────────────────────────────────────────────────────

export const WorkflowEventBase = z.object({
  streamId: z.string().min(1).max(100),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
  type: z.enum(EventTypes),
  correlationId: z.string().max(200).optional(),
  causationId: z.string().max(200).optional(),
  agentId: z.string().min(1).max(200).optional(),
  agentRole: z.string().max(50).optional(),
  tenantId: z.string().min(1).max(100).optional(),
  organizationId: z.string().min(1).max(100).optional(),
  source: z.string().max(100).optional(),
  schemaVersion: z.string().min(1).max(20).default('1.0'),
  data: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

// ─── Workflow-Level Event Data ──────────────────────────────────────────────

export const WorkflowStartedData = z.object({
  featureId: z.string(),
  workflowType: WorkflowTypeSchema,
  designPath: z.string().optional(),
});

export const TaskAssignedData = z.object({
  taskId: z.string(),
  title: z.string(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  assignee: z.string().optional(),
});

// ─── Task-Level Event Data ──────────────────────────────────────────────────

export const TaskClaimedData = z.object({
  taskId: z.string(),
  agentId: z.string(),
  claimedAt: z.string(),
});

export const TaskProgressedData = z.object({
  taskId: z.string(),
  tddPhase: z.enum(['red', 'green', 'refactor']),
  detail: z.string().max(500).optional(),
});

export const TaskCompletedData = z.object({
  taskId: z.string(),
  artifacts: z.array(z.string()).optional(),
  duration: z.number().optional(),
  evidence: z.object({
    type: z.enum(['test', 'build', 'typecheck', 'manual']),
    output: z.string(),
    passed: z.boolean(),
  }).optional(),
  verified: z.boolean().optional(),
  // Provenance chain fields (optional, backward-compatible)
  implements: z.array(z.string()).optional(),
  tests: z.array(z.object({ name: z.string(), file: z.string() })).optional(),
  files: z.array(z.string()).optional(),
});

export const TaskFailedData = z.object({
  taskId: z.string(),
  error: z.string().max(500),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});

// ─── Quality Gate Event Data ────────────────────────────────────────────────

export const GateExecutedDetailsSchema = z.object({
  skill: z.string().optional(),
  model: z.string().optional(),
  commit: z.string().optional(),
  reason: z.string().optional(),
  category: z.string().optional(),
  taskId: z.string().optional(),
  attemptNumber: z.number().int().min(1).optional(),
  promptVersion: z.string().optional(),
}).passthrough();

export const GateExecutedData = z.object({
  gateName: z.string(),
  layer: z.string(),
  passed: z.boolean(),
  duration: z.number().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// ─── Stack Event Data ───────────────────────────────────────────────────────

export const StackPositionFilledData = z.object({
  position: z.number().int(),
  taskId: z.string(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
});

export const StackRestackedData = z.object({
  branches: z.array(z.string()),
  conflicts: z.boolean(),
  reconstructed: z.boolean(),
});

export const StackEnqueuedData = z.object({
  prNumbers: z.array(z.number().int()),
});

// ─── Workflow Internal Event Data ─────────────────────────────────────────

export const WorkflowTransitionData = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  featureId: z.string(),
});

export const WorkflowFixCycleData = z.object({
  compoundStateId: z.string(),
  count: z.number().int(),
  featureId: z.string(),
});

export const WorkflowGuardFailedData = z.object({
  guard: z.string(),
  from: z.string(),
  to: z.string(),
  featureId: z.string(),
});

export const WorkflowCheckpointData = z.object({
  counter: z.number().int(),
  phase: z.string(),
  featureId: z.string(),
});

export const WorkflowCompoundEntryData = z.object({
  compoundStateId: z.string(),
  featureId: z.string(),
});

export const WorkflowCompoundExitData = z.object({
  compoundStateId: z.string(),
  featureId: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  trigger: z.string().optional(),
});

export const WorkflowCleanupData = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  featureId: z.string(),
});

export const WorkflowCancelData = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  featureId: z.string(),
  reason: z.string().optional(),
});

export const WorkflowCompensationData = z.object({
  featureId: z.string(),
  actionId: z.string(),
  status: z.enum(['executed', 'skipped', 'failed', 'dry-run']),
  message: z.string(),
});

export const WorkflowCircuitOpenData = z.object({
  featureId: z.string(),
  compoundId: z.string(),
  fixCycleCount: z.number().int().optional(),
  maxFixCycles: z.number().int().optional(),
});

export const WorkflowCasFailedData = z.object({
  featureId: z.string(),
  phase: z.string(),
  retries: z.number().int(),
});

// ─── Review Event Data ─────────────────────────────────────────────────────

export const ReviewRoutedData = z.object({
  pr: z.number().int(),
  riskScore: z.number(),
  factors: z.array(z.string()),
  destination: z.enum(['coderabbit', 'self-hosted', 'both']),
  velocityTier: z.enum(['normal', 'elevated', 'high']),
  semanticAugmented: z.boolean(),
});

export const ReviewFindingData = z.object({
  pr: z.number().int(),
  source: z.enum(['coderabbit', 'self-hosted']),
  severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
  filePath: z.string(),
  lineRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  message: z.string(),
  rule: z.string().optional(),
});

export const ReviewEscalatedData = z.object({
  pr: z.number().int(),
  reason: z.string(),
  originalScore: z.number(),
  triggeringFinding: z.string(),
});

// ─── Telemetry Event Data ──────────────────────────────────────────────────

export const ToolInvokedData = z.object({
  tool: z.string(),
});

export const ToolCompletedData = z.object({
  tool: z.string(),
  durationMs: z.number(),
  responseBytes: z.number(),
  tokenEstimate: z.number(),
});

export const ToolErroredData = z.object({
  tool: z.string(),
  durationMs: z.number(),
  errorMessage: z.string(),
});

// ─── Benchmark Event Data ───────────────────────────────────────────────────

export const BenchmarkCompletedData = z.object({
  taskId: z.string(),
  results: z.array(z.object({
    operation: z.string().min(1),
    metric: z.string(),
    value: z.number(),
    unit: z.string(),
    baseline: z.number().optional(),
    regressionPercent: z.number().optional(),
    passed: z.boolean(),
  })).min(1),
});

// ─── Team Event Data ────────────────────────────────────────────────────────

export const TeamSpawnedData = z.object({
  teamSize: z.number().int(),
  teammateNames: z.array(z.string()),
  taskCount: z.number().int(),
  dispatchMode: z.string(),
});

export const TeamTaskAssignedData = z.object({
  taskId: z.string(),
  teammateName: z.string(),
  worktreePath: z.string(),
  modules: z.array(z.string()),
});

export const TeamTaskCompletedData = z.object({
  taskId: z.string(),
  teammateName: z.string(),
  durationMs: z.number(),
  filesChanged: z.array(z.string()),
  testsPassed: z.boolean(),
  qualityGateResults: z.record(z.string(), z.unknown()),
});

export const TeamTaskFailedData = z.object({
  taskId: z.string(),
  teammateName: z.string(),
  failureReason: z.string(),
  gateResults: z.record(z.string(), z.unknown()),
});

export const TeamDisbandedData = z.object({
  totalDurationMs: z.number(),
  tasksCompleted: z.number().int(),
  tasksFailed: z.number().int(),
});

/** @planned — not yet emitted in production */
export const TeamContextInjectedData = z.object({
  phase: z.string(),
  toolsAvailable: z.number().int(),
  historicalHints: z.array(z.string()),
});

export const TeamTaskPlannedData = z.object({
  taskId: z.string(),
  title: z.string(),
  modules: z.array(z.string()),
  blockedBy: z.array(z.string()),
});

export const TeamTeammateDispatchedData = z.object({
  teammateName: z.string(),
  worktreePath: z.string(),
  assignedTaskIds: z.array(z.string()),
  model: z.string(),
});

// ─── Quality Regression Event Data ──────────────────────────────────────────

export const QualityRegressionData = z.object({
  skill: z.string(),
  gate: z.string(),
  consecutiveFailures: z.number().int().nonnegative(),
  firstFailureCommit: z.string(),
  lastFailureCommit: z.string(),
  detectedAt: z.string().datetime(),
});

// ─── Quality Hint Event Data ─────────────────────────────────────────────

export const QualityHintGeneratedData = z.object({
  skill: z.string(),
  hintCount: z.number().int().nonnegative(),
  categories: z.array(z.string()),
  generatedAt: z.string().datetime(),
});

// ─── Quality Refinement Event Data ──────────────────────────────────────────

export const RefinementSuggestedDataSchema = z.object({
  skill: z.string().min(1),
  signalConfidence: z.enum(['high', 'medium']),
  trigger: z.enum(['regression', 'trend-degradation', 'attribution-outlier']),
  evidence: z.object({
    gatePassRate: z.number(),
    evalScore: z.number(),
    topFailureCategories: z.array(z.object({
      category: z.string(),
      count: z.number(),
    })),
    selfCorrectionRate: z.number(),
    recentRegressions: z.number(),
  }),
  suggestedAction: z.string().min(1),
  affectedPromptPaths: z.array(z.string()),
});

// ─── Shepherd Event Data ──────────────────────────────────────────────────

/** @planned — not yet emitted in production */
export const ShepherdStartedData = z.object({
  prUrl: z.string(),
  stackSize: z.number().int().nonnegative(),
  ciStatus: z.string(),
});

export const ShepherdIterationData = z.object({
  iteration: z.number().int().nonnegative(),
  prsAssessed: z.number().int().nonnegative(),
  fixesApplied: z.number().int().nonnegative(),
  status: z.string(),
});

/** @planned — not yet emitted in production */
export const ShepherdApprovalRequestedData = z.object({
  prUrl: z.string(),
  reviewers: z.array(z.string()),
});

/** @planned — not yet emitted in production */
export const ShepherdCompletedData = z.object({
  prUrl: z.string(),
  merged: z.boolean(),
  iterations: z.number().int().nonnegative(),
  duration: z.number().nonnegative(),
});

// ─── Eval Event Data ────────────────────────────────────────────────────────

export const EvalRunStartedData = z.object({
  runId: z.string().uuid(),
  suiteId: z.string(),
  layer: z.enum(['regression', 'capability', 'reliability']).optional(),
  trigger: z.enum(['ci', 'local', 'scheduled']),
  caseCount: z.number().int().nonnegative(),
});

export const EvalCaseCompletedData = z.object({
  runId: z.string().uuid(),
  caseId: z.string(),
  suiteId: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  assertions: z.array(z.object({
    name: z.string(),
    type: z.string(),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    reason: z.string(),
  })).max(50),
  duration: z.number().int().nonnegative(),
});

export const EvalRunCompletedData = z.object({
  runId: z.string().uuid(),
  suiteId: z.string(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  avgScore: z.number().min(0).max(1),
  duration: z.number().int().nonnegative(),
  regressions: z.array(z.string()),
});

export const JudgeCalibratedDataSchema = z.object({
  skill: z.string(),
  rubricName: z.string(),
  split: z.enum(['validation', 'test']),
  tpr: z.number().min(0).max(1),
  tnr: z.number().min(0).max(1),
  accuracy: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
  goldStandardVersion: z.string(),
  rubricVersion: z.string(),
});

// ─── Remediation Event Data ─────────────────────────────────────────────────

export const RemediationAttemptedDataSchema = z.object({
  taskId: z.string().min(1),
  skill: z.string().min(1),
  gateName: z.string().min(1),
  attemptNumber: z.number().int().min(1),
  strategy: z.string(),
});

export const RemediationSucceededDataSchema = z.object({
  taskId: z.string().min(1),
  skill: z.string().min(1),
  gateName: z.string().min(1),
  totalAttempts: z.number().int().min(1),
  finalStrategy: z.string(),
});

export const SessionTaggedData = z.object({
  tag: z.string().min(1).max(100),
  sessionId: z.string().min(1),
  description: z.string().max(500).optional(),
  branch: z.string().optional(),
});

// ─── Readiness Event Data ───────────────────────────────────────────────────

export const WorktreeCreatedData = z.object({
  taskId: z.string(),
  path: z.string(),
  branch: z.string(),
});

export const WorktreeBaselineData = z.object({
  taskId: z.string(),
  path: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  output: z.string().optional(),
});

export const TestResultData = z.object({
  passed: z.boolean(),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  coveragePercent: z.number().optional(),
  output: z.string().optional(),
});

export const TypecheckResultData = z.object({
  passed: z.boolean(),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(z.string()).optional(),
});

export const StackSubmittedData = z.object({
  branches: z.array(z.string()),
  prNumbers: z.array(z.number().int()),
});

export const CiStatusData = z.object({
  pr: z.number().int(),
  status: z.enum(['passing', 'failing', 'pending']),
  jobUrl: z.string().optional(),
});

export const CommentPostedData = z.object({
  pr: z.number().int(),
  commentId: z.string(),
  body: z.string(),
  inReplyTo: z.string().optional(),
});

export const CommentResolvedData = z.object({
  pr: z.number().int(),
  threadId: z.string(),
  resolvedBy: z.enum(['author', 'outdated', 'manual']),
});

// ─── Event Data Schemas Map ─────────────────────────────────────────────────

export const EVENT_DATA_SCHEMAS: Partial<Record<EventType, z.ZodSchema>> = {
  // Workflow-level
  'workflow.started': WorkflowStartedData,
  'workflow.transition': WorkflowTransitionData,
  'workflow.fix-cycle': WorkflowFixCycleData,
  'workflow.guard-failed': WorkflowGuardFailedData,
  'workflow.checkpoint': WorkflowCheckpointData,
  'workflow.compound-entry': WorkflowCompoundEntryData,
  'workflow.compound-exit': WorkflowCompoundExitData,
  'workflow.cancel': WorkflowCancelData,
  'workflow.cleanup': WorkflowCleanupData,
  'workflow.compensation': WorkflowCompensationData,
  'workflow.circuit-open': WorkflowCircuitOpenData,
  'workflow.cas-failed': WorkflowCasFailedData,

  // Task-level
  'task.assigned': TaskAssignedData,
  'task.claimed': TaskClaimedData,
  'task.progressed': TaskProgressedData,
  'task.completed': TaskCompletedData,
  'task.failed': TaskFailedData,

  // Quality gate
  'gate.executed': GateExecutedData,

  // Stack
  'stack.position-filled': StackPositionFilledData,
  'stack.restacked': StackRestackedData,
  'stack.enqueued': StackEnqueuedData,
  'stack.submitted': StackSubmittedData,

  // Telemetry
  'tool.invoked': ToolInvokedData,
  'tool.completed': ToolCompletedData,
  'tool.errored': ToolErroredData,

  // Benchmark
  'benchmark.completed': BenchmarkCompletedData,

  // Team
  'team.spawned': TeamSpawnedData,
  'team.task.assigned': TeamTaskAssignedData,
  'team.task.completed': TeamTaskCompletedData,
  'team.task.failed': TeamTaskFailedData,
  'team.disbanded': TeamDisbandedData,
  'team.context.injected': TeamContextInjectedData,
  'team.task.planned': TeamTaskPlannedData,
  'team.teammate.dispatched': TeamTeammateDispatchedData,

  // Quality
  'quality.regression': QualityRegressionData,
  'quality.hint.generated': QualityHintGeneratedData,
  'quality.refinement.suggested': RefinementSuggestedDataSchema,

  // Review
  'review.routed': ReviewRoutedData,
  'review.finding': ReviewFindingData,
  'review.escalated': ReviewEscalatedData,

  // Remediation
  'remediation.attempted': RemediationAttemptedDataSchema,
  'remediation.succeeded': RemediationSucceededDataSchema,

  // Session
  'session.tagged': SessionTaggedData,

  // Readiness
  'worktree.created': WorktreeCreatedData,
  'worktree.baseline': WorktreeBaselineData,
  'test.result': TestResultData,
  'typecheck.result': TypecheckResultData,
  'ci.status': CiStatusData,
  'comment.posted': CommentPostedData,
  'comment.resolved': CommentResolvedData,

  // Shepherd
  'shepherd.started': ShepherdStartedData,
  'shepherd.iteration': ShepherdIterationData,
  'shepherd.approval_requested': ShepherdApprovalRequestedData,
  'shepherd.completed': ShepherdCompletedData,

  // Eval
  'eval.run.started': EvalRunStartedData,
  'eval.case.completed': EvalCaseCompletedData,
  'eval.run.completed': EvalRunCompletedData,
  'eval.judge.calibrated': JudgeCalibratedDataSchema,
};

// ─── TypeScript Types ───────────────────────────────────────────────────────

export type WorkflowEvent = z.infer<typeof WorkflowEventBase>;
export type WorkflowStarted = z.infer<typeof WorkflowStartedData>;
export type TaskAssigned = z.infer<typeof TaskAssignedData>;
export type TaskClaimed = z.infer<typeof TaskClaimedData>;
export type TaskProgressed = z.infer<typeof TaskProgressedData>;
export type TaskCompleted = z.infer<typeof TaskCompletedData>;
export type TaskFailed = z.infer<typeof TaskFailedData>;
export type GateExecutedDetails = z.infer<typeof GateExecutedDetailsSchema>;
export type GateExecuted = z.infer<typeof GateExecutedData>;
export type StackPositionFilled = z.infer<typeof StackPositionFilledData>;
export type StackRestacked = z.infer<typeof StackRestackedData>;
export type StackEnqueued = z.infer<typeof StackEnqueuedData>;
export type WorkflowTransition = z.infer<typeof WorkflowTransitionData>;
export type WorkflowFixCycle = z.infer<typeof WorkflowFixCycleData>;
export type WorkflowGuardFailed = z.infer<typeof WorkflowGuardFailedData>;
export type WorkflowCheckpoint = z.infer<typeof WorkflowCheckpointData>;
export type WorkflowCompoundEntry = z.infer<typeof WorkflowCompoundEntryData>;
export type WorkflowCompoundExit = z.infer<typeof WorkflowCompoundExitData>;
export type WorkflowCleanup = z.infer<typeof WorkflowCleanupData>;
export type WorkflowCancel = z.infer<typeof WorkflowCancelData>;
export type WorkflowCompensation = z.infer<typeof WorkflowCompensationData>;
export type WorkflowCircuitOpen = z.infer<typeof WorkflowCircuitOpenData>;
export type WorkflowCasFailed = z.infer<typeof WorkflowCasFailedData>;
export type ToolInvoked = z.infer<typeof ToolInvokedData>;
export type ToolCompleted = z.infer<typeof ToolCompletedData>;
export type ToolErrored = z.infer<typeof ToolErroredData>;
export type BenchmarkCompleted = z.infer<typeof BenchmarkCompletedData>;
export type TeamSpawned = z.infer<typeof TeamSpawnedData>;
export type TeamTaskAssigned = z.infer<typeof TeamTaskAssignedData>;
export type TeamTaskCompleted = z.infer<typeof TeamTaskCompletedData>;
export type TeamTaskFailed = z.infer<typeof TeamTaskFailedData>;
export type TeamDisbanded = z.infer<typeof TeamDisbandedData>;
export type TeamContextInjected = z.infer<typeof TeamContextInjectedData>;
export type TeamTaskPlanned = z.infer<typeof TeamTaskPlannedData>;
export type TeamTeammateDispatched = z.infer<typeof TeamTeammateDispatchedData>;
export type QualityRegression = z.infer<typeof QualityRegressionData>;
export type ReviewRouted = z.infer<typeof ReviewRoutedData>;
export type ReviewFinding = z.infer<typeof ReviewFindingData>;
export type ReviewEscalated = z.infer<typeof ReviewEscalatedData>;
export type QualityHintGenerated = z.infer<typeof QualityHintGeneratedData>;
export type RefinementSuggestedData = z.infer<typeof RefinementSuggestedDataSchema>;
export type ShepherdStarted = z.infer<typeof ShepherdStartedData>;
export type ShepherdIteration = z.infer<typeof ShepherdIterationData>;
export type ShepherdApprovalRequested = z.infer<typeof ShepherdApprovalRequestedData>;
export type ShepherdCompleted = z.infer<typeof ShepherdCompletedData>;
export type EvalRunStarted = z.infer<typeof EvalRunStartedData>;
export type EvalCaseCompleted = z.infer<typeof EvalCaseCompletedData>;
export type EvalRunCompleted = z.infer<typeof EvalRunCompletedData>;
export type JudgeCalibrated = z.infer<typeof JudgeCalibratedDataSchema>;
export type RemediationAttempted = z.infer<typeof RemediationAttemptedDataSchema>;
export type RemediationSucceeded = z.infer<typeof RemediationSucceededDataSchema>;
export type SessionTagged = z.infer<typeof SessionTaggedData>;
export type WorktreeCreated = z.infer<typeof WorktreeCreatedData>;
export type WorktreeBaseline = z.infer<typeof WorktreeBaselineData>;
export type TestResult = z.infer<typeof TestResultData>;
export type TypecheckResult = z.infer<typeof TypecheckResultData>;
export type StackSubmitted = z.infer<typeof StackSubmittedData>;
export type CiStatus = z.infer<typeof CiStatusData>;
export type CommentPosted = z.infer<typeof CommentPostedData>;
export type CommentResolved = z.infer<typeof CommentResolvedData>;

// ─── Event Data Map ─────────────────────────────────────────────────────────

export type EventDataMap = {
  'workflow.started': WorkflowStarted;
  'task.assigned': TaskAssigned;
  'task.claimed': TaskClaimed;
  'task.progressed': TaskProgressed;
  'task.completed': TaskCompleted;
  'task.failed': TaskFailed;
  'gate.executed': GateExecuted;
  'state.patched': Record<string, unknown>;
  'stack.position-filled': StackPositionFilled;
  'stack.restacked': StackRestacked;
  'stack.enqueued': StackEnqueued;
  'workflow.transition': WorkflowTransition;
  'workflow.fix-cycle': WorkflowFixCycle;
  'workflow.guard-failed': WorkflowGuardFailed;
  'workflow.checkpoint': WorkflowCheckpoint;
  'workflow.compound-entry': WorkflowCompoundEntry;
  'workflow.compound-exit': WorkflowCompoundExit;
  'workflow.cancel': WorkflowCancel;
  'workflow.cleanup': WorkflowCleanup;
  'workflow.compensation': WorkflowCompensation;
  'workflow.circuit-open': WorkflowCircuitOpen;
  'tool.invoked': ToolInvoked;
  'tool.completed': ToolCompleted;
  'tool.errored': ToolErrored;
  'benchmark.completed': BenchmarkCompleted;
  'team.spawned': TeamSpawned;
  'team.task.assigned': TeamTaskAssigned;
  'team.task.completed': TeamTaskCompleted;
  'team.task.failed': TeamTaskFailed;
  'team.disbanded': TeamDisbanded;
  'team.context.injected': TeamContextInjected;
  'team.task.planned': TeamTaskPlanned;
  'team.teammate.dispatched': TeamTeammateDispatched;
  'quality.regression': QualityRegression;
  'workflow.cas-failed': WorkflowCasFailed;
  'review.routed': ReviewRouted;
  'review.finding': ReviewFinding;
  'review.escalated': ReviewEscalated;
  'quality.hint.generated': QualityHintGenerated;
  'eval.run.started': EvalRunStarted;
  'eval.case.completed': EvalCaseCompleted;
  'eval.run.completed': EvalRunCompleted;
  'shepherd.started': ShepherdStarted;
  'shepherd.iteration': ShepherdIteration;
  'shepherd.approval_requested': ShepherdApprovalRequested;
  'shepherd.completed': ShepherdCompleted;
  'eval.judge.calibrated': JudgeCalibrated;
  'remediation.attempted': RemediationAttempted;
  'remediation.succeeded': RemediationSucceeded;
  'quality.refinement.suggested': RefinementSuggestedData;
  'session.tagged': SessionTagged;
  'worktree.created': WorktreeCreated;
  'worktree.baseline': WorktreeBaseline;
  'test.result': TestResult;
  'typecheck.result': TypecheckResult;
  'stack.submitted': StackSubmitted;
  'ci.status': CiStatus;
  'comment.posted': CommentPosted;
  'comment.resolved': CommentResolved;
};

// ─── Agent Event Validation ──────────────────────────────────────────────────

/** Event types that require agentId and source metadata. */
export const AGENT_EVENT_TYPES = [
  'task.claimed',
  'task.progressed',
  'team.task.completed',
  'team.task.failed',
] as const;

export type AgentEventType = typeof AGENT_EVENT_TYPES[number];

/**
 * Validates that agent event types include required metadata fields.
 *
 * Agent events (`task.claimed`, `task.progressed`) must have both `agentId`
 * and `source` set. System events pass through without validation.
 *
 * @returns `true` if validation passes
 * @throws Error if an agent event is missing `agentId` or `source`
 */
export function validateAgentEvent(event: {
  type: string;
  agentId?: string;
  source?: string;
}): true {
  const isAgentEvent = (AGENT_EVENT_TYPES as readonly string[]).includes(event.type);
  if (!isAgentEvent) {
    return true;
  }

  if (!event.agentId) {
    throw new Error(
      `Agent event '${event.type}' requires agentId but none was provided`,
    );
  }

  if (!event.source) {
    throw new Error(
      `Agent event '${event.type}' requires source but none was provided`,
    );
  }

  return true;
}
