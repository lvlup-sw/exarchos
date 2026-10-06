/**
 * The event catalog: every event type name and the Zod schema of each event payload.
 *
 * The `judgment` content schemas live in `judgment-content-schemas.ts`, so `event-annotations.ts`
 * takes no runtime value from this module, and this module imports the annotations with no cycle.
 * This module re-exports those schemas for existing importers. The re-exported `EVENT_NAME_PATTERN`
 * is a regex form of the grammar in `event-name.ts`. `tools/conformance/src/event-grammar-census.ts`
 * reads it to compare the two forms.
 */
import * as path from 'node:path';
import { z } from 'zod';
import { WorkflowTypeSchema } from '../workflow/schemas.js';
import { DoctorOutputSchema } from '../verbs/doctor/schema.js';
import { ReconcilePlanSchema, ReconcileResultSchema } from '../dispatch/core/onboarding/types.js';
import {
  AdmissionDecisionRecordV1Schema,
  AdmissionEvidenceV1Schema,
  AdmissionRequirementV1Schema,
  AttributedPrincipalV1Schema,
  AuthorizationSnapshotV1Schema,
  ContentDigestV1Schema,
  DecisionIdSchema,
  EvidenceIdSchema,
  EvidenceSubjectV1Schema,
  OperationIdSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  RequirementIdSchema,
  WaiverIdSchema,
  WaiverProvenanceV1Schema,
} from '../workflow/admission/types.js';
import { ANNOTATED_EVENTS } from './event-annotations.js';
import { BUNDLE_REF_FIELD, BundleRefV1Schema } from './bundle/digest-references.js';
import { assertWellFormedEventName } from './event-name.js';
import { deriveEmissionRegistry } from './event-registration.js';
import {
  RemediationAttemptedDataSchema,
  RemediationSucceededDataSchema,
  ReviewCompletedData,
  ReviewEscalatedData,
  ReviewFindingData,
  TestResultData,
  TypecheckResultData,
} from './judgment-content-schemas.js';

export {
  RemediationAttemptedDataSchema,
  RemediationSucceededDataSchema,
  ReviewCompletedData,
  ReviewEscalatedData,
  ReviewFindingData,
  TestResultData,
  TypecheckResultData,
};

/** Internal replay types for admission. None of them is a public admission action in v2.12. */
export const INTERNAL_ADMISSION_EVENT_TYPES = [
  'admission.requirement-resolved',
  'admission.evidence-recorded',
  'admission.transition-decided',
  'admission.waiver-recorded',
  'admission.contradiction-recorded',
  'admission.reassessment-requested',
  'admission.reassessment-completed',
  'admission.shadow-attempt',
  'admission.disagreement-disposition',
  'admission.rollout-decision',
  'admission.enforcement-enabled',
  /**
   * The first readiness export record of the cutover promotion path. The observer appends it when all
   * six cutover-gate conditions first hold. Its idempotency key is the store identity, not the clock.
   */
  'admission.cutover-ready',
] as const;

/**
 * Server-owned VCS ledger facts.
 *
 * `foldVcsLedger` treats these facts as authoritative fencing and idempotency state. The generic
 * `exarchos_event.append` surface rejects only reserved types. The reservation stops a caller from
 * minting a fact that suppresses or fences a real git mutation outside `VcsMutationOwner`.
 */
export const INTERNAL_VCS_LEDGER_EVENT_TYPES: readonly [
  'vcs.requested',
  'vcs.executed',
  'vcs.compensated',
] = ['vcs.requested', 'vcs.executed', 'vcs.compensated'];

/**
 * Server-owned execution-ledger facts. Each type is reserved, so that its only writer is the
 * handler that owns the evidence:
 * - `orchestrate.intent_executed`: the bounded executor commits it after the run bundle is in custody.
 * - `execution.settled`: the settle handler commits it after capsule parse, adjudication and custody.
 * - `workflow.prepared`: settlement adjudicates a capsule only when this record pins its digest.
 * - `deviation.proposed` and `deviation.decided`: the settle handler commits them for a held batch.
 * - `design.revised`: the settle handler commits it when a decision accepts a material deviation.
 *
 * A caller that can append these types can fake a settlement, pin any capsule, or move the design version.
 */
export const INTERNAL_EXECUTION_LEDGER_EVENT_TYPES: readonly [
  'orchestrate.intent_executed',
  'execution.settled',
  'workflow.prepared',
  'deviation.proposed',
  'deviation.decided',
  'design.revised',
] = [
  'orchestrate.intent_executed',
  'execution.settled',
  'workflow.prepared',
  'deviation.proposed',
  'deviation.decided',
  'design.revised',
];

/** Server-owned facts of the cancellation process manager. */
export const INTERNAL_CANCELLATION_EVENT_TYPES = [
  'cancel.requested',
  /**
   * The fencing token. Each ownership acquisition allocates a higher epoch. The process manager
   * rejects writes from a stale epoch, so a displaced instance cannot undercut a takeover.
   */
  'cancel.ownership-acquired',
  'cancel.compensation-requested',
  'cancel.compensation-completed',
  'cancel.compensation-failed',
  /** The bounded-retry record. It comes before each new attempt of a failed compensation effect. */
  'cancel.compensation-retry-scheduled',
  /**
   * The terminal escalation. Retry exhaustion, or a malformed result that cannot be retried, ends in
   * this queryable state.
   */
  'cancel.manual-intervention-required',
  'cancel.ready',
] as const;

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
  /**
   * A counted revise cycle of plan review, emitted on the `plan-review → plan` revise edge. The
   * projection folds it into `state.planReview.revisionCount`, which `revisionsExhausted` reads.
   */
  'workflow.plan-revision',
  /**
   * A counted plan-review dispatch. The `prepare_review scope:plan` handler appends it on every
   * provisioning of the plan review, so an agent cannot re-review without a count. The projection
   * folds the maximum 0-based `ordinal` into `planReview.revisionCount`. The idempotency key
   * `${featureId}:plan-review-dispatch:${ordinal}` collapses a crash retry of the same ordinal.
   */
  'workflow.plan-review-dispatched',
  'workflow.guard-failed',
  'workflow.checkpoint',
  /**
   * An auto-summarized handoff. A summarizer subagent emits it when a checkpoint fires with no
   * operator-authored handoff. The rehydration reducer folds it into `latestHandoff` only when no
   * operator handoff holds the slot. The event stores the summary, so replay is deterministic.
   */
  'workflow.handoff_summarized',
  'workflow.compound-entry',
  'workflow.compound-exit',
  'workflow.cancel',
  'workflow.cleanup',
  'workflow.compensation',
  ...INTERNAL_CANCELLATION_EVENT_TYPES,
  'workflow.circuit-open',
  'tool.invoked',
  'tool.completed',
  'tool.errored',
  /**
   * Emitted beside `tool.completed` when the handler returns the failure envelope
   * `{success: false, error: {…}}`. `tool.errored` counts only thrown errors.
   */
  'tool.action_errored',
  /** A per-tool runtime measurement of a budget breach. It is not a gate result. */
  'tool.budget_exceeded',
  /**
   * A per-turn output-token sample. Two projections fold it, and the `output_tokens_high` quality
   * hint reads it. No code appends it, so its lifecycle in `event-annotations.ts` is `planned`.
   */
  'turn.completed',
  /**
   * The output-token total of one subagent. The SubagentStop hook (`lifecycle/subagent-stop.ts`)
   * sums it from the subagent transcript and matches the subagent cwd to a dispatched worktree.
   */
  'subagent.tokens_used',
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
  'shepherd.escalated',
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
  /**
   * The detail of one CI check, beside the per-PR `ci.status` roll-up. It has its own type, so a CI
   * job and a local gate with the same name do not share one pass rate.
   */
  'ci.check_observed',
  'comment.posted',
  'comment.resolved',
  'diagnostic.executed',
  'pr.created',
  'pr.merged',
  'pr.commented',
  'issue.created',
  /**
   * The two-event onboard contract. `onboard.requested` records the reconcile plan before the
   * reconcile runs. `onboard.executed` records the result after it succeeds.
   */
  'onboard.requested',
  'onboard.executed',
  'checkpoint.enforced',
  'checkpoint.state_missing',
  'preflight.executed',
  'preflight.blocked',
  'provider.unknown-tier',
  'provider.parse-error',
  'dispatch.classified',
  'merge.preflight',
  /**
   * The durable intent, recorded before the GitHub merge call runs. The `merge-orchestrator@v1`
   * projection folds it as the move into the `requested` phase.
   */
  'merge.requested',
  'merge.executed',
  'merge.rollback',
  /** The only recovery terminal that code emits. `merge.rollback` stays for replay, and nothing writes it. */
  'merge.recovered',
  /**
   * The audit record of one retry after a transient failure. It holds the retry `attempt`, the
   * backoff `delayMs`, and the `reason`.
   */
  'merge.retry_attempt',
  /**
   * The terminal lifecycle event. `handleExecuteMerge` emits it directly after a successful
   * `merge.executed` append, and the projection moves into the `completed` phase. `merge.executed`
   * records the side effect, and this event records the end of the lifecycle.
   */
  'merge.completed',
  /**
   * Merge liveness. `handleExecuteMerge` emits it after it records the recovery point sha and before
   * the first `vcsMerge` attempt. A terminal `merge.executed` or `merge.recovered` follows it. It
   * does not change the projection phase.
   */
  'merge.executing_started',
  'command.resolved',
  /** Deprecation telemetry and migration events of the durable event store. */
  'hsm.deprecated_action_invoked',
  'spec.legacy_capabilities_array',
  'phase.contract_missing',
  /**
   * A gate-set resolver fault stopped a wave dispatch or a phase transition, which failed closed.
   * This event records the reason, so an operator sees the blocked phase.
   */
  'phase.blocked',
  /**
   * `executeTransition` appends `phase.entered` with the obligation that it resolved and froze for
   * the target kind. `phase.exited` carries the aggregate gate status. Replay folds the same
   * obligation, so a later policy edit cannot rewrite a frozen phase.
   */
  'phase.entered',
  'phase.exited',
  'migration.legacy_jsonl_imported',
  'migration.completed',
  'migration.failed',
  /**
   * Emitted once for each V3 → V4 stream with no workflow_type in a state file. Operators use it to
   * find the `__legacy` rows to classify by hand.
   */
  'migration.workflow_type_unknown',
  /**
   * Emitted once for each chunk of the V5 → V6 correlation-column backfill in `migrateV5ToV6`. It
   * lands on the `__migration__` stream with `{rowsBackfilled, totalRowsRemaining}`, so operators can
   * watch a long migration.
   */
  'migration.correlation_backfill_progress',
  /**
   * The two-event split of five VCS handlers. Each handler emits `*.requested` before the side
   * effect and `*.executed` after the side effect succeeds.
   */
  'pr.create.requested',
  'pr.create.executed',
  'pr.comment.requested',
  'pr.comment.executed',
  'issue.create.requested',
  'issue.create.executed',
  'branch.delete.requested',
  'branch.delete.executed',
  'worktree.remove.requested',
  'worktree.remove.executed',
  /**
   * The lease and ownership half of worktree lifecycle management. These four events share one payload
   * shape. Worktree deletion reuses the `worktree.remove.*` pair, so no `worktree.pruned` type exists.
   * The idempotency key is `<eventType>:<operationId>`.
   */
  'worktree.adopted',
  'worktree.reserved',
  'worktree.released',
  'worktree.orphan_detected',
  /**
   * The serialized-merge lease pair on the singleton `worktrees` stream. `worktree.merge_requested` is
   * the claim: the operation and the live process that hold the right to merge `sourceBranch` into
   * `integrationRef`. `worktree.merge_executed` is the release, with the terminal outcome. The only
   * discriminator is `operationId`, so two concurrent merges onto one `integrationRef` get distinct
   * keys. The claim goes through the `decide` seam, and the release is a plain keyed append.
   */
  'worktree.merge_requested',
  'worktree.merge_executed',
  /**
   * The launcher pairs. `worktree.create.*` is the intent and terminal pair for the top-level worktree
   * that the launcher creates. It is separate from `worktree.created`, which needs a `taskId` and a
   * `branch`. `launch.executing_started` records the live child process (`holderPid` and
   * `holderStartedAt`). `launch.executed` records that the child process exited.
   */
  'worktree.create.requested',
  'worktree.create.executed',
  'launch.executing_started',
  'launch.executed',
  /**
   * `resolveWorkspace` emits it when the dispatch boundary resolves a missing `featureId` from MCP
   * roots or from the cwd walk. It records the source. Zero matches or many matches emit nothing.
   */
  'workspace.resolved',
  /**
   * The elicitation hand-off in form mode, on the per-operation stream `elicitation/<operationId>`.
   * `requested` lands before the `elicitation/create` round trip. `fulfilled` lands after the client
   * returns a value.
   */
  'elicitation.requested',
  'elicitation.fulfilled',
  /**
   * Emitted when the client returns `value === undefined` (decline or cancel). It keeps a refusal
   * apart from a fulfilled round trip.
   */
  'elicitation.declined',
  /**
   * The lifecycle of an SDK-protocol task, separate from the workflow `task.*` family above.
   * `EventSourcedTaskStore` emits these events, and its reads project state from the event stream only.
   */
  'task.created',
  'task.polled',
  'task.result',
  'task.cancelled',
  /**
   * `dispatch.preflight` records the result of each dispatch guard, an aggregate `passed` flag, and the
   * total `durationMs`. `stash.detected` fires when the worktree under dispatch has a non-empty
   * `git stash list`. Both take `operationId` from the active `DispatchContext`.
   */
  'dispatch.preflight',
  'stash.detected',
  /**
   * The `invariants_add` handler appends `invariant.authored` on commit. It appends
   * `catalog.registered` on the first registration of a catalog file in `.exarchos.yml`.
   */
  'invariant.authored',
  /**
   * The `invariants_amend` handler appends it on commit, with the names of the replaced fields. An
   * amendment is a separate fact from an authoring.
   */
  'invariant.amended',
  'catalog.registered',
  /**
   * Mutation-run liveness. The `mutation-adequacy` gate handler appends `mutation.executing_started` at
   * the start of a run that is not a dry run. `mutation.executed` carries the verdict and the exit
   * code. A run with no event store skips both events.
   */
  'mutation.executing_started',
  'mutation.executed',
  /**
   * The `exarchos_workflow.feedback` action emits it when an agent or an operator files a friction
   * report. It lands on the shared `meta/feedback` stream, so reports are queryable across workflows.
   */
  'feedback.recorded',
  /**
   * Prune-run liveness on the singleton `worktrees` stream. `worktrees@v1` folds the pair into
   * `inFlightPrunes`, keyed by `operationId`. `prune.executing_started` records the process that runs
   * the `prune_worktrees` pass. `prune.executed` clears the in-flight marker. The WorktreeManager owns
   * both appends.
   */
  'prune.executing_started',
  'prune.executed',
  /**
   * The audit record of a prune evaluation: the count of malformed `handleList` entries and the count
   * of candidates. Every evaluation that is not suppressed appends it, so a clean run leaves a record.
   */
  'prune.diagnostics',
  /**
   * Durable projection health on the singleton `meta/projection-health` stream. `projection.degraded`
   * records that the worst projection cursor of a stream disagrees with its durable event tail.
   * `projection.recovered` records that the stream caught the tail again. An append to the observed
   * stream moves its tail, so these events never go there. The idempotency key is the cursor and tail
   * pair. `workflow.projection_degraded` is a different fault: a rehydration fallback.
   */
  'projection.degraded',
  'projection.recovered',
  /**
   * The two-event `export` contract. `export.requested` holds the resolved destination path and comes
   * before the zip write outside `.exarchos/`. `export.executed` holds the content hash of the bundle.
   * After a crash between the two, the next run checks the zip and the hash, then emits again or
   * writes again. The payload `idempotencyKey` collapses a retry of the same export.
   */
  'export.requested',
  'export.executed',
  /**
   * The VCS mutation ledger. The git and worktree mutation owner appends `vcs.requested` before each
   * non-idempotent git effect. Then it appends one terminal: `vcs.executed` on success, or
   * `vcs.compensated` on failure with compensation. The fold gives the fencing epoch, the replay cache
   * and the open intents, so an interrupted run converges on retry.
   */
  'vcs.requested',
  'vcs.executed',
  'vcs.compensated',
  /**
   * Records that `install/atomic-promotion.ts` swapped a staged tree into a live destination. The key
   * is the destination and the content digest. It is a separate fact from `admission.cutover-ready`,
   * which says that a cutover can proceed.
   */
  'promotion.executed',
  /**
   * A handler broke its emission contract: a declared event did not land, or an event landed
   * although its registration says that nothing emits it. The post-dispatch verifier appends it.
   * A violation is an Exarchos bug, so it is a recorded fact and not an error that the caller sees.
   */
  'emission.violated',
  /**
   * The admission proof substrate: internal replay contracts with the `planned` lifecycle. v2.12
   * exposes no admission action, and no transition reads `admission.enforcement-enabled`.
   */
  ...INTERNAL_ADMISSION_EVENT_TYPES,
  /**
   * The operation record of the bounded action executor. It is appended under the caller
   * `operationId` on the committed path and on the failed path, so a failed segment leaves a fact.
   */
  'orchestrate.intent_executed',
  /**
   * The settlement record: one batch of claims, adjudicated against the capsule pinned at compile
   * time. It is appended for every outcome (settled, rejected, or held for a deviation), so the next
   * call can read why a batch failed.
   */
  'execution.settled',
  /**
   * The compilation record: one capsule, with its bytes in custody and its digest pinned. Settlement
   * adjudicates a capsule only against this record.
   */
  'workflow.prepared',
  /**
   * The decision facts of the divergence loop. A held batch leaves one proposal for each deviation.
   * The settle call that decides the batch leaves one decision for each proposal.
   */
  'deviation.proposed',
  'deviation.decided',
  /**
   * The design revision fact. A decision round that accepts a material deviation leaves one row.
   * The row links the prior design version to the next one, and it rewrites no earlier row.
   */
  'design.revised',
] as const;

