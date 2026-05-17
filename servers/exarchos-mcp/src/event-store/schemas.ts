import * as path from 'node:path';
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
  // PR3/T7 (#1364) — emitted alongside `tool.completed` when the handler
  // returns the structured failure envelope `{success: false, error: {…}}`.
  // `tool.errored` continues to count transport/protocol failures (JS throws)
  // only; this event splits out action-level outcomes (MERGE_ROLLED_BACK,
  // PREFLIGHT_FAILED, RESERVED_FIELD, etc.) so `view telemetry` can report
  // them instead of silently rolling them up as completions.
  'tool.action_errored',
  // #1262 — per-turn output-token sample emitted by the telemetry middleware
  // when an agent turn completes. The `output_tokens_high` quality hint
  // (catalog: `telemetry/quality-hints.ts`) fires off this stream when a
  // turn's `outputTokens` crosses the configured threshold.
  'turn.completed',
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
  'workflow.projection_degraded',
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
  'session.machinery_consumed',
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
  'merge.preflight',
  // Wave 4 audit §F1.2 two-event split — `merge.requested` is the durable
  // INTENT recorded BEFORE the non-idempotent GitHub merge call fires. The
  // `merge-orchestrator@v1` projection (Wave 2B / #1304) folds it as the
  // transition into the new `requested` phase. Registered in Wave 2B.2 (this
  // commit) ahead of Wave 4's `decide` migration so the reducer can validly
  // fold it.
  'merge.requested',
  'merge.executed',
  'merge.rollback',
  'command.resolved',
  // Durable event-store substrate (#1259) — deprecation telemetry + migration
  // pipeline. T02 / T03 / T04 of the substrate plan.
  'hsm.deprecated_action_invoked',
  'spec.legacy_capabilities_array',
  'phase.contract_missing',
  'migration.legacy_jsonl_imported',
  'migration.completed',
  'migration.failed',
  // R-1 Marten primitive (#1313): emitted once per V3 → V4 stream that
  // could not have its workflow_type recovered from a state file. Lets
  // operators locate '__legacy' rows that need manual classification.
  'migration.workflow_type_unknown',
  // #1437 — emitted once per chunk during the V5 -> V6 correlation-column
  // backfill in `migrateV5ToV6`. Lands on the internal `__migration__`
  // stream with `{rowsBackfilled, totalRowsRemaining}` so operators can
  // observe progress of a long-running migration on multi-thousand-row
  // production DBs (the EventSourcedTaskStore generates dense
  // `task.polled` traffic that pushes single-shot backfills past the
  // sub-second window).
  'migration.correlation_backfill_progress',
  // Wave B (#1342) two-event split for 5 non-idempotent VCS handlers.
  // Each handler emits *.requested BEFORE invoking the side effect (durable
  // intent, INV-1 LOW audit requirement) then *.executed AFTER it succeeds.
  // B1: create-pr
  'pr.create.requested',
  'pr.create.executed',
  // B2: comment-on-pr
  'pr.comment.requested',
  'pr.comment.executed',
  // B3: create-issue
  'issue.create.requested',
  'issue.create.executed',
  // B4: delete-branch
  'branch.delete.requested',
  'branch.delete.executed',
  // B5: remove-worktree
  'worktree.remove.requested',
  'worktree.remove.executed',
  // #1290 — emitted by `resolveWorkspace` (servers/exarchos-mcp/src/workspace/
  // discovery.ts) when the dispatch boundary resolves a missing `featureId`
  // from MCP roots or via the cwd-walk fallback. Records the source so audit
  // queries can distinguish handshake-driven resolutions from cwd inference.
  // Not emitted on multi-match (no single featureId to attribute) or zero-match.
  'workspace.resolved',
  // #1274 — dispatch elicitation hand-off (form mode). Emitted on a
  // per-operation pseudo-stream (`elicitation/<operationId>`) so audit
  // queries can correlate the request/response round-trip without
  // contaminating the per-feature event log. `requested` lands BEFORE the
  // `elicitation/create` MCP round-trip fires; `fulfilled` lands AFTER the
  // client returns a value.
  'elicitation.requested',
  'elicitation.fulfilled',
  // Sentry MEDIUM #1424: pre-fix the dispatcher emitted `elicitation.fulfilled`
  // even when the client returned `value === undefined` (decline / cancel),
  // producing a misleading audit trail where round-trip failures looked like
  // successes. The declined branch now emits this distinct event so
  // downstream consumers can tell apart "the client supplied the value" from
  // "the client refused / cancelled the round-trip."
  'elicitation.declined',
  // #1272 — EventSourcedTaskStore lifecycle events. Distinct from the
  // workflow-orchestration `task.assigned`/`task.claimed`/`task.progressed`/
  // `task.completed`/`task.failed` family above, these four describe the
  // SDK-protocol task lifecycle (see
  // `@modelcontextprotocol/sdk/experimental/tasks/interfaces.ts:TaskStore`).
  // The EventSourcedTaskStore in `src/task-store/event-sourced-task-store.ts`
  // emits these to durably back the in-memory projection it serves to the
  // SDK; reads project state from the event stream alone (INV-1 event-sourcing
  // integrity — see the REPLAY acceptance test in
  // `event-sourced-task-store.test.ts`).
  'task.created',
  'task.polled',
  'task.result',
  'task.cancelled',
  // #1261 — dispatch-guard preflight observability. `dispatch.preflight`
  // records the per-guard pass/fail outcome (ancestry, worktree,
  // protectedBranch, mainWorktree) plus an aggregate `passed` flag and
  // total durationMs. `stash.detected` fires when the worktree under
  // dispatch has a non-empty `git stash list` — the cross-worktree
  // shared-stash hazard documented in project memory. Both inherit
  // `operationId` from the active `DispatchContext` (#1291 / B1).
  'dispatch.preflight',
  'stash.detected',
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
  'workflow.projection_degraded': 'auto',
  'synthesize.requested': 'auto',
  'task.claimed': 'auto',
  'task.completed': 'auto',
  'task.failed': 'auto',
  'gate.executed': 'auto',
  'state.patched': 'auto',
  'tool.invoked': 'auto',
  'tool.completed': 'auto',
  'tool.errored': 'auto',
  // PR3/T7 (#1364) — see EventTypes registration above.
  'tool.action_errored': 'auto',
  // #1262 — auto-emitted by telemetry middleware on agent-turn boundary.
  'turn.completed': 'auto',
  'quality.hint.generated': 'auto',
  'quality.refinement.suggested': 'auto',
  'stack.position-filled': 'auto',
  'stack.restacked': 'auto',
  'stack.enqueued': 'auto',
  'eval.judge.calibrated': 'auto',

  // auto — emitted by the dispatch-core interceptor on the first non-rehydrate
  // handler invocation after a workflow.rehydrated event lands (T-12). Marks
  // "the rehydrated agent has consumed the phase machinery and started doing
  // real work" — useful for v2.12 lifecycle alignment (ps, wait --condition).
  // Registration only; emission wired by T-12.
  'session.machinery_consumed': 'auto',

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

  // auto — emitted by the merge_orchestrate composite action (DR-MO-1).
  // Preflight failures DO NOT route through merge.rollback — they surface
  // as `phase: 'aborted'` with `abortReason: 'preflight-failed'`.
  'merge.preflight': 'auto',
  // model — emitted by Wave 4's `decide` closure as the durable intent before
  // the non-idempotent GitHub merge call (audit §F1.2 two-event split). Lives
  // in the model-emitted family because the closure that produces it is part
  // of the workflow-author's command logic, not server-deterministic plumbing.
  'merge.requested': 'model',
  'merge.executed': 'auto',
  'merge.rollback': 'auto',

  // auto — emitted by the test/typecheck/install runtime resolver (#1199 T15).
  // Audit-only: records where each command resolution came from so downstream
  // graceful-skip semantics can distinguish a configured null from an
  // unresolved command for which we should bail with remediation guidance.
  'command.resolved': 'auto',

  // auto — emitted by the HSM API single-path migration (#1259 T02 / DR-4).
  // Each invocation of a deprecated action (e.g., `workflow.set({phase})`)
  // emits this event so the migration window can be measured before the
  // legacy path is removed.
  'hsm.deprecated_action_invoked': 'auto',

  // auto — emitted during spec validation when a spec uses the legacy
  // `capabilities[]` array shape (#1259 T03 / DR-6). Drives the
  // capability-posture migration telemetry.
  'spec.legacy_capabilities_array': 'auto',

  // auto — emitted once at lifecycle start per phase that lacks a typed
  // contract (#1259 T03 / DR-7). Drives the phase-contract migration
  // telemetry.
  'phase.contract_missing': 'auto',

  // auto — emitted by the JSONL→SQLite migration importer (#1259 T04 / DR-9).
  // Per-file completion event during the import; the `migration.completed`
  // aggregate event closes the run; `migration.failed` records a failure
  // with partial-progress counters for resume/retry.
  'migration.legacy_jsonl_imported': 'auto',
  'migration.completed': 'auto',
  'migration.failed': 'auto',
  'migration.workflow_type_unknown': 'auto',
  'migration.correlation_backfill_progress': 'auto',

  // Wave B (#1342) two-event split — VCS side-effect handlers.
  // *.requested is emitted by the handler BEFORE invoking the side effect
  // (auto, deterministic plumbing). *.executed is emitted AFTER success.
  'pr.create.requested': 'auto',
  'pr.create.executed': 'auto',
  'pr.comment.requested': 'auto',
  'pr.comment.executed': 'auto',
  'issue.create.requested': 'auto',
  'issue.create.executed': 'auto',
  'branch.delete.requested': 'auto',
  'branch.delete.executed': 'auto',
  'worktree.remove.requested': 'auto',
  'worktree.remove.executed': 'auto',

  // #1290 — auto-emitted by the workspace discovery resolver on the
  // dispatch boundary. See EventTypes registration above.
  'workspace.resolved': 'auto',
  // #1274 — dispatch elicitation hand-off. Auto-emitted by the dispatch
  // boundary on the per-operation pseudo-stream.
  'elicitation.requested': 'auto',
  'elicitation.fulfilled': 'auto',
  'elicitation.declined': 'auto',

  // #1272 — EventSourcedTaskStore lifecycle. Auto-emitted by the store
  // on each protocol-level operation (createTask/getTask/getTaskResult/
  // cancelTask). See EventTypes registration above.
  'task.created': 'auto',
  'task.polled': 'auto',
  'task.result': 'auto',
  'task.cancelled': 'auto',
  // #1261 — dispatch-guard preflight observability. Auto-emitted by
  // `orchestrate/dispatch-guard.ts` once per dispatch (preflight
  // outcome) and on demand when shared-stash collision is observed
  // in the worktree under dispatch.
  'dispatch.preflight': 'auto',
  'stash.detected': 'auto',
};

