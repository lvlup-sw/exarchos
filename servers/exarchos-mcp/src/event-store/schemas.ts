import * as path from 'node:path';
import { z } from 'zod';
import { WorkflowTypeSchema } from '../workflow/schemas.js';
import { DoctorOutputSchema } from '../orchestrate/doctor/schema.js';
import { ReconcilePlanSchema, ReconcileResultSchema } from '../core/onboarding/types.js';
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

// ─── Event Type Discriminated Union ─────────────────────────────────────────

/** Additive internal replay types; none are public admission actions in v2.12. */
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
  // Cutover promotion path (#1739) — the FIRST-time readiness export record.
  // Appended (auto, idempotency-keyed on store identity, never clock-derived)
  // by the observer's durable-append success hook when all six cutover-gate
  // conditions are first satisfied. See workflow/admission/cutover-auto-export.ts.
  'admission.cutover-ready',
] as const;

/** Server-owned cancellation process-manager facts (v2.12, DR-7). */
export const INTERNAL_CANCELLATION_EVENT_TYPES = [
  'cancel.requested',
  // P04-02 (EFF-005) — fencing token. A monotonically increasing epoch is
  // allocated on ownership acquisition; a stale-epoch instance's writes are
  // rejected by the process manager, so a takeover cannot be undercut by the
  // instance it displaced.
  'cancel.ownership-acquired',
  'cancel.compensation-requested',
  'cancel.compensation-completed',
  'cancel.compensation-failed',
  // P04-02 (EFF-005) — bounded-retry record. Emitted before a re-attempt of a
  // failed compensation effect so the attempt ladder is replayable.
  'cancel.compensation-retry-scheduled',
  // P04-02 (EFF-005) — terminal-but-unresolved escalation. Retry exhaustion (or
  // a non-retryable malformed result) lands here as a real, queryable state
  // rather than being silently swallowed.
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
  // DR-1 — counted plan-review revise cycle. The plan-review analog of
  // `workflow.fix-cycle`: emitted when the `plan-review → plan` revise edge is
  // traversed (HSM `isRevision` flag). The workflow-state projection folds
  // occurrences into `state.planReview.revisionCount`, the field the
  // `revisionsExhausted` guard reads, so the revise loop is bounded by an
  // event-sourced (replay-stable) count rather than advisory prose.
  'workflow.plan-revision',
  // WLM-6 (DR-2) — counted plan-review dispatch. Emitted by the unskippable
  // `prepare_review scope:plan` provisioning seam (orchestrate/prepare-review.ts)
  // on EVERY provisioning of the front-of-pipeline adversarial plan-review, so
  // the plan-review revision loop is bounded at the one server action an agent
  // MUST call to re-review — closing the skippable-edge bypass the old
  // `plan-review → plan` `isRevision` counter left open (an agent could
  // re-provision + re-dispatch without ever traversing the counted edge). Each
  // event carries a 0-based `ordinal`; the workflow-state projection folds the
  // MAX ordinal into `planReview.revisionCount` (the field `revisionsExhausted`
  // reads), so the ordinal-0 initial review is revision 0 (no counter increment)
  // and every re-dispatch is +1. A deterministic idempotency key
  // (`${featureId}:plan-review-dispatch:${ordinal}`, INV-8) collapses a
  // same-ordinal crash-retry at the storage layer. `auto` — the handler owns the
  // append; the model is never asked to hand-emit it.
  'workflow.plan-review-dispatched',
  'workflow.guard-failed',
  'workflow.checkpoint',
  // #1242 (F1 of #1239 spike) — auto-summarized handoff fallback. Emitted by a
  // downstream summarizer subagent when a checkpoint fires with no operator-
  // authored handoff (phase transitions / wave dispatches). The rehydration
  // reducer folds it into `latestHandoff` ONLY when no operator handoff holds
  // the slot — operator-authored content always takes precedence. The summary
  // string is stored on the event (source of truth), so replay is deterministic
  // over the stored payload even though the summarizer itself is not (INV-1).
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
  // #1525 W2 Half 1 — per-subagent output-token total emitted by the restored
  // SubagentStop hook (`cli-commands/subagent-stop.ts`). The handler parses the
  // subagent's own transcript, sums output tokens, and resolves teammate identity
  // by matching the subagent cwd to a dispatched worktree before appending to the
  // feature stream. Folded by team-performance / delegation-timeline.
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
  'comment.posted',
  'comment.resolved',
  'diagnostic.executed',
  'pr.created',
  'pr.merged',
  'pr.commented',
  'issue.created',
  // DR-7 (task 008) — the two-event onboard contract (INV-1 / INV-13).
  // `onboard.requested` is the durable INTENT (the reconcile plan) recorded
  // BEFORE the non-idempotent reconcile fires; `onboard.executed` is the RESULT
  // recorded AFTER it succeeds. Emitted by the `onboard` composite (which
  // subsumes init/doctor-fix/new-project). `init.executed` was retired in DR-5
  // (task 018) alongside the init verb/handler — `onboard.*` is the audit trail.
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
  // Wave 4 audit §F1.2 two-event split — `merge.requested` is the durable
  // INTENT recorded BEFORE the non-idempotent GitHub merge call fires. The
  // `merge-orchestrator@v1` projection (Wave 2B / #1304) folds it as the
  // transition into the new `requested` phase. Registered in Wave 2B.2 (this
  // commit) ahead of Wave 4's `decide` migration so the reducer can validly
  // fold it.
  'merge.requested',
  'merge.executed',
  'merge.rollback',
  // #1306 — successor to `merge.rollback` and, since DR-2 (task 006), the SOLE
  // emitted recovery terminal. `merge.rollback` is now read-tolerant-not-
  // emittable (schema + type-map kept for replay; nothing writes it).
  'merge.recovered',
  // #1308 — audit record of a transient-failure retry of the merge attempt.
  // Records the retry `attempt` ordinal, the backoff `delayMs` before it, and
  // the transient-failure `reason` (e.g. 'timeout') that triggered it. The
  // emission site lands in a later #1308 task; this registration is additive.
  'merge.retry_attempt',
  // Terminal lifecycle event — emitted by the executor (`handleExecuteMerge`)
  // immediately after a successful `merge.executed` append. Folded by the
  // `merge-orchestrator@v1` projection (#1304) as the transition into the
  // terminal `completed` phase. Distinct from `merge.executed` (records the
  // side effect) so the projection can model "side effect done" and
  // "lifecycle formally terminated" as two states — matching INV-10's
  // executing_started + paired terminal event pattern.
  'merge.completed',
  // #1309 — merge-executor liveness event. Emitted by `handleExecuteMerge`
  // after the recovery point sha is recorded and BEFORE the first `vcsMerge`
  // attempt, so a long-running merge is observable as "started but not yet
  // terminated" — the INV-10 `<surface>.executing_started` + paired terminal
  // (`merge.executed` / `merge.recovered`) pattern, mirroring
  // `mutation.executing_started`. Audit-only: it does NOT transition the
  // `merge-orchestrator@v1` projection phase.
  'merge.executing_started',
  'command.resolved',
  // Durable event-store substrate (#1259) — deprecation telemetry + migration
  // pipeline. T02 / T03 / T04 of the substrate plan.
  'hsm.deprecated_action_invoked',
  'spec.legacy_capabilities_array',
  'phase.contract_missing',
  // Phase-kind binding (DR-7, epic #1546) — fail-closed at the gate-set
  // boundary. Emitted when the IMPLEMENT-kind gate-set resolver throws while
  // stamping a wave's verification sequence: the dispatch is REFUSED (fail
  // closed) and this durable event records why, so an operator sees the
  // blocked phase instead of a silently-failed-open dispatch.
  'phase.blocked',
  // Phase-kind binding S4 (DR-13, epic #1546) — resolve-then-freeze. The
  // executeTransition boundary appends `phase.entered` carrying the obligation
  // it resolved+froze for the target kind, and `phase.exited` on advance with
  // the aggregate gate status. Replaying these left-folds the same obligation a
  // live HSM observed (a later policy edit cannot rewrite a frozen phase).
  'phase.entered',
  'phase.exited',
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
  // WLM foundation — worktree lifecycle (adopt / reserve / release / orphan).
  // These four share one payload shape (`worktreeId`, `path`, `featureId`,
  // `ownerPid`, `ownerStartedAt`, `operationId`). They are the lease/ownership
  // half of worktree lifecycle management; the GC/deletion half REUSES the
  // `worktree.remove.requested`/`worktree.remove.executed` pair above (there is
  // deliberately no `worktree.pruned` type). Like the remove pair, they are
  // `auto` (deterministic plumbing) and keyed on the existing two-component
  // `<eventType>:<operationId>` idempotency convention.
  'worktree.adopted',
  'worktree.reserved',
  'worktree.released',
  'worktree.orphan_detected',
  // WLM operational-core (DR-4 / DR-7) — the serialized-merge lease pair that
  // rides the singleton `worktrees` stream alongside the lifecycle family above.
  // `worktree.merge_requested` is the CLAIM (intent + lease record: which
  // operation holds the right to merge `sourceBranch` into `integrationRef`,
  // and which live process holds it). `worktree.merge_executed` is the RELEASE
  // (terminal outcome: merged / aborted / failed). `operationId` is the sole
  // discriminator so two concurrent merges onto one `integrationRef` mint
  // distinct keys and never collide. The CLAIM is appended via the event-store
  // `decide` seam (its own `${streamId}:${reducerId}:${operationId}` key); the
  // RELEASE is a plain keyed append `<eventType>:<operationId>` per the
  // worktree-family convention.
  'worktree.merge_requested',
  'worktree.merge_executed',
  // harness-launcher (DR-2) — the launcher's top-level worktree create pair plus
  // the child-process liveness pair. `worktree.create.requested`/
  // `worktree.create.executed` mirror the INV-13 `worktree.remove.*` intent/
  // terminal pair (durable intent BEFORE the non-idempotent create; terminal
  // AFTER it succeeds). This terminal is DISTINCT from the task-scoped
  // `worktree.created` above (which requires `taskId`+`branch` and is
  // task-worktree-only): the launcher creates a task-LESS top-level worktree, so
  // it needs its own shared-stem create pair rather than reusing the task
  // terminal. `launch.executing_started`/`launch.executed` are the liveness pair
  // — `launch.executing_started` records the live child process
  // (`holderPid`/`holderStartedAt`, mirroring `InFlightMerge`) so a dead-holder
  // reconciler is expressible later; `launch.executed` is the terminal ("executed"
  // = the child process exited). All four are `auto` deterministic plumbing.
  'worktree.create.requested',
  'worktree.create.executed',
  'launch.executing_started',
  'launch.executed',
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
  // invariants-catalog-wizard (P2 / #1479 follow-up) — invariant-authoring
  // lifecycle. `invariant.authored` is appended by the `invariants_add`
  // composite handler on commit (dryRun:false). `catalog.registered` is
  // appended on the first registration of a catalog file in `.exarchos.yml`
  // (by `invariants_add`). Both are server-deterministic (auto) — the handler
  // owns the write, the model is never nagged to hand-emit them.
  'invariant.authored',
  'catalog.registered',
  // verification-ladder slice 1 (task 020) — mutation-run liveness (INV-10).
  // `mutation.executing_started` lands at the start of a (non-dry-run) mutation
  // run driven by the `mutation-adequacy` gate handler
  // (`orchestrate/mutation-adequacy.ts`); `mutation.executed` is the paired
  // terminal event carrying the pass/fail verdict + exit code. The pair makes
  // a long-running mutation sweep observable as "started but not yet
  // terminated" the same way merge.executing_started/executed does. Emitted
  // best-effort — a run with no event store (invoked outside a workspace)
  // skips emission and never crashes.
  'mutation.executing_started',
  'mutation.executed',
  // #1319 — agent→runtime friction back-channel (Trevin Principle 10b). Emitted
  // by the `exarchos_workflow.feedback` action when an agent (or operator) files
  // a friction report mid-run. Lands on the shared `meta/feedback` stream (NOT a
  // feature stream) so reports are queryable across every workflow — the
  // in-runtime, event-sourced counterpart to the manual `/exarchos:dogfood`
  // transcript triage, which now reads this stream as input.
  'feedback.recorded',
  // WLM slice 3 (DR-3, epic #1574) — prune-run liveness pair (INV-10). Rides the
  // singleton `worktrees` stream alongside the worktree lifecycle family and is
  // folded by `worktrees@v1` into `inFlightPrunes` (keyed by `operationId`).
  // `prune.executing_started` records the live holder (the process running the
  // `prune_worktrees` GC pass) so a long pass is observable as "started but not
  // yet terminated"; `prune.executed` is the paired terminal that clears the
  // in-flight marker (never a phantom). Makes an in-flight prune `ps`/`wait`-
  // visible — the rolled-forward foundation deferral. Both are `auto`
  // deterministic plumbing: the WorktreeManager owns both appends around the pass.
  'prune.executing_started',
  'prune.executed',
  // DR-4 (wiring-closure T-06) — durable projection-health state.
  //
  // `_meta.projectionDegraded` was an EPHEMERAL per-response annotation:
  // recomputed on every read from an in-memory LRU of materialized folds,
  // persisted nowhere and consumed by nobody, so a stale fold could still be
  // served as `success: true` to any consumer that did not read `_meta`. This
  // pair publishes the SAME cursor/tail verdict durably, so an independent
  // consumer — a different process, or the same process after a restart with a
  // cold cache — can READ the degraded state instead of re-deriving it from a
  // cache it does not share.
  //
  // Both ride the dedicated singleton `meta/projection-health` stream, NEVER
  // the observed stream: appending to the stream under assessment would move
  // the very `MAX(sequence)` tail the verdict is computed against, and each
  // read would then observe a fresh disagreement and append again (an
  // unbounded self-feeding loop). Same shared-meta-stream idiom as
  // `feedback.recorded` on `meta/feedback`.
  //
  // `projection.degraded` is published when a stream's worst projection cursor
  // disagrees with its durable event tail. `projection.recovered` is the paired
  // RESOLUTION, published only when a stream that currently holds a degraded
  // record has caught the tail — so the folded state is a real two-state
  // machine rather than a sticky one-way flag that can never be cleared. Both
  // are `auto` deterministic plumbing (the freshness publisher owns the
  // appends; the model is never asked to hand-emit them) and both are
  // idempotency-keyed on the observed cursor/tail pair (INV-8), so repeated
  // detection of the SAME degraded cursor collapses onto one row at the storage
  // layer instead of spamming the stream once per read.
  //
  // Deliberately distinct from `workflow.projection_degraded` (DR-18) above:
  // that event records a REHYDRATION fallback (reducer throw / corrupt
  // snapshot / unavailable stream) on the feature stream. This pair records
  // CURSOR/TAIL disagreement of an already-materialized fold. Different fault,
  // different stream, different consumer — merging them would force one enum to
  // carry two unrelated failure vocabularies.
  'projection.degraded',
  'projection.recovered',
  // DR-6 (lifecycle-verbs, task 012) — the two-event `export` contract (INV-13
  // two-event split, INV-8 idempotency). `export` writes a zip bundle
  // (events.jsonl + state.json + metadata.json + artifacts/) to a path OUTSIDE
  // `.exarchos/` — a non-idempotent external side effect. `export.requested` is
  // the durable INTENT carrying the RESOLVED destination path, journaled BEFORE
  // the write; `export.executed` is the RESULT carrying the written bundle's
  // content hash, journaled AFTER. A crash between the two is recoverable: the
  // next invocation observes `export.requested` without `export.executed` and
  // runs an idempotent precheck (zip exists + hash matches the recorded
  // `contentHash`) to re-emit or redo. Both are `auto` — the `export` composite
  // handler owns both appends deterministically (task 013), so the model is
  // never asked to hand-emit them. Keyed on the payload's `idempotencyKey`
  // (INV-8): a crash-retry of the SAME logical export collapses onto one intent,
  // while a fresh export invocation mints a distinct key and a new pair.
  'export.requested',
  'export.executed',
  // Phase-gate v2.12 proof substrate (DR-2 / DR-3). These are additive,
  // internal replay contracts only. They are classified `planned` below:
  // v2.12 does not expose admission actions, authorize generic appends, or
  // consume `admission.enforcement-enabled` to alter transition behavior.
  ...INTERNAL_ADMISSION_EVENT_TYPES,
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

// `retired` — the data schema + type-map entry are KEPT so legacy event logs
// remain replayable (INV-1), but nothing emits the event any more. Semantically
// the mirror of `planned` (schema exists, not-yet-emitted): `retired` is
// schema-exists, no-longer-emitted. Distinguishing the two keeps the emission
// catalog honest — a `retired` event must never appear in any action's
// `autoEmits` (the RegistryDrift test enforces `autoEmits ⊆ auto`).
export type EventEmissionSource = 'auto' | 'model' | 'hook' | 'planned' | 'retired';

export const EVENT_EMISSION_REGISTRY: Record<EventType, EventEmissionSource> = {
  // auto — emitted by MCP server handlers (deterministic)
  'workflow.started': 'auto',
  'workflow.transition': 'auto',
  'workflow.fix-cycle': 'auto',
  'workflow.plan-revision': 'auto',
  // WLM-6 (DR-2) — emitted deterministically by the `prepare_review scope:plan`
  // handler, never hand-written by the model.
  'workflow.plan-review-dispatched': 'auto',
  'workflow.guard-failed': 'auto',
  'workflow.checkpoint': 'auto',
  // #1242 — emitted by a summarizer subagent via event.append (agent-driven,
  // not a deterministic server handler), hence 'model'.
  'workflow.handoff_summarized': 'model',
  'workflow.compound-entry': 'auto',
  'workflow.compound-exit': 'auto',
  'workflow.cancel': 'auto',
  'workflow.cleanup': 'auto',
  'workflow.compensation': 'auto',
  'cancel.requested': 'auto',
  'cancel.ownership-acquired': 'auto',
  'cancel.compensation-requested': 'auto',
  'cancel.compensation-completed': 'auto',
  'cancel.compensation-failed': 'auto',
  'cancel.compensation-retry-scheduled': 'auto',
  'cancel.manual-intervention-required': 'auto',
  'cancel.ready': 'auto',
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
  // #1525 — hook-owned append (the SubagentStop handler emits it), like turn.completed.
  'subagent.tokens_used': 'auto',
  'quality.hint.generated': 'auto',
  'quality.refinement.suggested': 'auto',
  'stack.position-filled': 'auto',
  'stack.restacked': 'auto',
  'stack.enqueued': 'auto',
  'eval.judge.calibrated': 'auto',

  // auto — RC2 (#1395): migrated from 'model'. The runtime emits these
  // deterministically from a dispatch-core handler, so the model must no
  // longer be nagged via _eventHints.missing to hand-maintain them (INV-1
  // event-sourcing integrity, INV-12 trust boundary):
  //   • review.routed       — review/tools.ts:60 (handleReviewTriage),
  //                            idempotency key ${featureId}:review.routed:${pr}
  //   • ci.status           — orchestrate/assess-stack.ts:313 (assess_stack),
  //                            idempotency key …:ci.status:${pr}:iter-${n}
  //   • quality.regression  — quality/regression-detector.ts:89, emitted from
  //                            handleViewCodeQuality (views/tools.ts:724),
  //                            deduped against existing regression events
  'review.routed': 'auto',
  'ci.status': 'auto',
  'quality.regression': 'auto',

  // auto — emitted by the dispatch-core interceptor on the first non-rehydrate
  // handler invocation after a workflow.rehydrated event lands (T-12). Marks
  // "the rehydrated agent has consumed the phase machinery and started doing
  // real work" — useful for v2.12 lifecycle alignment (ps, wait --condition).
  // Registration only; emission wired by T-12.
  'session.machinery_consumed': 'auto',

  // model — must be emitted explicitly by the model via exarchos_event.
  //
  // Category-C note (#1395): team.spawned / team.disbanded / shepherd.iteration
  // are runtime-determined transitions that STAY model-emitted because their
  // transition site is a model-walked runbook step bracketing a `native:`
  // harness tool (runbooks/definitions.ts) — there is no in-process handler
  // seam to move the append into yet. Auto-emitting them requires a
  // runbook-executor seam (feature-shaped, deferred to v2.11 / #1258); until
  // then the _eventHints.missing nag for them is intentional, not a defect.
  'team.spawned': 'model',
  'team.task.assigned': 'model',
  'team.task.completed': 'model',
  'team.task.failed': 'model',
  'team.disbanded': 'model',
  'team.task.planned': 'model',
  'team.teammate.dispatched': 'model',
  // review.completed / review.finding / review.escalated stay model: they are
  // qualitative model outputs (verdict, finding text, escalation reason). The
  // finding/escalation emitters exist but are dormant (no wired caller), so
  // they are not demonstrably handler-emitted (#1395 audit, Category B).
  'review.completed': 'model',
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
  'comment.posted': 'model',
  'comment.resolved': 'model',
  'shepherd.iteration': 'model',
  'task.assigned': 'model',
  'task.progressed': 'model',

  // auto — emitted by exarchos doctor composite
  'diagnostic.executed': 'auto',

  // auto — emitted by the exarchos onboard composite (DR-7, two-event split)
  'onboard.requested': 'auto',
  'onboard.executed': 'auto',

  // hook — emitted by Claude Code hooks
  'benchmark.completed': 'hook',

  // auto — emitted by assess-stack orchestration
  'shepherd.started': 'auto',
  'shepherd.approval_requested': 'auto',
  // auto — emitted by assess-stack on the bound-hit escalate path (DR-3, #1595):
  // a structured terminal escalation (NOT a hang), surfaced via shepherd_status/ps.
  'shepherd.escalated': 'auto',
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
  // DR-2 (task 006) — the `merge.rollback` WRITE path is RETIRED. The recovery
  // path in `orchestrate/execute-merge.ts` now emits ONLY the canonical
  // `merge.recovered`. `merge.rollback` stays read-tolerant (its data schema +
  // type-map entry below are KEPT so legacy logs replay identically, INV-1) but
  // is NON-EMITTABLE — hence `retired`, not `auto`.
  'merge.rollback': 'retired',
  // #1306 successor — the sole emitted recovery terminal after DR-2.
  'merge.recovered': 'auto',
  // #1308 — emitted by the merge executor's retry loop (server-deterministic
  // plumbing), so it lives in the auto family alongside the other merge events.
  'merge.retry_attempt': 'auto',
  // auto — emitted by `handleExecuteMerge` immediately after `merge.executed`
  // succeeds, as the projection's terminal lifecycle marker (#1304 / INV-10).
  'merge.completed': 'auto',
  // #1309 — emitted by `handleExecuteMerge` (server-deterministic plumbing)
  // before the first vcsMerge, so it lives in the auto family alongside the
  // other merge-executor events.
  'merge.executing_started': 'auto',

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

  // auto — emitted by the wave-dispatch boundary (DR-7, epic #1546) when the
  // IMPLEMENT-kind gate-set resolver throws; the dispatch fails closed.
  'phase.blocked': 'auto',

  // auto — appended by the executeTransition boundary (DR-13, epic #1546) as
  // resolve-then-freeze: `phase.entered` freezes the resolved obligation,
  // `phase.exited` records the aggregate gate status on advance.
  'phase.entered': 'auto',
  'phase.exited': 'auto',

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

  // WLM foundation — worktree lifecycle events. Auto-emitted by the worktree
  // lifecycle manager as deterministic plumbing (adopt/reserve/release/heal on
  // the lease path). `worktree.orphan_detected` is registered + folded now (so
  // WLM-3's on-demand probe emits it without a schema migration), but its
  // EMITTER is deferred to WLM-3 (DR-4/5 on-demand ground-truth probe) — the
  // foundation GC reclaims orphans structurally via the prune ladder instead.
  // See EventTypes above and docs/specs/2026-06-25-wlm-foundation.md (DR-6).
  'worktree.adopted': 'auto',
  'worktree.reserved': 'auto',
  'worktree.released': 'auto',
  'worktree.orphan_detected': 'auto',

  // WLM operational-core (DR-4 / DR-7) — serialized-merge lease pair. Both are
  // `auto`: the CLAIM is appended deterministically by the merge orchestrator
  // via the event-store `decide` seam, and the RELEASE is a deterministic
  // keyed append on the terminal outcome — neither is model-authored.
  'worktree.merge_requested': 'auto',
  'worktree.merge_executed': 'auto',

  // harness-launcher (DR-2) — top-level worktree create pair + child liveness
  // pair. All four are `auto` deterministic plumbing: the create intent/terminal
  // are appended around the launcher's `git worktree add`, and the liveness pair
  // is emitted around the spawned child process — none is model-authored.
  'worktree.create.requested': 'auto',
  'worktree.create.executed': 'auto',
  'launch.executing_started': 'auto',
  'launch.executed': 'auto',

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

  // auto — emitted by the invariant-authoring composite handlers
  // (invariants-catalog-wizard, P2). `invariant.authored` lands on commit
  // (`invariants_add` dryRun:false); `catalog.registered` lands on the first
  // registration of a catalog file in `.exarchos.yml`. Server-deterministic:
  // the handler owns the append, so they are never model-emitted hints.
  'invariant.authored': 'auto',
  'catalog.registered': 'auto',

  // auto — emitted by the `mutation-adequacy` gate handler
  // (`orchestrate/mutation-adequacy.ts`) on the execution path (verification-
  // ladder slice 1, task 020). The handler owns both appends (started at entry,
  // executed at exit), so the model is never asked to hand-emit the liveness
  // pair.
  'mutation.executing_started': 'auto',
  'mutation.executed': 'auto',
  // #1319 — the `exarchos_workflow.feedback` handler owns the write
  // deterministically when the action is invoked, so the model is never
  // separately nagged to hand-emit it. ('auto', not 'model'.)
  'feedback.recorded': 'auto',

  // WLM slice 3 (DR-3) — prune-run liveness pair. Both `auto`: the
  // WorktreeManager owns both appends deterministically around the prune pass,
  // so the model is never asked to hand-emit them.
  'prune.executing_started': 'auto',
  'prune.executed': 'auto',

  // DR-4 (wiring-closure T-06) — durable projection-health state. Both `auto`:
  // `publishProjectionFreshness` (projections/freshness.ts) owns both appends
  // deterministically off a real cursor/tail comparison, so the model is never
  // asked to hand-emit them.
  'projection.degraded': 'auto',
  'projection.recovered': 'auto',

  // DR-6 (lifecycle-verbs, task 012) — the two-event `export` contract. Both
  // `auto`: the `export` composite handler owns both appends deterministically
  // (task 013 — `export.requested` before the zip write, `export.executed`
  // after), so the model is never nagged to hand-emit them.
  'export.requested': 'auto',
  'export.executed': 'auto',

  // Phase-gate v2.12 proof substrate. Evidence is now written by the canonical
  // audit/shadow runner; the remaining records stay reserved for later slices.
  // Nothing in this registration makes these model-emittable or changes
  // transition admission.
  'admission.requirement-resolved': 'planned',
  // Canonical gate producers append this automatically in v2.12 audit/shadow
  // mode; callers never model-emit proof records.
  'admission.evidence-recorded': 'auto',
  'admission.transition-decided': 'planned',
  'admission.waiver-recorded': 'planned',
  'admission.contradiction-recorded': 'planned',
  'admission.reassessment-requested': 'planned',
  'admission.reassessment-completed': 'planned',
  // DR-23 / T-31: the live shadow observer appends both automatically on every
  // guarded transition (`workflow/admission/live-shadow-observer.ts`); callers
  // never model-emit shadow evidence.
  'admission.shadow-attempt': 'auto',
  'admission.disagreement-disposition': 'auto',
  // Cutover promotion path (#1739): the `cutover_decide` typed handler
  // (`orchestrate/cutover-readiness.ts`) owns both appends deterministically —
  // the rollout decision is always recorded; the enablement fact is appended
  // ONLY behind a satisfied gate (the module refuses to build it otherwise).
  'admission.rollout-decision': 'auto',
  'admission.enforcement-enabled': 'auto',
  // #1739: the observer's durable-append success hook owns this append
  // deterministically (first-time readiness export); never model-emitted.
  'admission.cutover-ready': 'auto',
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
  // DR-2 / DR-4: identity of the initial actionable phase entry. Optional for
  // replay compatibility with pre-v2.12 streams; every new writer supplies it.
  phaseAttemptId: PhaseAttemptIdSchema.optional(),
  designPath: z.string().optional(),
  // Oneshot-only: the synthesisPolicy chosen at init time. Must be persisted
  // in the event stream so ES v2 rematerialization reconstructs the policy
  // — otherwise the workflow silently reverts to the schema default
  // (`on-request`) after `handleInit` → rehydrate round-trips. Silently
  // accepted for non-oneshot workflow types but never populated by them.
  synthesisPolicy: z.enum(['always', 'never', 'on-request']).optional(),
  // Repo identity (DR-5). OPTIONAL: populated by the composite layer at init
  // from the serving process's working directory via `deriveRepoKey`
  // (utils/paths.ts). Legacy events without it MUST still parse — the pipeline
  // projection treats an absent `repoRoot` as unscoped. The field enters the
  // model strictly as event data; no historical event is rewritten.
  repoRoot: z.string().optional(),
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
  // Identity allocated at the successful entry boundary. Optional solely for
  // historical event compatibility; new transition writes always carry it.
  phaseAttemptId: PhaseAttemptIdSchema.optional(),
});