export type EventType = typeof EventTypes[number];

const BUILT_IN_EVENT_TYPES = new Set<string>(EventTypes);
const customEventTypes = new Set<string>();

export { EVENT_NAME_PATTERN } from './event-name.js';

/**
 * Register a custom event type at runtime.
 *
 * A built-in name or a duplicate custom name throws. The grammar in `event-name.ts` decides
 * well-formedness and throws a {@link MalformedEventNameError} for a malformed name.
 */
export function registerEventType(
  name: string,
  options: { source: 'auto' | 'model' | 'hook'; schema?: z.ZodSchema },
): void {
  assertWellFormedEventName(name);
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

  (EVENT_EMISSION_REGISTRY as Record<string, EventEmissionSource>)[name] = options.source;

  if (options.schema) {
    (EVENT_DATA_SCHEMAS as Record<string, z.ZodSchema>)[name] = options.schema;
  }
}

/** Remove a custom event type, for test cleanup. A built-in type throws. */
export function unregisterEventType(name: string): void {
  if (BUILT_IN_EVENT_TYPES.has(name)) {
    throw new Error(`Cannot unregister built-in event type: '${name}'`);
  }
  customEventTypes.delete(name);
  delete (EVENT_EMISSION_REGISTRY as Record<string, EventEmissionSource>)[name];
  delete (EVENT_DATA_SCHEMAS as Record<string, z.ZodSchema>)[name];
}

/** Returns all valid event types: built-in and custom. */
export function getValidEventTypes(): string[] {
  return [...EventTypes, ...customEventTypes];
}

/** Whether a name is a built-in event type. */
export function isBuiltInEventType(name: string): boolean {
  return BUILT_IN_EVENT_TYPES.has(name);
}

/**
 * Where an event comes from. `planned` has a schema and no emitter yet. `retired` keeps its schema
 * and type-map entry for replay, and nothing emits it. A `retired` event never appears in `autoEmits`.
 */
export type EventEmissionSource = 'auto' | 'model' | 'hook' | 'planned' | 'retired';

/**
 * The emission source of every registered event type.
 *
 * Each source derives from the tier and the lifecycle in `event-annotations.ts`, through
 * `resolveEmissionSource` in `event-registration.ts`. No source is authored here, so a source cannot
 * disagree with its tier. The registry is built from `EventTypes`, so its keys match the catalog.
 * {@link deriveEmissionRegistry} fails closed at load on an empty population or an unannotated type.
 * Only {@link registerEventType} supplies a source directly, for a custom type from
 * `ExarchosConfig.events`.
 */
export const EVENT_EMISSION_REGISTRY: Record<EventType, EventEmissionSource> =
  deriveEmissionRegistry(EventTypes, ANNOTATED_EVENTS.registrationOf);

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
  /**
   * The dispatch correlation id. Each `dispatch()` call mints it, and `EventStore.append*` stamps it on
   * each event in the dispatch through AsyncLocalStorage. It is top-level, beside `correlationId`, for
   * the projections that read these keys. It is optional because direct tests and migration tooling
   * append outside a dispatch.
   */
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

export const WorkflowStartedData = z.object({
  featureId: z.string(),
  workflowType: WorkflowTypeSchema,
  /**
   * The identity of the initial actionable phase entry. It is optional for streams older than v2.12.
   * Every new writer supplies it.
   */
  phaseAttemptId: PhaseAttemptIdSchema.optional(),
  designPath: z.string().optional(),
  /**
   * The oneshot synthesis policy chosen at init. The stream must persist it, or rehydration falls back
   * to the schema default `on-request`. Other workflow types do not set it.
   */
  synthesisPolicy: z.enum(['always', 'never', 'on-request']).optional(),
  /**
   * The repository identity, from `deriveRepoKey` on the server working directory at init. Older
   * events do not have it, and the pipeline projection treats an absent `repoRoot` as unscoped.
   */
  repoRoot: z.string().optional(),
});

export const TaskAssignedData = z.object({
  taskId: z.string().describe('Unique identifier for the task'),
  title: z.string().describe('Human-readable task title'),
  /**
   * The planned branch of the task. `setup_worktree` takes the first branch that is set: `args.branch`,
   * then `workflow.tasks[id].branch`, then the default.
   */
  branch: z.string().optional().describe('Git branch for this task (planned). Optional.'),
  worktree: z.string().optional().describe('Path to the git worktree for isolation'),
  assignee: z.string().optional().describe('Agent or user assigned to this task'),
});

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
  /** Provenance: the requirement ids that this task implements. */
  implements: z.array(z.string()).optional(),
  tests: z.array(z.object({ name: z.string(), file: z.string() })).optional(),
  files: z.array(z.string()).optional(),
});

export const TaskFailedData = z.object({
  taskId: z.string(),
  error: z.string().max(500),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});

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

/**
 * A tool response that exceeded its response-economy token budget. It is a runtime measurement and
 * not a gate result, so the convergence view does not fold it into `D3`. The `context-economy` gate
 * reads `queryRuntimeMetrics` and appends the governance verdict for `D3`.
 */
export const ToolBudgetExceededData = z.object({
  tool: z.string(),
  tokenEstimate: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
  /** The workflow the breaching call named, when it named one. */
  featureId: z.string().optional(),
});

/**
 * The observed status of one CI check on one pull request. It is not a gate result, so a CI job
 * cannot share a pass rate with a local gate of the same name.
 */
export const CiCheckObservedData = z.object({
  pr: z.number().int(),
  check: z.string(),
  passed: z.boolean(),
  /** The skill whose outcome this check measures. */
  skill: z.string().optional(),
});

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

export const WorkflowTransitionData = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  featureId: z.string(),
  /**
   * The identity allocated at the entry boundary. It is optional only for historical events. New
   * transition writes always carry it.
   */
  phaseAttemptId: PhaseAttemptIdSchema.optional(),
});

export const WorkflowFixCycleData = z.object({
  /** The parent compound state. A top-level child has no parent compound, so it omits this field. */
  compoundStateId: z.string().optional(),
  count: z.number().int(),
  featureId: z.string(),
});

/**
 * A counted revise cycle of plan review, with the same shape as `WorkflowFixCycleData`. `count` is
 * the 1-based occurrence. Plan review is a top-level phase, so `compoundStateId` is absent.
 */
export const WorkflowPlanRevisionData = z.object({
  compoundStateId: z.string().optional(),
  count: z.number().int(),
  featureId: z.string(),
});

/**
 * A counted plan-review dispatch. `ordinal` is the 0-based dispatch index of the feature, and 0 is
 * the initial review. The projection folds the maximum ordinal into `planReview.revisionCount`.
 */
export const WorkflowPlanReviewDispatchedData = z.object({
  featureId: z.string(),
  ordinal: z.number().int().nonnegative(),
});

export const WorkflowGuardFailedData = z.object({
  guard: z.string(),
  from: z.string(),
  to: z.string(),
  featureId: z.string(),
});

/**
 * The optional handoff of `workflow.checkpoint`: phase-exit notes for the rehydration projection.
 * Each field has a size cap. The strict object rejects unknown keys at the persisted-event boundary,
 * the same as `CheckpointHandoffSchema` in `workflow/schemas.ts`.
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
  /**
   * Older checkpoint events have no handoff. The payload has no version. Only the rehydration
   * projection envelope has a version.
   */
  handoff: HandoffEntryData.optional(),
});

/**
 * An auto-summarized handoff. A summarizer subagent emits it when a checkpoint fires with no
 * operator-authored handoff. It has the same `handoff` shape as `workflow.checkpoint`, so
 * `extractHandoff` folds both. Here `handoff` is required. The event stores the summary, so replay
 * never calls the summarizer again.
 */
export const WorkflowHandoffSummarizedData = z.object({
  featureId: z
    .string()
    .describe('The workflow/feature the summarized handoff belongs to.'),
  phase: z
    .string()
    .optional()
    .describe('The phase the summary pertains to (the checkpoint\'s phase), for audit.'),
  handoff: HandoffEntryData.describe(
    'Summarized handoff content (context/nextSteps/suggestions), stored verbatim.',
  ),
  summarizedBy: z
    .string()
    .optional()
    .describe('Optional identifier of the summarizer subagent that produced this fallback.'),
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
  phaseAttemptId: PhaseAttemptIdSchema.optional(),
});

export const WorkflowCancelData = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  featureId: z.string(),
  phaseAttemptId: PhaseAttemptIdSchema.optional(),
  reason: z.string().optional(),
});

export const WorkflowCompensationData = z.object({
  featureId: z.string(),
  actionId: z.string(),
  status: z.enum(['executed', 'skipped', 'failed', 'dry-run']),
  message: z.string(),
});

const CancellationEventVersionSchema = z.literal('1.0');
const CancellationIdSchema = z.string().trim().min(1).max(200);
const CancellationActionIdSchema = z.string().trim().min(1).max(200);
const CancellationRecordedAtSchema = z.string().datetime({ offset: true });
const CancellationTrustedProvenance = {
  caller: AttributedPrincipalV1Schema,
  authorization: AuthorizationSnapshotV1Schema.optional(),
} as const;

/** Durable cancellation intent. It always comes before the compensation side effects. */
export const CancelRequestedData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    from: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    reason: z.string().optional(),
    requestedAt: CancellationRecordedAtSchema,
    ...CancellationTrustedProvenance,
  })
  .strict()
  .readonly();

/** Durable intent for one deterministic compensation action. */
export const CancelCompensationRequestedData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    actionId: CancellationActionIdSchema,
    requestedAt: CancellationRecordedAtSchema,
  })
  .strict()
  .readonly();

/** Durable successful result for one compensation action. */
export const CancelCompensationCompletedData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    actionId: CancellationActionIdSchema,
    status: z.enum(['executed', 'skipped']),
    message: z.string().min(1),
    completedAt: CancellationRecordedAtSchema,
  })
  .strict()
  .readonly();

/** Explicit terminal failure for an attempted or malformed compensation. */
export const CancelCompensationFailedData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    actionId: CancellationActionIdSchema,
    reason: z.enum(['effect-failed', 'malformed-result']),
    message: z.string().min(1),
    failedAt: CancellationRecordedAtSchema,
  })
  .strict()
  .readonly();

/** Typed proof that every required compensation result is durably present. */
export const CancelReadyData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    evidenceId: z.string().trim().min(1).max(256),
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    completedActionIds: z.array(CancellationActionIdSchema).readonly(),
    outcomeSequences: z.array(z.number().int().positive()).readonly(),
    contentDigest: ContentDigestV1Schema,
    readyAt: CancellationRecordedAtSchema,
    ...CancellationTrustedProvenance,
  })
  .strict()
  .readonly();

const CancellationEpochSchema = z.number().int().positive();
const CancellationInstanceIdSchema = z.string().trim().min(1).max(200);

/**
 * Fencing-token allocation. `epoch` is greater than every earlier ownership epoch on the stream. The
 * process manager rejects a later write with a lower epoch, so a displaced instance cannot undercut
 * a takeover. The saga facts are replayable events, so restart and takeover fold to the same
 * decisions.
 */
export const CancelOwnershipAcquiredData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    epoch: CancellationEpochSchema,
    instanceId: CancellationInstanceIdSchema,
    acquiredAt: CancellationRecordedAtSchema,
  })
  .strict()
  .readonly();

/**
 * The durable record of a retry of a failed compensation attempt. `attempt` is the 1-based index of
 * the attempt that failed, and attempt + 1 follows. `maxAttempts` bounds the retries.
 */
export const CancelCompensationRetryScheduledData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    actionId: CancellationActionIdSchema,
    epoch: CancellationEpochSchema,
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    reason: z.enum(['effect-failed', 'malformed-result']),
    message: z.string().min(1),
    scheduledAt: CancellationRecordedAtSchema,
  })
  .strict()
  .readonly();

/**
 * The unresolved terminal state of a compensation, after retry exhaustion or a malformed result that
 * cannot be retried. The saga never reports `cancel.ready` while an action is in this state.
 */