// ─── Base Event Schema ──────────────────────────────────────────────────────

export const WorkflowEventBase = z.object({
  streamId: z.string().min(1).max(100),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
  type: z.string().min(1).refine(
    (t) => getValidEventTypes().includes(t),
    {
      error: (ctx) =>
        `Unknown event type: "${String(ctx.input)}". Valid types: built-in EventTypes + registered custom types`,
    },
  ),
  correlationId: z.string().max(200).optional(),
  causationId: z.string().max(200).optional(),
  // #1291 — dispatch-boundary three-field correlation. `operationId` is
  // minted per `dispatch()` call (see `dispatch/dispatch-context.ts`) and
  // stamped onto every event emitted transitively inside the dispatch via
  // AsyncLocalStorage in `EventStore.append*`. Sibling to the existing
  // `correlationId` / `causationId` fields rather than nested under
  // `_meta` to preserve the prior shape's projection contracts (rehydrate,
  // telemetry, audit views) which read these as top-level event keys.
  //
  // Optional because a dispatch wrapper is not always active — direct
  // tests and migration tooling append events outside the dispatch
  // boundary and must continue to work un-stamped (backward-compatible
  // widening, INV-5b).
  operationId: z.string().max(200).optional(),
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
  // Optional. When present, downstream tools (e.g., setup_worktree) may
  // honor this as the planned branch for the task — see the resolution
  // priority documented on SetupWorktreeArgs (`args.branch >
  // workflow.tasks[id].branch > default`). Aligns the event hint with the
  // workflow-state shape so orchestrators can pre-emit the same branch
  // they later set on the workflow.
  branch: z.string().optional().describe('Git branch for this task (planned). Optional.'),
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

/**
 * Handoff payload (#1240) — optional sub-object on `workflow.checkpoint`.
 * Carries human-readable phase-exit notes alongside the structured counter
 * + phase + featureId. Per-field byte caps (DIM-7) prevent unbounded growth;
 * the rehydration projection (`latestHandoff` / `recentHandoffs`) derives
 * its content from this payload.
 *
 * CodeRabbit major on PR #1297: strictObject rejects unknown keys so a
 * malformed event payload (typo, future-version key, structured-clone
 * artifact) fails validation at the persisted-event boundary rather
 * than being silently truncated and folded into the rehydration
 * projection's `latestHandoff`. Mirrors the dispatch-side strictness
 * in `workflow/schemas.ts:CheckpointHandoffSchema` exactly.
 */
export const HandoffEntryData = z.strictObject({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
});

export const WorkflowCheckpointData = z.object({
  counter: z.number().int(),
  phase: z.string(),
  featureId: z.string(),
  // Additive (#1240). Historical workflow.checkpoint events without handoff
  // parse cleanly under .optional(). The event payload itself stays
  // unversioned — only the rehydration projection envelope is versioned.
  handoff: HandoffEntryData.optional(),
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
  // T-10: optional playbook-presence flags (v2.12 lifecycle alignment).
  // Emission wired by T-21; absent in legacy events (additive, no version bump).
  phaseHasPlaybook: z.boolean().optional(),
  phasePlaybookComposed: z.boolean().optional(),
});

export const WorkflowSnapshotTakenData = z.object({
  projectionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

/**
 * Closed enum of degradation causes (DR-18, T054/T055/T056). Extending this
 * set is a coordinated change: add the literal here, add the matching
 * `DegradationCause` union member in `workflow/rehydrate.ts`, and surface
 * the new code in the audit/observability paths so dashboards don't fragment.
 */
export const WorkflowProjectionDegradedCause = z.enum([
  'reducer-throw',
  'snapshot-corrupt',
  'event-stream-unavailable',
]);
export type WorkflowProjectionDegradedCause = z.infer<
  typeof WorkflowProjectionDegradedCause
>;

/**
 * Closed enum of fallback-source codes (DR-18). Mirrors the
 * `DegradationFallbackSource` union in `workflow/rehydrate.ts`. New entries
 * MUST be added in both places — the schema enforces the wire contract,
 * the union enforces the call-site contract.
 */
export const WorkflowProjectionDegradedFallbackSource = z.enum([
  'state-store-only',
  'full-replay',
]);
export type WorkflowProjectionDegradedFallbackSource = z.infer<
  typeof WorkflowProjectionDegradedFallbackSource
>;

export const WorkflowProjectionDegradedData = z.object({
  projectionId: z.string().min(1),
  cause: WorkflowProjectionDegradedCause,
  fallbackSource: WorkflowProjectionDegradedFallbackSource,
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

// PR3/T7 (#1364) — structured action-level failure paired with `tool.completed`.
// Mirrors `tool.completed`'s perf fields so the projection can fold both events
// off the same per-tool entry without re-deriving durationMs/responseBytes.
// `errorCode` is the discriminator carried up from the handler's error envelope
// (e.g., MERGE_ROLLED_BACK, PREFLIGHT_FAILED, RESERVED_FIELD); falls back to
// 'UNKNOWN' when the handler emits an envelope without a code.
export const ToolActionErroredData = z.object({
  tool: z.string(),
  durationMs: z.number(),
  errorCode: z.string(),
  responseBytes: z.number(),
  tokenEstimate: z.number(),
});

// #1262 — per-turn output-token sample (CodeRabbit F2).
//
// Emitted by the telemetry middleware when an agent turn completes. The
// telemetry projection (`telemetry/telemetry-projection.ts`) folds
// `turnId` + `outputTokens` into `view.turns` for the `output_tokens_high`
// quality hint. Anything else on the payload is ignored by the projection
// today, so the schema is `.passthrough()` to keep the door open for
// future per-turn samples (cache-read tokens, latency, etc.) without a
// breaking schema bump.
export const TurnCompletedDataSchema = z.object({
  turnId: z.string().min(1).describe('Stable identifier for the turn (typically a UUID).'),
  outputTokens: z.number().nonnegative().describe('Total output tokens consumed by the turn.'),
}).passthrough();
export type TurnCompletedData = z.infer<typeof TurnCompletedDataSchema>;

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
  summary: DoctorOutputSchema.shape.summary,
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

/**
 * session.machinery_consumed — emitted by the dispatch-core interceptor on the
 * first non-rehydrate handler invocation after a `workflow.rehydrated` event
 * lands (T-11 registration; T-12 emission). Marks "the rehydrated agent has
 * consumed the phase machinery and started doing real work" — useful for v2.12
 * lifecycle alignment (`ps`, `wait --condition=machinery_consumed`).
 *
 * `rehydrateSequence` — the **event-store sequence** of the preceding
 * `workflow.rehydrated` event (i.e. `event.sequence`, NOT the embedded
 * `data.projectionSequence`). Event-store sequence is globally monotonic
 * over the stream, so two rehydrates that fold the same number of events
 * still get distinct correlators — required for the per-rehydrate-cycle
 * idempotency cache in `core/interceptors/session-machinery.ts`.
 * `firstActionVerb` — the tool/handler name of the first real action, e.g.
 * `"task_complete"`, `"exarchos_orchestrate"`. Non-empty string required so
 * observability queries can group by action type.
 * `firstActionAt` — ISO 8601 wall-clock timestamp of the first action, anchors
 * the machinery consumption to a point in time for `wait --condition` queries.
 */
export const SessionMachineryConsumedDataSchema = z.object({
  rehydrateSequence: z.number().int().nonnegative(),
  firstActionVerb: z.string().min(1),
  firstActionAt: z.string().datetime(),
}).strict();

export type SessionMachineryConsumedData = z.infer<typeof SessionMachineryConsumedDataSchema>;

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

// ─── Merge Orchestrator Event Data (DR-MO-2) ───────────────────────────────

// DR-MO-1 AC#1 — preflight sub-result schemas, mirrored from the pure-helper
// types (`AncestryResult`, `WorktreeAssertionResult`,
// `CurrentBranchProtectionResult`, `DriftResult`). Re-defined here as Zod
// shapes so the event payload is the canonical source of truth for
// event-sourced timeline reconstruction — readers do not need to read the
// workflow state file to learn *why* preflight failed.

const MergePreflightAncestryData = z.object({
  passed: z.boolean(),
  blocked: z.boolean().optional(),
  checks: z.array(z.string()).optional(),
  reason: z.enum(['ancestry', 'git-error']).optional(),
  missing: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const MergePreflightCurrentBranchProtectionData = z.object({
  blocked: z.boolean(),
  reason: z.literal('current-branch-protected').optional(),
  currentBranch: z.string().optional(),
  hint: z.string().optional(),
});

const MergePreflightWorktreeData = z.object({
  isMain: z.boolean(),
  actual: z.string(),
  expected: z.string(),
});

const MergePreflightDriftData = z.object({
  clean: z.boolean(),
  uncommittedFiles: z.array(z.string()),
  indexStale: z.boolean(),
  detachedHead: z.boolean(),
});

// #1362 phase 1 — Windows ancestry-mismatch instrumentation. Optional debug
// payload attached to `merge.preflight` when `EXARCHOS_PREFLIGHT_DEBUG=1`
// AND ancestry failed. Failure-only gating is deliberate (DIM-8 / event-store
// growth); verbose sub-modes belong on a separate `=2` channel.
//
// Field shape mirrors the `PreflightDebug` TypeScript type in
// `orchestrate/pure/merge-preflight.ts`. Phase-1 captures the minimal data
// needed to disambiguate Windows ref-resolution and merge-base failures
// from filesystem-layer worktree mis-detection; phase-2 may extend.
const MergePreflightDebugRefData = z.object({
  sha: z.string(),
  packed: z.boolean(),
});

export const MergePreflightDebugData = z.object({
  gitVersion: z.string(),
  repoRoot: z.string(),
  worktreeList: z.string(),
  refsHeadsSource: MergePreflightDebugRefData,
  refsHeadsTarget: MergePreflightDebugRefData,
  mergeBaseCommand: z.array(z.string()),
  mergeBaseExitCode: z.number().int(),
  mergeBaseStdout: z.string(),
  mergeBaseStderr: z.string(),
});

/**
 * merge.preflight — captures the outcome of the preflight gate run before a
 * candidate merge. Preflight failures DO NOT route through merge.rollback;
 * they surface as `phase: 'aborted'` with `abortReason: 'preflight-failed'`
 * (handled in T11/T12). The event is recorded for observability either way.
 *
 * The structured sub-results (`ancestry`, `currentBranchProtection`,
 * `worktree`, `drift`) are required when any guard runs (DR-MO-1 AC#1) so
 * downstream consumers can reconstruct the failure mode from the event log
 * alone. They are `.optional()` only to keep older events (emitted before
 * the schema widening) parseable.
 *
 * `failureReasons` carries the operator-facing diagnostic that
 * `describePreflightFailure` produces when `passed === false`.
 */
export const MergePreflightData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  passed: z.boolean(),
  ancestry: MergePreflightAncestryData.optional(),
  currentBranchProtection: MergePreflightCurrentBranchProtectionData.optional(),
  worktree: MergePreflightWorktreeData.optional(),
  drift: MergePreflightDriftData.optional(),
  failureReasons: z.array(z.string()).optional(),
  // #1362 phase 1 — see MergePreflightDebugData. Optional so legacy events
  // (and the common ancestry-passing case) remain parseable unchanged.
  debug: MergePreflightDebugData.optional(),
});

/**
 * merge.requested — Wave 4 / audit §F1.2 two-event split: the durable INTENT
 * recorded BEFORE the non-idempotent GitHub merge call. The `decide` closure
 * that produces this event is pure (safe to retry under `withStateRetry`);
 * the side effect (PR merge API) fires OUTSIDE the retry boundary; a second
 * `decide` then commits `merge.executed`.
 *
 * Folded by the `merge-orchestrator@v1` projection (#1304) as the transition
 * into the new `requested` phase between `preflight` and `executed`.
 *
 * `prNumber` is optional because preview.2 may emit this event for streams
 * that have not yet acquired a PR (e.g. local-only merge orchestration).
 * `taskId` / `featureId` are optional for the same reason — the design (lines
 * 538-543) provides them when the calling context knows them.
 */
export const MergeRequestedData = z.object({
  sourceBranch: z
    .string()
    .min(1)
    .describe('Feature/work branch being merged in'),
  targetBranch: z
    .string()
    .min(1)
    .describe('Target branch the merge lands on'),
  strategy: z
    .enum(['squash', 'rebase', 'merge'])
    .optional()
    .describe('Operator-selected merge strategy'),
  prNumber: z
    .number()
    .int()
    .optional()
    .describe('Pull-request number; absent when no PR has been opened yet'),
  taskId: z
    .string()
    .optional()
    .describe(
      'Originating task id (matches the worktree task.completed.taskId)',
    ),
  featureId: z
    .string()
    .optional()
    .describe('Feature stream id; useful for cross-stream observability'),
});

/**
 * merge.executed — records that a merge has been performed. `mergeSha` is
 * the resulting commit on the target branch; `rollbackSha` is the parent
 * commit captured prior to merge so a downstream rollback handler can
 * `git reset --hard <rollbackSha>` deterministically.
 */
export const MergeExecutedData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  /** Operator-selected merge strategy. Captured for event-log fidelity so
   * observability and replay don't have to re-derive it from state. */
  strategy: z.enum(['squash', 'rebase', 'merge']).optional(),
  mergeSha: z.string().min(1),
  rollbackSha: z.string().min(1),
});

/**
 * merge.rollback — emitted when a merge is reverted. `reason` is a closed
 * enum so observability dashboards don't fragment across free-form text.
 * Preflight failures are NOT a rollback cause — they short-circuit before
 * any merge occurs. `rollbackError` carries the reset-failure detail when
 * `git reset --hard <rollbackSha>` itself failed: presence signals the
 * worktree may be in an indeterminate state, so consumers can page operators.
 */
export const MergeRollbackData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  rollbackSha: z.string().min(1),
  reason: z.enum(['merge-failed', 'verification-failed', 'timeout']),
  rollbackError: z.string().min(1).optional(),
});

// ─── Wave B Two-Event Split Schemas (#1342) ──────────────────────────────────
//
// Each VCS side-effect handler emits *.requested BEFORE the side effect fires
// (durable intent, INV-1 LOW) then *.executed AFTER the side effect succeeds.
// On retry the *.requested event is already persisted; the handler's idempotent
// check (B*.3, wired by the per-handler agents B1–B5) short-circuits re-invocation
// using the prior result.

/**
 * pr.create.requested — B1.1: durable intent recorded BEFORE `gh pr create`
 * fires. Carries the full PR intent so a recovery handler can reconstruct the
 * call from the persisted event alone (INV-1 LOW audit requirement).
 */
export const PrCreateRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — stable across retries'),
  title: z.string().min(1).describe('PR title'),
  body: z.string().describe('PR body markdown'),
  base: z.string().min(1).describe('Target base branch'),
  head: z.string().min(1).describe('Source head branch'),
  draft: z.boolean().optional().describe('Open as draft PR when true'),
  labels: z.array(z.string()).optional().describe('Label names to apply'),
});