export const WorkflowFixCycleData = z.object({
  // Only meaningful inside a compound state; a top-level child has no parent
  // compound, so absence is valid (#1339). Compound entry/exit always carry a
  // defined id and keep their non-optional `z.string()`.
  compoundStateId: z.string().optional(),
  count: z.number().int(),
  featureId: z.string(),
});

// DR-1 — counted plan-review revise cycle. Mirrors WorkflowFixCycleData: the
// emission boundary stamps the 1-based occurrence ordinal as `count`, and
// `compoundStateId` is optional because plan-review is a top-level atomic phase
// (no parent compound) — omitted rather than emitted as `undefined`.
export const WorkflowPlanRevisionData = z.object({
  compoundStateId: z.string().optional(),
  count: z.number().int(),
  featureId: z.string(),
});

// WLM-6 (DR-2) — counted plan-review dispatch, emitted by the
// `prepare_review scope:plan` provisioning seam. `ordinal` is the 0-based
// dispatch index for this feature (0 = the initial review = revision 0, 1 = the
// first re-dispatch = revision 1, …); the projection folds the MAX ordinal into
// `planReview.revisionCount`. Non-negative because it is a count-derived index.
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

/**
 * `workflow.handoff_summarized` (#1242) — auto-summarized handoff fallback.
 *
 * Emitted by a summarizer subagent (out of scope for #1242 — separate dispatch
 * path) when a checkpoint fires with no operator-authored handoff. Carries the
 * same `handoff` sub-object shape as `workflow.checkpoint` so the rehydration
 * reducer's `extractHandoff` folds both uniformly; `handoff` is REQUIRED here
 * (a summary event with no content is meaningless, though the reducer still
 * no-ops defensively on empty content).
 *
 * Replay determinism (INV-1 / Constraint 1): the summary string lives ON the
 * event — replay folds the stored payload, never re-invokes the (non-
 * deterministic) summarizer — so the projection is reproducible.
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

/** Durable cancellation intent; always precedes compensation side effects. */
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

