// Tier and lifecycle annotations for every built-in event type.
//
// `schemas.ts` derives `EVENT_EMISSION_REGISTRY` from {@link ANNOTATED_EVENTS}. This table is
// therefore the single authority for the emission source of each registered event.
// Each entry comes from two measurements: the code that appends the event, and the reducers
// and views that fold it.
//
// The judgment content schemas come from a leaf module. A value import of `schemas.js` makes an
// import cycle, which throws at load under Node ESM and fails `tools/audit/cycle-gate.ts`.
//
// This module does not name `EventAnnotationSource`, not even as a type. The reachability checks
// follow type-only imports, and that name makes `contract/declaration.ts` reachable from every
// registration site. A registration site must not import that envelope. The proof that this table
// implements the port is in `event-declarations.ts`.

import type { EventEmissionSource } from './schemas.js';
import {
  RemediationAttemptedDataSchema,
  RemediationSucceededDataSchema,
  ReviewCompletedData,
  ReviewEscalatedData,
  ReviewFindingData,
  TestResultData,
  TypecheckResultData,
} from './judgment-content-schemas.js';
import {
  findTierSourceDisagreement,
  resolveEmissionSource,
  type EventRegistration,
  type TierSourceDisagreement,
} from './event-registration.js';

/**
 * The source that `EVENT_EMISSION_REGISTRY` declares for each event type, keyed by name.
 * Each census function takes it as a parameter, so a test can seed a disagreement without a
 * change to the live registry.
 */
export type DeclaredEmissionSources = Readonly<Record<string, EventEmissionSource>>;

/**
 * The annotation for each built-in event type, keyed by the bare event-type name.
 * The key type is `string`, not `EventType`, so the census test can find a missing event.
 *
 * For a `capability` entry, `provider` is the tool whose handler appends the event. `consumedBy`
 * lists each reducer or view whose arm for the event changes state. No-op arms do not count.
 * An `operation-record` entry has no consumer fold, so it cannot be `capability`.
 * A `judgment` entry names the gate that carries the verdict. The model writes only the content.
 */