export const CancelManualInterventionRequiredData = z
  .object({
    eventVersion: CancellationEventVersionSchema,
    cancelId: CancellationIdSchema,
    featureId: z.string().min(1),
    phaseAttemptId: PhaseAttemptIdSchema,
    actionId: CancellationActionIdSchema,
    epoch: CancellationEpochSchema,
    attempts: z.number().int().positive(),
    reason: z.enum(['retries-exhausted', 'effect-failed', 'malformed-result']),
    message: z.string().min(1),
    requiredAt: CancellationRecordedAtSchema,
  })
  .strict()
  .readonly();

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
  /** Optional playbook-presence flags. Older events do not have them. */
  phaseHasPlaybook: z.boolean().optional(),
  phasePlaybookComposed: z.boolean().optional(),
});

export const WorkflowSnapshotTakenData = z.object({
  projectionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

/**
 * The closed set of degradation causes. A new cause needs the literal here, a matching
 * `DegradationCause` member in `workflow/rehydrate.ts`, and support in the audit paths.
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
 * The closed set of fallback sources. It mirrors `DegradationFallbackSource` in
 * `workflow/rehydrate.ts`, and a new entry must go in both places.
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

export const ReviewRoutedData = z.object({
  pr: z.number().int().describe('Pull request number'),
  riskScore: z.number().min(0).max(1).describe('Computed risk score (0-1) for review routing'),
  factors: z.array(z.string()).describe('Risk factors that contributed to the score'),
  destination: z.enum(['coderabbit', 'self-hosted', 'both']).describe('Where the review was routed'),
  velocityTier: z.enum(['normal', 'elevated', 'high']).describe('Current review velocity tier'),
  semanticAugmented: z.boolean().describe('Whether semantic analysis augmented the routing'),
});

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

/**
 * A structured action failure, paired with `tool.completed`. It repeats the performance fields of
 * `tool.completed`, so the projection folds both events into one per-tool entry. `errorCode` comes
 * from the handler error envelope, or is `UNKNOWN` when the envelope has no code.
 */
export const ToolActionErroredData = z.object({
  tool: z.string(),
  durationMs: z.number(),
  errorCode: z.string(),
  responseBytes: z.number(),
  tokenEstimate: z.number(),
});

/**
 * A per-turn output-token sample. The telemetry projection folds `turnId` and `outputTokens` into
 * `view.turns` for the `output_tokens_high` quality hint. The schema is `.passthrough()`, so a later
 * per-turn field needs no breaking change.
 */
export const TurnCompletedDataSchema = z.object({
  turnId: z.string().min(1).describe('Stable identifier for the turn (typically a UUID).'),
  outputTokens: z.number().nonnegative().describe('Total output tokens consumed by the turn.'),
}).passthrough();
export type TurnCompletedData = z.infer<typeof TurnCompletedDataSchema>;

/**
 * The output-token total of one subagent, from the SubagentStop hook. The hook matches the subagent
 * `cwd` to a dispatched worktree to resolve `teammateName` and `taskId`. A subagent without its own
 * worktree has a shared cwd, so it gets only `agentType` attribution.
 */
export const SubagentTokensUsedDataSchema = z.object({
  agentId: z.string().min(1).describe('Stable subagent invocation id from the SubagentStop hook (agent_id).'),
  outputTokens: z.number().int().nonnegative().describe('Summed output tokens across the subagent\'s own transcript.'),
  agentType: z.string().optional().describe('Subagent type/name (agent_type), e.g. "exarchos-implementer".'),
  teammateName: z.string().optional().describe('Resolved teammate name when the subagent cwd matched a dispatched worktree.'),
  taskId: z.string().optional().describe('Resolved task id from the matching team dispatch.'),
  sessionId: z.string().optional().describe('Parent session id (subagents share the parent session).'),
  cwd: z.string().optional().describe('Subagent working directory; the worktree path for isolated teammates.'),
}).passthrough();
export type SubagentTokensUsedData = z.infer<typeof SubagentTokensUsedDataSchema>;

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

export const QualityRegressionData = z.object({
  skill: z.string().describe('Skill where regression was detected'),
  gate: z.string().describe('Gate that started failing'),
  consecutiveFailures: z.number().int().nonnegative().describe('Number of consecutive gate failures'),
  firstFailureCommit: z.string().describe('Git commit SHA of the first failure'),
  lastFailureCommit: z.string().describe('Git commit SHA of the most recent failure'),
  detectedAt: z.string().datetime().describe('ISO timestamp when the regression was detected'),
});

export const QualityHintGeneratedData = z.object({
  skill: z.string(),
  hintCount: z.number().int().nonnegative(),
  categories: z.array(z.string()),
  generatedAt: z.string().datetime(),
});

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

/**
 * A structured escalation when the shepherd hits its auto-fix bound. It is a terminal, not a hang, so
 * `shepherd_status` and `ps` can show the reason and the counts.
 */
export const ShepherdEscalatedData = z.object({
  featureId: z.string(),
  prNumbers: z
    .array(z.number().int().positive())
    .describe('PRs in the stack at the time the bound was hit'),
  iterationCount: z.number().int().nonnegative().describe('Iterations run when the bound was hit'),
  maxIterations: z
    .number()
    .int()
    .positive()
    .describe('The resolved auto-fix bound that was reached (a positive integer, per escalation-policy)'),
  reason: z.string().describe('Human-readable escalation reason'),
});

export const ShepherdCompletedData = z.object({
  prUrl: z.string(),
  outcome: z.string(),
});

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

export const DiagnosticExecutedDataSchema = z.object({
  summary: DoctorOutputSchema.shape.summary,
  checkCount: z.number().int().nonnegative(),
  failedCheckNames: z.array(z.string()),
  /**
   * The names of the checks that reported a warning. The exit code does not carry a warning, so the
   * ledger needs the names. Older rows have only the failed names.
   */
  warningCheckNames: z.array(z.string()).optional(),
  durationMs: z.number().int().nonnegative(),
});

/** `invariants_add` emits it on commit. It records the invariant id, the catalog, and the tier. */
export const InvariantAuthoredDataSchema = z.object({
  id: z.string().min(1),
  catalog: z.string().min(1),
  tier: z.enum(['dev', 'user']),
  dimension: z.string().optional(),
  mode: z.enum(['audit', 'check']).optional(),
});

/**
 * `invariants_amend` emits it on commit. It records the entry, the catalog, and the fields that the
 * amendment replaced. It is separate from `invariant.authored`, so the history keeps a new rule apart
 * from a correction.
 */
export const InvariantAmendedDataSchema = z.object({
  id: z.string().min(1),
  catalog: z.string().min(1),
  tier: z.enum(['dev', 'user']),
  /** Top-level entry fields the patch replaced. Never empty. */
  fields: z.array(z.string().min(1)).min(1),
});
/** `invariants_add` emits it on the first registration of a catalog file in `.exarchos.yml`. */
export const CatalogRegisteredDataSchema = z.object({
  path: z.string().min(1),
  tier: z.enum(['dev', 'user']),
});

/**
 * The onboard trigger. `onboard` reconciles an existing repo, `onboard-new` scaffolds a new project,
 * and `doctor-fix` applies the doctor diff. All three run the same reconciler.
 */
const OnboardTriggerSchema = z.enum(['onboard', 'onboard-new', 'doctor-fix']);

/**
 * The durable intent, recorded before the reconcile runs. It carries the planned
 * {@link ReconcilePlan}, so the timeline keeps the intent after a crash. `idempotencyKey` collapses a
 * retry onto the same request.
 */
export const OnboardRequestedDataSchema = z.object({
  trigger: OnboardTriggerSchema,
  /** The structured reconcile plan (= the structured doctor diff). */
  plan: ReconcilePlanSchema,
  /** Stable key used to collapse retries onto the same logical request. */
  idempotencyKey: z.string().min(1),
});

/**
 * The result, recorded after the reconcile succeeds. It carries the {@link ReconcileResult}, the
 * `durationMs`, and the `idempotencyKey` of the paired `onboard.requested`.
 */
export const OnboardExecutedDataSchema = z.object({
  trigger: OnboardTriggerSchema,
  /** The outcome of applying the plan. */
  result: ReconcileResultSchema,
  /** Same key as the paired `onboard.requested` intent. */
  idempotencyKey: z.string().min(1),
  /** Wall-clock duration of the reconcile, in milliseconds. */
  durationMs: z.number().int().nonnegative(),
});

export const SessionTaggedData = z.object({
  tag: z.string().min(1).max(100).describe('Tag label for the session (e.g., feature name)'),
  sessionId: z.string().min(1).describe('Session identifier'),
  description: z.string().max(500).optional().describe('Optional description of what the session covers'),
  branch: z.string().optional().describe('Git branch associated with this session'),
});

/**
 * The dispatch-core interceptor emits it on the first handler call, other than rehydrate, after a
 * `workflow.rehydrated` event. It marks that the rehydrated agent started real work.
 *
 * `rehydrateSequence` is the event-store `sequence` of that `workflow.rehydrated` event, not its
 * `data.projectionSequence`. The event-store sequence is unique on the stream, so the idempotency
 * cache of `session-machinery.ts` keeps each rehydrate cycle apart. `firstActionVerb` names the
 * first real action, and `firstActionAt` is its ISO 8601 time.
 */
export const SessionMachineryConsumedDataSchema = z.object({
  rehydrateSequence: z.number().int().nonnegative(),
  firstActionVerb: z.string().min(1),
  firstActionAt: z.string().datetime(),
}).strict();

export type SessionMachineryConsumedData = z.infer<typeof SessionMachineryConsumedDataSchema>;

/**
 * The terminal of a task worktree. It needs `taskId` and `branch`, and its source is `model`. The
 * launcher uses the separate `worktree.create.*` pair for a top-level worktree with no task.
 */
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

/**
 * The preflight sub-results, as Zod copies of `AncestryResult`, `WorktreeAssertionResult`,
 * `CurrentBranchProtectionResult` and `DriftResult`. The event payload holds the failure reason, so
 * a reader does not need the workflow state file.
 */
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

/**
 * Debug data for a Windows ancestry mismatch. `merge.preflight` carries it only when
 * `EXARCHOS_PREFLIGHT_DEBUG=1` and ancestry failed, to limit event-store growth. The shape mirrors
 * `PreflightDebug` in `verbs/pure/merge-preflight.ts`.
 */
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
 * The outcome of the preflight gate before a candidate merge. A preflight failure does not go
 * through `merge.rollback`. It ends as `phase: 'aborted'` with `abortReason: 'preflight-failed'`.
 *
 * The sub-results are required when any guard runs, so the event log alone shows the failure mode.
 * They are optional only so that older events parse. `failureReasons` holds the diagnostic from
 * `describePreflightFailure` when `passed === false`.
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
  /** See `MergePreflightDebugData`. It is optional, so older events and passing runs parse. */
  debug: MergePreflightDebugData.optional(),
});

/**
 * The durable intent, recorded before the GitHub merge call. A pure `decide` closure produces it, so
 * `withStateRetry` can retry it. The merge API call runs outside the retry boundary, and a second
 * `decide` commits `merge.executed`. The projection folds it as the `requested` phase between
 * `preflight` and `executed`. `prNumber`, `taskId` and `featureId` are optional, because a local
 * merge can have no PR.
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
 * The shared instance key of the four liveness pairs: merge, launch, mutation and prune. A liveness
 * view uses `instanceId` to match a start event with its terminal. Each emitter derives it from its
 * own key:
 * - merge: `taskId`, or `sourceBranch→targetBranch`
 * - launch: `worktreeId`
 * - mutation and prune: `operationId`
 *
 * The native fields stay. The key is optional, so historical rows without it still validate.
 */
export const livenessInstanceFields = {
  instanceId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Canonical per-instance liveness key correlating a `<surface>.executing_started` event with its paired terminal (DR-2 / INV-10). Additive: absent on pre-retrofit rows.',
    ),
} as const;

/**
 * Records a performed merge. `mergeSha` is the new commit on the target branch. `rollbackSha` is the
 * parent commit captured before the merge. A rollback rewinds to it with `git merge --abort`, then
 * `git reset --keep <rollbackSha>`, and never with `--hard`.
 */
export const MergeExecutedData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  /** The operator-selected merge strategy, kept so that replay does not derive it from state. */
  strategy: z.enum(['squash', 'rebase', 'merge']).optional(),
  mergeSha: z.string().min(1),
  rollbackSha: z.string().min(1),
  /** The liveness instance key: `taskId`, or `sourceBranch→targetBranch`. */
  ...livenessInstanceFields,
});

/**
 * The retired recovery event. Its schema and type-map entry stay for replay, and nothing writes it.
 * The recovery path emits `merge.recovered`. `reason` is a closed enum, and a preflight failure is
 * never a reason. `rollbackError` holds the failure detail when the recovery ladder did not finish
 * cleanly. Then the worktree state can be indeterminate.
 */
export const MergeRollbackData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  rollbackSha: z.string().min(1),
  reason: z.enum(['merge-failed', 'verification-failed', 'timeout']),
  rollbackError: z.string().min(1).optional(),
  /**
   * The recovery outcome. `pure/execute-merge.ts` runs `git merge --abort`, then
   * `git reset --keep <rollbackSha>`. It emits `reset-keep-blocked` when `reset --keep` refuses to
   * discard local work, `reset-failed` when the reset fails, and `unexpected-mid-merge-drift` when
   * HEAD is not the anchor after recovery.
   */
  recoveryError: z
    .enum(['reset-keep-blocked', 'reset-failed', 'unexpected-mid-merge-drift'])
    .optional(),
});

/**
 * The only recovery terminal that code emits, after the recovery ladder reverts a merge. It has the
 * same closed `reason` enum as `merge.rollback`. `recoveryPointSha` is the anchor of the rewind.
 * `recoveryErrorDetail` is the failure text beside the `recoveryError` discriminator. The reducers
 * fold `merge.rollback` and this event to the same terminal state, so old streams replay the same.
 */
export const MergeRecoveredData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  recoveryPointSha: z.string().min(1),
  reason: z.enum(['merge-failed', 'verification-failed', 'timeout']),
  recoveryErrorDetail: z.string().min(1).optional(),
  /** The recovery outcome, with the same values as in `MergeRollbackData`. */
  recoveryError: z
    .enum(['reset-keep-blocked', 'reset-failed', 'unexpected-mid-merge-drift'])
    .optional(),
});

/**
 * The audit record of one retry after a transient failure. `attempt` is the retry ordinal, `delayMs`
 * is the backoff before the retry, and `reason` is the transient failure, for example `'timeout'`.
 */
export const MergeRetryAttemptData = z.object({
  attempt: z.number().int().nonnegative(),
  delayMs: z.number().int().nonnegative(),
  reason: z.string().min(1),
});

/**
 * The terminal lifecycle event, emitted directly after a successful `merge.executed`. The projection
 * folds it as the move into its terminal `completed` phase. `merge.executed` records the side
 * effect, and this event records the end of the lifecycle.
 *
 * The shape derives from `MergeExecutedData`, so a field change there reaches this event. It adds
 * an optional `featureId` for cross-stream observability.
 */
export const MergeCompletedData = MergeExecutedData.pick({
  taskId: true,
  sourceBranch: true,
  targetBranch: true,
  mergeSha: true,
}).extend({
  featureId: z
    .string()
    .optional()
    .describe('Feature stream id; useful for cross-stream observability'),
});

/**
 * Merge liveness. `handleExecuteMerge` emits it after it records the recovery point sha and before
 * the first `vcsMerge` attempt. `recoveryPointSha` is the anchor for a rewind. `startedAt` is the
 * ISO start time. `taskId` is optional, because a direct CLI call has no task.
 */