/**
 * pr.create.executed — B1.1: records that `gh pr create` succeeded. Keyed by
 * `operationId` so the pair {requested, executed} is correlatable in the stream.
 */
export const PrCreateExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the pr.create.requested event'),
  prNumber: z.number().int().positive().describe('GitHub PR number'),
  url: z.string().url().describe('HTML URL of the created PR'),
});

/**
 * pr.comment.requested — B2.1: durable intent recorded BEFORE `gh pr comment`
 * fires. The body field is the raw comment text; the handler embeds the
 * `<!-- exarchos-op:UUID -->` marker before posting (B2.3 idempotency check
 * queries existing comments for this marker to detect prior execution).
 */
export const PrCommentRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — embedded as marker in posted comment'),
  prNumber: z.number().int().positive().describe('PR number being commented on'),
  body: z.string().min(1).describe('Comment body (handler embeds operationId marker before posting)'),
});

/**
 * pr.comment.executed — B2.1: records that the comment was successfully posted.
 */
export const PrCommentExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the pr.comment.requested event'),
  commentId: z.number().int().positive().describe('GitHub comment id'),
  url: z.string().url().describe('HTML URL of the posted comment'),
});

/**
 * issue.create.requested — B3.1: durable intent recorded BEFORE `gh issue create`
 * fires. Carries the full issue intent so recovery can reconstruct the call
 * (INV-1 LOW). B3.3 idempotency check: query existing issues for same
 * `operationId` marker in body or labels.
 */
