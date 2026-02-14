import { z } from 'zod';

// ─── Event Type Discriminated Union ─────────────────────────────────────────

export const EventTypes = [
  'workflow.started',
  'team.formed',
  'phase.transitioned',
  'task.assigned',
  'task.claimed',
  'task.progressed',
  'test.result',
  'task.completed',
  'task.failed',
  'agent.message',
  'agent.handoff',
  'gate.executed',
  'gate.self-corrected',
  'stack.position-filled',
  'stack.restacked',
  'stack.enqueued',
  'context.assembled',
  'task.routed',
  'remediation.started',
  'workflow.transition',
  'workflow.fix-cycle',
  'workflow.guard-failed',
  'workflow.checkpoint',
  'workflow.compound-entry',
  'workflow.compound-exit',
  'workflow.cancel',
  'workflow.compensation',
  'workflow.circuit-open',
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

export const TeamFormedData = z.object({
  teammates: z.array(z.object({
    name: z.string(),
    role: z.string(),
    model: z.string().optional(),
  })),
});

export const PhaseTransitionedData = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string().optional(),
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

export const TestResultData = z.object({
  taskId: z.string(),
  passed: z.boolean(),
  testCount: z.number().int(),
  failCount: z.number().int(),
  coverage: z.number().optional(),
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

// ─── Inter-Agent Event Data ─────────────────────────────────────────────────

export const AgentMessageData = z.object({
  from: z.string(),
  to: z.string(),
  content: z.string(),
  messageType: z.enum(['direct', 'broadcast']),
});

export const AgentHandoffData = z.object({
  from: z.string(),
  to: z.string(),
  context: z.string().optional(),
  reason: z.string().optional(),
});

// ─── Quality Gate Event Data ────────────────────────────────────────────────

export const GateExecutedData = z.object({
  gateName: z.string(),
  layer: z.string(),
  passed: z.boolean(),
  duration: z.number().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const GateSelfCorrectedData = z.object({
  gateName: z.string(),
  attempt: z.number().int(),
  correction: z.string(),
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

// ─── Context Event Data ─────────────────────────────────────────────────────

export const ContextAssembledData = z.object({
  qualityScore: z.number(),
  sources: z.array(z.string()),
});

export const TaskRoutedData = z.object({
  taskId: z.string(),
  scores: z.record(z.string(), z.number()),
});

export const RemediationStartedData = z.object({
  failedGates: z.array(z.string()),
  strategy: z.string(),
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

// ─── TypeScript Types ───────────────────────────────────────────────────────

export type WorkflowEvent = z.infer<typeof WorkflowEventBase>;
export type WorkflowStarted = z.infer<typeof WorkflowStartedData>;
export type TeamFormed = z.infer<typeof TeamFormedData>;
export type PhaseTransitioned = z.infer<typeof PhaseTransitionedData>;
export type TaskAssigned = z.infer<typeof TaskAssignedData>;
export type TaskClaimed = z.infer<typeof TaskClaimedData>;
export type TaskProgressed = z.infer<typeof TaskProgressedData>;
export type TestResult = z.infer<typeof TestResultData>;
export type TaskCompleted = z.infer<typeof TaskCompletedData>;
export type TaskFailed = z.infer<typeof TaskFailedData>;
export type AgentMessage = z.infer<typeof AgentMessageData>;
export type AgentHandoff = z.infer<typeof AgentHandoffData>;
export type GateExecuted = z.infer<typeof GateExecutedData>;
export type GateSelfCorrected = z.infer<typeof GateSelfCorrectedData>;
export type StackPositionFilled = z.infer<typeof StackPositionFilledData>;
export type StackRestacked = z.infer<typeof StackRestackedData>;
export type StackEnqueued = z.infer<typeof StackEnqueuedData>;
export type ContextAssembled = z.infer<typeof ContextAssembledData>;
export type TaskRouted = z.infer<typeof TaskRoutedData>;
export type RemediationStarted = z.infer<typeof RemediationStartedData>;
export type WorkflowTransition = z.infer<typeof WorkflowTransitionData>;
export type WorkflowFixCycle = z.infer<typeof WorkflowFixCycleData>;
export type WorkflowGuardFailed = z.infer<typeof WorkflowGuardFailedData>;
export type WorkflowCheckpoint = z.infer<typeof WorkflowCheckpointData>;
export type WorkflowCompoundEntry = z.infer<typeof WorkflowCompoundEntryData>;
export type WorkflowCompoundExit = z.infer<typeof WorkflowCompoundExitData>;
export type WorkflowCancel = z.infer<typeof WorkflowCancelData>;
export type WorkflowCompensation = z.infer<typeof WorkflowCompensationData>;
export type WorkflowCircuitOpen = z.infer<typeof WorkflowCircuitOpenData>;