export const MergeExecutingStartedData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  recoveryPointSha: z.string().min(1),
  startedAt: z.string().min(1),
  /** The liveness instance key: `taskId`, or `sourceBranch→targetBranch`. */
  ...livenessInstanceFields,
});

/**
 * The durable intent before `gh pr create`. It holds the full PR intent, so recovery can rebuild the
 * call from the event.
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

/** Records that `gh pr create` succeeded. `operationId` pairs it with the request. */
export const PrCreateExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the pr.create.requested event'),
  prNumber: z.number().int().positive().describe('GitHub PR number'),
  url: z.string().url().describe('HTML URL of the created PR'),
});

/**
 * The durable intent before `gh pr comment`. `body` is the raw comment text. The handler adds the
 * `<!-- exarchos-op:UUID -->` marker before it posts, and the idempotency check searches for it.
 */
export const PrCommentRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — embedded as marker in posted comment'),
  prNumber: z.number().int().positive().describe('PR number being commented on'),
  body: z.string().min(1).describe('Comment body (handler embeds operationId marker before posting)'),
  threadId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Id of the review-comment thread being replied to (provider addReply path). Absent ⇒ PR-level comment via addComment.',
    ),
});

/** Records that the comment was posted. */
export const PrCommentExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the pr.comment.requested event'),
  commentId: z.number().int().positive().describe('GitHub comment id'),
  url: z.string().url().describe('HTML URL of the posted comment'),
});

/**
 * The durable intent before `gh issue create`. It holds the full issue intent, so recovery can
 * rebuild the call. The idempotency check searches existing issues for the `operationId` marker.
 */
export const IssueCreateRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — embedded as marker in issue body or label'),
  title: z.string().min(1).describe('Issue title'),
  body: z.string().describe('Issue body markdown'),
  labels: z.array(z.string()).optional().describe('Label names to apply'),
  assignees: z.array(z.string()).optional().describe('GitHub usernames to assign'),
});

/** Records that the issue was created. */
export const IssueCreateExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the issue.create.requested event'),
  issueNumber: z.number().int().positive().describe('GitHub issue number'),
  url: z.string().url().describe('HTML URL of the created issue'),
});

/**
 * The durable intent before `git branch -D`, `git push origin --delete`, or both. Both commands fail
 * when the branch is absent, and the handler ignores that failure.
 */
export const BranchDeleteRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — stable across retries'),
  branch: z.string().min(1).describe('Branch name to delete'),
  remote: z.string().optional().describe("Remote name (defaults to 'origin' when omitted)"),
  localOnly: z.boolean().optional().describe('When true, skip the push --delete step'),
});

/** Records the outcome of the delete. Both flags are false when the branch was already absent. */
export const BranchDeleteExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the branch.delete.requested event'),
  branch: z.string().min(1).describe('Branch that was targeted'),
  deletedLocally: z.boolean().describe('True if local branch was removed'),
  deletedRemote: z.boolean().describe('True if remote tracking ref was removed'),
});

/**
 * The durable intent before `git worktree remove`. The idempotency check filters `git worktree list`.
 *
 * `worktreeId` is the optional canonical projection key that `WorktreeManager` stamps. The
 * `worktrees@v1` reducer drops the entry by this key and calls no `realpath()` at fold time. So the
 * cold rebuild is deterministic from the event log alone. An older event without it falls back to a
 * canonical form of `worktreePath`.
 */
export const WorktreeRemoveRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — stable across retries'),
  worktreePath: z.string().min(1).describe('Absolute path of the worktree to remove'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Canonical worktrees@v1 key, stamped so replay drops by stored id (no realpath at fold time)'),
});

/**
 * Records the outcome of the removal. `removed: false` means that the worktree was already absent.
 * It carries the same optional `worktreeId` as {@link WorktreeRemoveRequestedData}.
 */
export const WorktreeRemoveExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the worktree.remove.requested event'),
  worktreePath: z.string().min(1).describe('Path that was targeted'),
  removed: z.boolean().describe('True if removed; false if already absent (idempotent success)'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Canonical worktrees@v1 key, stamped so replay drops by stored id (no realpath at fold time)'),
});

/**
 * The shared payload of the worktree lifecycle events: adopted, reserved, released and
 * orphan_detected. `worktreeId` is the canonical (symlink-resolved) worktree path. Deletion reuses
 * the `worktree.remove.*` pair.
 *
 * The idempotency key is `<eventType>:<operationId>`, and callers build it. Each invocation has its
 * own `operationId`, so reserve, release, and reserve again give three keys.
 *
 * `ownerPid` is non-null only on `worktree.reserved`. There, `ownerStartedAt` is a non-empty
 * create-time fingerprint, or null when the platform cannot resolve it, and never `''`.
 */
const WorktreeLifecycleBaseData = z.object({
  worktreeId: z.string().min(1).describe('Canonical (symlink-resolved) worktree path — stable identity'),
  path: z.string().min(1).describe('Absolute filesystem path to the worktree'),
  featureId: z.string().min(1).nullable().describe('Owning feature id, or null when unattached'),
  operationId: z.string().uuid().describe('Idempotency key — stable across retries of one invocation'),
});

export const WorktreeAdoptedData = WorktreeLifecycleBaseData.extend({
  ownerPid: z.number().int().nullable().describe('PID of the holder, or null'),
  ownerStartedAt: z.string().nullable().describe('Holder process start time (ISO 8601), or null'),
});

export const WorktreeReservedData = WorktreeLifecycleBaseData.extend({
  ownerPid: z.number().int().describe('PID of the reserving process (non-null for reservations)'),
  ownerStartedAt: z
    .string()
    .min(1)
    .nullable()
    .describe('Reserving process start time (ISO 8601) — non-empty when resolved, or null when the platform cannot resolve create-time (DR-5, never the empty string)'),
});

export const WorktreeReleasedData = WorktreeLifecycleBaseData.extend({
  ownerPid: z.number().int().nullable().describe('PID of the prior holder, or null'),
  ownerStartedAt: z.string().nullable().describe('Prior holder process start time (ISO 8601), or null'),
});

export const WorktreeOrphanDetectedData = WorktreeLifecycleBaseData.extend({
  ownerPid: z.number().int().nullable().describe('PID recorded on the orphaned reservation, or null'),
  ownerStartedAt: z.string().nullable().describe('Start time recorded on the orphaned reservation, or null'),
});

/**
 * The claim half of the serialized-merge lease. It is an intent to merge, and it also records the
 * live process that can merge `sourceBranch` into `integrationRef`. `worktree.merge_executed` is the
 * release half.
 *
 * Both events are on the singleton `worktrees` stream, and `operationId` is the only discriminator.
 * Two merge attempts onto one `integrationRef` get two keys, so they never collapse. `holderPid` and
 * `holderStartedAt` identify the lease holder for orphan reclamation.
 */