export const IssueCreateRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — embedded as marker in issue body or label'),
  title: z.string().min(1).describe('Issue title'),
  body: z.string().describe('Issue body markdown'),
  labels: z.array(z.string()).optional().describe('Label names to apply'),
  assignees: z.array(z.string()).optional().describe('GitHub usernames to assign'),
});

/**
 * issue.create.executed — B3.1: records that the issue was successfully created.
 */
export const IssueCreateExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the issue.create.requested event'),
  issueNumber: z.number().int().positive().describe('GitHub issue number'),
  url: z.string().url().describe('HTML URL of the created issue'),
});

/**
 * branch.delete.requested — B4.1: durable intent recorded BEFORE `git branch -D`
 * and/or `git push origin --delete` fires. B4.3 idempotency is natural: both
 * commands fail if the branch is already absent — the existing handler swallows
 * these; the two-event split formalizes the recovery path.
 */
export const BranchDeleteRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — stable across retries'),
  branch: z.string().min(1).describe('Branch name to delete'),
  remote: z.string().optional().describe("Remote name (defaults to 'origin' when omitted)"),
  localOnly: z.boolean().optional().describe('When true, skip the push --delete step'),
});

/**
 * branch.delete.executed — B4.1: records the outcome of the delete operation.
 * Both flags may be false when the branch was already absent (natural idempotency).
 */