// ─── P04-02 (EFF-005) — process-manager saga facts ──────────────────────────
// A monotonic fencing epoch, a bounded-retry ladder, and an explicit
// manual-intervention terminal, all recorded as replayable events so that
// restart AND takeover fold to the same decisions (see cancel-process-manager.ts).

const CancellationEpochSchema = z.number().int().positive();
const CancellationInstanceIdSchema = z.string().trim().min(1).max(200);

/**
 * Fencing-token allocation. `epoch` is strictly greater than every prior
 * ownership epoch on the stream; the process manager rejects any subsequent
 * write carrying a lower epoch (the classic distributed-lock fencing token).
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
 * Durable record that a failed compensation attempt is being retried. `attempt`
 * is the 1-based index of the attempt that just failed; a re-attempt (attempt
 * + 1) follows. Bounded by `maxAttempts`.
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
 * Terminal-but-unresolved compensation state. Reached when retries are
 * exhausted (or a non-retryable malformed result is observed). The saga can
 * never report `cancel.ready` while any action is in this state — it is a real,
 * queryable escalation, not a silently swallowed failure.
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
  // 'review' is the single dimension; 'spec-review'/'quality-review' retained for historical events.
  stage: z.enum(['review', 'spec-review', 'quality-review', 'security-review']).describe('Review stage that completed'),
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

// #1525 W2 Half 1 — per-subagent output-token total, emitted by the restored
// SubagentStop hook. The hook resolves teammate identity (teammateName/taskId)
// by matching the subagent's `cwd` to a dispatched worktree on the feature stream
// before appending, so the projection fold stays a clean single-stream left-fold.
// `teammateName`/`taskId` are optional: a non-worktree-isolated subagent has an
// ambiguous (shared) cwd and degrades to agentType-only attribution (INV-4).
// `.passthrough()` keeps room for future per-subagent samples (cache tokens, etc).
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

// DR-3 (#1595): structured bound-hit escalation. Hitting the auto-fix bound
// emits this (a structured terminal, NOT a hang — INV-10) so shepherd_status/ps
// can surface the WHY (reason + counts), not just the derived 'escalate' status.
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

// ─── Invariant Authoring Event Data (invariants-catalog-wizard, P2) ──────────

/**
 * `invariant.authored` — emitted by `invariants_add` on commit. Records which
 * invariant id was authored, into which catalog, at what tier, so the audit
 * trail can reconstruct the authoring history (INV-1 event-sourcing integrity).
 */
