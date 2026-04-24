import { z } from 'zod';
import { WorkflowTypeSchema } from '../workflow/schemas.js';
import { DoctorOutputSchema } from '../orchestrate/doctor/schema.js';

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
  'team.task.planned',
  'team.teammate.dispatched',
  'quality.regression',
  'workflow.cas-failed',
  'workflow.pruned',
  'workflow.checkpoint_requested',
  'workflow.checkpoint_written',
  'workflow.checkpoint_superseded',
  'workflow.rehydrated',
  'workflow.snapshot_taken',
  'synthesize.requested',
  'review.completed',
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
  'diagnostic.executed',
  'pr.created',
  'pr.merged',
  'pr.commented',
  'issue.created',
  'init.executed',
  'checkpoint.enforced',
  'checkpoint.state_missing',
  'preflight.executed',
  'preflight.blocked',
  'provider.unknown-tier',
  'provider.parse-error',
  'dispatch.classified',
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
  'workflow.pruned': 'auto',
  'workflow.checkpoint_requested': 'auto',
  'workflow.checkpoint_written': 'auto',
  'workflow.checkpoint_superseded': 'auto',
  'workflow.rehydrated': 'auto',
  'workflow.snapshot_taken': 'auto',
  'synthesize.requested': 'auto',
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
  'eval.judge.calibrated': 'auto',

  // model — must be emitted explicitly by the model via exarchos_event
  'team.spawned': 'model',
  'team.task.assigned': 'model',
  'team.task.completed': 'model',
  'team.task.failed': 'model',
  'team.disbanded': 'model',
  'team.task.planned': 'model',
  'team.teammate.dispatched': 'model',
  'review.completed': 'model',
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

  // auto — emitted by exarchos doctor composite
  'diagnostic.executed': 'auto',

  // auto — emitted by exarchos init composite
  'init.executed': 'auto',

  // hook — emitted by Claude Code hooks
  'benchmark.completed': 'hook',

  // auto — emitted by assess-stack orchestration
  'shepherd.started': 'auto',
  'shepherd.approval_requested': 'auto',
  'shepherd.completed': 'auto',

  // auto — emitted by VCS orchestration handlers
  'pr.created': 'auto',
  'pr.merged': 'auto',
  'pr.commented': 'auto',
  'issue.created': 'auto',

  // auto — emitted by checkpoint enforcement gate
  'checkpoint.enforced': 'auto',
  'checkpoint.state_missing': 'auto',
  'preflight.executed': 'auto',
  'preflight.blocked': 'auto',

  // auto — emitted by assess_stack when a review provider adapter
  // encounters an unrecognised severity tier (#1159).
  'provider.unknown-tier': 'auto',

  // auto — emitted by assess_stack when adapter.parse throws; the batch
  // continues, but we record the failure so observability catches
  // adapter regressions instead of them being silently swallowed (#1161).
  'provider.parse-error': 'auto',

  // auto — emitted by classify_review_items per invocation, capturing
  // the per-group dispatch decisions for downstream observability (#1159).
  'dispatch.classified': 'auto',

  // planned — schema exists, not yet emitted in production
  'eval.run.started': 'planned',
  'eval.case.completed': 'planned',
  'eval.run.completed': 'planned',
};

// ─── Base Event Schema ──────────────────────────────────────────────────────

export const WorkflowEventBase = z.object({
  streamId: z.string().min(1).max(100),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
  type: z.string().min(1).refine(
    (t) => getValidEventTypes().includes(t),
    (t) => ({ message: `Unknown event type: "${t}". Valid types: built-in EventTypes + registered custom types` }),
  ),
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
  // Oneshot-only: the synthesisPolicy chosen at init time. Must be persisted
  // in the event stream so ES v2 rematerialization reconstructs the policy
  // — otherwise the workflow silently reverts to the schema default
  // (`on-request`) after `handleInit` → rehydrate round-trips. Silently
  // accepted for non-oneshot workflow types but never populated by them.
  synthesisPolicy: z.enum(['always', 'never', 'on-request']).optional(),
});

export const TaskAssignedData = z.object({
  taskId: z.string().describe('Unique identifier for the task'),
  title: z.string().describe('Human-readable task title'),
  branch: z.string().optional().describe('Git branch for this task'),
  worktree: z.string().optional().describe('Path to the git worktree for isolation'),
  assignee: z.string().optional().describe('Agent or user assigned to this task'),
});

// ─── Task-Level Event Data ──────────────────────────────────────────────────

export const TaskClaimedData = z.object({
  taskId: z.string(),
  agentId: z.string(),
  claimedAt: z.string(),
});