export const BranchDeleteExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the branch.delete.requested event'),
  branch: z.string().min(1).describe('Branch that was targeted'),
  deletedLocally: z.boolean().describe('True if local branch was removed'),
  deletedRemote: z.boolean().describe('True if remote tracking ref was removed'),
});

/**
 * worktree.remove.requested — B5.1: durable intent recorded BEFORE
 * `git worktree remove` fires. B5.3 idempotency check: `git worktree list` filter.
 */
export const WorktreeRemoveRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — stable across retries'),
  worktreePath: z.string().min(1).describe('Absolute path of the worktree to remove'),
});

/**
 * worktree.remove.executed — B5.1: records the outcome of the removal.
 * `removed: false` indicates the worktree was already absent (idempotent success).
 */
export const WorktreeRemoveExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the worktree.remove.requested event'),
  worktreePath: z.string().min(1).describe('Path that was targeted'),
  removed: z.boolean().describe('True if removed; false if already absent (idempotent success)'),
});

// ─── Command Resolver Event Data (#1199 T15) ────────────────────────────────

/**
 * command.resolved — emitted by the test/typecheck/install runtime resolver
 * (#1199). Audit-only: captures where each command resolution came from so
 * downstream graceful-skip semantics (T17) can distinguish a configured
 * `null` from an unresolved command for which we should bail with
 * remediation guidance. Not folded by any state reducer.
 */
// Discriminated on `source` so contradictory shapes (e.g. `source: 'config'`
// + `command: null`, or `source: 'unresolved'` + a runnable command) are
// rejected at the schema boundary. Downstream graceful-skip logic relies on
// `source === 'unresolved'` implying `command === null` and a non-empty
// `remediation`.
const CommandResolvedBase = z.object({
  field: z.enum(['test', 'typecheck', 'install']),
  repoRoot: z.string().min(1),
});

export const CommandResolvedEventSchema = z.discriminatedUnion('source', [
  CommandResolvedBase.extend({
    source: z.enum(['config', 'detection', 'override']),
    command: z.string().min(1),
    remediation: z.string().optional(),
  }),
  CommandResolvedBase.extend({
    source: z.literal('unresolved'),
    command: z.null(),
    remediation: z.string().min(1),
  }),
]);
export type CommandResolvedEvent = z.infer<typeof CommandResolvedEventSchema>;

// ─── Durable Event-Store Substrate Event Data (#1259) ───────────────────────

/**
 * hsm.deprecated_action_invoked — telemetry for the HSM API single-path
 * migration (T02, DR-4 / DR-10). Each invocation of a deprecated action
 * (e.g. `workflow.set({phase})`) emits one of these so the migration window
 * can be measured before the legacy path is removed.
 *
 * `action` — the deprecated action identifier (e.g. `'set({phase})'`).
 * `invokedBy` — caller surface (e.g. `'orchestrator'`, `'cli'`, `'mcp'`).
 *
 * Fields are required strings (`min(1)`) so deprecation events without
 * actionable telemetry fail at the schema boundary rather than fragmenting
 * downstream dashboards with empty rows.
 */
export const HsmDeprecatedActionInvokedData = z.object({
  action: z.string().min(1).describe('Deprecated action identifier'),
  invokedBy: z.string().min(1).describe('Caller surface that invoked the deprecated action'),
});

/**
 * spec.legacy_capabilities_array — emitted during spec validation when a
 * spec uses the legacy `capabilities[]` array shape (T03, DR-6 / DR-10).
 * Drives capability-posture migration telemetry during the transition window.
 *
 * `capabilities` is allowed to be empty — an empty legacy-shape array is
 * still a legacy-shape signal worth recording.
 */
export const SpecLegacyCapabilitiesArrayData = z.object({
  specName: z.string().min(1).describe('Spec name carrying the legacy capabilities array'),
  capabilities: z.array(z.string()).describe('Capability identifiers in the legacy array shape'),
});

/**
 * phase.contract_missing — historical event type (T03, DR-7).
 *
 * v2.10 history: emitted once at lifecycle start per phase that lacked a
 * typed `staleness` contract; the pruner fell back to a single-signal
 * heuristic for those phases.
 *
 * v2.11 (Phase 5c, DR-7 hard-cut): NO LONGER EMITTED. The topology loader
 * now throws on any phase missing a `staleness` block, so the advisory
 * pathway is gone. The schema slot is RETAINED so replays of v2.10-era
 * event logs (and the historical schemas test) remain decodable. New
 * code MUST NOT emit this event type.
 */
export const PhaseContractMissingData = z.object({
  phaseName: z.string().min(1).describe('Phase missing a typed contract'),
});

/**
 * migration.legacy_jsonl_imported — per-file completion event from the
 * JSONL→SQLite migration importer (T04, DR-9 / DR-10).
 *
 * `eventCount` and `durationMs` are non-negative — a file with zero events
 * (e.g. an empty stream) is a valid import outcome.
 *
 * INV-1 portability (T65, CodeRabbit #3): `sourcePath` is **state-dir-relative**.
 * Absolute paths are rejected by the schema because they leak machine-specific
 * identifiers (home directories, usernames) into the durable event log and
 * prevent the SQLite store from being replayed on another machine — both
 * locally (a teammate pulling a copy of the store) and on the future
 * basileus-remote shared store (#1081). Both POSIX-absolute (e.g.
 * `/var/exarchos/...`) and Windows-absolute (e.g. `C:\Users\...`) forms are
 * rejected so the invariant holds regardless of which platform produced
 * the event.
 */