export const EVENT_ANNOTATIONS: Readonly<Record<string, EventRegistration>> = Object.freeze({
  'workflow.started': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },
  'workflow.transition': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },
  'workflow.compound-entry': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  'workflow.compound-exit': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  'workflow.plan-revision': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  'workflow.plan-review-dispatched': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  'workflow.guard-failed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  'workflow.cancel': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },
  'synthesize.requested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  /**
   * `phase.entered` freezes the resolved obligation, and `phase.exited` records the aggregate
   * gate status. A replay folds the same obligation that the live HSM saw.
   */
  'phase.entered': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },
  'phase.exited': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },
  /**
   * The gate-set resolver for an IMPLEMENT phase threw, and the boundary refused the dispatch.
   */
  'phase.blocked': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },

  'state.patched': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'tool.invoked': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'hsm.deprecated_action_invoked': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'append-path',
  },
  'workspace.resolved': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'elicitation.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'elicitation.fulfilled': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'elicitation.declined': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  /**
   * The `EventSourcedTaskStore` appends these events to back the projection that it serves. Its
   * reads project from the event stream alone.
   */
  'task.created': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'task.polled': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'task.result': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'task.cancelled': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },

  'workflow.checkpoint': { lifecycle: 'active', tier: 'substrate', rationale: 'session-lifecycle' },
  'workflow.checkpoint_requested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'workflow.checkpoint_written': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'workflow.checkpoint_superseded': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'workflow.rehydrated': { lifecycle: 'active', tier: 'substrate', rationale: 'session-lifecycle' },
  'workflow.snapshot_taken': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'workflow.projection_degraded': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'workflow.pruned': { lifecycle: 'active', tier: 'substrate', rationale: 'session-lifecycle' },
  'workflow.cleanup': { lifecycle: 'active', tier: 'substrate', rationale: 'session-lifecycle' },
  'session.machinery_consumed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  /**
   * `publishProjectionFreshness` appends these on the `meta/projection-health` stream after it
   * compares a cursor with the stream tail.
   */
  'projection.degraded': { lifecycle: 'active', tier: 'substrate', rationale: 'session-lifecycle' },
  'projection.recovered': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  /**
   * The JSONL-to-SQLite importer and the V3-to-V4 and V5-to-V6 schema migrations append these
   * store events.
   */
  'migration.legacy_jsonl_imported': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'migration.completed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'migration.failed': { lifecycle: 'active', tier: 'substrate', rationale: 'session-lifecycle' },
  'migration.workflow_type_unknown': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  'migration.correlation_backfill_progress': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },

  'workflow.cas-failed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'concurrency-outcome',
  },
  'workflow.circuit-open': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'concurrency-outcome',
  },
  /**
   * The fencing-token epoch. The process manager rejects writes from an instance with a stale
   * epoch, and this event records the winner.
   */
  'cancel.ownership-acquired': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'concurrency-outcome',
  },

  'workflow.compensation': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'compensation-record',
  },
  'cancel.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'compensation-record' },
  'cancel.compensation-requested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'compensation-record',
  },
  'cancel.compensation-completed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'compensation-record',
  },
  'cancel.compensation-failed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'compensation-record',
  },
  'cancel.compensation-retry-scheduled': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'compensation-record',
  },
  'cancel.manual-intervention-required': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'compensation-record',
  },
  'cancel.ready': { lifecycle: 'active', tier: 'substrate', rationale: 'compensation-record' },

  'stack.enqueued': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'quality.regression': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'quality.hint.generated': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'quality.refinement.suggested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'diagnostic.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'checkpoint.enforced': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'checkpoint.state_missing': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'preflight.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'preflight.blocked': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'provider.unknown-tier': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'provider.parse-error': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'dispatch.classified': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  /** The audit line of the prune evaluation. Dashboards read it from the stream. */
  'prune.diagnostics': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'dispatch.preflight': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'stash.detected': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'command.resolved': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'spec.legacy_capabilities_array': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'phase.contract_missing': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'invariant.authored': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'invariant.amended': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'catalog.registered': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'mutation.executing_started': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'mutation.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'feedback.recorded': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'merge.retry_attempt': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'merge.executing_started': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'pr.created': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'pr.merged': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'pr.commented': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'issue.created': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'onboard.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'onboard.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'export.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'export.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  /**
   * The two-event VCS operations. `*.requested` records the intent before the effect, which is
   * not idempotent. `*.executed` records the result. `worktree.remove.executed` has a consumer
   * fold, so it is a `capability` entry.
   */
  'pr.create.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'pr.create.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'pr.comment.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'pr.comment.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'issue.create.requested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'issue.create.executed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'branch.delete.requested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'branch.delete.executed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'worktree.remove.requested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'worktree.create.requested': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'worktree.create.executed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  /**
   * The single git and worktree mutation owner appends the intent before the git effect, then one
   * of the two terminals. Only the ledger fold of that owner reads them, and an emitter is not a
   * consumer of its own record.
   */
  'vcs.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'vcs.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'vcs.compensated': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  /**
   * The atomic tree-promotion record. `promoteTree` declares this emission, but only tests call
   * it. Production calls `promoteTreeSync`, which declares nothing. The entry stays `planned`
   * until a production caller reaches `promoteTree`.
   */
  'promotion.executed': { lifecycle: 'planned', tier: 'substrate', rationale: 'operation-record' },
  /**
   * The post-dispatch verifier finds a missed emission and appends this record in the same pass.
   * People read the record, but no code folds it.
   */
  'emission.violated': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  /** The `execute_intent` handler appends this record after a commit and after a failure. */
  'orchestrate.intent_executed': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  /** The `settle` handler appends this record for every outcome. */
  'execution.settled': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  /**
   * The `prepare` handler appends this record when the capsule and its definition are in custody.
   * `settle` reads it to verify a capsule, which is not a fold.
   */
  'workflow.prepared': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  /**
   * When `settle` holds a batch, it appends one proposal for each deviation. A later `settle`
   * call on that batch appends one decision for each proposal. Only `settle` reads these events.
   */
  'deviation.proposed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'deviation.decided': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  /**
   * `settle` appends one row when a decision round accepts a material deviation. It reads the rows
   * back to number the next revision, and no registered reducer folds them.
   */
  'design.revised': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },

  /**
   * `verbs/tasks/tools.ts` appends the three task lifecycle events. The `task_claim`,
   * `task_complete` and `task_fail` actions of `exarchos_orchestrate` declare them.
   */
  'task.claimed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['task-store@v1'],
  },
  /**
   * `prepare` appends this announcement in the same commit as the prepared record.
   * `prepare_delegation` appends it before the readiness fold, once for each planned task that
   * the stream does not know.
   */
  'task.assigned': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: [
      'rehydration@v1',
      'task-store@v1',
      'workflow-state@v1',
      'pipeline',
      'synthesis-readiness',
      'workflow-status',
      'delegation-readiness',
      'delegation-timeline',
    ],
  },
  'task.completed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: [
      'rehydration@v1',
      'task-store@v1',
      'workflow-state@v1',
      'pipeline',
      'provenance',
      'synthesis-readiness',
      'workflow-status',
    ],
  },
  'task.failed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: [
      'rehydration@v1',
      'task-store@v1',
      'workflow-state@v1',
      'pipeline',
      'synthesis-readiness',
      'workflow-status',
    ],
  },
  'workflow.fix-cycle': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['team-performance'],
  },
  'gate.executed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: [
      'workflow-state@v1',
      'code-quality',
      'convergence',
      'delegation-readiness',
      'synthesis-readiness',
    ],
  },
  'stack.position-filled': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['workflow-state@v1', 'pipeline'],
  },
  /** No code appends this event. The `synthesis-readiness` fold exists before its producer. */
  'stack.restacked': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['synthesis-readiness'],
  },
  'review.routed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['workflow-state@v1'],
  },
  'ci.status': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['shepherd-status'],
  },
  /**
   * The assessment pass that appends `ci.status` appends this event too, one row for each check.
   * `code-quality` folds it because the pass rate of the checks is the shepherd outcome.
   */
  'ci.check_observed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['code-quality'],
  },
  'shepherd.started': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['shepherd-status'],
  },
  'shepherd.approval_requested': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['shepherd-status'],
  },
  'shepherd.escalated': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['shepherd-status'],
  },
  'shepherd.completed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['shepherd-status'],
  },
  'merge.preflight': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['merge-orchestrator@v1', 'workflow-state@v1'],
  },
  'merge.executed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['merge-orchestrator@v1', 'rehydration@v1', 'workflow-state@v1'],
  },
  'merge.completed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['merge-orchestrator@v1'],
  },
  /** The only merge recovery terminal that code emits. */
  'merge.recovered': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['merge-orchestrator@v1', 'rehydration@v1', 'workflow-state@v1'],
  },
  /**
   * Retired. The schema stays so that old logs replay the same, but no code writes this event.
   * The tier records the weld that the event had when it was live.
   */
  'merge.rollback': {
    lifecycle: 'retired',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['merge-orchestrator@v1', 'rehydration@v1', 'workflow-state@v1'],
  },
  'worktree.remove.executed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'worktree.adopted': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'worktree.reserved': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'worktree.released': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'worktree.orphan_detected': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'worktree.merge_requested': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'worktree.merge_executed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'launch.executing_started': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'launch.executed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'prune.executing_started': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'prune.executed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['worktrees@v1'],
  },
  'tool.completed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['telemetry'],
  },
  /**
   * The telemetry wrapper appends this event to the telemetry stream, as it does for the rest of
   * the `tool` family. It derives GOVERNANCE. A demotion is a separate roadmap decision, because
   * `CHARTER_TELEMETRY_EXAMPLES` in the partition test does not include it.
   */
  'tool.budget_exceeded': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['telemetry'],
  },
  'tool.errored': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['telemetry'],
  },
  'tool.action_errored': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['telemetry'],
  },
  /**
   * No code appends this per-turn aggregate. The `telemetry` fold (`view.turns`) reads a shape
   * that nothing writes.
   */
  'turn.completed': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['telemetry'],
  },
  /**
   * The SubagentStop hook triggers the append, but `lifecycle/subagent-stop.ts` writes it. The
   * source is therefore `auto`, not `hook`.
   */
  'subagent.tokens_used': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['delegation-timeline', 'team-performance'],
  },
  /**
   * Only the evaluation harness under `tools/` appends this event, outside the governed source
   * root. The `harness` tier names that coupling.
   */
  'eval.judge.calibrated': {
    lifecycle: 'active',
    tier: 'harness',
    module: 'tools/evals/evals/harness.ts',
    consumedBy: ['eval-results'],
  },
  /** Planned. No code emits this event or the next two `eval` events. */
  'eval.run.started': {
    lifecycle: 'planned',
    tier: 'substrate',
    rationale: 'operation-record',
  },
  'eval.case.completed': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_view',
    consumedBy: ['eval-results'],
  },
  'eval.run.completed': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_view',
    consumedBy: ['eval-results'],
  },
  /**
   * `workflow-state@v1` folds all twelve admission events. The `planned` ones have no admission
   * action. `verbs/gates/gate-runner.ts` appends this event and `gate.executed` in one body, so
   * both name `exarchos_orchestrate`.
   */
  'admission.evidence-recorded': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.shadow-attempt': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.disagreement-disposition': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.rollout-decision': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.enforcement-enabled': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.cutover-ready': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.requirement-resolved': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.transition-decided': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.waiver-recorded': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.contradiction-recorded': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.reassessment-requested': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  'admission.reassessment-completed': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_workflow',
    consumedBy: ['workflow-state@v1'],
  },
  /**
   * The `code-quality` fold reads the results, but no module appends this event. The only
   * producer is a fixture factory under `tools/evals/` that builds synthetic streams.
   */
  'benchmark.completed': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['code-quality'],
  },

  'review.completed': {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'review-verdict',
    contentSchema: ReviewCompletedData,
  },
  'review.finding': {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'review-verdict',
    contentSchema: ReviewFindingData,
  },
  'review.escalated': {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'review-verdict',
    contentSchema: ReviewEscalatedData,
  },
  'remediation.attempted': {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'review-verdict',
    contentSchema: RemediationAttemptedDataSchema,
  },
  'remediation.succeeded': {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'review-verdict',
    contentSchema: RemediationSucceededDataSchema,
  },
  'test.result': {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'test-adequacy',
    contentSchema: TestResultData,
  },
  'typecheck.result': {
    lifecycle: 'active',
    tier: 'judgment',
    gate: 'static-analysis',
    contentSchema: TypecheckResultData,
  },

  /**
   * A model-walked runbook step of the `feature` workflow appends each `workflow-local` event.
   * `PHASE_EVENT_CONTRACTS` maps each one to the phase that owns it. An event leaves this tier
   * when a handler seam takes its append.
   */
  'task.progressed': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'workflow.handoff_summarized': {
    lifecycle: 'active',
    tier: 'workflow-local',
    workflow: 'feature',
  },
  'team.spawned': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'team.task.assigned': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'team.task.completed': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'team.task.failed': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'team.disbanded': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'team.task.planned': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'team.teammate.dispatched': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'shepherd.iteration': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'session.tagged': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'worktree.created': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'worktree.baseline': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'stack.submitted': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'comment.posted': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'comment.resolved': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
  'merge.requested': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
});