export const WorktreeMergeRequestedData = z.object({
  integrationRef: z.string().min(1).describe('Integration ref the merge targets (the per-branch serialization key)'),
  sourceBranch: z.string().min(1).describe('Branch being merged into integrationRef'),
  operationId: z.string().min(1).describe('Idempotency key / lease correlator — the sole per-merge discriminator'),
  holderPid: z.number().int().describe('PID of the live process holding the merge lease (liveness ground truth)'),
  holderStartedAt: z
    .string()
    .min(1)
    .nullable()
    .describe('Lease-holder process start time (ISO 8601) — disambiguates PID reuse; null when the platform cannot resolve it'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Canonical worktrees@v1 key, when the merge is attributable to a specific tracked worktree'),
});

/**
 * The release half of the serialized-merge lease, paired by `operationId`. `mergeSha` is present
 * only on `status: 'merged'`. `recoveryError` is set when dead-holder recovery released the lease.
 */
export const WorktreeMergeExecutedData = z.object({
  integrationRef: z.string().min(1).describe('Integration ref the merge targeted (matches the requested event)'),
  operationId: z.string().min(1).describe('Correlates to the worktree.merge_requested event'),
  status: z.enum(['merged', 'aborted', 'failed']).describe('Terminal outcome of the merge operation'),
  mergeSha: z.string().min(1).optional().describe('Resulting integration commit SHA — present only on status "merged"'),
  recoveryError: z
    .string()
    .min(1)
    .optional()
    .describe('Diagnostic captured when the lease was released during dead-holder recovery'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Canonical worktrees@v1 key the released lease was attributable to, when known'),
});

/**
 * The intent before `git worktree add` for the top-level worktree of the launcher, paired by
 * `operationId`. It is separate from `worktree.created`, which needs a task. `worktreeId` is the
 * optional canonical key, so a reducer folds without a `realpath()` call.
 */
export const WorktreeCreateRequestedData = z.object({
  operationId: z.string().uuid().describe('Idempotency key — stable across retries'),
  worktreePath: z.string().min(1).describe('Absolute path of the top-level worktree to create'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Canonical worktrees@v1 key, stamped so replay folds by stored id (no realpath at fold time)'),
  branch: z
    .string()
    .min(1)
    .optional()
    .describe(
      'New branch (git worktree add -b) captured in the durable intent so crash-resume replays the ORIGINAL command instead of deriving a branch from the path basename (INV-13). Omitted when git derives the branch from the path.',
    ),
  startPoint: z
    .string()
    .min(1)
    .optional()
    .describe('Start-point commit-ish captured in the intent so crash-resume replays it faithfully (INV-13).'),
});

/**
 * The terminal for {@link WorktreeCreateRequestedData}, paired by `operationId`. `created: false`
 * means that the worktree already existed.
 */
export const WorktreeCreateExecutedData = z.object({
  operationId: z.string().uuid().describe('Correlates to the worktree.create.requested event'),
  worktreePath: z.string().min(1).describe('Path that was targeted'),
  created: z.boolean().describe('True if created; false if already present (idempotent success)'),
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe('Canonical worktrees@v1 key, stamped so replay folds by stored id (no realpath at fold time)'),
});

/**
 * Liveness start of the launcher child process. `holderPid` and `holderStartedAt` identify the
 * child, like the fields of {@link InFlightMerge}. A dead-holder reconciler can probe them to
 * reclaim an abandoned launch, and the start time defeats PID reuse. `worktreeId` binds the launch to
 * its worktree.
 */
export const LaunchExecutingStartedData = z.object({
  worktreeId: z.string().min(1).describe('Canonical worktrees@v1 key of the launch top-level worktree'),
  holderPid: z.number().int().describe('PID of the live child process holding the launch (liveness ground truth)'),
  holderStartedAt: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'Supervisor process start time (ISO 8601) — disambiguates PID reuse; non-empty when resolved, or null when the platform cannot resolve create-time (DR-6, never the empty string)',
    ),
  /** The liveness instance key: `worktreeId`. */
  ...livenessInstanceFields,
});

/**
 * Liveness terminal of the launcher child process: the child exited. `worktreeId` pairs it with its
 * start. `exitCode` is null after a signal, or when no code was captured.
 */
export const LaunchExecutedData = z.object({
  worktreeId: z.string().min(1).describe('Canonical worktrees@v1 key of the launch top-level worktree'),
  exitCode: z.number().int().nullable().describe('Child process exit code, or null when signalled / not captured'),
  /** The liveness instance key: `worktreeId`. */
  ...livenessInstanceFields,
});

/**
 * The runtime resolver for test, typecheck and install emits `command.resolved`. It records the
 * source of each resolution. It is audit-only, and no state reducer folds it.
 *
 * The union discriminates on `source`, so the schema rejects a contradictory shape. Graceful-skip
 * logic relies on `source === 'unresolved'` with `command === null` and a non-empty `remediation`.
 */
const CommandResolvedBase = z.object({
  field: z.enum(['test', 'typecheck', 'install']),
  repoRoot: z.string().min(1),
});

export const CommandResolvedEventSchema = z.discriminatedUnion('source', [
  CommandResolvedBase.extend({
    /**
     * `toolchain-config` is the user `toolchains:` in `.exarchos.yml`. `task-runner` is Taskfile, just,
     * mise, or Makefile.
     */
    source: z.enum(['config', 'detection', 'override', 'toolchain-config', 'task-runner']),
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

/**
 * Telemetry for the HSM single-path migration. Each call of a deprecated action, for example
 * `workflow.set({phase})`, emits one event. Both fields are required non-empty strings, so an event
 * without telemetry fails at the schema boundary.
 */
export const HsmDeprecatedActionInvokedData = z.object({
  action: z.string().min(1).describe('Deprecated action identifier'),
  invokedBy: z.string().min(1).describe('Caller surface that invoked the deprecated action'),
});

/**
 * Emitted in spec validation when a spec uses the legacy `capabilities[]` array shape. An empty
 * legacy array is still a legacy signal, so `capabilities` can be empty.
 */
export const SpecLegacyCapabilitiesArrayData = z.object({
  specName: z.string().min(1).describe('Spec name carrying the legacy capabilities array'),
  capabilities: z.array(z.string()).describe('Capability identifiers in the legacy array shape'),
});

/**
 * A historical event type for a phase without a typed `staleness` contract. Nothing emits it,
 * because the topology loader throws on such a phase. The schema stays so that v2.10 event logs
 * decode. New code must not emit it.
 */
export const PhaseContractMissingData = z.object({
  phaseName: z.string().min(1).describe('Phase missing a typed contract'),
});

/**
 * The closed phase-kind set, a copy of `PhaseKind` in `workflow/phase-kind.ts`. It is inlined
 * because `phase-kind.ts` pulls in resolvers that the event store must not depend on. A drift-guard
 * test pins it to `KIND_OBLIGATIONS`.
 */
export const PhaseBlockedKindSchema = z.enum([
  'IMPLEMENT',
  'PLAN',
  'REVIEW',
  'SYNTHESIZE',
  'MERGE',
  'GATHER',
]);

/**
 * A gate-set resolver fault that failed closed. `handlePrepareDelegation` appends it when
 * `classifyTasksFailClosed` reports a fault for a wave. The transition guard appends it when
 * gate-set resolution fails at a phase boundary. `kind` is the faulted phase kind, `phase` is the
 * lifecycle phase, and `error` holds the resolver fault.
 */
export const PhaseBlockedData = z.object({
  phase: z.string().min(1).describe('Lifecycle phase the dispatch was blocked at'),
  kind: PhaseBlockedKindSchema.describe('Phase kind whose gate-set resolver faulted'),
  reason: z.string().min(1).describe('Operator-visible skip reason for the blocked dispatch'),
  error: z
    .object({
      code: z.string().min(1).describe('Stable error code for the resolver fault'),
      message: z.string().min(1).describe('Underlying resolver error message'),
    })
    .describe('The underlying gate-set resolver fault that triggered the block'),
});

/** The gate resolver that produced the obligation of a `phase.entered` event. */
export const PhaseEnteredResolverSchema = z.enum([
  'verification-ladder',
  'plan-structure',
  'review-contract',
  'synthesis-readiness',
]);

export const ResolvedGateFamilySchema = z.enum(['ladder', 'plan', 'review', 'synthesis']);

/**
 * The POLA posture of a phase kind. It is inlined, so the event store does not import
 * `runtime/agents/spec.ts`. A drift-guard test pins it to the posture set of `KIND_OBLIGATIONS`.
 */
export const PhaseEnteredPostureSchema = z.enum(['read-only', 'task-isolated', 'shared-mutating']);

/**
 * The resolve-then-freeze record. `executeTransition` resolves the gate-set of the target kind and
 * appends one `phase.entered` with the obligation. Replay folds the same obligation, so a later
 * policy edit cannot change a frozen phase. Each `gate` is an opaque string, because
 * `phase-kind.ts` and `review-contract.ts` own the gate vocabulary.
 */
export const PhaseEnteredData = z.object({
  phase: z.string().min(1).describe('Lifecycle phase entered'),
  kind: PhaseBlockedKindSchema.describe('Phase kind whose obligation was resolved and frozen'),
  resolver: PhaseEnteredResolverSchema.nullable().describe(
    'Gate-resolver name that produced the obligation; null for a kind with no gates (GATHER)',
  ),
  resolvedGates: z
    .array(
      z.object({
        family: ResolvedGateFamilySchema.describe('ResolvedGate discriminant family'),
        gate: z
          .string()
          .min(1)
          .describe('Resolved gate identifier (vocabulary owned by phase-kind.ts / review-contract.ts)'),
      }),
    )
    .describe('The frozen ordered gate-set the phase must satisfy'),
  policySource: z
    .enum(['builtin', 'config'])
    .describe('Whether the obligation came from built-in policy or a .exarchos.yml overlay'),
  mode: z.enum(['audit', 'enforce']).describe('Resolved enforcement mode for the phase gate-set'),
  posture: PhaseEnteredPostureSchema.describe(
    'The kind POLA posture (trust tier) frozen at entry — the bundle minted by capabilities/resolver.ts is derived from this (DR-14)',
  ),
  /**
   * The planning depth of the feature, frozen at PLAN entry. Only the PLAN `phase.entered` has it.
   * When it is absent, the resolver uses `standard`. A test pins the inlined enum to `DesignDepth`.
   */
  designDepth: z
    .enum(['thin', 'standard', 'deep'])
    .optional()
    .describe('Feature planning depth frozen at PLAN entry (DR-3); absent ⇒ standard'),
  /**
   * The risk coordinate of the resolved gate-set, frozen with it, so a replay does not resolve again
   * from current state. `unknown` records that nobody classified the task. Older logs do not have it.
   */
  riskTier: z
    .enum(['low', 'medium', 'high', 'unknown'])
    .optional()
    .describe(
      'Risk tier the obligation was resolved at; "unknown" = no trustworthy claim (DR-10)',
    ),
  boundaryTouching: z
    .boolean()
    .optional()
    .describe('Boundary-touching flag the obligation was resolved at (DR-10)'),
});

export const PhaseExitedData = z.object({
  phase: z.string().min(1).describe('Lifecycle phase exited'),
  allRequiredGatesPassed: z
    .boolean()
    .describe('Aggregate status: did every required (enforce-mode) gate pass before advance'),
});

/**
 * The per-file completion event of the JSONL to SQLite importer. A file with zero events is a valid
 * import.
 *
 * `sourcePath` is relative to the state directory. The schema rejects POSIX and Windows absolute
 * paths, because they put machine-specific names into the event log and block replay on another
 * machine.
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
 * The final aggregate event after a successful JSONL to SQLite migration. A run with zero files
 * still records completion, so sibling processes unblock without a new run.
 */
export const MigrationCompletedData = z.object({
  filesImported: z.number().int().nonnegative().describe('Total JSONL files successfully imported'),
  eventsImported: z.number().int().nonnegative().describe('Total events successfully imported'),
  totalDurationMs: z.number().nonnegative().describe('Total wall-clock import duration in milliseconds'),
});

/**
 * Emitted when the JSONL to SQLite importer fails. It holds the operator-facing reason and the
 * partial counts, so an operator can retry from a known point.
 */
export const MigrationFailedData = z.object({
  reason: z.string().min(1).describe('Operator-facing failure reason'),
  partialFilesImported: z.number().int().nonnegative().describe('Files imported before the failure'),
  partialEventsImported: z.number().int().nonnegative().describe('Events imported before the failure'),
});

/**
 * Emitted once in the V3 → V4 migration for each stream with no `workflow_type` in its state file.
 * The row stays at the `__legacy` sentinel until an operator edits the state file and runs the
 * migration again. The event is on the affected stream. `data.streamId` repeats the envelope
 * `streamId` for aggregators that index on `data`.
 */
export const MigrationWorkflowTypeUnknownData = z.object({
  streamId: z.string().min(1).describe('Affected stream / featureId'),
});

/**
 * Emitted once for each 1,000-row chunk of the V5 → V6 correlation-column backfill, on the
 * `__migration__` stream. `rowsBackfilled` is the row count that the chunk UPDATE targets, not the
 * SQLite `changes()` count. `totalRowsRemaining` is the count still to backfill after the chunk. No
 * final event exists. The ledger stamp `schema_version.version = 6` marks completion.
 */
export const MigrationCorrelationBackfillProgressData = z.object({
  rowsBackfilled: z.number().int().nonnegative().describe('Rows targeted by this chunk (chunk size, not SQLite changes())'),
  totalRowsRemaining: z
    .number()
    .int()
    .nonnegative()
    .describe('Rows whose correlation_id is still NULL after this chunk'),
});

/**
 * `resolveWorkspace` emits it when the dispatch boundary resolves a missing `featureId` from one MCP
 * root or from the cwd walk. `source` records the branch. `path` is the absolute workspace root.
 */
export const WorkspaceResolvedData = z.object({
  source: z.enum(['roots', 'cwd']),
  /** An absolute POSIX or Windows path, because both surfaces use `path.resolve()`. */
  path: z
    .string()
    .min(1)
    .refine(
      (p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p),
      { message: 'path must be absolute (POSIX or Windows)' },
    ),
  featureId: z.string().min(1),
});

/**
 * `dispatch/elicitation-dispatch.ts` emits it before the `elicitation/create` round trip.
 * `operationId` pairs it with `elicitation.fulfilled`. `field` is the missing required parameter.
 * `schema` is a JSON Schema fragment from `.pick({field: true})`. Its type is a loose record, so the
 * validator does not drift with each action schema.
 */
export const ElicitationRequestedData = z.object({
  operationId: z.string().min(1),
  field: z.string().min(1),
  schema: z.record(z.string(), z.unknown()),
});

/**
 * `dispatch/elicitation-dispatch.ts` emits it after the client returns a value. `operationId`
 * matches the request. `value` is `unknown`, because the caller supplies the schema.
 */
export const ElicitationFulfilledData = z.object({
  operationId: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
});

/**
 * Emitted after the round trip when the client returned `value === undefined` (decline or cancel).
 * It has the shape of {@link ElicitationFulfilledData} without `value`.
 */
export const ElicitationDeclinedData = z.object({
  operationId: z.string().min(1),
  field: z.string().min(1),
});

/**
 * Emitted on `createTask`. `request` is the original JSON-RPC request, stored as it is, so `getTask`
 * can rebuild the request. A `ttl` of null means an unlimited lifetime.
 */
export const TaskCreatedData = z.object({
  taskId: z.string().min(1),
  createdBy: z.string().min(1).optional(),
  ttl: z.union([z.number().int().nonnegative(), z.null()]),
  request: z.unknown(),
  /**
   * The caller poll cadence, persisted so that replay in `projectTask` restores it. Without it, a
   * restart gives the 1000 ms default. Older events do not have it.
   */
  pollInterval: z.number().int().positive().optional(),
  /**
   * The JSON-RPC `requestId`, so replay recovers the original correlation id. Older events do not
   * have it, and `projectTask` then synthesizes `replayed:${taskId}`. The type mirrors the SDK
   * `RequestId`.
   */
  requestId: z.union([z.string(), z.number()]).optional(),
});

/**
 * Emitted on each `getTask` read. The envelope `sequence` is the poll order, and consumers must use
 * it. New events omit `data.sequence`.
 *
 * @deprecated Use `envelope.sequence`. The optional `sequence` field stays only for historical events.
 */
export const TaskPolledData = z.object({
  taskId: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
});

/**
 * Emitted on a terminal task transition. `result` is the SDK `Result` on success, and `error` is a
 * message on failure. A `cancelled` terminal carries neither.
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

/**
 * `verbs/team/dispatch-guard.ts` emits it after the dispatch boundary runs all preflight guards. It
 * records each guard result, an aggregate `passed` flag, and the total `durationMs`. The guards:
 * - `ancestry`: `validateBranchAncestry`
 * - `worktree`: `assertMainWorktree`
 * - `protectedBranch`: `assertCurrentBranchNotProtected`
 * - `mainWorktree`: a reserved slot that mirrors `worktree.passed`
 *
 * `stampWithDispatchContext` in `events/store.ts` adds the `operationId` of the active dispatch.
 */
export const DispatchPreflightData = z.object({
  guards: z.object({
    ancestry: z.object({ passed: z.boolean() }),
    worktree: z.object({ passed: z.boolean() }),
    protectedBranch: z.object({ passed: z.boolean() }),
    mainWorktree: z.object({ passed: z.boolean() }),
    /**
     * The base-pin guard of a native-isolation worktree. Only the `nativeIsolation` path runs it, so it
     * is optional.
     */
    baseRef: z.object({ passed: z.boolean() }).optional(),
  }),
  passed: z.boolean(),
  durationMs: z.number().nonnegative(),
});

/**
 * `verbs/team/dispatch-guard.ts` emits it when the worktree under dispatch has a non-empty
 * `git stash list`. Worktrees of one repository share the stash, so a sibling agent can pop the
 * wrong entry. The event is advisory and does not block the dispatch. `stashRef` is the newest entry.
 */
export const StashDetectedData = z.object({
  worktreePath: z.string().min(1),
  stashRef: z.string().min(1),
});

/** Emitted at the start of a (non-dry-run) mutation-adequacy run. */
export const MutationExecutingStartedData = z.object({
  /** The resolved mutation command, for example `npx stryker run`. */
  command: z.string().min(1),
  /** Repo root the command runs in. */
  repoRoot: z.string().min(1),
  /**
   * The directory where the runner executed. A package-local mutation config makes it the package
   * directory, not `repoRoot`. Zod strips an undeclared field, so the schema declares it.
   */
  cwd: z.string().min(1).optional(),
  /** The liveness instance key: `operationId`. */
  ...livenessInstanceFields,
});

/** Paired terminal event: the mutation run completed (pass/fail + exit code). */
export const MutationExecutedData = z.object({
  command: z.string().min(1),
  repoRoot: z.string().min(1),
  /** Where the runner executed — see {@link MutationExecutingStartedData.cwd}. */
  cwd: z.string().min(1).optional(),
  /** True when the mutation command exited 0. */
  passed: z.boolean(),
  /** The child process exit code. */
  exitCode: z.number().int(),
  /** The liveness instance key: `operationId`. */
  ...livenessInstanceFields,
});

/**
 * An agent friction report. `sessionContext` records the workflow, action and error code.
 * `configuredEndpoint` is the `feedback.upstream` URL at emit time, or null. `upstreamDelivered`
 * records whether the best-effort POST succeeded, and the local write always succeeds. The object
 * is not strict, so an additive field keeps older rows valid.
 */
export const FeedbackRecordedData = z.object({
  message: z.string().min(1),
  sessionContext: z
    .object({
      workflow: z.string().optional(),
      action: z.string().optional(),
      errorCode: z.string().optional(),
    })
    .optional(),
  configuredEndpoint: z.string().nullable().optional(),
  upstreamDelivered: z.boolean().optional(),
});

/** Emitted at the start of a `prune_worktrees` pass. */
export const PruneExecutingStartedData = z.object({
  /** Correlation key + `inFlightPrunes` map key — one per prune pass. */
  operationId: z.string().min(1),
  /** Repo root the prune pass governs. */
  repoRoot: z.string().min(1),
  /** PID of the live process running the prune (liveness ground truth). */
  holderPid: z.number().int(),
  /**
   * The holder process create time (ISO 8601), so a dead-holder reconciler can detect PID reuse. It
   * is `null`, never `''`, when the platform cannot resolve it.
   */
  holderStartedAt: z.string().min(1).nullable(),
  /** The liveness instance key: `operationId`. */
  ...livenessInstanceFields,
});

/**
 * The audit record of a prune evaluation. A rejected entry can have no readable `featureId`, so that
 * field is optional and `reasons` holds the detail.
 */
export const PruneDiagnosticsData = z.object({
  malformedCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  malformedEntries: z.array(
    z.object({
      featureId: z.string().optional(),
      reasons: z.array(z.string()),
    }),
  ),
  advisory: z.string().optional(),
});

/** The paired terminal: the `prune_worktrees` pass completed. */
export const PruneExecutedData = z.object({
  operationId: z.string().min(1),
  /** How many worktrees the pass deleted (0 on a dry-run or a no-op pass). */
  deletedCount: z.number().int().nonnegative(),
  /** The liveness instance key: `operationId`. */
  ...livenessInstanceFields,
});

/**
 * The durable intent before the zip write. `outputPath` is the resolved absolute destination, so the
 * timeline shows the target after a crash. `idempotencyKey` collapses a crash retry onto the same
 * request, and the emitter builds the storage key from it.
 */
export const ExportRequestedData = z.object({
  featureId: z.string().min(1).describe('The workflow/feature stream being exported'),
  outputPath: z
    .string()
    .min(1)
    .describe(
      'RESOLVED absolute destination path for the zip bundle — the intent recorded before the write (default ./<featureId>-export.zip, resolved by the handler before emit)',
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .describe(
      'Stable key (INV-8) collapsing crash-retries of the same logical export onto one intent; a fresh export invocation mints a distinct key',
    ),
});

/**
 * The result after the zip write succeeds. The crash precheck compares `contentHash` with the zip on
 * disk. `missingArtifacts` lists referenced artifacts that were absent. `idempotencyKey` pairs it
 * with its `export.requested`.
 */
export const ExportExecutedData = z.object({
  featureId: z.string().min(1).describe('The workflow/feature stream that was exported'),
  outputPath: z.string().min(1).describe('Path the zip bundle was written to (matches the requested event)'),
  contentHash: z
    .string()
    .min(1)
    .describe(
      'Content hash of the written zip bundle — the INV-13 crash precheck compares it against the on-disk manifest to decide re-emit vs redo',
    ),
  eventCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of events in the exported stream extract (recorded in metadata.json)'),
  missingArtifacts: z
    .array(z.string().min(1))
    .optional()
    .describe('Referenced artifact paths that did not exist on disk — tolerated, listed in the bundle metadata'),
  idempotencyKey: z
    .string()
    .min(1)
    .describe('Same key as the paired export.requested intent (INV-8)'),
});

/**
 * The fields of every VCS ledger event, which the ledger fold reads. `epoch` gives the fencing
 * token, `idempotencyKey` keys the replay cache, and `kind` names the mutation family. The two
 * terminals are separate types, so "compensated" and "executed" differ without a status field.
 */
const vcsLedgerCommonFields = {
  kind: z
    .string()
    .min(1)
    .describe('Mutation family for the audit trail (e.g. branch.create, worktree.add)'),
  idempotencyKey: z
    .string()
    .min(1)
    .describe(
      'Caller-supplied key; a duplicate replays the recorded terminal and performs no second effect',
    ),
  epoch: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Monotonic fencing token of the requesting owner; a writer below the ledger high-water mark has lost ownership and is rejected',
    ),
};

/**
 * The durable intent, appended before the git effect. An intent without a terminal is recoverable.
 * The effect probes before it mutates, so a re-run of the key does nothing or completes the mutation.
 */
export const VcsRequestedData = z.object({ ...vcsLedgerCommonFields });

/**
 * The success terminal, appended after the effect succeeds. A later request with the same key gets
 * `result` back verbatim, so a duplicate create cannot occur.
 */
export const VcsExecutedData = z.object({
  ...vcsLedgerCommonFields,
  result: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The effect outcome, replayed verbatim to a duplicate request bearing the same key'),
});

/**
 * The failure terminal, appended after a failed effect and its compensation. A partial multi-step
 * create undoes the state it made. This terminal is sticky: it is never checked again and never
 * re-runs.
 */
export const VcsCompensatedData = z.object({
  ...vcsLedgerCommonFields,
  error: z.string().optional().describe('Failure message captured from the effect carrier'),
});

/**
 * The durable record that `install/atomic-promotion.ts` promoted a staged tree. It records the
 * commit rename, which is the one non-idempotent step of an install. It is one event, not a pair.
 * The promoter recovers interrupted attempts from its own journal, and a failed promotion rolls back.
 *
 * The payload is the identity of the promotion: the destination, the verified tree digest, the
 * owner, and whether it recovered an earlier attempt. It omits `directoryDurability`, which is a
 * platform capability that `utils/atomic-write.ts` owns.
 */
export const PromotionExecutedData = z.object({
  target: z
    .string()
    .min(1)
    .describe('Absolute destination directory the staged tree was promoted into'),
  treeDigest: z
    .string()
    .min(1)
    .describe('Content-addressed digest of the promoted tree, as verified before the commit rename'),
  owner: z
    .string()
    .min(1)
    .describe('Effect owner recorded in the promotion plan — the code that performed the promotion'),
  recoveredPriorAttempt: z
    .boolean()
    .describe(
      'True when a journal left by an interrupted earlier attempt was recovered before this promotion ran',
    ),
});

/**
 * The registration state of an event that landed although its registration says that nothing emits
 * it. It mirrors `NonEmittingLifecycle` in `emission-verifier.ts`: the lifecycle axis without
 * `active`. A new member must go in both places.
 */
export const NonEmittingLifecycle = z.enum(['planned', 'retired']);
export type NonEmittingLifecycle = z.infer<typeof NonEmittingLifecycle>;

/** One event that landed while its own registration says nothing emits it. */
export const LifecycleViolationEntry = z.object({
  event: z.string().min(1).describe('The event name that landed'),
  lifecycle: NonEmittingLifecycle.describe('The registration state that says nothing emits it'),
});
export type LifecycleViolationEntry = z.infer<typeof LifecycleViolationEntry>;

/**
 * An operation finished with its emission contract broken on one of two axes. Either an
 * unconditionally declared event did not land, or an event landed that its registration says nothing
 * emits. The payload names the action, the broken contract, and the `operationId` of the run.
 *
 * Each axis field holds the full set, not the first miss. Each axis can be empty, but the refinement
 * rejects a report with no evidence on either axis.
 */
export const EmissionViolatedData = z
  .object({
    action: z
      .string()
      .min(1)
      .describe('The dispatched action whose handler completed without its declared emissions'),
    missingEvents: z
      .array(z.string().min(1))
      .describe(
        'Every unconditionally declared event name that did not land — the full set, not the first miss',
      ),
    lifecycleViolations: z
      .array(LifecycleViolationEntry)
      .optional()
      .describe(
        'Every landed event whose own registration says nothing emits it — the full set, not the first',
      ),
    operationId: z
      .string()
      .min(1)
      .describe('Identifier of the dispatch operation the verifier assessed, joining this finding to that run'),
  })
  .refine(
    (data) => data.missingEvents.length > 0 || (data.lifecycleViolations?.length ?? 0) > 0,
    {
      message: 'emission.violated requires evidence on at least one axis: missingEvents or lifecycleViolations',
    },
  );

/**
 * The closed set of cursor and tail disagreement directions. It mirrors
 * `ProjectionDegradationReason` in `projections/freshness.ts`, and a new member must go in both
 * places.
 */
export const ProjectionDegradedReason = z.enum([
  /** The fold stops short of the durable tail — the answer omits recent events. */
  'projection-behind',
  /** The fold claims events past the durable tail — fold and log contradict. */
  'projection-ahead',
]);
export type ProjectionDegradedReason = z.infer<typeof ProjectionDegradedReason>;

/**
 * The folds of a stream disagree with its durable event tail. The record is durable, so another
 * process, or this one after a restart, can tell "no tasks completed" from "the fold has not seen
 * the events". `streamId` is the assessed stream and the fold key. The event itself is on
 * `meta/projection-health`.
 */
export const ProjectionDegradedData = z.object({
  streamId: z
    .string()
    .min(1)
    .describe('The assessed stream — NOT the stream this event lives on (meta/projection-health)'),
  reason: ProjectionDegradedReason,
  eventTail: z
    .number()
    .int()
    .nonnegative()
    .describe('MAX(events.sequence) observed for the assessed stream at detection time'),
  projectionCursor: z
    .number()
    .int()
    .nonnegative()
    .describe('The trailing (worst) projection cursor observed for the assessed stream'),
  lag: z
    .number()
    .int()
    .describe('eventTail - projectionCursor; negative when a projection runs ahead of the log'),
  staleViews: z
    .array(z.string().min(1))
    .describe('Projections that disagree with the tail, worst first'),
});

/**
 * The paired resolution. It is published only when a stream with an unresolved
 * `projection.degraded` record caught the tail, so the folded health state can return to healthy.
 */
export const ProjectionRecoveredData = z.object({
  streamId: z
    .string()
    .min(1)
    .describe('The assessed stream whose folds have caught the durable tail'),
  eventTail: z.number().int().nonnegative(),
  projectionCursor: z.number().int().nonnegative(),
});

/**
 * The event version of the internal admission proof events. These schemas are a replay contract
 * only: no public action arguments, no generic append, no policy evaluation, and no transition
 * enforcement. The domain fields reuse `workflow/admission/types.ts`, so the unions cannot drift.
 */
export const AdmissionProofEventVersionSchema = z.literal('1.0');

const AdmissionFactIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'admission fact IDs may contain only letters, digits, dot, underscore, colon, and hyphen',
  );

const AdmissionPolicyVersionSchema = z.string().trim().min(1).max(128);
const AdmissionRecordedAtSchema = z.string().datetime({ offset: true });

const TrustedAdmissionProvenanceFields = {
  caller: AttributedPrincipalV1Schema,
  authorization: AuthorizationSnapshotV1Schema,
} as const;

/** Frozen resolution of one runtime requirement against immutable inputs. */
export const AdmissionRequirementResolvedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    resolutionId: AdmissionFactIdSchema,
    operationId: OperationIdSchema,
    policyId: PolicyIdSchema,
    policyVersion: AdmissionPolicyVersionSchema,
    policyDigest: ContentDigestV1Schema,
    requirementSetDigest: ContentDigestV1Schema,
    inputDigest: ContentDigestV1Schema,
    resolvedAt: AdmissionRecordedAtSchema,
    requirement: AdmissionRequirementV1Schema,
  })
  .strict()
  .readonly();

/** A durable evidence fact. The runtime evidence union owns the subject and the provenance. */
export const AdmissionEvidenceRecordedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    evidence: AdmissionEvidenceV1Schema,
    /**
     * The explicit append-only rerun link. Attribution comes from the producer snapshot of the
     * superseding evidence. Replay never rewrites the predecessor.
     */
    supersedesEvidenceId: EvidenceIdSchema.optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.supersedesEvidenceId === record.evidence.evidenceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedesEvidenceId'],
        message: 'evidence cannot supersede itself',
      });
    }
  })
  .readonly();