export const MigrationLegacyJsonlImportedData = z.object({
  sourcePath: z
    .string()
    .min(1)
    .refine((p) => !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p), {
      message: 'sourcePath must be relative to state-dir (INV-1 portability)',
    })
    .describe(
      'State-dir-relative path of the JSONL file imported (absolute paths rejected for INV-1 portability)',
    ),
  eventCount: z.number().int().nonnegative().describe('Number of events imported from this file'),
  durationMs: z.number().nonnegative().describe('Wall-clock import duration in milliseconds'),
});

/**
 * migration.completed — final aggregate event after a successful run of the
 * JSONL→SQLite migration importer (T04, DR-9 / DR-10). Zero-file completion
 * is valid: the lock holder still records completion so siblings unblock
 * without re-running.
 */
export const MigrationCompletedData = z.object({
  filesImported: z.number().int().nonnegative().describe('Total JSONL files successfully imported'),
  eventsImported: z.number().int().nonnegative().describe('Total events successfully imported'),
  totalDurationMs: z.number().nonnegative().describe('Total wall-clock import duration in milliseconds'),
});

/**
 * migration.failed — emitted when the JSONL→SQLite migration importer
 * fails (T04, DR-9 / DR-10). Carries the operator-facing failure reason
 * (`min(1)` — empty reasons fragment observability) plus partial-progress
 * counters so operators can resume or retry from a known point.
 */
export const MigrationFailedData = z.object({
  reason: z.string().min(1).describe('Operator-facing failure reason'),
  partialFilesImported: z.number().int().nonnegative().describe('Files imported before the failure'),
  partialEventsImported: z.number().int().nonnegative().describe('Events imported before the failure'),
});

/**
 * migration.workflow_type_unknown — emitted once during the V3 → V4
 * Marten R-1 migration (#1313) for each stream whose `workflow_type`
 * could not be recovered from a co-located state file. The row remains
 * at the `__legacy` sentinel until an operator hand-edits the state file
 * and re-runs the migration. Lets operators locate the rows that need
 * manual classification without scanning every row of the streams
 * registry.
 *
 * Event lives on the per-stream log (streamId is the affected feature)
 * so it appears alongside the workflow's other events in a single
 * `event.query`. The `data.streamId` field is redundant with the
 * envelope's streamId but is retained for cross-stream aggregator
 * reducers that index off data.* rather than envelope.streamId.
 */
export const MigrationWorkflowTypeUnknownData = z.object({
  streamId: z.string().min(1).describe('Affected stream / featureId'),
});

/**
 * migration.correlation_backfill_progress — emitted once per chunk during
 * the V5 -> V6 backfill (`migrateV5ToV6`) of the three correlation-tuple
 * columns (#1437). Lands on the internal `__migration__` stream so the
 * progress trail is queryable via `event.query streamId=__migration__`
 * without contaminating per-feature event logs.
 *
 * Chunk size is fixed at 1,000 rows; each event records how many rows
 * the chunk just touched (`rowsBackfilled`) and how many still need
 * backfilling AFTER that chunk (`totalRowsRemaining`). The pair lets an
 * operator estimate remaining wall-clock from a single progress event
 * (chunkDuration = elapsed since previous event; remainingChunks =
 * ceil(totalRowsRemaining / chunkSize)).
 *
 * `rowsBackfilled` reflects the number of rows targeted by the chunk's
 * UPDATE, not SQLite's `changes()` count — the latter would exclude
 * legacy rows whose correlation columns are written from NULL to NULL
 * and understate per-chunk progress for those payloads.
 *
 * Emission stops naturally when the chunk-selection query returns zero
 * rows — the loop terminates and no final "completed" event is emitted
 * (the absence of further progress events is the completion signal).
 * This keeps the contract minimal; downstream aggregators that need a
 * terminal "done" marker can derive it from the ledger stamp at
 * `schema_version.version = 6` instead.
 */
export const MigrationCorrelationBackfillProgressData = z.object({
  rowsBackfilled: z.number().int().nonnegative().describe('Rows targeted by this chunk (chunk size, not SQLite changes())'),
  totalRowsRemaining: z
    .number()
    .int()
    .nonnegative()
    .describe('Rows whose correlation_id is still NULL after this chunk'),
});

// ─── Workspace discovery (#1290) ────────────────────────────────────────────

/**
 * Emitted by `resolveWorkspace` when the dispatch boundary resolves a
 * missing `featureId` from a single matching MCP root or via the cwd-walk
 * fallback. `source` records which branch produced the resolution so
 * audit queries can distinguish handshake-driven inference from cwd
 * inference. `path` is the absolute workspace root (the directory
 * containing `.exarchos.yml` or `docs/workflow-state/<id>.state.json`).
 */
export const WorkspaceResolvedData = z.object({
  source: z.enum(['roots', 'cwd']),
  // CodeRabbit MINOR #1423: docstring above declares `path` as the
  // absolute workspace root; pre-fix the schema only required `min(1)`
  // so a relative path could slip past validation. Refine to accept
  // either a POSIX absolute path (`/foo/bar`) or a Windows absolute
  // path (`C:\foo`) — both shipped surfaces use `path.resolve()` so
  // either form may legitimately appear depending on host platform.
  path: z
    .string()
    .min(1)
    .refine(
      (p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p),
      { message: 'path must be absolute (POSIX or Windows)' },
    ),
  featureId: z.string().min(1),
});

// ─── Dispatch elicitation hand-off (#1274) ──────────────────────────────────

/**
 * Emitted by `dispatch/elicitation-dispatch.ts` BEFORE the
 * `elicitation/create` MCP round-trip fires. `operationId` correlates the
 * request with its matching `elicitation.fulfilled`; `field` is the missing
 * required parameter the server is asking the client to supply; `schema`
 * is the JSON Schema fragment derived via `.pick({field: true})`.
 *
 * `schema` is intentionally typed as `Record<string, unknown>` (rather
 * than a tight JSONSchema7 zod shape) because the wire shape depends on
 * the action schema's surface and we don't want the audit-trail validator
 * to drift every time a new action's field gets elicited.
 */
export const ElicitationRequestedData = z.object({
  operationId: z.string().min(1),
  field: z.string().min(1),
  schema: z.record(z.string(), z.unknown()),
});

/**
 * Emitted by `dispatch/elicitation-dispatch.ts` AFTER the client returns a
 * value through `elicitation/create`. `operationId` matches the request;
 * `value` is the elicited value (typed `unknown` since the schema is
 * caller-supplied and JSON-shaped).
 */
export const ElicitationFulfilledData = z.object({
  operationId: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
});

/**
 * Emitted by `dispatch/elicitation-dispatch.ts` AFTER the round-trip when
 * the client returned `value === undefined` (decline / cancel). Mirrors
 * the {@link ElicitationFulfilledData} shape minus the `value` so the
 * audit-trail keeps the operationId/field pairing for post-hoc query.
 * Sentry MEDIUM #1424 root cause: pre-fix all responses were logged as
 * fulfilled; this event makes the decline path observable.
 */
export const ElicitationDeclinedData = z.object({
  operationId: z.string().min(1),
  field: z.string().min(1),
});