/**
 * The annotations as an `EventAnnotationSource` for `eventDeclarations` and
 * `openEventDeclarationSeam`. The result is `undefined` for a custom type registered at runtime.
 */
export const ANNOTATED_EVENTS: {
  readonly registrationOf: (eventType: string) => EventRegistration | undefined;
} = Object.freeze({
  registrationOf: (eventType: string): EventRegistration | undefined => EVENT_ANNOTATIONS[eventType],
});

/**
 * Registered event types with no annotation, sorted for a stable failure message.
 * Each census in this module returns a list, not a count, so a caller can print the subjects.
 */
export function unannotatedEventTypes(
  registeredTypes: Iterable<string>,
  annotations: typeof ANNOTATED_EVENTS = ANNOTATED_EVENTS,
): readonly string[] {
  const missing: string[] = [];
  for (const eventType of registeredTypes) {
    if (annotations.registrationOf(eventType) === undefined) missing.push(eventType);
  }
  return Object.freeze(missing.sort());
}

/**
 * Annotated event types that no registration claims. This census finds a misspelled key, which
 * otherwise looks the same as a missing annotation.
 */
export function unregisteredAnnotations(
  registeredTypes: Iterable<string>,
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
): readonly string[] {
  const registered = new Set(registeredTypes);
  return Object.freeze(Object.keys(annotations).filter((k) => !registered.has(k)).sort());
}