export const InvariantAuthoredDataSchema = z.object({
  id: z.string().min(1),
  catalog: z.string().min(1),
  tier: z.enum(['dev', 'user']),
  dimension: z.string().optional(),
  mode: z.enum(['audit', 'check']).optional(),
});

/**
 * `catalog.registered` — emitted on the first registration of a catalog file
 * in `.exarchos.yml` (by `invariants_add`). Records the registered path + tier.
 */
export const CatalogRegisteredDataSchema = z.object({
  path: z.string().min(1),
  tier: z.enum(['dev', 'user']),
});

// ─── Onboard Event Data (DR-7, two-event contract) ──────────────────────────
//
// `init.executed` (the retired init composite's event) was removed in DR-5
// (task 018). The onboard two-event contract below is its successor.

/**
 * The onboard trigger surface. `onboard` reconciles an existing repo;
 * `onboard-new` scaffolds a fresh project; `doctor-fix` applies the structured
 * doctor diff. All three drive the same reconciler, distinguished only by this
 * tag so the audit trail records *why* the reconcile ran.
 */
const OnboardTriggerSchema = z.enum(['onboard', 'onboard-new', 'doctor-fix']);

/**
 * `onboard.requested` — the durable INTENT recorded BEFORE the non-idempotent
 * reconcile fires (INV-1 / INV-13 two-event split). Carries the planned
 * {@link ReconcilePlan} so the timeline can reconstruct what was *intended*
 * even if execution crashes mid-flight. `idempotencyKey` lets a retry collapse
 * onto the same logical request.
 */
export const OnboardRequestedDataSchema = z.object({
  trigger: OnboardTriggerSchema,
  /** The structured reconcile plan (= the structured doctor diff). */
  plan: ReconcilePlanSchema,
  /** Stable key used to collapse retries onto the same logical request. */
  idempotencyKey: z.string().min(1),
});

