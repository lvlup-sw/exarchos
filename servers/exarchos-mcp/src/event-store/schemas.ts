import { z } from 'zod';

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
  'shepherd.started',
  'shepherd.iteration',
  'shepherd.approval_requested',
  'shepherd.completed',
] as const;

export type EventType = typeof EventTypes[number];

// ─── Base Event Schema ──────────────────────────────────────────────────────

export const WorkflowEventBase = z.object({
  streamId: z.string().min(1).max(100),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
  type: z.enum(EventTypes),
  correlationId: z.string().max(200).optional(),
  causationId: z.string().max(200).optional(),
  agentId: z.string().max(200).optional(),
  agentRole: z.string().max(50).optional(),
  tenantId: z.string().min(1).max(100).optional(),
  organizationId: z.string().min(1).max(100).optional(),
  source: z.string().max(100).optional(),
  schemaVersion: z.string().max(20).default('1.0'),
  data: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

// ─── Workflow-Level Event Data ──────────────────────────────────────────────

export const WorkflowStartedData = z.object({
  featureId: z.string(),
  workflowType: z.enum(['feature', 'debug', 'refactor']),
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
  detail: z.string().optional(),
});

export const TaskCompletedData = z.object({
  taskId: z.string(),
  artifacts: z.array(z.string()).optional(),
  duration: z.number().optional(),
});

export const TaskFailedData = z.object({
  taskId: z.string(),
  error: z.string(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});

// ─── Quality Gate Event Data ────────────────────────────────────────────────

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

/** @planned — not yet emitted in production */
export const StackRestackedData = z.object({
  affectedPositions: z.array(z.number().int()),
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

/** @planned — not yet emitted in production */
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

// ─── Shepherd Event Data ──────────────────────────────────────────────────

/** @planned — not yet emitted in production */
export const ShepherdStartedData = z.object({
  prUrl: z.string(),
  stackSize: z.number().int().nonnegative(),
  ciStatus: z.string(),
});

/** @planned — not yet emitted in production */
export const ShepherdIterationData = z.object({
  prUrl: z.string(),
  iteration: z.number().int().nonnegative(),
  action: z.string(),
  outcome: z.string(),
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
  })),
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

// ─── TypeScript Types ───────────────────────────────────────────────────────

export type WorkflowEvent = z.infer<typeof WorkflowEventBase>;
export type WorkflowStarted = z.infer<typeof WorkflowStartedData>;
export type TaskAssigned = z.infer<typeof TaskAssignedData>;
export type TaskClaimed = z.infer<typeof TaskClaimedData>;
export type TaskProgressed = z.infer<typeof TaskProgressedData>;
export type TaskCompleted = z.infer<typeof TaskCompletedData>;
export type TaskFailed = z.infer<typeof TaskFailedData>;
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
export type ShepherdStarted = z.infer<typeof ShepherdStartedData>;
export type ShepherdIteration = z.infer<typeof ShepherdIterationData>;
export type ShepherdApprovalRequested = z.infer<typeof ShepherdApprovalRequestedData>;
export type ShepherdCompleted = z.infer<typeof ShepherdCompletedData>;
export type EvalRunStarted = z.infer<typeof EvalRunStartedData>;
export type EvalCaseCompleted = z.infer<typeof EvalCaseCompletedData>;
export type EvalRunCompleted = z.infer<typeof EvalRunCompletedData>;

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