/**
 * The report-coupled event types: each annotated type whose axes resolve to `'model'`. The model
 * must remember to append each one, so context pressure drops these first. The result comes from
 * {@link resolveEmissionSource}, not from the registry `source` column.
 */
export function reportCoupledEventTypes(
  registeredTypes: Iterable<string>,
  annotations: typeof ANNOTATED_EVENTS = ANNOTATED_EVENTS,
): readonly string[] {
  const coupled: string[] = [];
  for (const eventType of registeredTypes) {
    const registration = annotations.registrationOf(eventType);
    if (registration === undefined) continue;
    if (resolveEmissionSource(registration) === 'model') coupled.push(eventType);
  }
  return Object.freeze(coupled.sort());
}

/** One registration's tier/lifecycle disagreeing with the source the registry declares for it. */
export interface AnnotatedDisagreement extends TierSourceDisagreement {
  readonly eventType: string;
}

/**
 * Every annotated type whose derived source differs from the declared one. `declared` is a
 * parameter so that a test can seed a disagreement. Lifecycle sets the source of a `planned` or
 * `retired` entry, and the tier sets it only for an `active` entry.
 */
export function tierSourceDisagreements(
  declared: DeclaredEmissionSources,
  annotations: typeof ANNOTATED_EVENTS = ANNOTATED_EVENTS,
): readonly AnnotatedDisagreement[] {
  const out: AnnotatedDisagreement[] = [];
  for (const eventType of Object.keys(declared).sort()) {
    const registration = annotations.registrationOf(eventType);
    if (registration === undefined) continue;
    const declaredSource = declared[eventType];
    if (declaredSource === undefined) continue;
    const disagreement = findTierSourceDisagreement(registration, declaredSource);
    if (disagreement !== undefined) out.push(Object.freeze({ eventType, ...disagreement }));
  }
  return Object.freeze(out);
}

type Expect<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;

/**
 * Each table value is an {@link EventRegistration}. A weaker value fails here at the table, for
 * example a missing `consumedBy` or a rationale outside the closed vocabulary.
 * This proof is in a source file because `tsconfig.json` excludes test files from the typecheck.
 * @proof
 */
export type _EventAnnotations_TableValues_AreRegistrations = Expect<
  Assignable<(typeof EVENT_ANNOTATIONS)[string], EventRegistration>
>;