/** Internal transition decision record, never a public transition carrier. */
export const AdmissionTransitionDecidedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    subject: EvidenceSubjectV1Schema,
    decision: AdmissionDecisionRecordV1Schema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

/** Append-only issue/revoke/supersede waiver provenance. */
export const AdmissionWaiverRecordedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    provenance: WaiverProvenanceV1Schema,
  })
  .strict()
  .readonly();

/** Active, non-superseding evidence disagreement. */
export const AdmissionContradictionRecordedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    contradictionId: AdmissionFactIdSchema,
    phaseAttemptId: PhaseAttemptIdSchema,
    policyId: PolicyIdSchema,
    policyDigest: ContentDigestV1Schema,
    /** New writers add it. Historical V1 facts derive it from `evidenceIds`. */
    requirementId: RequirementIdSchema.optional(),
    subject: EvidenceSubjectV1Schema,
    evidenceIds: z.array(EvidenceIdSchema).min(2).readonly(),
    evidenceSetDigest: ContentDigestV1Schema,
    detectedAt: AdmissionRecordedAtSchema,
  })
  .strict()
  .readonly();

/** Authorized intent to reconsider a prior immutable decision under a policy. */
export const AdmissionReassessmentRequestedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    reassessmentId: AdmissionFactIdSchema,
    operationId: OperationIdSchema,
    phaseAttemptId: PhaseAttemptIdSchema,
    priorDecisionId: DecisionIdSchema,
    policyId: PolicyIdSchema,
    policyVersion: AdmissionPolicyVersionSchema,
    policyDigest: ContentDigestV1Schema,
    inputDigest: ContentDigestV1Schema,
    subject: EvidenceSubjectV1Schema,
    evidenceIds: z.array(EvidenceIdSchema).readonly(),
    waiverIds: z.array(WaiverIdSchema).readonly(),
    requestedAt: AdmissionRecordedAtSchema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

/** Reassessment result preserving both the prior and replacement decisions. */
export const AdmissionReassessmentCompletedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    reassessmentId: AdmissionFactIdSchema,
    priorDecisionId: DecisionIdSchema,
    subject: EvidenceSubjectV1Schema,
    decision: AdmissionDecisionRecordV1Schema,
    completedAt: AdmissionRecordedAtSchema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

/** Audit-only comparison of current legacy behavior with an admission record. */
export const AdmissionShadowAttemptData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    shadowAttemptId: AdmissionFactIdSchema,
    operationId: OperationIdSchema,
    phaseAttemptId: PhaseAttemptIdSchema,
    legacyOutcome: z.enum(['allow', 'deny']),
    subject: EvidenceSubjectV1Schema,
    evidenceSetDigest: ContentDigestV1Schema,
    decision: AdmissionDecisionRecordV1Schema,
    attemptedAt: AdmissionRecordedAtSchema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

/** Attributable disposition of a legacy/admission shadow disagreement. */
export const AdmissionDisagreementDispositionData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    dispositionId: AdmissionFactIdSchema,
    shadowAttemptId: AdmissionFactIdSchema,
    disposition: z.enum([
      'explained-legacy',
      'explained-admission',
      'accepted-risk',
      'unexplained',
    ]),
    rationale: z.string().trim().min(1).max(2_000),
    recordedAt: AdmissionRecordedAtSchema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

/** An authorized, attributable rollout assessment. It is inert in v2.12. */
export const AdmissionRolloutDecisionData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    rolloutDecisionId: AdmissionFactIdSchema,
    operationId: OperationIdSchema,
    outcome: z.enum(['approve-enforcement', 'continue-shadow']),
    policyId: PolicyIdSchema,
    policyVersion: AdmissionPolicyVersionSchema,
    policyDigest: ContentDigestV1Schema,
    inputDigest: ContentDigestV1Schema,
    evidenceIds: z.array(EvidenceIdSchema).readonly(),
    shadowEvidenceDigest: ContentDigestV1Schema,
    decidedAt: AdmissionRecordedAtSchema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

/**
 * The replay shape of a future enablement fact. No v2.12 resolver reads it, and it enables no
 * enforcement.
 */
export const AdmissionEnforcementEnabledData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    enablementId: AdmissionFactIdSchema,
    operationId: OperationIdSchema,
    rolloutDecisionId: AdmissionFactIdSchema,
    policyId: PolicyIdSchema,
    policyVersion: AdmissionPolicyVersionSchema,
    policyDigest: ContentDigestV1Schema,
    inputDigest: ContentDigestV1Schema,
    enabledAt: AdmissionRecordedAtSchema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

/**
 * The first readiness export record of the cutover promotion path. The observer appends it when all
 * six cutover conditions first hold. It carries a reference to the exported report (path and content
 * digest) and the summary counts, not the full report. The idempotency key derives only from the
 * store identity, so a repeat evaluation collapses onto the stored row. No `z.infer` alias exists,
 * because the only producer calls `AdmissionCutoverReadyData.parse` directly.
 */
export const AdmissionCutoverReadyData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    readinessId: AdmissionFactIdSchema,
    reportPath: z.string().min(1).max(1_024),
    reportDigest: ContentDigestV1Schema,
    comparableLiveAttemptCount: z.number().int().nonnegative(),
    durableAttemptCount: z.number().int().nonnegative(),
    observerStatus: z.enum(['unobserved', 'dead', 'degraded', 'healthy']),
    recordedAt: AdmissionRecordedAtSchema,
    ...TrustedAdmissionProvenanceFields,
  })
  .strict()
  .readonly();

export type AdmissionRequirementResolved = z.infer<
  typeof AdmissionRequirementResolvedData
>;
export type AdmissionEvidenceRecorded = z.infer<
  typeof AdmissionEvidenceRecordedData
>;
export type AdmissionTransitionDecided = z.infer<
  typeof AdmissionTransitionDecidedData
>;
export type AdmissionWaiverRecorded = z.infer<typeof AdmissionWaiverRecordedData>;
export type AdmissionContradictionRecorded = z.infer<
  typeof AdmissionContradictionRecordedData
>;
export type AdmissionReassessmentRequested = z.infer<
  typeof AdmissionReassessmentRequestedData
>;
export type AdmissionReassessmentCompleted = z.infer<
  typeof AdmissionReassessmentCompletedData
>;
export type AdmissionShadowAttempt = z.infer<typeof AdmissionShadowAttemptData>;
export type AdmissionDisagreementDisposition = z.infer<
  typeof AdmissionDisagreementDispositionData
>;
export type AdmissionRolloutDecision = z.infer<
  typeof AdmissionRolloutDecisionData
>;
export type AdmissionEnforcementEnabled = z.infer<
  typeof AdmissionEnforcementEnabledData
>;

/** One compiled leaf's outcome within an executed intent segment. */
export const IntentExecutedLeafEntry = z
  .object({
    action: z.string().min(1).describe('Registered action name the compiled leaf invoked'),
    status: z
      .enum(['passed', 'failed', 'advisory-failed'])
      .describe('Per-leaf outcome after the runbook onFail policy was applied'),
    sequences: z
      .array(z.number().int().positive())
      .describe('Event-store sequence numbers appended while executing this leaf'),
  })
  .strict();

/**
 * Caller-supplied steering, recorded for audit. No durable per-task `riskTier` or
 * `boundaryTouching` stamp exists, so `source` names where the values came from.
 */