/**
 * `onboard.executed` — the RESULT recorded AFTER the reconcile succeeds
 * (INV-1 / INV-13). Carries the {@link ReconcileResult} (applied / skipped /
 * residual steps + advisories), the wall-clock `durationMs`, and the same
 * `idempotencyKey` that paired it to its `onboard.requested` intent.
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

/**
 * worktree.created — the TASK-worktree terminal (UNCHANGED). Requires
 * `taskId` + `branch`: it records the per-task worktree an implementer boots into
 * and is classified `'model'` (the readiness path, not deterministic plumbing).
 *
 * Deliberately distinct from the launcher's top-level create pair
 * `worktree.create.requested`/`worktree.create.executed` (harness-launcher, DR-2):
 * that pair is the INV-13 intent/terminal for a task-LESS top-level worktree and
 * carries no `taskId`. Two different KINDS of worktree, two different terminals —
 * do NOT reuse this task terminal for the launcher's top-level creation.
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

// ─── Shared liveness instance key (DR-2 / INV-10) ────────────────────────────
//
// The SINGLE field the four INV-10 liveness pairs — merge / launch / mutation /
// prune `<surface>.executing_started` + paired terminal — agree on. `instanceId`
// is a canonical per-instance key so a uniform liveness view can correlate a
// START event with its TERMINAL without per-surface knowledge of which native
// field is the instance discriminator. Each emitter derives it from its own key:
//   • merge    → taskId ?? `${sourceBranch}→${targetBranch}`
//   • launch   → worktreeId
//   • mutation → operationId
//   • prune    → operationId
//
// This is ADDITIVE, not a uniform-shape rewrite: the surface-native fields
// (sourceBranch, worktreeId, operationId, holderPid, …) are DELIBERATELY kept
// as-is. Only this one field is shared — the payloads otherwise stay their own
// distinct shapes (do not force a uniform shape where the real payloads differ).
//
// OPTIONAL + additive (INV-5b widening): every payload emitted BEFORE this
// retrofit carried NO `instanceId`, so historical rows MUST still validate — no
// migration, no schemaVersion bump. The emitters populate it going forward and
// legacy rows fold as instanceId-absent. `.min(1)` rejects an empty/blank key:
// an empty instance id is meaningless, and a wrong-typed value is a malformed
// payload the boundary now rejects — the field the DR-2 revert-probe pins.
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
 * merge.executed — records that a merge has been performed. `mergeSha` is
 * the resulting commit on the target branch; `rollbackSha` is the parent
 * commit captured prior to merge so a downstream rollback handler can rewind
 * to it deterministically via the INV-14 ladder (`git merge --abort` →
 * `git reset --keep <rollbackSha>`, never `--hard`).
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
  // DR-2 — canonical liveness instance key (merge: taskId ?? `src→tgt`).
  ...livenessInstanceFields,
});

/**
 * merge.rollback — legacy recovery event, RETIRED as of DR-2 (task 006):
 * read-tolerant-not-emittable. Its data schema + type-map entry are KEPT so
 * pre-DR-2 event logs still replay to identical state (INV-1), but nothing
 * writes it any more — the recovery path now emits `merge.recovered` (below).
 * `reason` is a closed enum so observability dashboards don't fragment across
 * free-form text. Preflight failures are NOT a rollback cause — they
 * short-circuit before any merge occurs. `rollbackError` carries the
 * human-readable recovery-failure
 * detail (paired with the `recoveryError` discriminator below) when the INV-14
 * recovery ladder did not land cleanly: presence signals the worktree may be in
 * an indeterminate state, so consumers can page operators.
 */
export const MergeRollbackData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  rollbackSha: z.string().min(1),
  reason: z.enum(['merge-failed', 'verification-failed', 'timeout']),
  rollbackError: z.string().min(1).optional(),
  // INV-14 discriminator on the recovery outcome — distinguishes the three
  // cases the invariant names so downstream observability sees indeterminate
  // worktrees explicitly rather than as silent successes. The producer in
  // `pure/execute-merge.ts` runs the full ladder (`git merge --abort` →
  // `git reset --keep <rollbackSha>`, never `--hard`) and emits:
  // `'reset-keep-blocked'` when `reset --keep` refuses to discard local work,
  // `'reset-failed'` when the reset errors, and `'unexpected-mid-merge-drift'`
  // when HEAD ≠ the anchor after recovery. See INV-14 in
  // `.exarchos/invariants.md` for the full primitive-ordering contract.
  recoveryError: z
    .enum(['reset-keep-blocked', 'reset-failed', 'unexpected-mid-merge-drift'])
    .optional(),
});

/**
 * merge.recovered — the #1306 successor to `merge.rollback`. Emitted when a
 * merge is reverted via the INV-14 recovery ladder. Same closed `reason` enum.
 * `recoveryPointSha` is the anchor the worktree was rewound to (was
 * `rollbackSha`); `recoveryErrorDetail` is the human-readable recovery-failure
 * string (was `rollbackError`) paired with the `recoveryError` discriminator.
 *
 * Since DR-2 (task 006) this is the SOLE emitted recovery terminal; the legacy
 * `merge.rollback` write path is retired (read-tolerant-not-emittable). Old
 * dual-emit streams still replay identically because the reducers fold both
 * events to the same terminal state. Vocabulary follows the canonical frame —
 * recovery point / recovery event, not saga compensation / rollback.
 */
export const MergeRecoveredData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  recoveryPointSha: z.string().min(1),
  reason: z.enum(['merge-failed', 'verification-failed', 'timeout']),
  recoveryErrorDetail: z.string().min(1).optional(),
  // INV-14 discriminator on the recovery outcome — see MergeRollbackData above
  // for the full primitive-ordering contract. Kept under the canonical name.
  recoveryError: z
    .enum(['reset-keep-blocked', 'reset-failed', 'unexpected-mid-merge-drift'])
    .optional(),
});

/**
 * merge.retry_attempt — #1308 audit record of a transient-failure retry of the
 * merge attempt. `attempt` is the retry ordinal, `delayMs` is the backoff
 * applied before the retry fired, and `reason` is the transient-failure reason
 * that triggered the retry (e.g. `'timeout'`). The emission site lands in a
 * later #1308 task; this registration is additive (no behavior change).
 */
export const MergeRetryAttemptData = z.object({
  attempt: z.number().int().nonnegative(),
  delayMs: z.number().int().nonnegative(),
  reason: z.string().min(1),
});

/**
 * merge.completed — terminal lifecycle event emitted immediately after a
 * successful `merge.executed`. Folded by the `merge-orchestrator@v1`
 * projection (#1304) as the transition into the `completed` phase, which is
 * the projection's terminal state.
 *
 * Distinct from `merge.executed` (which records the side effect — the actual
 * merge against the target branch) so the projection can model the two
 * states separately: `executed` ("the merge happened") vs `completed`
 * ("the orchestrator has formally terminated this lifecycle"). The
 * separation matches INV-10's `<surface>.executing_started` + paired
 * terminal event pattern.
 *
 * In the current (preview.2) producer the two events are emitted adjacent
 * in `handleExecuteMerge`; future work may interpose post-merge
 * verification between them, at which point the `executed → completed`
 * transition gains operational meaning.
 */
// Derived from `MergeExecutedData` to keep the adjacent event-pair contracts
// in lockstep — any field-shape change to the executed payload (e.g., a
// tighter mergeSha pattern, a renamed taskId) automatically propagates to
// the terminal marker. Adds `featureId` (optional) for cross-stream
// observability; merge.executed doesn't carry it because the executor's
// stream context already pins the feature.
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
 * merge.executing_started — #1309 merge-executor liveness event. Emitted by
 * `handleExecuteMerge` after the recovery point sha is recorded and BEFORE the
 * first `vcsMerge` attempt, so a long-running merge is observable as "started
 * but not yet terminated" — the INV-10 `<surface>.executing_started` + paired
 * terminal (`merge.executed` / `merge.recovered`) pattern, mirroring
 * `mutation.executing_started`.
 *
 * `recoveryPointSha` is the anchor HEAD the merge can be rewound to (the same
 * sha the terminal events carry as `rollbackSha` / `recoveryPointSha`).
 * `startedAt` is the ISO timestamp at which the merge attempt began. `taskId`
 * is optional (CLI direct-invocation has no task context), matching the other
 * merge events.
 */