// ─── EventSourcedTaskStore lifecycle (#1272) ───────────────────────────────
//
// Emitted by `src/task-store/event-sourced-task-store.ts` to durably back
// the SDK `TaskStore` projection. See the file header on
// `task-store/event-sourced-task-store.ts` for the lifecycle map and the
// REPLAY acceptance test in `event-sourced-task-store.test.ts` for the
// INV-1 event-sourcing-integrity contract these schemas enforce.
//
// `request` is typed `unknown` because it's the original JSON-RPC request
// envelope from the SDK (caller-supplied, JSON-shaped); the schema cannot
// usefully tighten it without taking a dependency on the SDK's request
// type registry. The store stores it verbatim so a fresh `getTask` can
// reconstruct what was originally asked. `ttl` matches the SDK contract
// (`number | null`); null means "unlimited lifetime, no automatic
// cleanup".

/** Emitted on `createTask`. Captures the durable creation intent. */
export const TaskCreatedData = z.object({
  taskId: z.string().min(1),
  createdBy: z.string().min(1).optional(),
  ttl: z.union([z.number().int().nonnegative(), z.null()]),
  request: z.unknown(),
  // CodeRabbit MAJOR #1431 follow-up: persist pollInterval so REPLAY
  // (`projectTask` in `event-sourced-task-store.ts`) reconstructs the
  // caller-supplied cadence. Pre-fix the value was only kept in the
  // in-memory projection, so a process restart silently reverted every
  // task to the 1000ms default. Optional so historical events without
  // the field continue to project (back-compat with pre-fix
  // `task.created` payloads).
  pollInterval: z.number().int().positive().optional(),
});

/**
 * Emitted on each `getTask` read. The canonical poll-ordering signal is
 * the event envelope's own `.sequence` field (assigned atomically by the
 * appender — see `event-sourced-task-store.ts` `getTask`). Consumers MUST
 * use `envelope.sequence` for ordering; `data.sequence` is retained as
 * optional ONLY for back-compat with historical events emitted before
 * CodeRabbit MAJOR #1431 follow-up which removed the placeholder. New
 * emits omit the payload field entirely.
 *
 * @deprecated Use `envelope.sequence` instead. Retained as optional for
 *             historical-event back-compat; will be removed once the
 *             retention window has rolled past the placeholder-era events.
 */
export const TaskPolledData = z.object({
  taskId: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
});

/**
 * Emitted on terminal task transitions. `status` is the SDK terminal
 * surface (`completed | failed | cancelled`). `result` is the SDK
 * `Result` envelope on success; `error` is a human-readable message on
 * failure. Both are optional — `cancelled` terminals carry neither.
 */
export const TaskResultData = z.object({
  taskId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled']),
  result: z.unknown().optional(),
  error: z.string().max(2000).optional(),
});

/** Emitted on `cancelTask`. Reason is required so audit can attribute. */
export const TaskCancelledData = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1).max(500),
});
// ─── Dispatch guard preflight observability (#1261) ─────────────────────────

/**
 * Emitted by `orchestrate/dispatch-guard.ts` after the dispatch boundary
 * runs all preflight guards. Records the per-guard pass/fail outcome plus
 * an aggregate `passed` flag and total `durationMs` so audit queries can
 * (a) attribute dispatch blocks to a specific guard and (b) track
 * preflight latency over time without parsing structured logs.
 *
 * The four guards mirror `prepare-delegation.ts` today:
 *   - `ancestry` — `validateBranchAncestry` (required upstream branches)
 *   - `worktree` — `assertMainWorktree` (refuse from a subagent worktree)
 *   - `protectedBranch` — `assertCurrentBranchNotProtected` (HEAD not on
 *     main/master)
 *   - `mainWorktree` — alias slot reserved for future cross-cutting
 *     "we are in the canonical main worktree" assertions; currently
 *     mirrors `worktree.passed` until further split is needed.
 *
 * Inherits `operationId` from the active `DispatchContext` (B1 / #1291)
 * via the `stampWithDispatchContext` helper in `event-store/store.ts`,
 * so no manual correlation threading is required at the emit site.
 */
export const DispatchPreflightData = z.object({
  guards: z.object({
    ancestry: z.object({ passed: z.boolean() }),
    worktree: z.object({ passed: z.boolean() }),
    protectedBranch: z.object({ passed: z.boolean() }),
    mainWorktree: z.object({ passed: z.boolean() }),
  }),
  passed: z.boolean(),
  durationMs: z.number().nonnegative(),
});

/**
 * Emitted by `orchestrate/dispatch-guard.ts` when the worktree under
 * dispatch has a non-empty `git stash list`. Stash storage is shared
 * across worktrees in the same repository (documented project hazard:
 * `feedback_subagent_stash_hazard`), so any pre-existing stash entry
 * raises the risk that a sibling agent's WIP will be popped into the
 * current worktree. Emission is advisory — the dispatch is not blocked
 * — but operators can use the audit trail to correlate later
 * data-corruption incidents back to the moment of collision.
 *
 * `stashRef` is the ref of the most recent entry (e.g. `stash@{0}`).
 */