export const IntentExecutedSteering = z
  .object({
    riskTier: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .describe('Caller-supplied risk tier passed through to the intent args'),
    boundaryTouching: z
      .boolean()
      .optional()
      .describe('Caller-supplied boundary-touching flag passed through to the intent args'),
    source: z
      .enum(['caller-args', 'capsule'])
      .describe(
        'Provenance of the two fields above — caller-supplied, or read off the pinned capsule a ' +
          'settlement composed this segment under; never a resolved durable stamp',
      ),
  })
  .strict();

/**
 * The operation event that a bounded intent segment commits under the caller `operationId`. It is
 * appended on the committed path and on the failed path, so each `execute_intent` call leaves a fact.
 */
export const OrchestrateIntentExecutedData = z
  .object({
    operationId: z
      .string()
      .min(1)
      .describe('Caller-supplied (or core-minted) idempotency key for this execute_intent call'),
    intent: z.string().min(1).describe('Named intent id that was compiled and executed'),
    outcome: z
      .enum(['committed', 'failed'])
      .describe('Whether every leaf ran to completion or the segment halted on a blocking failure'),
    failedLeaf: z
      .string()
      .min(1)
      .optional()
      .describe('Action name of the leaf that halted the segment, present only when outcome is failed'),
    leaves: z
      .array(IntentExecutedLeafEntry)
      .describe('Compact per-leaf summary in execution order'),
    requestDigest: z
      .string()
      .min(1)
      .describe('Digest of {intent, streamId, validated args} — the replay fast-path comparison key'),
    steering: IntentExecutedSteering.optional().describe(
      'Caller-supplied riskTier/boundaryTouching, when either was passed to execute_intent',
    ),
    /**
     * Required, with at least one entry. The run-bundle integrity oracle reports a custodial settlement
     * without a reference as a violation, so the bytes must be in custody before this record exists.
     * The producer parse and the generic append tool validate this field, not the store, so older rows
     * stay readable. The key is the constant that the oracle reads.
     */
    [BUNDLE_REF_FIELD]: z
      .array(BundleRefV1Schema)
      .min(1)
      .describe(
        'Content-addressed run-bundle references (artifact id + sha256) for the receipt and ' +
          'per-leaf trace this record summarises; the bytes are durable before this row exists',
      ),
  })
  .strict();
export type OrchestrateIntentExecuted = z.infer<typeof OrchestrateIntentExecutedData>;

/** How many findings of one kind this settlement reported. */
export const SettlementFindingCount = z
  .object({
    kind: z.string().min(1).describe('Adjudication finding kind, as `verbs/settle` names it'),
    count: z.number().int().positive().describe('How many findings of this kind the batch produced'),
  })
  .strict();

/**
 * What the adjudication looked at. A batch that adjudicated nothing and a clean batch both report
 * zero findings. Only this denominator tells them apart, so it travels with the record.
 */
export const SettlementCensusData = z
  .object({
    claims: z.number().int().nonnegative().describe('Claims submitted in this batch'),
    requiredResults: z
      .number()
      .int()
      .nonnegative()
      .describe("Tasks the capsule's settlement contract required a result from"),
    fields: z.number().int().nonnegative().describe('Declared result fields read against a claim'),
    evidence: z.number().int().nonnegative().describe('Evidence entries checked for admissibility'),
    deviations: z.number().int().nonnegative().describe('Deviations proposed against the envelope'),
    verification: z
      .number()
      .int()
      .nonnegative()
      .describe('Task verification outcomes read on the final pass; zero when no verification ran'),
    decisions: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Decisions read against proposed deviations; absent on a record written before a held ' +
          'batch could be decided',
      ),
  })
  .strict();

/**
 * The record of one adjudicated batch. The payload is a summary: the capsule, the outcome, the
 * accepted tasks, and the finding count of each kind. The findings and the claims are in the
 * referenced bundle, so no projection folds them. Counts keep the row size independent of how
 * badly the work went.
 */
export const ExecutionSettledData = z
  .object({
    operationId: z
      .string()
      .min(1)
      .describe('Caller-supplied (or core-minted) idempotency key for this settle call'),
    workflowId: z.string().min(1).describe('Workflow the settled capsule compiled for'),
    capsuleVersion: z
      .number()
      .int()
      .min(1)
      .describe('Which compilation of the design was applied — half of the settlement key'),
    batchId: z.string().min(1).describe('The batch this settlement adjudicated — the other half'),
    definitionVersion: z
      .string()
      .min(1)
      .describe('Digest of the workflow definition the capsule compiled from'),
    outcome: z
      .enum(['settled', 'rejected', 'deviation-pending'])
      .describe('Whether the batch settled, was refused, or is held for a deviation decision'),
    round: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Which settlement round of the batch this record closes: absent for the round that ' +
          'submitted it, 1 for the round that decided its held deviations',
      ),
    acceptedTasks: z
      .array(z.string().min(1))
      .describe('Task ids whose claims were adjudicated with no finding against them'),
    findingCounts: z
      .array(SettlementFindingCount)
      .describe('Findings by kind; the findings themselves are in the referenced bundle'),
    adjudicated: SettlementCensusData.describe('The denominator this verdict was reached over'),
    requestDigest: z
      .string()
      .min(1)
      .describe('Digest of {capsule identity, batch, claims} — the replay comparison key'),
    /**
     * Required, with at least one entry, for the same reason as on the executor record. The
     * adjudication bundle is in custody before this record exists.
     */
    [BUNDLE_REF_FIELD]: z
      .array(BundleRefV1Schema)
      .min(1)
      .describe(
        'Content-addressed reference to the adjudication bundle this record summarises; ' +
          'the bytes are durable before this row exists',
      ),
  })
  .strict();
export type ExecutionSettled = z.infer<typeof ExecutionSettledData>;

export const WorkflowPreparedData = z
  .object({
    operationId: z
      .string()
      .min(1)
      .describe('The claim this compilation was recorded under, derived from its inputs'),
    workflowId: z.string().min(1).describe('Workflow the capsule compiled for'),
    workflowType: z.string().min(1).describe('The workflow type whose definition was lowered'),
    capsuleVersion: z
      .number()
      .int()
      .min(1)
      .describe('Which compilation this is — monotonic per workflow, and half of the settlement key'),
    definitionVersion: z
      .string()
      .min(1)
      .describe('Digest of the workflow definition the capsule compiled from'),
    designVersion: z.string().min(1).describe('The design reference this compilation pinned'),
    capsuleDigest: z
      .string()
      .min(1)
      .describe(
        'Content address of the compiled capsule, as bare sha256 hex; settlement refuses a ' +
          'submitted capsule that does not match it',
      ),
    compilerVersion: z.string().min(1).describe('The compiler that produced the capsule'),
    taskCount: z.number().int().min(1).describe('Tasks in the compiled batch'),
    requestDigest: z
      .string()
      .min(1)
      .describe('Digest of the compilation inputs — the replay comparison key'),
    /**
     * Required, with at least one entry. The capsule and its definition are in custody before this
     * record exists, and a record that names no bytes pins an unreadable capsule.
     */
    [BUNDLE_REF_FIELD]: z
      .array(BundleRefV1Schema)
      .min(1)
      .describe(
        'Content-addressed reference to the compiled capsule and its definition; ' +
          'the bytes are durable before this row exists',
      ),
  })
  .strict();
export type WorkflowPrepared = z.infer<typeof WorkflowPreparedData>;

/**
 * What every divergence fact says about its settlement. A decision is a fact about a held batch, not
 * a new batch. Both facts name the settlement and a content-derived deviation id, so a reader can
 * pair each decision with its proposal.
 */
const DeviationSettlementIdentity = {
  operationId: z.string().min(1).describe('The settle call this fact was recorded under'),
  workflowId: z.string().min(1).describe('Workflow the settled capsule compiled for'),
  capsuleVersion: z.number().int().min(1).describe('Which compilation the batch ran under'),
  batchId: z.string().min(1).describe('The held batch the deviation belongs to'),
  deviationId: z
    .string()
    .min(1)
    .describe('Content-derived id of the deviation, the same on the proposal and its decision'),
};

export const DeviationProposedData = z
  .object({
    ...DeviationSettlementIdentity,
    deviationKind: z.string().min(1).describe("A kind the capsule's deviation envelope admits"),
    statement: z
      .string()
      .min(1)
      .describe("What the worker found wrong with the capsule's assumption, in its words"),
    affectedTasks: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'The unfinished tasks the deviation affects, sorted and unique; absent when it names ' +
          'none, and on a row written before a deviation could name tasks',
      ),
  })
  .strict();
export type DeviationProposed = z.infer<typeof DeviationProposedData>;

export const DeviationDecidedData = z
  .object({
    ...DeviationSettlementIdentity,
    decision: z
      .enum(['accepted', 'rejected'])
      .describe('Whether the proposed deviation stands: accepted admits the work, rejected refuses the batch'),
    actor: z.string().min(1).describe('Who decided: a person, or a named policy'),
    rationale: z.string().min(1).describe('Why, as the decider put it'),
  })
  .strict();
export type DeviationDecided = z.infer<typeof DeviationDecidedData>;

/**
 * The record of one design revision. One decision round leaves at most one row, for all the
 * material deviations that the round accepted. The schema is structural: it does not compare the
 * two versions, and it does not check the order of the lists. The change itself is in the
 * referenced settlement bundle, which holds each deviation and its decision.
 */
export const DesignRevisedData = z
  .object({
    operationId: z.string().min(1).describe('The settle call that recorded the revision'),
    workflowId: z.string().min(1).describe('Workflow the settled capsule compiled for'),
    capsuleVersion: z.number().int().min(1).describe('Which compilation the decided batch ran under'),
    batchId: z.string().min(1).describe('The batch whose decision round accepted the deviations'),
    priorDesignVersion: z
      .number()
      .int()
      .min(1)
      .describe('The design version of the stream before this revision; 1 when no row came before'),
    nextDesignVersion: z
      .number()
      .int()
      .min(2)
      .describe('The design version of the stream from this row on'),
    deviationIds: z
      .array(z.string().min(1))
      .min(1)
      .describe('Ids of the accepted material deviations that this revision records, sorted'),
    affectedTasks: z
      .array(z.string().min(1))
      .describe('The unfinished tasks those deviations affect, as one sorted list; empty when they name none'),
    [BUNDLE_REF_FIELD]: z
      .array(BundleRefV1Schema)
      .min(1)
      .describe(
        'Content-addressed reference to the settlement bundle of the decision round; ' +
          'the bytes are durable before this row exists',
      ),
  })
  .strict();
export type DesignRevised = z.infer<typeof DesignRevisedData>;