export const TaskProgressedData = z.object({
  taskId: z.string().describe('Task being progressed'),
  tddPhase: z.enum(['red', 'green', 'refactor']).describe('Current TDD phase: red, green, or refactor'),
  detail: z.string().max(500).optional().describe('Optional detail about the progress step'),
});

export const TaskCompletedData = z.object({
  taskId: z.string(),
  acceptanceTestRef: z.string().min(1).optional(),
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

export const WorkflowPrunedData = z.object({
  featureId: z.string(),
  stalenessMinutes: z.number().nonnegative(),
  triggeredBy: z.enum(['manual', 'scheduled']),
  skippedSafeguards: z.array(z.string()).optional(),
});

export const WorkflowCheckpointRequestedData = z.object({
  trigger: z.enum(['manual', 'threshold', 'hook']),
  reason: z.string().optional(),
});

export const WorkflowCheckpointWrittenData = z.object({
  projectionId: z.string().min(1),
  projectionSequence: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
});

export const WorkflowCheckpointSupersededData = z.object({
  priorSequence: z.number().int().nonnegative(),
  reason: z.string().min(1),
});

export const WorkflowRehydratedData = z.object({
  projectionSequence: z.number().int().nonnegative(),
  deliveryPath: z.enum(['direct', 'ndjson', 'snapshot']),
  tokenEstimate: z.number().int().nonnegative(),
});

export const WorkflowSnapshotTakenData = z.object({
  projectionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

export const SynthesizeRequestedData = z.object({
  featureId: z.string(),
  reason: z.string().optional(),
  timestamp: z.string().datetime(),
});

// ─── Review Event Data ─────────────────────────────────────────────────────

export const ReviewRoutedData = z.object({
  pr: z.number().int().describe('Pull request number'),
  riskScore: z.number().min(0).max(1).describe('Computed risk score (0-1) for review routing'),
  factors: z.array(z.string()).describe('Risk factors that contributed to the score'),
  destination: z.enum(['coderabbit', 'self-hosted', 'both']).describe('Where the review was routed'),
  velocityTier: z.enum(['normal', 'elevated', 'high']).describe('Current review velocity tier'),
  semanticAugmented: z.boolean().describe('Whether semantic analysis augmented the routing'),
});

export const ReviewFindingData = z.object({
  pr: z.number().int().describe('Pull request where finding was detected'),
  source: z.enum(['coderabbit', 'self-hosted']).describe('Review tool that produced the finding'),
  severity: z.enum(['critical', 'major', 'minor', 'suggestion']).describe('Finding severity level'),
  filePath: z.string().describe('File path where the finding was detected'),
  lineRange: z.tuple([z.number().int(), z.number().int()]).optional().describe('Start and end line numbers of the finding'),
  message: z.string().describe('Description of the review finding'),
  rule: z.string().optional().describe('Lint or analysis rule that triggered the finding'),
});

export const ReviewEscalatedData = z.object({
  pr: z.number().int().describe('Pull request being escalated'),
  reason: z.string().describe('Why the review was escalated'),
  originalScore: z.number().min(0).max(1).describe('Risk score before escalation'),
  triggeringFinding: z.string().describe('The finding that triggered escalation'),
});

export const ReviewCompletedData = z.object({
  stage: z.enum(['spec-review', 'quality-review', 'security-review']).describe('Review stage that completed'),
  verdict: z.enum(['pass', 'fail', 'blocked']).describe('Review verdict: pass, fail, or blocked'),
  findingsCount: z.number().int().nonnegative().describe('Number of findings from the review'),
  summary: z.string().describe('Human-readable summary of review results'),
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
  teamSize: z.number().int().nonnegative().describe('Number of agents spawned in this team'),
  teammateNames: z.array(z.string()).describe('Names assigned to each teammate agent'),
  taskCount: z.number().int().nonnegative().describe('Number of tasks to distribute across the team'),
  dispatchMode: z.string().describe('Dispatch mechanism: subagent or agent-team'),
});

export const TeamTaskAssignedData = z.object({
  taskId: z.string().describe('Task assigned to this teammate'),
  teammateName: z.string().describe('Name of the teammate receiving the task'),
  worktreePath: z.string().describe('Absolute path to the teammate worktree'),
  modules: z.array(z.string()).describe('Module paths this task is scoped to'),
});

export const TeamTaskCompletedData = z.object({
  taskId: z.string().describe('Task that was completed'),
  teammateName: z.string().describe('Teammate who completed the task'),
  durationMs: z.number().nonnegative().describe('Wall-clock time in milliseconds'),
  filesChanged: z.array(z.string()).describe('Paths of files modified by this task'),
  testsPassed: z.boolean().describe('Whether all tests passed after implementation'),
  qualityGateResults: z.record(z.string(), z.unknown()).describe('Per-gate pass/fail results from quality checks'),
});

export const TeamTaskFailedData = z.object({
  taskId: z.string().describe('Task that failed'),
  teammateName: z.string().describe('Teammate whose task failed'),
  failureReason: z.string().describe('Root cause or error message for the failure'),
  gateResults: z.record(z.string(), z.unknown()).describe('Gate results at time of failure'),
});

export const TeamDisbandedData = z.object({
  totalDurationMs: z.number().nonnegative().describe('Total wall-clock time for the team'),
  tasksCompleted: z.number().int().nonnegative().describe('Number of tasks successfully completed'),
  tasksFailed: z.number().int().nonnegative().describe('Number of tasks that failed'),
});

export const TeamTaskPlannedData = z.object({
  taskId: z.string().describe('Planned task identifier'),
  title: z.string().describe('Human-readable task title'),
  modules: z.array(z.string()).describe('Module paths this task will modify'),
  blockedBy: z.array(z.string()).describe('Task IDs that must complete before this task'),
});

export const TeamTeammateDispatchedData = z.object({
  teammateName: z.string().describe('Name of the dispatched teammate'),
  worktreePath: z.string().describe('Absolute path to the teammate worktree'),
  assignedTaskIds: z.array(z.string()).describe('Task IDs assigned to this teammate'),
  model: z.string().describe('LLM model used for this teammate'),
});

// ─── Quality Regression Event Data ──────────────────────────────────────────

export const QualityRegressionData = z.object({
  skill: z.string().describe('Skill where regression was detected'),
  gate: z.string().describe('Gate that started failing'),
  consecutiveFailures: z.number().int().nonnegative().describe('Number of consecutive gate failures'),
  firstFailureCommit: z.string().describe('Git commit SHA of the first failure'),
  lastFailureCommit: z.string().describe('Git commit SHA of the most recent failure'),
  detectedAt: z.string().datetime().describe('ISO timestamp when the regression was detected'),
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

export const ShepherdStartedData = z.object({
  featureId: z.string(),
});

export const ShepherdIterationData = z.object({
  iteration: z.number().int().nonnegative().describe('Iteration number in the shepherd loop'),
  prsAssessed: z.number().int().nonnegative().describe('Number of PRs assessed in this iteration'),
  fixesApplied: z.number().int().nonnegative().describe('Number of fixes applied during this iteration'),
  status: z.string().describe('Current shepherd status summary'),
});

export const ShepherdApprovalRequestedData = z.object({
  prUrl: z.string(),
});

export const ShepherdCompletedData = z.object({
  prUrl: z.string(),
  outcome: z.string(),
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
  tp: z.number().int().nonnegative(),
  fp: z.number().int().nonnegative(),
  tn: z.number().int().nonnegative(),
  fn: z.number().int().nonnegative(),
  goldStandardVersion: z.string(),
  rubricVersion: z.string(),
});

// ─── Diagnostic Event Data ──────────────────────────────────────────────────

export const DiagnosticExecutedDataSchema = z.object({
  summary: DoctorOutputSchema.innerType().shape.summary,
  checkCount: z.number().int().nonnegative(),
  failedCheckNames: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
});

// ─── Init Event Data ────────────────────────────────────────────────────

export const InitExecutedDataSchema = z.object({
  runtimes: z.array(z.object({
    runtime: z.string().min(1),
    path: z.string().optional(),
    status: z.string(),
    componentsWritten: z.array(z.string()),
    warnings: z.array(z.string()).optional(),
    error: z.string().optional(),
  })),
  vcs: z.object({
    provider: z.string(),
    remoteUrl: z.string(),
    cliAvailable: z.boolean(),
    cliVersion: z.string().optional(),
  }).nullable(),
  durationMs: z.number().int().nonnegative(),
});

// ─── Remediation Event Data ─────────────────────────────────────────────────

export const RemediationAttemptedDataSchema = z.object({
  taskId: z.string().min(1).describe('Task being remediated'),
  skill: z.string().min(1).describe('Skill context for the remediation'),
  gateName: z.string().min(1).describe('Gate that failed and triggered remediation'),
  attemptNumber: z.number().int().min(1).describe('Sequential attempt number (1-based)'),
  strategy: z.string().describe('Remediation strategy being applied'),
});

export const RemediationSucceededDataSchema = z.object({
  taskId: z.string().min(1).describe('Task that was successfully remediated'),
  skill: z.string().min(1).describe('Skill context for the remediation'),
  gateName: z.string().min(1).describe('Gate that now passes after remediation'),
  totalAttempts: z.number().int().min(1).describe('Total attempts before success'),
  finalStrategy: z.string().describe('Strategy that ultimately succeeded'),
});

export const SessionTaggedData = z.object({
  tag: z.string().min(1).max(100).describe('Tag label for the session (e.g., feature name)'),
  sessionId: z.string().min(1).describe('Session identifier'),
  description: z.string().max(500).optional().describe('Optional description of what the session covers'),
  branch: z.string().optional().describe('Git branch associated with this session'),
});

// ─── Readiness Event Data ───────────────────────────────────────────────────

export const WorktreeCreatedData = z.object({
  taskId: z.string().describe('Task this worktree was created for'),
  path: z.string().describe('Absolute filesystem path to the worktree'),
  branch: z.string().describe('Git branch checked out in the worktree'),
});

export const WorktreeBaselineData = z.object({
  taskId: z.string().describe('Task whose worktree was baselined'),
  path: z.string().describe('Absolute filesystem path to the worktree'),
  status: z.enum(['passed', 'failed', 'skipped']).describe('Baseline test result: passed, failed, or skipped'),
  output: z.string().optional().describe('Test runner output from the baseline run'),
});

export const TestResultData = z.object({
  passed: z.boolean().describe('Whether the overall test suite passed'),
  passCount: z.number().int().nonnegative().describe('Number of passing tests'),
  failCount: z.number().int().nonnegative().describe('Number of failing tests'),
  coveragePercent: z.number().min(0).max(100).optional().describe('Code coverage percentage (0-100)'),
  output: z.string().optional().describe('Raw test runner output'),
});

export const TypecheckResultData = z.object({
  passed: z.boolean().describe('Whether TypeScript compilation succeeded'),
  errorCount: z.number().int().nonnegative().describe('Number of type errors found'),
  errors: z.array(z.string()).optional().describe('Individual type error messages'),
});

export const StackSubmittedData = z.object({
  branches: z.array(z.string()).describe('Branch names in the submitted stack'),
  prNumbers: z.array(z.number().int()).describe('PR numbers created for the stack'),
});

export const CiStatusData = z.object({
  pr: z.number().int().describe('Pull request number'),
  status: z.enum(['passing', 'failing', 'pending']).describe('Current CI pipeline status'),
  jobUrl: z.string().optional().describe('URL to the CI job for inspection'),
});

export const CommentPostedData = z.object({
  pr: z.number().int().describe('Pull request where comment was posted'),
  commentId: z.string().describe('GitHub comment identifier'),
  body: z.string().describe('Comment body text'),
  inReplyTo: z.string().optional().describe('Parent comment ID if this is a reply'),
});

export const CommentResolvedData = z.object({
  pr: z.number().int().describe('Pull request where thread was resolved'),
  threadId: z.string().describe('GitHub review thread identifier'),
  resolvedBy: z.enum(['author', 'outdated', 'manual']).describe('How the thread was resolved'),
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
  'workflow.pruned': WorkflowPrunedData,
  'workflow.checkpoint_requested': WorkflowCheckpointRequestedData,
  'workflow.checkpoint_written': WorkflowCheckpointWrittenData,
  'workflow.checkpoint_superseded': WorkflowCheckpointSupersededData,
  'workflow.rehydrated': WorkflowRehydratedData,
  'workflow.snapshot_taken': WorkflowSnapshotTakenData,
  'synthesize.requested': SynthesizeRequestedData,

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
  'team.task.planned': TeamTaskPlannedData,
  'team.teammate.dispatched': TeamTeammateDispatchedData,

  // Quality
  'quality.regression': QualityRegressionData,
  'quality.hint.generated': QualityHintGeneratedData,
  'quality.refinement.suggested': RefinementSuggestedDataSchema,

  // Review
  'review.completed': ReviewCompletedData,
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

  // Diagnostic (exarchos doctor)
  'diagnostic.executed': DiagnosticExecutedDataSchema,

  // Init (exarchos init)
  'init.executed': InitExecutedDataSchema,

  // Review provider adapter unknown-tier (#1159)
  'provider.unknown-tier': z.object({
    reviewer: z.string().min(1),
    rawTier: z.string().optional(),
    commentId: z.number().int(),
  }),

  // Review provider adapter parse-error (#1161) — batch continues; this
  // event records the single-comment failure for observability.
  'provider.parse-error': z.object({
    reviewer: z.string().min(1),
    commentId: z.number().int(),
    errorMessage: z.string().min(1),
  }),

  // classify_review_items per-invocation observability (#1159)
  'dispatch.classified': z.object({
    groupCount: z.number().int().nonnegative(),
    directCount: z.number().int().nonnegative(),
    delegateCount: z.number().int().nonnegative(),
    severityDistribution: z.object({
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
    }),
  }),
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
export type WorkflowPruned = z.infer<typeof WorkflowPrunedData>;
export type WorkflowCheckpointRequested = z.infer<typeof WorkflowCheckpointRequestedData>;
export type WorkflowCheckpointWritten = z.infer<typeof WorkflowCheckpointWrittenData>;
export type WorkflowCheckpointSuperseded = z.infer<typeof WorkflowCheckpointSupersededData>;
export type WorkflowRehydrated = z.infer<typeof WorkflowRehydratedData>;
export type WorkflowSnapshotTaken = z.infer<typeof WorkflowSnapshotTakenData>;
export type SynthesizeRequested = z.infer<typeof SynthesizeRequestedData>;
export type ToolInvoked = z.infer<typeof ToolInvokedData>;
export type ToolCompleted = z.infer<typeof ToolCompletedData>;
export type ToolErrored = z.infer<typeof ToolErroredData>;
export type BenchmarkCompleted = z.infer<typeof BenchmarkCompletedData>;
export type TeamSpawned = z.infer<typeof TeamSpawnedData>;
export type TeamTaskAssigned = z.infer<typeof TeamTaskAssignedData>;
export type TeamTaskCompleted = z.infer<typeof TeamTaskCompletedData>;
export type TeamTaskFailed = z.infer<typeof TeamTaskFailedData>;
export type TeamDisbanded = z.infer<typeof TeamDisbandedData>;
export type TeamTaskPlanned = z.infer<typeof TeamTaskPlannedData>;
export type TeamTeammateDispatched = z.infer<typeof TeamTeammateDispatchedData>;
export type QualityRegression = z.infer<typeof QualityRegressionData>;
export type ReviewCompleted = z.infer<typeof ReviewCompletedData>;
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
export type DiagnosticExecuted = z.infer<typeof DiagnosticExecutedDataSchema>;
export type InitExecuted = z.infer<typeof InitExecutedDataSchema>;

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
  'team.task.planned': TeamTaskPlanned;
  'team.teammate.dispatched': TeamTeammateDispatched;
  'quality.regression': QualityRegression;
  'workflow.cas-failed': WorkflowCasFailed;
  'workflow.pruned': WorkflowPruned;
  'workflow.checkpoint_requested': WorkflowCheckpointRequested;
  'workflow.checkpoint_written': WorkflowCheckpointWritten;
  'workflow.checkpoint_superseded': WorkflowCheckpointSuperseded;
  'workflow.rehydrated': WorkflowRehydrated;
  'workflow.snapshot_taken': WorkflowSnapshotTaken;
  'synthesize.requested': SynthesizeRequested;
  'review.completed': ReviewCompleted;
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
  'diagnostic.executed': DiagnosticExecuted;
  'init.executed': InitExecuted;
};

// ─── Event Catalog Serialization ────────────────────────────────────────────

export interface EventCatalog {
  types: Record<string, {
    source: string;
    isBuiltIn: boolean;
    hasSchema: boolean;
  }>;
  bySource: {
    auto: string[];
    model: string[];
    hook: string[];
    planned: string[];
  };
  totalCount: number;
}

/**
 * Returns a comprehensive catalog of all registered event types (built-in + custom)
 * with their emission source, built-in status, and whether they have a data schema.
 *
 * Pure function with no side effects.
 */
export function serializeEventCatalog(): EventCatalog {
  const allTypes = getValidEventTypes();
  const registry = EVENT_EMISSION_REGISTRY as Record<string, EventEmissionSource>;
  const schemas = EVENT_DATA_SCHEMAS as Partial<Record<string, z.ZodSchema>>;

  const types: EventCatalog['types'] = {};
  const bySource: EventCatalog['bySource'] = {
    auto: [],
    model: [],
    hook: [],
    planned: [],
  };

  for (const eventType of allTypes) {
    const source = registry[eventType] ?? 'model';
    const isBuiltIn = isBuiltInEventType(eventType);
    const hasSchema = eventType in schemas && schemas[eventType] !== undefined;

    types[eventType] = { source, isBuiltIn, hasSchema };
    bySource[source as keyof EventCatalog['bySource']].push(eventType);
  }

  return {
    types,
    bySource,
    totalCount: allTypes.length,
  };
}

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
