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
] as const;

export type EventType = typeof EventTypes[number];

// ─── Base Event Schema ──────────────────────────────────────────────────────

export const WorkflowEventBase = z.object({
  streamId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
  type: z.enum(EventTypes),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  agentId: z.string().optional(),
  agentRole: z.string().optional(),
  source: z.string().optional(),
  schemaVersion: z.string().default('1.0'),
  data: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
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
  consecutiveFailures: z.number(),
  firstFailureCommit: z.string(),
  lastFailureCommit: z.string(),
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