export const MergeExecutingStartedData = z.object({
  taskId: z.string().optional(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  recoveryPointSha: z.string().min(1),
  startedAt: z.string().min(1),
  // DR-2 — canonical liveness instance key (merge: taskId ?? `src→tgt`).
  ...livenessInstanceFields,
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
  threadId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Id of the review-comment thread being replied to (provider addReply path). Absent ⇒ PR-level comment via addComment.',
    ),
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
 *
 * `worktreeId` is the OPTIONAL canonical (symlink-resolved, POSIX-separator)
 * projection key, stamped by the emitter (`WorktreeManager`) so the
 * `worktrees@v1` reducer can drop the entry by the ALREADY-CANONICAL key during
 * replay — without a `realpath()` filesystem call at fold time. That keeps the
 * cold rebuild deterministic from the event log alone (INV-1): once the worktree
 * is deleted, or on a host with a different symlink topology, re-deriving the key
 * from `worktreePath` via the live filesystem would fold differently. Optional
 * for backward compatibility: a legacy event without it still folds via the
 * `worktreePath` canonicalization fallback.
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
 * worktree.remove.executed — B5.1: records the outcome of the removal.
 * `removed: false` indicates the worktree was already absent (idempotent success).
 *
 * Carries the same OPTIONAL canonical `worktreeId` as the requested event so the
 * reducer drops the projection entry by the stored key during a filesystem-free
 * replay (see {@link WorktreeRemoveRequestedData}).
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
 * WLM foundation — worktree lifecycle event data.
 *
 * `worktree.adopted` / `worktree.reserved` / `worktree.released` /
 * `worktree.orphan_detected` share one payload shape. `worktreeId` is DEFINED
 * as the canonical (symlink-resolved) worktree path: it is the stable identity
 * a later reducer canonicalizes the remove pair's `worktreePath` onto, which is
 * why GC deletion REUSES `worktree.remove.requested`/`worktree.remove.executed`
 * (no `worktree.pruned` type is introduced; the serialized-merge lease pair
 * `worktree.merge_requested`/`worktree.merge_executed` is defined separately
 * below as the WLM operational-core layer — DR-4 / DR-7).
 *
 * Idempotency: these events use the existing two-component
 * `<eventType>:<operationId>` key — exactly like `worktree.remove.requested:${operationId}`
 * in `workflow/compensation.ts`. The per-invocation `operationId` is the sole
 * discriminator, so a reserve → release → re-reserve sequence mints three
 * distinct operationIds and therefore three distinct keys (no silent collapse).
 * Keys are minted by callers; the schema's contract is only that every
 * lifecycle payload carries `operationId` so callers can build the key.
 *
 * `ownerPid` / `ownerStartedAt` identify the holding process. `ownerPid` is
 * non-null only on `worktree.reserved` (the reservation records who holds the
 * lease); `ownerStartedAt` is a NON-EMPTY create-time fingerprint on a reserved
 * event when the platform can resolve it, or null when it cannot (DR-5 — a
 * create-time-unresolvable platform reserves with `ownerStartedAt: null`, NEVER
 * the empty string `''`; the `.min(1).nullable()` shape mirrors the launcher's
 * `holderStartedAt`). The other three lifecycle events may pass null for both.
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
 * WLM operational-core — serialized-merge lease event data (DR-4 / DR-7).
 *
 * `worktree.merge_requested` is the CLAIM half: an intent-to-merge record that
 * doubles as a lease (which live process is currently authorized to merge
 * `sourceBranch` into `integrationRef`). `worktree.merge_executed` is the
 * RELEASE half: the terminal outcome of that operation.
 *
 * Both ride the singleton `worktrees` stream alongside the lifecycle family and
 * are correlated by `operationId`. `operationId` is the SOLE discriminator, so
 * two distinct merge attempts onto the SAME `integrationRef` mint two distinct
 * operationIds and therefore two distinct idempotency keys — they never collapse
 * into one another, which is what serializes merges per branch without a literal
 * `<integrationRef>:…` key. The CLAIM is appended via the event-store `decide`
 * seam, which derives its own `${streamId}:${reducerId}:${operationId}` key; the
 * RELEASE is a plain keyed append `<eventType>:<operationId>` per the
 * worktree-family convention. The schema's only contract is that both payloads
 * carry `operationId` so callers can build those keys.
 *
 * `holderPid` / `holderStartedAt` identify the live process that holds the merge
 * lease (liveness ground truth for orphan reclamation). `worktreeId` is the
 * OPTIONAL canonical worktrees@v1 key, stamped when the merge is attributable to
 * a specific tracked worktree.
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
 * worktree.merge_executed — RELEASE half of the serialized-merge lease.
 *
 * Correlates back to its `worktree.merge_requested` via `operationId` and
 * records the terminal `status`. `mergeSha` is present only on `status: 'merged'`
 * (the resulting integration commit). `recoveryError` is an OPTIONAL diagnostic
 * captured when the lease was released during recovery of a dead holder rather
 * than by the original operation completing.
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

// ─── Harness-Launcher Event Data (DR-2) ─────────────────────────────────────

/**
 * worktree.create.requested — the launcher's top-level worktree INTENT (INV-13).
 *
 * Mirrors {@link WorktreeRemoveRequestedData}: a durable intent recorded BEFORE
 * the non-idempotent `git worktree add` fires, correlated to its terminal by
 * `operationId`. This is the launcher's TASK-LESS top-level worktree — distinct
 * from the task-scoped `worktree.created` terminal (which requires `taskId` +
 * `branch`). `worktreeId` is the OPTIONAL canonical (symlink-resolved) key,
 * stamped so a later reducer folds by the stored id without a `realpath()` call.
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
 * worktree.create.executed — the launcher's top-level worktree TERMINAL (INV-13).
 *
 * The shared-stem terminal for {@link WorktreeCreateRequestedData}, correlated by
 * `operationId`. `created: false` indicates the worktree already existed
 * (idempotent success). A NEW terminal — NOT the task-scoped `worktree.created`.
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
 * launch.executing_started — launcher child-process liveness START.
 *
 * Mirrors the liveness fields of {@link InFlightMerge}: `holderPid` /
 * `holderStartedAt` identify the live child process the launcher spawned into the
 * top-level worktree, so a dead-holder reconciler can later reclaim an abandoned
 * launch by probing whether that PID (with matching start time, to defeat PID
 * reuse) is still alive. `worktreeId` binds the launch to its top-level worktree.
 * Emitted BEFORE the child is observed as terminated, so a long-running launch is
 * observable as "started but not yet terminated" — the INV-10
 * `<surface>.executing_started` + paired terminal pattern.
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
  // DR-2 — canonical liveness instance key (launch: worktreeId).
  ...livenessInstanceFields,
});

/**
 * launch.executed — launcher child-process liveness TERMINAL.
 *
 * The paired terminal for {@link LaunchExecutingStartedData}: "executed" = the
 * child process exited. Correlated back to its start by `worktreeId`, carrying the
 * process `exitCode` (null when terminated by signal / not captured).
 */
export const LaunchExecutedData = z.object({
  worktreeId: z.string().min(1).describe('Canonical worktrees@v1 key of the launch top-level worktree'),
  exitCode: z.number().int().nullable().describe('Child process exit code, or null when signalled / not captured'),
  // DR-2 — canonical liveness instance key (launch: worktreeId).
  ...livenessInstanceFields,
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
    // `toolchain-config` (user .exarchos.yml toolchains:) and `task-runner`
    // (Taskfile/just/mise/Makefile) added with the layered resolver — additive
    // enum widening on an existing event type, no schema-version bump.
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
 * phase.blocked — fail-closed at the gate-set boundary (DR-7, epic #1546).
 *
 * Emitted by the wave-dispatch boundary (`handlePrepareDelegation` →
 * `classifyTasksFailClosed`) when the kind-keyed gate-set resolver
 * (`resolveGateSet(kind, …)`) throws while stamping a wave's verification
 * sequence. Rather than letting the exception propagate and fail the dispatch
 * OPEN / silently, the boundary REFUSES to proceed and records this durable
 * event so an operator sees the blocked phase and why.
 *
 * Required-string fields (`min(1)`) so a blocked-dispatch record without an
 * actionable reason fails at the schema boundary rather than landing an empty
 * audit row. `kind` is the {@link PhaseKind} whose resolver faulted; `phase` is
 * the lifecycle phase the dispatch was at; `error` carries the underlying
 * resolver fault so the failure is debuggable from the event log alone.
 */
/**
 * The closed phase-kind set, mirrored from `workflow/phase-kind.ts`'s `PhaseKind`
 * union. Inlined (not imported) to keep this low-level event-store layer free of
 * a workflow/config dependency — `phase-kind.ts` transitively pulls in the
 * verification-policy + config resolvers, which must not become event-store deps.
 * A drift-guard test pins these options to `KIND_OBLIGATIONS` so the two cannot
 * silently diverge.
 */
export const PhaseBlockedKindSchema = z.enum([
  'IMPLEMENT',
  'PLAN',
  'REVIEW',
  'SYNTHESIZE',
  'MERGE',
  'GATHER',
]);

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

/**
 * phase.entered / phase.exited — resolve-then-freeze obligation record
 * (DR-13, epic #1546).
 *
 * `executeTransition` resolves the target kind's gate-set at the phase boundary
 * (DR-10) and FREEZES it by appending exactly one `phase.entered` carrying the
 * resolved obligation: the dispatching `resolver` name, the resolved
 * `resolvedGates` sequence, the `policySource` (built-in policy vs a
 * `.exarchos.yml` verification overlay), and the resolved `mode`. Replaying the
 * event log left-folds these into the same obligation a live HSM observed — a
 * later policy edit cannot retroactively change an in-flight or completed phase.
 * `phase.exited` is appended on phase advance with the aggregate gate status.
 *
 * `kind` reuses {@link PhaseBlockedKindSchema} (the inlined PhaseKind union,
 * drift-guarded against `KIND_OBLIGATIONS`). `resolver` is null for a kind with
 * no gates (GATHER). The per-family gate vocabulary stays owned by
 * `phase-kind.ts` / `review-contract.ts`, so each resolved `gate` is carried as
 * an opaque string at this vocabulary-light event-store layer; only the
 * four-member `family` discriminant is pinned (drift-guarded against the
 * `ResolvedGate` union in the schemas test).
 */
export const PhaseEnteredResolverSchema = z.enum([
  'verification-ladder',
  'plan-structure',
  'review-contract',
  'synthesis-readiness',
]);

export const ResolvedGateFamilySchema = z.enum(['ladder', 'plan', 'review', 'synthesis']);

/**
 * Phase-kind POLA posture (DR-14). Inlined to keep the event-store layer free of
 * an `agents/spec.ts` import; pinned to the `KIND_OBLIGATIONS` posture set by a
 * drift-guard test (mirrors `PhaseBlockedKindSchema`).
 */
export const PhaseEnteredPostureSchema = z.enum(['read-only', 'task-isolated', 'shared-mutating']);

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
  // DR-3 (#1581): the feature-level planning depth, resolve-then-frozen at PLAN
  // entry — the per-feature analog of per-task riskTier. Optional and present
  // ONLY on the PLAN phase.entered (the single per-feature freeze point); absent
  // on every other kind and on pre-#1581 logs, where the resolver defaults to
  // 'standard'. Enum inlined to keep the event-store layer free of a workflow
  // import (mirrors PhaseEnteredPostureSchema); pinned to DesignDepth by a test.
  designDepth: z
    .enum(['thin', 'standard', 'deep'])
    .optional()
    .describe('Feature planning depth frozen at PLAN entry (DR-3); absent ⇒ standard'),
  // DR-10 (T-15): the danger COORDINATE the gate-set was resolved from, frozen
  // alongside it. Without it the record is not self-describing — IMPLEMENT
  // defers its sequence to the wave stamp and several resolvers ignore one axis
  // — so a later attempt (or a replay) would have to RE-RESOLVE from current
  // state, which is the DR-10 defect. `'unknown'` is a first-class member: the
  // record states that nobody classified the task rather than fabricating the
  // weakest tier. Optional so pre-T-15 logs keep validating.
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
  // FINDING-8 (#1438, T6): persist the JSON-RPC `requestId` so REPLAY
  // recovers the original outbound correlation id verbatim instead of
  // having to synthesize `replayed:${taskId}`. Optional because
  // historical `task.created` events emitted before this fix do NOT
  // carry the field — the synthesizer in `projectTask` remains the
  // load-bearing back-compat fallback for those events (INV-1: events
  // are immutable, so old events stay shaped as they were when written).
  // SDK `RequestId` is `string | number` (JSON-RPC envelope), so we
  // mirror that union here rather than narrowing to string.
  requestId: z.union([z.string(), z.number()]).optional(),
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
    // #1509/#1501 — native-isolation worktree base-pin guard. Optional so
    // the non-native dispatch path and `runPreflightGuards` (which never
    // run it) remain schema-valid; populated only on the `nativeIsolation`
    // path where Claude Code selects the worktree base.
    baseRef: z.object({ passed: z.boolean() }).optional(),
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

// ─── Mutation-run liveness (verification-ladder slice 1, task 020 / INV-10) ──
//
// `mutation.executing_started` records the start of a mutation run driven by
// the `mutation-adequacy` gate handler (`orchestrate/mutation-adequacy.ts`);
// `mutation.executed` is the paired terminal carrying the verdict. The pair
// makes a long-running mutation sweep observable as a lifecycle, the same shape
// as the merge orchestrator's executing/executed split.

/** Emitted at the start of a (non-dry-run) mutation-adequacy run. */
export const MutationExecutingStartedData = z.object({
  /** The resolved mutation command being run (e.g. `npx stryker run`). */
  command: z.string().min(1),
  /** Repo root the command runs in. */
  repoRoot: z.string().min(1),
  // DR-2 — canonical liveness instance key (mutation: operationId).
  ...livenessInstanceFields,
});

/** Paired terminal event: the mutation run completed (pass/fail + exit code). */
export const MutationExecutedData = z.object({
  command: z.string().min(1),
  repoRoot: z.string().min(1),
  /** True when the mutation command exited 0. */
  passed: z.boolean(),
  /** The child process exit code. */
  exitCode: z.number().int(),
  // DR-2 — canonical liveness instance key (mutation: operationId).
  ...livenessInstanceFields,
});

/**
 * `feedback.recorded` (#1319) — agent→runtime friction back-channel.
 *
 * `message` is the friction report itself (required, non-empty). `sessionContext`
 * is optional structured provenance: which workflow / action / errorCode the
 * agent was in when it hit the friction. `configuredEndpoint` records the
 * `.exarchos.yml` `feedback.upstream` URL captured at emit time (or `null` when
 * unset) so a later query can tell whether the report was eligible for upstream
 * federation; `upstreamDelivered` records whether the best-effort POST actually
 * succeeded (`false` when there was no endpoint, the POST failed, or it was
 * skipped — the local event write always succeeds regardless, INV-15 /
 * offline-first).
 *
 * Intentionally NOT `.strict()`: this is an append-only event payload, so a
 * future additive field must not retroactively invalidate replay of older rows.
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

// ─── Prune-run liveness (WLM slice 3, DR-3 / INV-10) ────────────────────────
//
// `prune.executing_started` records the START of a `prune_worktrees` GC pass;
// `prune.executed` is the paired TERMINAL. The pair rides the singleton
// `worktrees` stream and is folded by `worktrees@v1` into `inFlightPrunes`
// (keyed by `operationId`) so an in-flight prune is `ps`/`wait`-visible — the
// INV-10 liveness idiom shared with the merge / launch / mutation pairs.

/** Emitted at the START of a `prune_worktrees` GC pass (DR-3). */
export const PruneExecutingStartedData = z.object({
  /** Correlation key + `inFlightPrunes` map key — one per prune pass. */
  operationId: z.string().min(1),
  /** Repo root the prune pass governs. */
  repoRoot: z.string().min(1),
  /** PID of the live process running the prune (liveness ground truth). */
  holderPid: z.number().int(),
  /**
   * Holder process create-time (ISO 8601) — disambiguates PID reuse for a later
   * dead-holder reconciler. Modeled as `null` (never `''`) when the platform
   * cannot resolve it, mirroring the DR-5 `ownerStartedAt` / `holderStartedAt`
   * null-ready contract.
   */
  holderStartedAt: z.string().min(1).nullable(),
  // DR-2 — canonical liveness instance key (prune: the existing operationId).
  ...livenessInstanceFields,
});

/** Paired TERMINAL: the `prune_worktrees` GC pass completed (DR-3). */
export const PruneExecutedData = z.object({
  operationId: z.string().min(1),
  /** How many worktrees the pass deleted (0 on a dry-run or a no-op pass). */
  deletedCount: z.number().int().nonnegative(),
  // DR-2 — canonical liveness instance key (prune: the existing operationId).
  ...livenessInstanceFields,
});

// ─── Export event contract (DR-6, lifecycle-verbs task 012 / INV-13 / INV-8) ─
//
// `export` writes a zip bundle (events.jsonl + state.json + metadata.json +
// artifacts/) to a path OUTSIDE `.exarchos/` — a non-idempotent external side
// effect, so it follows the INV-13 two-event split. `export.requested` is the
// durable INTENT (carrying the RESOLVED destination path) journaled BEFORE the
// write; `export.executed` is the RESULT (carrying the written bundle's content
// hash) journaled AFTER. On a crash between the two, the next invocation
// observes `export.requested` without `export.executed` and runs an idempotent
// precheck (the zip exists AND its hash matches the recorded `contentHash`) to
// decide whether to re-emit `export.executed` or redo the write.
//
// Both payloads carry `idempotencyKey` (INV-8) — the emitter (task 013) derives
// the storage key from it so a crash-retry of the SAME logical export collapses
// onto one intent, while a fresh export invocation mints a distinct key and a
// new pair. The schema's only contract is that the field is present + non-empty;
// the emitter owns the key's construction.

/**
 * `export.requested` — durable INTENT recorded BEFORE the non-idempotent zip
 * write (INV-13). Carries the RESOLVED destination `outputPath` so the timeline
 * reconstructs exactly WHERE the bundle was intended to land even if the write
 * crashes mid-flight (the default `./<featureId>-export.zip` is resolved to an
 * absolute path by the handler before this event is emitted). `idempotencyKey`
 * (INV-8) lets a crash-retry collapse onto the same logical request.
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
 * `export.executed` — the RESULT recorded AFTER the zip write succeeds
 * (INV-13). Carries the written bundle's `contentHash` (the INV-13 crash
 * precheck compares it against the on-disk zip to decide re-emit vs redo), the
 * `eventCount` in the exported stream extract, the OPTIONAL `missingArtifacts`
 * (referenced artifact paths that did not exist on disk — tolerated and listed
 * in the bundle metadata), and the SAME `idempotencyKey` that paired it to its
 * `export.requested` intent.
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

// ─── Durable projection-health state (DR-4, wiring-closure T-06) ────────────
//
// The cursor/tail freshness verdict, made durable. `projections/freshness.ts`
// computes it (pure comparison, no I/O) and `publishProjectionFreshness`
// journals it to the singleton `meta/projection-health` stream — never to the
// stream under assessment, whose tail the append would itself move.
//
// `reason` mirrors the `ProjectionDegradationReason` union in
// `projections/freshness.ts` exactly. New members MUST be added in both places:
// the enum enforces the wire contract, the union enforces the call-site
// contract (same coordinated-change rule as the DR-18
// `WorkflowProjectionDegradedCause` enum above).

/** Closed enum of cursor/tail disagreement directions (DR-4). */
export const ProjectionDegradedReason = z.enum([
  /** The fold stops short of the durable tail — the answer omits recent events. */
  'projection-behind',
  /** The fold claims events past the durable tail — fold and log contradict. */
  'projection-ahead',
]);
export type ProjectionDegradedReason = z.infer<typeof ProjectionDegradedReason>;

/**
 * `projection.degraded` — a stream's materialized folds disagree with its
 * durable event tail, recorded durably so a consumer that does not share the
 * in-memory materializer cache (another process, or this one after a restart)
 * can still tell "no tasks completed" from "the fold has not seen the events
 * that completed them".
 *
 * `streamId` is the ASSESSED stream (the event itself lives on
 * `meta/projection-health`), which is also the fold key: the latest
 * unresolved record per `streamId` IS the durable degraded state.
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
 * `projection.recovered` — the paired RESOLUTION. Published only when a stream
 * that currently holds an unresolved `projection.degraded` record has caught
 * the tail, so the folded health state can return to healthy. Without it the
 * durable state would be a sticky one-way flag that no consumer could ever
 * clear.
 */
export const ProjectionRecoveredData = z.object({
  streamId: z
    .string()
    .min(1)
    .describe('The assessed stream whose folds have caught the durable tail'),
  eventTail: z.number().int().nonnegative(),
  projectionCursor: z.number().int().nonnegative(),
});

// ─── Internal admission proof events (phase-gate v2.12, DR-2 / DR-3) ────────
//
// These schemas establish an additive replay contract. They deliberately do
// not define public action arguments, authorize generic event append, evaluate
// policy, or switch transition enforcement. The domain-bearing fields reuse
// workflow/admission/types.ts so event and runtime unions cannot drift.

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

/** Durable evidence fact; the runtime evidence union owns subject/provenance. */
export const AdmissionEvidenceRecordedData = z
  .object({
    eventVersion: AdmissionProofEventVersionSchema,
    evidence: AdmissionEvidenceV1Schema,
    /**
     * Explicit append-only rerun link. Attribution comes from the superseding
     * evidence producer snapshot; replay never rewrites the predecessor.
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
    /** Added for new writers; historical V1 facts derive it from evidenceIds. */
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

/** Authorized, attributable rollout assessment; still inert in v2.12. */
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
 * Replay shape for a future enablement fact. Merely registering this planned
 * schema does not make any v2.12 resolver consume it or enable enforcement.
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
 * Cutover promotion path (#1739) — the first-time readiness export record.
 *
 * Appended by the observer's durable-append success hook when all six cutover
 * conditions are FIRST satisfied. Carries a REFERENCE to the exported report
 * (path + content digest) plus the load-bearing summary counts, not a copy of
 * the full report — the artifact on disk is the detail, the event is the fact.
 * The idempotency key is a pure function of store identity (never clock- or
 * random-derived, the T-49 lesson), so a repeat evaluation after readiness
 * collapses onto the stored row instead of duplicating it.
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
// NOTE: deliberately no `AdmissionCutoverReady` z.infer alias — the sole
// producer (`cutover-auto-export.ts`) builds the payload through
// `AdmissionCutoverReadyData.parse` directly, so an exported alias would be
// dead code (knip fails closed on unconsumed exports).

// ─── Event Data Schemas Map ─────────────────────────────────────────────────

export const EVENT_DATA_SCHEMAS: Partial<Record<EventType, z.ZodSchema>> = {
  // Workflow-level
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
  'subagent.tokens_used': SubagentTokensUsedDataSchema,

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
  'shepherd.escalated': ShepherdEscalatedData,
  'shepherd.completed': ShepherdCompletedData,

  // Eval
  'eval.run.started': EvalRunStartedData,
  'eval.case.completed': EvalCaseCompletedData,
  'eval.run.completed': EvalRunCompletedData,
  'eval.judge.calibrated': JudgeCalibratedDataSchema,

  // Diagnostic (exarchos doctor)
  'diagnostic.executed': DiagnosticExecutedDataSchema,

  // Onboard (exarchos onboard composite, DR-7 two-event contract)
  'onboard.requested': OnboardRequestedDataSchema,
  'onboard.executed': OnboardExecutedDataSchema,

  // Invariant authoring (invariants-catalog-wizard, P2)
  'invariant.authored': InvariantAuthoredDataSchema,
  'catalog.registered': CatalogRegisteredDataSchema,

  // Mutation-run liveness (verification-ladder slice 1, task 020 / INV-10)
  'mutation.executing_started': MutationExecutingStartedData,
  'mutation.executed': MutationExecutedData,

  // Agent→runtime friction back-channel (#1319)
  'feedback.recorded': FeedbackRecordedData,

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
  'merge.recovered': MergeRecoveredData,
  'merge.retry_attempt': MergeRetryAttemptData,
  'merge.completed': MergeCompletedData,
  'merge.executing_started': MergeExecutingStartedData,

  // Command resolver (#1199 T15) — audit trail for runtime resolver decisions.
  'command.resolved': CommandResolvedEventSchema,

  // Durable event-store substrate (#1259) — T02 / T03 / T04.
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

  // WLM foundation — worktree lifecycle (lease/ownership half).
  'worktree.adopted': WorktreeAdoptedData,
  'worktree.reserved': WorktreeReservedData,
  'worktree.released': WorktreeReleasedData,
  'worktree.orphan_detected': WorktreeOrphanDetectedData,

  // WLM operational-core — serialized-merge lease pair (DR-4 / DR-7).
  'worktree.merge_requested': WorktreeMergeRequestedData,
  'worktree.merge_executed': WorktreeMergeExecutedData,

  // harness-launcher (DR-2) — top-level worktree create pair + child liveness pair.
  'worktree.create.requested': WorktreeCreateRequestedData,
  'worktree.create.executed': WorktreeCreateExecutedData,
  'launch.executing_started': LaunchExecutingStartedData,
  'launch.executed': LaunchExecutedData,

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

  // WLM slice 3 (DR-3 / INV-10) — prune-run liveness pair.
  'prune.executing_started': PruneExecutingStartedData,
  'prune.executed': PruneExecutedData,

  // DR-6 (lifecycle-verbs task 012) — export two-event contract (INV-13 / INV-8).
  'export.requested': ExportRequestedData,
  'export.executed': ExportExecutedData,

  // DR-4 (wiring-closure T-06) — durable projection-health state.
  'projection.degraded': ProjectionDegradedData,
  'projection.recovered': ProjectionRecoveredData,

  // Phase-gate v2.12 internal proof/admission replay contracts (DR-2 / DR-3).
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
export type ShepherdEscalated = z.infer<typeof ShepherdEscalatedData>;
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
// Onboard two-event contract (DR-7, task 008).
export type OnboardRequested = z.infer<typeof OnboardRequestedDataSchema>;
export type OnboardExecuted = z.infer<typeof OnboardExecutedDataSchema>;
// invariants-catalog-wizard (P2) — authoring lifecycle event payloads.
export type InvariantAuthored = z.infer<typeof InvariantAuthoredDataSchema>;
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

// WLM foundation — worktree lifecycle (lease/ownership half).
export type WorktreeAdopted = z.infer<typeof WorktreeAdoptedData>;
export type WorktreeReserved = z.infer<typeof WorktreeReservedData>;
export type WorktreeReleased = z.infer<typeof WorktreeReleasedData>;
export type WorktreeOrphanDetected = z.infer<typeof WorktreeOrphanDetectedData>;

// WLM operational-core — serialized-merge lease pair (DR-4 / DR-7).
export type WorktreeMergeRequested = z.infer<typeof WorktreeMergeRequestedData>;
export type WorktreeMergeExecuted = z.infer<typeof WorktreeMergeExecutedData>;

// harness-launcher (DR-2) — top-level worktree create pair + child liveness pair.
export type WorktreeCreateRequested = z.infer<typeof WorktreeCreateRequestedData>;
export type WorktreeCreateExecuted = z.infer<typeof WorktreeCreateExecutedData>;
export type LaunchExecutingStarted = z.infer<typeof LaunchExecutingStartedData>;
export type LaunchExecuted = z.infer<typeof LaunchExecutedData>;

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
export type FeedbackRecorded = z.infer<typeof FeedbackRecordedData>;

// WLM slice 3 (DR-3 / INV-10) — prune-run liveness pair.
export type PruneExecutingStarted = z.infer<typeof PruneExecutingStartedData>;
export type PruneExecuted = z.infer<typeof PruneExecutedData>;

// DR-6 (lifecycle-verbs task 012) — export two-event contract (INV-13 / INV-8).
export type ExportRequested = z.infer<typeof ExportRequestedData>;
export type ExportExecuted = z.infer<typeof ExportExecutedData>;

// DR-4 (wiring-closure T-06) — durable projection-health state.
export type ProjectionDegraded = z.infer<typeof ProjectionDegradedData>;
export type ProjectionRecovered = z.infer<typeof ProjectionRecoveredData>;

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
  'comment.posted': CommentPosted;
  'comment.resolved': CommentResolved;
  'diagnostic.executed': DiagnosticExecuted;
  // Onboard two-event contract (DR-7, task 008).
  'onboard.requested': OnboardRequested;
  'onboard.executed': OnboardExecuted;
  // invariants-catalog-wizard (P2) — authoring lifecycle events.
  'invariant.authored': InvariantAuthored;
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
  // WLM foundation — worktree lifecycle (lease/ownership half).
  'worktree.adopted': WorktreeAdopted;
  'worktree.reserved': WorktreeReserved;
  'worktree.released': WorktreeReleased;
  'worktree.orphan_detected': WorktreeOrphanDetected;
  // WLM operational-core — serialized-merge lease pair (DR-4 / DR-7).
  'worktree.merge_requested': WorktreeMergeRequested;
  'worktree.merge_executed': WorktreeMergeExecuted;
  // harness-launcher (DR-2) — top-level worktree create pair + child liveness pair.
  'worktree.create.requested': WorktreeCreateRequested;
  'worktree.create.executed': WorktreeCreateExecuted;
  'launch.executing_started': LaunchExecutingStarted;
  'launch.executed': LaunchExecuted;
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
  'feedback.recorded': FeedbackRecorded;
  // WLM slice 3 (DR-3 / INV-10) — prune-run liveness pair.
  'prune.executing_started': PruneExecutingStarted;
  'prune.executed': PruneExecuted;
  // DR-6 (lifecycle-verbs task 012) — export two-event contract (INV-13 / INV-8).
  'export.requested': ExportRequested;
  'export.executed': ExportExecuted;

  // DR-4 (wiring-closure T-06) — durable projection-health state.
  'projection.degraded': ProjectionDegraded;
  'projection.recovered': ProjectionRecovered;
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
    // read-tolerant-but-not-emittable (DR-2): schema kept for replay, never emitted.
    retired: string[];
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