export const EVENT_DATA_SCHEMAS: Partial<Record<EventType, z.ZodSchema>> = {
  'workflow.started': WorkflowStartedData,
  'workflow.transition': WorkflowTransitionData,
  'workflow.fix-cycle': WorkflowFixCycleData,
  'workflow.plan-revision': WorkflowPlanRevisionData,
  'workflow.plan-review-dispatched': WorkflowPlanReviewDispatchedData,
  'workflow.guard-failed': WorkflowGuardFailedData,
  'workflow.checkpoint': WorkflowCheckpointData,
  'workflow.handoff_summarized': WorkflowHandoffSummarizedData,
  'workflow.compound-entry': WorkflowCompoundEntryData,
  'workflow.compound-exit': WorkflowCompoundExitData,
  'workflow.cancel': WorkflowCancelData,
  'workflow.cleanup': WorkflowCleanupData,
  'workflow.compensation': WorkflowCompensationData,
  'cancel.requested': CancelRequestedData,
  'cancel.ownership-acquired': CancelOwnershipAcquiredData,
  'cancel.compensation-requested': CancelCompensationRequestedData,
  'cancel.compensation-completed': CancelCompensationCompletedData,
  'cancel.compensation-failed': CancelCompensationFailedData,
  'cancel.compensation-retry-scheduled': CancelCompensationRetryScheduledData,
  'cancel.manual-intervention-required': CancelManualInterventionRequiredData,
  'cancel.ready': CancelReadyData,
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

  'task.assigned': TaskAssignedData,
  'task.claimed': TaskClaimedData,
  'task.progressed': TaskProgressedData,
  'task.completed': TaskCompletedData,
  'task.failed': TaskFailedData,

  'gate.executed': GateExecutedData,

  'stack.position-filled': StackPositionFilledData,
  'stack.restacked': StackRestackedData,
  'stack.enqueued': StackEnqueuedData,
  'stack.submitted': StackSubmittedData,

  'tool.invoked': ToolInvokedData,
  'tool.completed': ToolCompletedData,
  'tool.errored': ToolErroredData,
  'tool.action_errored': ToolActionErroredData,
  'tool.budget_exceeded': ToolBudgetExceededData,
  'turn.completed': TurnCompletedDataSchema,
  'subagent.tokens_used': SubagentTokensUsedDataSchema,

  'benchmark.completed': BenchmarkCompletedData,

  'team.spawned': TeamSpawnedData,
  'team.task.assigned': TeamTaskAssignedData,
  'team.task.completed': TeamTaskCompletedData,
  'team.task.failed': TeamTaskFailedData,
  'team.disbanded': TeamDisbandedData,
  'team.task.planned': TeamTaskPlannedData,
  'team.teammate.dispatched': TeamTeammateDispatchedData,

  'quality.regression': QualityRegressionData,
  'quality.hint.generated': QualityHintGeneratedData,
  'quality.refinement.suggested': RefinementSuggestedDataSchema,

  'review.completed': ReviewCompletedData,
  'review.routed': ReviewRoutedData,
  'review.finding': ReviewFindingData,
  'review.escalated': ReviewEscalatedData,

  'remediation.attempted': RemediationAttemptedDataSchema,
  'remediation.succeeded': RemediationSucceededDataSchema,

  'session.tagged': SessionTaggedData,
  'session.machinery_consumed': SessionMachineryConsumedDataSchema,

  'worktree.created': WorktreeCreatedData,
  'worktree.baseline': WorktreeBaselineData,
  'test.result': TestResultData,
  'typecheck.result': TypecheckResultData,
  'ci.status': CiStatusData,
  'ci.check_observed': CiCheckObservedData,
  'comment.posted': CommentPostedData,
  'comment.resolved': CommentResolvedData,

  'shepherd.started': ShepherdStartedData,
  'shepherd.iteration': ShepherdIterationData,
  'shepherd.approval_requested': ShepherdApprovalRequestedData,
  'shepherd.escalated': ShepherdEscalatedData,
  'shepherd.completed': ShepherdCompletedData,

  'eval.run.started': EvalRunStartedData,
  'eval.case.completed': EvalCaseCompletedData,
  'eval.run.completed': EvalRunCompletedData,
  'eval.judge.calibrated': JudgeCalibratedDataSchema,

  'diagnostic.executed': DiagnosticExecutedDataSchema,

  'onboard.requested': OnboardRequestedDataSchema,
  'onboard.executed': OnboardExecutedDataSchema,

  'invariant.authored': InvariantAuthoredDataSchema,
  'invariant.amended': InvariantAmendedDataSchema,
  'catalog.registered': CatalogRegisteredDataSchema,

  'mutation.executing_started': MutationExecutingStartedData,
  'mutation.executed': MutationExecutedData,

  'feedback.recorded': FeedbackRecordedData,

  /** A review provider adapter met an unknown tier. */
  'provider.unknown-tier': z.object({
    reviewer: z.string().min(1),
    rawTier: z.string().optional(),
    commentId: z.number().int(),
  }),

  /** One review comment failed to parse. The batch continues. */
  'provider.parse-error': z.object({
    reviewer: z.string().min(1),
    commentId: z.number().int(),
    errorMessage: z.string().min(1),
  }),

  /** Per-call observability of `classify_review_items`. */
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

  'merge.preflight': MergePreflightData,
  'merge.requested': MergeRequestedData,
  'merge.executed': MergeExecutedData,
  'merge.rollback': MergeRollbackData,
  'merge.recovered': MergeRecoveredData,
  'merge.retry_attempt': MergeRetryAttemptData,
  'merge.completed': MergeCompletedData,
  'merge.executing_started': MergeExecutingStartedData,

  'command.resolved': CommandResolvedEventSchema,

  'hsm.deprecated_action_invoked': HsmDeprecatedActionInvokedData,
  'spec.legacy_capabilities_array': SpecLegacyCapabilitiesArrayData,
  'phase.contract_missing': PhaseContractMissingData,
  'phase.blocked': PhaseBlockedData,
  'phase.entered': PhaseEnteredData,
  'phase.exited': PhaseExitedData,
  'migration.legacy_jsonl_imported': MigrationLegacyJsonlImportedData,
  'migration.completed': MigrationCompletedData,
  'migration.failed': MigrationFailedData,
  'migration.workflow_type_unknown': MigrationWorkflowTypeUnknownData,
  'migration.correlation_backfill_progress': MigrationCorrelationBackfillProgressData,

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

  'worktree.adopted': WorktreeAdoptedData,
  'worktree.reserved': WorktreeReservedData,
  'worktree.released': WorktreeReleasedData,
  'worktree.orphan_detected': WorktreeOrphanDetectedData,

  'worktree.merge_requested': WorktreeMergeRequestedData,
  'worktree.merge_executed': WorktreeMergeExecutedData,

  'worktree.create.requested': WorktreeCreateRequestedData,
  'worktree.create.executed': WorktreeCreateExecutedData,
  'launch.executing_started': LaunchExecutingStartedData,
  'launch.executed': LaunchExecutedData,

  'workspace.resolved': WorkspaceResolvedData,

  'elicitation.requested': ElicitationRequestedData,
  'elicitation.fulfilled': ElicitationFulfilledData,
  'elicitation.declined': ElicitationDeclinedData,

  'task.created': TaskCreatedData,
  'task.polled': TaskPolledData,
  'task.result': TaskResultData,
  'task.cancelled': TaskCancelledData,
  'dispatch.preflight': DispatchPreflightData,
  'stash.detected': StashDetectedData,

  'prune.executing_started': PruneExecutingStartedData,
  'prune.executed': PruneExecutedData,
  'prune.diagnostics': PruneDiagnosticsData,

  'export.requested': ExportRequestedData,
  'export.executed': ExportExecutedData,

  'vcs.requested': VcsRequestedData,
  'vcs.executed': VcsExecutedData,
  'vcs.compensated': VcsCompensatedData,

  'promotion.executed': PromotionExecutedData,

  'emission.violated': EmissionViolatedData,

  'projection.degraded': ProjectionDegradedData,
  'projection.recovered': ProjectionRecoveredData,

  'admission.requirement-resolved': AdmissionRequirementResolvedData,
  'admission.evidence-recorded': AdmissionEvidenceRecordedData,
  'admission.transition-decided': AdmissionTransitionDecidedData,
  'admission.waiver-recorded': AdmissionWaiverRecordedData,
  'admission.contradiction-recorded': AdmissionContradictionRecordedData,
  'admission.reassessment-requested': AdmissionReassessmentRequestedData,
  'admission.reassessment-completed': AdmissionReassessmentCompletedData,
  'admission.shadow-attempt': AdmissionShadowAttemptData,
  'admission.disagreement-disposition': AdmissionDisagreementDispositionData,
  'admission.rollout-decision': AdmissionRolloutDecisionData,
  'admission.enforcement-enabled': AdmissionEnforcementEnabledData,
  'admission.cutover-ready': AdmissionCutoverReadyData,

  'orchestrate.intent_executed': OrchestrateIntentExecutedData,
  'execution.settled': ExecutionSettledData,
  'workflow.prepared': WorkflowPreparedData,
  'deviation.proposed': DeviationProposedData,
  'deviation.decided': DeviationDecidedData,
  'design.revised': DesignRevisedData,
};

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
export type WorkflowPlanRevision = z.infer<typeof WorkflowPlanRevisionData>;
export type WorkflowPlanReviewDispatched = z.infer<typeof WorkflowPlanReviewDispatchedData>;
export type WorkflowGuardFailed = z.infer<typeof WorkflowGuardFailedData>;
export type WorkflowCheckpoint = z.infer<typeof WorkflowCheckpointData>;
export type WorkflowHandoffSummarized = z.infer<typeof WorkflowHandoffSummarizedData>;
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
export type ToolBudgetExceeded = z.infer<typeof ToolBudgetExceededData>;
export type ToolErrored = z.infer<typeof ToolErroredData>;
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
export type ShepherdEscalated = z.infer<typeof ShepherdEscalatedData>;
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
export type CiCheckObserved = z.infer<typeof CiCheckObservedData>;
export type CommentPosted = z.infer<typeof CommentPostedData>;
export type CommentResolved = z.infer<typeof CommentResolvedData>;
export type DiagnosticExecuted = z.infer<typeof DiagnosticExecutedDataSchema>;
export type OnboardRequested = z.infer<typeof OnboardRequestedDataSchema>;
export type OnboardExecuted = z.infer<typeof OnboardExecutedDataSchema>;
export type InvariantAuthored = z.infer<typeof InvariantAuthoredDataSchema>;
export type InvariantAmended = z.infer<typeof InvariantAmendedDataSchema>;
export type CatalogRegistered = z.infer<typeof CatalogRegisteredDataSchema>;
export type MergePreflight = z.infer<typeof MergePreflightData>;
export type MergeRequested = z.infer<typeof MergeRequestedData>;
export type MergeExecuted = z.infer<typeof MergeExecutedData>;
export type MergeRollback = z.infer<typeof MergeRollbackData>;
export type MergeRecovered = z.infer<typeof MergeRecoveredData>;
export type MergeRetryAttempt = z.infer<typeof MergeRetryAttemptData>;
export type MergeCompleted = z.infer<typeof MergeCompletedData>;
export type MergeExecutingStarted = z.infer<typeof MergeExecutingStartedData>;
export type HsmDeprecatedActionInvoked = z.infer<typeof HsmDeprecatedActionInvokedData>;
export type SpecLegacyCapabilitiesArray = z.infer<typeof SpecLegacyCapabilitiesArrayData>;
export type PhaseContractMissing = z.infer<typeof PhaseContractMissingData>;
export type PhaseBlocked = z.infer<typeof PhaseBlockedData>;
export type PhaseEntered = z.infer<typeof PhaseEnteredData>;
export type PhaseExited = z.infer<typeof PhaseExitedData>;
export type MigrationLegacyJsonlImported = z.infer<typeof MigrationLegacyJsonlImportedData>;
export type MigrationCompleted = z.infer<typeof MigrationCompletedData>;
export type MigrationFailed = z.infer<typeof MigrationFailedData>;
export type MigrationCorrelationBackfillProgress = z.infer<typeof MigrationCorrelationBackfillProgressData>;

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

export type WorktreeAdopted = z.infer<typeof WorktreeAdoptedData>;
export type WorktreeReserved = z.infer<typeof WorktreeReservedData>;
export type WorktreeReleased = z.infer<typeof WorktreeReleasedData>;
export type WorktreeOrphanDetected = z.infer<typeof WorktreeOrphanDetectedData>;

export type WorktreeMergeRequested = z.infer<typeof WorktreeMergeRequestedData>;
export type WorktreeMergeExecuted = z.infer<typeof WorktreeMergeExecutedData>;

export type WorktreeCreateRequested = z.infer<typeof WorktreeCreateRequestedData>;
export type WorktreeCreateExecuted = z.infer<typeof WorktreeCreateExecutedData>;
export type LaunchExecutingStarted = z.infer<typeof LaunchExecutingStartedData>;
export type LaunchExecuted = z.infer<typeof LaunchExecutedData>;

export type WorkspaceResolved = z.infer<typeof WorkspaceResolvedData>;

export type ElicitationRequested = z.infer<typeof ElicitationRequestedData>;
export type ElicitationFulfilled = z.infer<typeof ElicitationFulfilledData>;
export type ElicitationDeclined = z.infer<typeof ElicitationDeclinedData>;

export type TaskCreated = z.infer<typeof TaskCreatedData>;
export type TaskPolled = z.infer<typeof TaskPolledData>;
export type TaskResult = z.infer<typeof TaskResultData>;
export type TaskCancelled = z.infer<typeof TaskCancelledData>;
export type DispatchPreflight = z.infer<typeof DispatchPreflightData>;
export type StashDetected = z.infer<typeof StashDetectedData>;
export type FeedbackRecorded = z.infer<typeof FeedbackRecordedData>;

export type PruneExecutingStarted = z.infer<typeof PruneExecutingStartedData>;
export type PruneExecuted = z.infer<typeof PruneExecutedData>;
export type PruneDiagnostics = z.infer<typeof PruneDiagnosticsData>;

export type ExportRequested = z.infer<typeof ExportRequestedData>;
export type ExportExecuted = z.infer<typeof ExportExecutedData>;

export type VcsRequested = z.infer<typeof VcsRequestedData>;
export type VcsExecuted = z.infer<typeof VcsExecutedData>;
export type VcsCompensated = z.infer<typeof VcsCompensatedData>;

export type PromotionExecuted = z.infer<typeof PromotionExecutedData>;

export type EmissionViolated = z.infer<typeof EmissionViolatedData>;

export type ProjectionDegraded = z.infer<typeof ProjectionDegradedData>;
export type ProjectionRecovered = z.infer<typeof ProjectionRecoveredData>;

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
  'workflow.plan-revision': WorkflowPlanRevision;
  'workflow.plan-review-dispatched': WorkflowPlanReviewDispatched;
  'workflow.guard-failed': WorkflowGuardFailed;
  'workflow.checkpoint': WorkflowCheckpoint;
  'workflow.handoff_summarized': WorkflowHandoffSummarized;
  'workflow.compound-entry': WorkflowCompoundEntry;
  'workflow.compound-exit': WorkflowCompoundExit;
  'workflow.cancel': WorkflowCancel;
  'workflow.cleanup': WorkflowCleanup;
  'workflow.compensation': WorkflowCompensation;
  'workflow.circuit-open': WorkflowCircuitOpen;
  'tool.invoked': ToolInvoked;
  'tool.completed': ToolCompleted;
  'tool.errored': ToolErrored;
  'tool.action_errored': ToolActionErrored;
  'tool.budget_exceeded': ToolBudgetExceeded;
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
  'shepherd.escalated': ShepherdEscalated;
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
  'ci.check_observed': CiCheckObserved;
  'comment.posted': CommentPosted;
  'comment.resolved': CommentResolved;
  'diagnostic.executed': DiagnosticExecuted;
  'onboard.requested': OnboardRequested;
  'onboard.executed': OnboardExecuted;
  'invariant.authored': InvariantAuthored;
  'invariant.amended': InvariantAmended;
  'catalog.registered': CatalogRegistered;
  'merge.preflight': MergePreflight;
  'merge.requested': MergeRequested;
  'merge.executed': MergeExecuted;
  'merge.rollback': MergeRollback;
  'merge.recovered': MergeRecovered;
  'merge.retry_attempt': MergeRetryAttempt;
  'merge.completed': MergeCompleted;
  'merge.executing_started': MergeExecutingStarted;
  'command.resolved': CommandResolvedEvent;
  'hsm.deprecated_action_invoked': HsmDeprecatedActionInvoked;
  'spec.legacy_capabilities_array': SpecLegacyCapabilitiesArray;
  'phase.contract_missing': PhaseContractMissing;
  'phase.blocked': PhaseBlocked;
  'migration.legacy_jsonl_imported': MigrationLegacyJsonlImported;
  'migration.completed': MigrationCompleted;
  'migration.failed': MigrationFailed;
  'migration.correlation_backfill_progress': MigrationCorrelationBackfillProgress;
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
  'worktree.adopted': WorktreeAdopted;
  'worktree.reserved': WorktreeReserved;
  'worktree.released': WorktreeReleased;
  'worktree.orphan_detected': WorktreeOrphanDetected;
  'worktree.merge_requested': WorktreeMergeRequested;
  'worktree.merge_executed': WorktreeMergeExecuted;
  'worktree.create.requested': WorktreeCreateRequested;
  'worktree.create.executed': WorktreeCreateExecuted;
  'launch.executing_started': LaunchExecutingStarted;
  'launch.executed': LaunchExecuted;
  'workspace.resolved': WorkspaceResolved;
  'elicitation.requested': ElicitationRequested;
  'elicitation.fulfilled': ElicitationFulfilled;
  'elicitation.declined': ElicitationDeclined;
  'task.created': TaskCreated;
  'task.polled': TaskPolled;
  'task.result': TaskResult;
  'task.cancelled': TaskCancelled;
  'dispatch.preflight': DispatchPreflight;
  'stash.detected': StashDetected;
  'feedback.recorded': FeedbackRecorded;
  'prune.executing_started': PruneExecutingStarted;
  'prune.executed': PruneExecuted;
  'prune.diagnostics': PruneDiagnostics;
  'export.requested': ExportRequested;
  'export.executed': ExportExecuted;
  'vcs.requested': VcsRequested;
  'vcs.executed': VcsExecuted;
  'vcs.compensated': VcsCompensated;
  'promotion.executed': PromotionExecuted;
  'emission.violated': EmissionViolated;

  'projection.degraded': ProjectionDegraded;
  'projection.recovered': ProjectionRecovered;
  'orchestrate.intent_executed': OrchestrateIntentExecuted;
  'execution.settled': ExecutionSettled;
  'workflow.prepared': WorkflowPrepared;
  'deviation.proposed': DeviationProposed;
  'deviation.decided': DeviationDecided;
  'design.revised': DesignRevised;
};

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
    /** Retired types: the schema stays for replay, and nothing emits them. */
    retired: string[];
  };
  totalCount: number;
}

/**
 * Returns a catalog of all registered event types, built-in and custom. Each entry has the emission
 * source, the built-in status, and whether the type has a data schema. It has no side effects.
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
    retired: [],
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

/** Event types that require agentId and source metadata. */
export const AGENT_EVENT_TYPES = [
  'task.claimed',
  'task.progressed',
  'team.task.completed',
  'team.task.failed',
] as const;

export type AgentEventType = typeof AGENT_EVENT_TYPES[number];

/**
 * Validates that an agent event has its required metadata fields.
 *
 * An event in `AGENT_EVENT_TYPES` must have both `agentId` and `source`. Other events pass without
 * validation.
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