export const StashDetectedData = z.object({
  worktreePath: z.string().min(1),
  stashRef: z.string().min(1),
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
  'workflow.projection_degraded': WorkflowProjectionDegradedData,
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
  // PR3/T7 (#1364) — structured action-level failure event.
  'tool.action_errored': ToolActionErroredData,
  // #1262 — per-turn output-token sample (CodeRabbit F2 on PR #1409).
  'turn.completed': TurnCompletedDataSchema,

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
  'session.machinery_consumed': SessionMachineryConsumedDataSchema,

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

  // Merge orchestrator (T03, DR-MO-2)
  'merge.preflight': MergePreflightData,
  // Wave 4 audit §F1.2 two-event split — see MergeRequestedData definition.
  // Registered in Wave 2B.2 so the `merge-orchestrator@v1` projection can
  // fold it ahead of Wave 4's `decide` migration.
  'merge.requested': MergeRequestedData,
  'merge.executed': MergeExecutedData,
  'merge.rollback': MergeRollbackData,

  // Command resolver (#1199 T15) — audit trail for runtime resolver decisions.
  'command.resolved': CommandResolvedEventSchema,

  // Durable event-store substrate (#1259) — T02 / T03 / T04.
  'hsm.deprecated_action_invoked': HsmDeprecatedActionInvokedData,
  'spec.legacy_capabilities_array': SpecLegacyCapabilitiesArrayData,
  'phase.contract_missing': PhaseContractMissingData,
  'migration.legacy_jsonl_imported': MigrationLegacyJsonlImportedData,
  'migration.completed': MigrationCompletedData,
  'migration.failed': MigrationFailedData,
  'migration.workflow_type_unknown': MigrationWorkflowTypeUnknownData,
  'migration.correlation_backfill_progress': MigrationCorrelationBackfillProgressData,

  // Wave B (#1342) two-event split — VCS side-effect handlers.
  'pr.create.requested': PrCreateRequestedData,
  'pr.create.executed': PrCreateExecutedData,
  'pr.comment.requested': PrCommentRequestedData,
  'pr.comment.executed': PrCommentExecutedData,
  'issue.create.requested': IssueCreateRequestedData,
  'issue.create.executed': IssueCreateExecutedData,
  'branch.delete.requested': BranchDeleteRequestedData,
  'branch.delete.executed': BranchDeleteExecutedData,
  'worktree.remove.requested': WorktreeRemoveRequestedData,
  'worktree.remove.executed': WorktreeRemoveExecutedData,

  // #1290 — workspace discovery resolution
  'workspace.resolved': WorkspaceResolvedData,

  // #1274 — dispatch elicitation hand-off
  'elicitation.requested': ElicitationRequestedData,
  'elicitation.fulfilled': ElicitationFulfilledData,
  'elicitation.declined': ElicitationDeclinedData,

  // #1272 — EventSourcedTaskStore lifecycle
  'task.created': TaskCreatedData,
  'task.polled': TaskPolledData,
  'task.result': TaskResultData,
  'task.cancelled': TaskCancelledData,
  // #1261 — dispatch-guard preflight observability
  'dispatch.preflight': DispatchPreflightData,
  'stash.detected': StashDetectedData,
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
export type WorkflowProjectionDegraded = z.infer<typeof WorkflowProjectionDegradedData>;
export type SynthesizeRequested = z.infer<typeof SynthesizeRequestedData>;
export type ToolInvoked = z.infer<typeof ToolInvokedData>;
export type ToolCompleted = z.infer<typeof ToolCompletedData>;
export type ToolErrored = z.infer<typeof ToolErroredData>;
// PR3/T7 (#1364)
export type ToolActionErrored = z.infer<typeof ToolActionErroredData>;
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
// SessionMachineryConsumedData is exported alongside its schema above (co-located).
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
export type MergePreflight = z.infer<typeof MergePreflightData>;
export type MergeRequested = z.infer<typeof MergeRequestedData>;
export type MergeExecuted = z.infer<typeof MergeExecutedData>;
export type MergeRollback = z.infer<typeof MergeRollbackData>;
export type HsmDeprecatedActionInvoked = z.infer<typeof HsmDeprecatedActionInvokedData>;
export type SpecLegacyCapabilitiesArray = z.infer<typeof SpecLegacyCapabilitiesArrayData>;
export type PhaseContractMissing = z.infer<typeof PhaseContractMissingData>;
export type MigrationLegacyJsonlImported = z.infer<typeof MigrationLegacyJsonlImportedData>;
export type MigrationCompleted = z.infer<typeof MigrationCompletedData>;
export type MigrationFailed = z.infer<typeof MigrationFailedData>;
export type MigrationCorrelationBackfillProgress = z.infer<typeof MigrationCorrelationBackfillProgressData>;

// Wave B (#1342) two-event split types
export type PrCreateRequested = z.infer<typeof PrCreateRequestedData>;
export type PrCreateExecuted = z.infer<typeof PrCreateExecutedData>;
export type PrCommentRequested = z.infer<typeof PrCommentRequestedData>;
export type PrCommentExecuted = z.infer<typeof PrCommentExecutedData>;
export type IssueCreateRequested = z.infer<typeof IssueCreateRequestedData>;
export type IssueCreateExecuted = z.infer<typeof IssueCreateExecutedData>;
export type BranchDeleteRequested = z.infer<typeof BranchDeleteRequestedData>;
export type BranchDeleteExecuted = z.infer<typeof BranchDeleteExecutedData>;
export type WorktreeRemoveRequested = z.infer<typeof WorktreeRemoveRequestedData>;
export type WorktreeRemoveExecuted = z.infer<typeof WorktreeRemoveExecutedData>;

// #1290 — workspace discovery
export type WorkspaceResolved = z.infer<typeof WorkspaceResolvedData>;

// #1274 — dispatch elicitation hand-off
export type ElicitationRequested = z.infer<typeof ElicitationRequestedData>;
export type ElicitationFulfilled = z.infer<typeof ElicitationFulfilledData>;
export type ElicitationDeclined = z.infer<typeof ElicitationDeclinedData>;

// #1272 — EventSourcedTaskStore lifecycle
export type TaskCreated = z.infer<typeof TaskCreatedData>;
export type TaskPolled = z.infer<typeof TaskPolledData>;
export type TaskResult = z.infer<typeof TaskResultData>;
export type TaskCancelled = z.infer<typeof TaskCancelledData>;
// #1261 — dispatch-guard preflight observability
export type DispatchPreflight = z.infer<typeof DispatchPreflightData>;
export type StashDetected = z.infer<typeof StashDetectedData>;

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
  // PR3/T7 (#1364)
  'tool.action_errored': ToolActionErrored;
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
  'workflow.projection_degraded': WorkflowProjectionDegraded;
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
  'session.machinery_consumed': SessionMachineryConsumedData;
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
  'merge.preflight': MergePreflight;
  'merge.requested': MergeRequested;
  'merge.executed': MergeExecuted;
  'merge.rollback': MergeRollback;
  'command.resolved': CommandResolvedEvent;
  'hsm.deprecated_action_invoked': HsmDeprecatedActionInvoked;
  'spec.legacy_capabilities_array': SpecLegacyCapabilitiesArray;
  'phase.contract_missing': PhaseContractMissing;
  'migration.legacy_jsonl_imported': MigrationLegacyJsonlImported;
  'migration.completed': MigrationCompleted;
  'migration.failed': MigrationFailed;
  'migration.correlation_backfill_progress': MigrationCorrelationBackfillProgress;
  // Wave B (#1342) two-event split
  'pr.create.requested': PrCreateRequested;
  'pr.create.executed': PrCreateExecuted;
  'pr.comment.requested': PrCommentRequested;
  'pr.comment.executed': PrCommentExecuted;
  'issue.create.requested': IssueCreateRequested;
  'issue.create.executed': IssueCreateExecuted;
  'branch.delete.requested': BranchDeleteRequested;
  'branch.delete.executed': BranchDeleteExecuted;
  'worktree.remove.requested': WorktreeRemoveRequested;
  'worktree.remove.executed': WorktreeRemoveExecuted;
  // #1290 — workspace discovery
  'workspace.resolved': WorkspaceResolved;
  // #1274 — dispatch elicitation hand-off
  'elicitation.requested': ElicitationRequested;
  'elicitation.fulfilled': ElicitationFulfilled;
  'elicitation.declined': ElicitationDeclined;
  // #1272 — EventSourcedTaskStore lifecycle
  'task.created': TaskCreated;
  'task.polled': TaskPolled;
  'task.result': TaskResult;
  'task.cancelled': TaskCancelled;
  // #1261 — dispatch-guard preflight observability
  'dispatch.preflight': DispatchPreflight;
  'stash.detected': StashDetected;
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
