// ADOPTED by task 011 — this module is now load-bearing production code, not a reservation.
// `schemas.ts` imports {@link ANNOTATED_EVENTS} to DERIVE `EVENT_EMISSION_REGISTRY`, so the
// table below is the single authority for every registered event's emission source. The
// `RESERVED(issue: #1473, …)` header this module carried while it had no production importer is
// gone with the condition that justified it. Task 012 resolves the `provider` welds at boot and
// task 013 seeds the G3 ratchet from {@link reportCoupledEventTypes}.
//
// ─── The DR-2 tier + lifecycle annotations for the event catalog (task 010) ──
//
// The implementation of `EventAnnotationSource` (`event-declarations.ts`, task 008) for all 170
// built-in event types. Task 008 shaped its subject as a union over MIGRATION STATE
// (`EventEmissionSubject | EventRegistration`) precisely so this table could arrive one event at
// a time through an unchanged type; nothing in the bridge is reshaped here, and `schemas.ts` is
// still not edited — this module reads it, it does not write to it.
//
// ## Why this is a module and not a `Record` inside `schemas.ts`
//
// Task 008 kept `schemas.ts` at exactly zero edits so the lift was provably a projection out of
// the storage module rather than a change to it. Annotating through the PORT keeps that property:
// `schemas.ts` compiles untouched, and the substitution point task 008 opened is the one this
// task fills.
//
// ## The measurement, stated up front
//
// Every assignment below is derived from two live populations, not from the registry's `source`
// column (which is the thing the annotation is CHECKED against, and would be circular as an
// input):
//
//   • EMISSION SITE — which code appends the event, read out of the handler tree. This decides
//     substrate-vs-capability-vs-workflow-local and fixes `provider` / `workflow`.
//   • CONSUMER FOLD — which reducer or view turns the event into state, read out of every
//     `ViewProjection` / `ProjectionReducer` in `views/`, `projections/`, `telemetry/` and
//     `verbs/worktree/projections/`. This fixes `consumedBy`, and its EMPTINESS is what
//     disqualifies an event from `capability`.
//
// Three findings came out of that measurement, and they are the substance of this task:
//
//   1. **76 of the 170 registrations have no consumer fold at all**, and 44 of them are neither
//      store machinery nor an HSM transition: they are handler-owned records of an operation —
//      the INV-13 `*.requested`/`*.executed` pairs, plus the audit records that follow the same
//      rule. `CapabilityRegistration.consumedBy` is a non-empty tuple on purpose ("declared a
//      capability, consumed by nobody is a report with extra steps"), so the union CORRECTLY
//      refuses them, and none of task 009's five substrate rationales named a mechanism outside
//      the store's own machinery. Those 44 are annotated `substrate` under the one additive
//      rationale task 009 pre-authorised for this discovery (`operation-record`). That member is
//      the weakest weld in the union and it is deliberately named to read that way. **It is the
//      population a G3 successor should look at after the 25.**
//   2. **Only 7 of the 25 report-coupled registrations can name a gate.** Task 009 expected all
//      25 to be `judgment`. Eleven of them have no non-test reference anywhere in `src/` outside
//      `schemas.ts` — they exist solely as an `exarchos_event.append` the model is nagged to
//      make. The other 18 are emitted from a model-walked runbook step; that step belongs to a
//      workflow definition, which is exactly `workflow-local`. `EMISSION_SOURCE_BY_TIER` changed
//      one value (`workflow-local: 'auto' -> 'model'`) to carry them; the shape is unchanged.
//   3. **`benchmark.completed` is not an observation, and it is the one registration this task
//      could not reconcile.** See {@link UNRECONCILED_REGISTRATIONS}.
//
// ## What this module deliberately does NOT do
//
// It does not resolve `EffectProviderId` at boot (task 012) or ratchet the report-coupled count
// (task 013). It exports the census functions those tasks read, and every count they produce is
// COMPUTED from the table — no cardinality is written as a literal anywhere in this file or its
// test. The derivation itself lives in `event-registration.ts` (`deriveEmissionRegistry`) and is
// applied by `schemas.ts`; this module supplies its input.
// ────────────────────────────────────────────────────────────────────────────

import type { EventEmissionSource } from './schemas.js';
// The judgment `contentSchema` values come from a LEAF module, not from `schemas.js`. Task 011
// made `schemas.ts` derive `EVENT_EMISSION_REGISTRY` from this table, so a runtime value import
// back into `schemas.ts` would close a cycle — one measured to throw at load under real Node ESM
// (TDZ) and to fail `tools/audit/cycle-gate.ts` in CI. The `EventEmissionSource` import above
// stays, because `import type` is erased and contributes no edge.
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

// NOTE: this module deliberately does NOT name `EventAnnotationSource` from `event-declarations.ts`,
// even as a type. `schemas.ts` imports this module to derive `EVENT_EMISSION_REGISTRY`, and the
// static-reachability instruments in this repo (DR-30's oracle-independence walk,
// `built-in-workflow-ir.structure.test.ts`) follow type-only specifiers. Naming the port here would
// therefore make `contract/declaration.ts` reachable from every registration site — falsifying
// DR-1's standing claim that "no registration site imports the envelope, so they can genuinely
// disagree" (`contract/declaration.test.ts`). {@link ANNOTATED_EVENTS} is annotated structurally
// instead, and the CONFORMANCE proof lives with the port it conforms to
// (`_EventDeclarations_AnnotatedEvents_ImplementsThePort` in `event-declarations.ts`), which is
// where a change of the port's shape should be felt anyway.

// ─── The declared-source input, as a port ───────────────────────────────────

/**
 * What `EVENT_EMISSION_REGISTRY` says today, keyed by event-type name.
 *
 * Taken as a PARAMETER by every census function below rather than imported and closed over, so a
 * caller (a test, task 011, task 013) can seed a disagreement without mutating the live registry.
 * A census that could only ever read one hard-wired input could not be shown to be capable of
 * reporting anything.
 */
export type DeclaredEmissionSources = Readonly<Record<string, EventEmissionSource>>;

// ─── The annotations ────────────────────────────────────────────────────────
//
// Keyed by bare event-type name, matching `EventAnnotationSource.registrationOf(eventType: string)`
// — runtime-registered custom types are carried by the same bridge and are absent from the
// built-in union by construction.
//
// NOT typed `Record<EventType, …>` on purpose. A type-keyed table would make
// `EventAnnotations_EveryRegisteredType_CarriesATierAndLifecycle` vacuous: the census difference it asserts
// is empty would be empty BY CONSTRUCTION, which is the Class-B defect the DR-30 gate exists to
// catch. Keyed by `string`, forgetting an event is a runtime finding the test can actually make.
//
// Annotated `Readonly<Record<string, EventRegistration>>` rather than `as const`: the annotation
// gives every value its contextual type (so `consumedBy` checks against the non-empty tuple) and
// this module spends nothing from the repo's type-assertion budget.

export const EVENT_ANNOTATIONS: Readonly<Record<string, EventRegistration>> = Object.freeze({
  // ── HSM transition records — the event IS the transition; state is a fold over them ──
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
  // DR-13 (epic #1546) resolve-then-freeze: `phase.entered` freezes the resolved obligation and
  // `phase.exited` records the aggregate gate status. Replaying them left-folds the same
  // obligation a live HSM observed, which is the definition of a transition record.
  'phase.entered': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },
  'phase.exited': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },
  // The IMPLEMENT-kind gate-set resolver threw and the dispatch was REFUSED. The refusal is the
  // transition that did not happen; it is appended by the same boundary.
  'phase.blocked': { lifecycle: 'active', tier: 'substrate', rationale: 'transition-record' },

  // ── Append-path — emitted inside the append/dispatch machinery, never by a caller ──
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
  // #1272 — the EventSourcedTaskStore appends these to durably back the projection it serves to
  // the SDK; the store's reads project from the event stream alone (INV-1). The append IS the
  // storage operation.
  'task.created': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'task.polled': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'task.result': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },
  'task.cancelled': { lifecycle: 'active', tier: 'substrate', rationale: 'append-path' },

  // ── Session/stream lifecycle — store bookkeeping around an append ──
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
  // DR-4 (wiring-closure T-06) — `publishProjectionFreshness` appends these on the dedicated
  // `meta/projection-health` stream off a real cursor/tail comparison. Stream bookkeeping about
  // a fold, not a fold of anything.
  'projection.degraded': { lifecycle: 'active', tier: 'substrate', rationale: 'session-lifecycle' },
  'projection.recovered': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'session-lifecycle',
  },
  // #1259 T04 / #1313 / #1437 — the JSONL→SQLite importer and the V5→V6 backfill. Store
  // maintenance on the store's own rows.
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

  // ── Concurrency-control outcomes ──
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
  // P04-02 (EFF-005) — the fencing-token epoch. A stale-epoch instance's writes are rejected by
  // the process manager; this records who won.
  'cancel.ownership-acquired': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'concurrency-outcome',
  },

  // ── Compensation bookkeeping — the INV-9 compensation contract ──
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

  // ── Operation records — handler-owned, CONSUMED BY NOBODY (finding 1) ──
  //
  // Every entry below was checked against every `ViewProjection` and `ProjectionReducer` in the
  // tree and folds into no state anywhere. They are not `capability` because `consumedBy` would
  // have to be empty, and DR-2 refuses that on purpose. `operation-record` claims only that the
  // code performing the operation owns the append — which is the `auto` emission claim and
  // nothing more.
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
  // Wave B (#1342) — the five two-event VCS splits. `*.requested` is the durable intent journaled
  // BEFORE the non-idempotent effect; `*.executed` the result after it. `worktree.remove.executed`
  // is the one member of this family with a real consumer and is `capability` below.
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
  // The VCS mutation ledger, measured the same way as the rest of this section.
  // The single git & worktree mutation owner appends all three itself — the
  // intent before the git effect, one of the two terminals after — so the code
  // performing the operation owns the append and nothing else can be claimed.
  //
  // `capability` is structurally unavailable to them and that is the honest
  // reading, not a downgrade: the only reader of these events is the owner's own
  // ledger fold, which is the emitter re-reading its own record to decide
  // whether to replay, not a projection or view turning the emission into state
  // anyone else depends on. Listing the emitter as its own consumer would
  // launder "consumed by nobody" into a consumer, which is the move the
  // non-empty `consumedBy` tuple exists to refuse.
  'vcs.requested': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'vcs.executed': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  'vcs.compensated': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },
  // The atomic tree-promotion record. `substrate` is the tier it WOULD be welded
  // to: the promoting code in `install/atomic-promotion.ts` performs the commit
  // rename, and the record belongs to that operation rather than to a caller
  // asked to report on the promoter's behalf.
  //
  // `capability` is unavailable for the same structural reason as the ledger
  // above, and it is worth naming which half is missing: there is no fold. No
  // reducer, view or telemetry surface turns a promotion into state anyone reads,
  // and `consumedBy` is a non-empty tuple precisely so that "declared a
  // capability, consumed by nobody" cannot be written down.
  //
  // The lifecycle is `planned`, and that is a measurement rather than a plan.
  // `promoteTree` — the carrier-wrapped path that DECLARES this emission — has
  // no caller anywhere in the governed source; every call site is a test. The
  // engine beneath it (`promoteTreeSync`) is what production uses, and it
  // declares nothing. So the schema exists, the projection already folds this
  // type, and no reachable code appends it. Annotating it `active` would claim
  // an append happens on some path, which is the one claim the tree cannot
  // support; `planned` says what is true — the emitter is not wired. It becomes
  // `active` when a production caller reaches `promoteTree` with a sink that
  // lands the record, not before.
  'promotion.executed': { lifecycle: 'planned', tier: 'substrate', rationale: 'operation-record' },
  // The emission-violation report, measured the same way. The post-dispatch
  // verifier detects the miss and appends the finding in the same pass — the
  // code performing the check owns the record of it, and no handler is asked to
  // report its own broken emission contract.
  //
  // `capability` is unavailable for the familiar structural reason, and it is
  // worth being exact about which half is absent here, because this one is
  // easily misread as coupled: the finding is READ — by whoever investigates the
  // bug it reports — but reading is not folding. No reducer, view or telemetry
  // surface turns a violation into state any code path depends on, so there is
  // no `ConsumerId` to name, and `consumedBy` is a non-empty tuple precisely so
  // that "a human will look at it" cannot be written down as a consumer.
  'emission.violated': { lifecycle: 'active', tier: 'substrate', rationale: 'operation-record' },

  // ── Capability — an effect provider appends it, and named consumers fold it ──
  //
  // `provider` is the composite tool whose handler owns the append (`EFFECT_PROVIDERS`, resolved
  // at boot by task 012). `consumedBy` is the MEASURED fold set: every id is a live
  // `ProjectionReducer.id` or `BUILTIN_VIEW_NAMES` entry whose arm for this event mutates state.
  // Explicit no-op arms are excluded — listing one would launder "nobody consumes this" into a
  // consumer.
  // The three task lifecycle events are appended by `verbs/tasks/tools.ts` and declared on
  // `task_claim` / `task_complete` / `task_fail`, which are registered on `exarchos_orchestrate`.
  // They were annotated `exarchos_workflow`, naming the workflow-state authority that FOLDS them
  // rather than the provider that appends them — a job `consumedBy` already does. The append
  // module was the last of the task family still sitting outside `verbs/`; now that it has joined
  // its siblings, the area and the declaring tool agree and this row can say so.
  'task.claimed': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['task-store@v1'],
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
  // PLANNED — measured, not inherited. The schema, the type-map entry and the
  // `synthesis-readiness` fold all exist; nothing in the tree appends the event.
  // A restack is performed today through the VCS surface without recording a
  // fact, so the fold is written ahead of its producer. `lifecycle` carries
  // that, and the tier still records the weld the append will have.
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
  // #1306 — the SOLE emitted recovery terminal after DR-2 (task 006).
  'merge.recovered': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_orchestrate',
    consumedBy: ['merge-orchestrator@v1', 'rehydration@v1', 'workflow-state@v1'],
  },
  // RETIRED: the schema and type-map entry are KEPT so legacy logs replay identically (INV-1) but
  // nothing writes it. `lifecycle` — not tier — is what produces `'retired'`, and the tier it was
  // welded to when it was live is still recorded. Not a coupling defect and not a disagreement.
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
  // PLANNED — measured, not inherited. The telemetry middleware appends the
  // three `tool.*` rows above once per dispatch; a per-TURN aggregate has a
  // `telemetry` fold (`view.turns`) and no producer anywhere in the tree. The
  // fold reads a shape nothing writes yet, which is what `planned` states.
  'turn.completed': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['telemetry'],
  },
  // #1525 — the restored SubagentStop hook resolves teammate identity and appends. The append is
  // owned by exarchos code (`lifecycle/subagent-stop.ts`), which is why the registry records
  // it `auto` and not `hook`; the hook is the TRIGGER, not the author.
  'subagent.tokens_used': {
    lifecycle: 'active',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['delegation-timeline', 'team-performance'],
  },
  // RE-TIERED from `capability` / `exarchos_view`. That annotation asserted an effect provider
  // appends this, and none does: every `exarchos_view` action is a read of a projection,
  // `eval_results` included. The only append is in the evaluation harness under `tools/`, a
  // developer entry point outside the governed source root — the coupling the `harness` tier
  // was added to name. The event is genuinely active and `eval-results` genuinely folds it, so
  // neither `planned` nor `retired` was available either.
  'eval.judge.calibrated': {
    lifecycle: 'active',
    tier: 'harness',
    module: 'tools/evals/evals/harness.ts',
    consumedBy: ['eval-results'],
  },
  // PLANNED — schema and type-map entry exist, nothing emits them yet. `lifecycle` produces the
  // source; the tier records the weld they will have.
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
  // ── The v2.12 phase-gate proof substrate ──
  // All twelve are folded by `workflow-state@v1` (audit/shadow visibility). The `planned` ones
  // are not exposed as admission actions in v2.12; `lifecycle`, not tier, records that.
  // The append site is `verbs/gates/gate-runner.ts`, pinned as the sole canonical evidence
  // emitter by the gate-ownership census, and `verbs/` is the area of exactly one provider.
  // `gate.executed` is appended by the same `runGate` body, declared on the same five actions,
  // and already annotated `exarchos_orchestrate` — one append site cannot have two owning tools,
  // so the two rows could not both be right. Corrected from `exarchos_workflow`.
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
  // PLANNED — measured, not inherited, and the registration the catalog has
  // argued about longest. The `code-quality` fold reads the results array, and
  // no module in the tree appends the event: the only producer is a benchmark
  // FIXTURE factory under `tools/evals/`, which mints the shape for a synthetic
  // stream rather than recording a measurement anything folds. Annotating it
  // `active` claimed an effect provider appends it, which is the one claim the
  // tree does not support; `planned` says what is actually true — the schema
  // and the fold are ready and the emitter is not written.
  'benchmark.completed': {
    lifecycle: 'planned',
    tier: 'capability',
    provider: 'exarchos_event',
    consumedBy: ['code-quality'],
  },

  // ── Judgment — a gate carries the verdict; the model composes only the CONTENT ──
  //
  // Seven of the twenty-five report-coupled registrations. Each names a `SupportedGateClass` with
  // a live provider action (`gate-provider-registry.ts`) whose subject IS this verdict, and a live
  // Zod schema for the content. The other eighteen could not name one and are `workflow-local`.
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

  // ── Workflow-local — a workflow definition's model-walked runbook step composes it ──
  //
  // The other eighteen report-coupled registrations. `PHASE_EXPECTED_EVENTS`
  // (`verbs/gates/check-event-emissions.ts`) is the independent authority: it maps model-emitted
  // events to the phase that owns them, and its header records the reason they stay model-emitted
  // — "their transition site is a model-walked runbook step bracketing a `native:` harness tool
  // (runbooks/definitions.ts) — there is no in-process handler seam to move the append into yet."
  //
  // `workflow: 'feature'` for all eighteen: every owning phase (delegate / review / synthesize /
  // overhaul-*) belongs to the `feature` definition (`BUILT_IN_WORKFLOW_TYPES`). This is the weld
  // G3 shrinks — each one leaves this tier when a handler seam takes the append.
  'task.assigned': { lifecycle: 'active', tier: 'workflow-local', workflow: 'feature' },
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

// ─── The port implementation (task 008's substitution point) ────────────────

/**
 * The DR-2 annotations as the annotation SOURCE task 008's bridge consumes (the
 * `EventAnnotationSource` port declared in `event-declarations.ts`, which proves this value
 * conforms — see the import-block note at the top of this file for why the proof lives there).
 *
 * Pass this to `eventDeclarations` / `openEventDeclarationSeam` and every annotated type's
 * declaration flips from the `EventEmissionSubject` arm to the {@link EventRegistration} arm — a
 * change of VALUES flowing through the type task 008 already shipped. `undefined` for a
 * runtime-registered custom type, which is honest: nothing in this task annotated it.
 */
export const ANNOTATED_EVENTS: {
  readonly registrationOf: (eventType: string) => EventRegistration | undefined;
} = Object.freeze({
  registrationOf: (eventType: string): EventRegistration | undefined => EVENT_ANNOTATIONS[eventType],
});

// ─── Disposed: the one registration task 010 could not reconcile ────────────
//
// Task 010 left exactly one entry here — `benchmark.completed`, which the registry declared
// `'hook'` while its measured coupling (capability tier, two real consumer folds, no emitter
// anywhere in `src/`, `hooks/` or `.claude-plugin/`) derives `'auto'` — as a named,
// owner-carrying, shrink-only list whose owner was recorded as task 011.
//
// **Task 011 disposed of the entry AND of the list.** `EVENT_EMISSION_REGISTRY` no longer
// declares a source for any built-in type; it derives one from this table. A tier<->source
// disagreement is therefore not a state the live catalog can hold and a census must report — it
// is a state the catalog has no form for. A shrink-only list of a population that cannot be
// constructed is a declaration that exists, is enforced, and cannot fail, which is exactly the
// class this program removes rather than keeps as cover.
//
// The claim now rests on what CAN still fail: {@link tierSourceDisagreements} takes its
// declared-source map as a PARAMETER, so `EventAnnotations_SeededTierSourceDisagreement_IsReported`
// seeds a contradiction and requires it to be reported by name. The falsifier survived the
// disposal; only the standing exception did not.

// ─── The censuses tasks 011/012/013 read ────────────────────────────────────
//
// Every one takes its population as an argument and returns a LIST, never a count. A caller that
// wants a cardinality takes `.length` of a list it can also print, so no number in this program is
// ever separable from the subjects that produced it.

/**
 * Registered event types carrying no annotation — the gap {@link EVENT_ANNOTATIONS} must close.
 *
 * `registeredTypes` is the live population (`EventTypes`, or the registry's key set). Sorted, so
 * a failure message is stable.
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
 * Annotated event types that no live registration claims — the other direction of the census, and
 * the one that catches a typo'd key. Without it, misspelling `'task.compelted'` would show up
 * only as a missing annotation, and the two errors would be indistinguishable.
 */
export function unregisteredAnnotations(
  registeredTypes: Iterable<string>,
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
): readonly string[] {
  const registered = new Set(registeredTypes);
  return Object.freeze(Object.keys(annotations).filter((k) => !registered.has(k)).sort());
}

/**
 * **The G3 seed, derived.** The report-coupled population: every annotated type whose two axes
 * produce `'model'` — a dedicated append the model must remember to make, which is therefore the
 * first thing dropped under context pressure.
 *
 * Derived from the ANNOTATIONS through {@link resolveEmissionSource}, never read off the
 * registry's `source` column, so the number G3 ratchets is a consequence of the coupling claims
 * rather than a transcription of the thing those claims are supposed to replace. Returns the
 * subjects; task 013 takes `.length`.
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
 * Every annotated type whose derived source differs from the declared one.
 *
 * `declared` is a parameter so a caller can seed a disagreement — the falsifier for the whole
 * derivation claim. A `lifecycle: 'planned'`/`'retired'` entry is NOT a disagreement when the
 * registry declares the same, because lifecycle produces the source directly
 * ({@link resolveEmissionSource} consults the tier only for `active`).
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

// ─── Compile-time proofs (verified by `npm run typecheck`) ──────────────────
//
// Exported type aliases in a non-test source file, per the `_EventRegistration_*` /
// `_EventDeclarations_*` idiom: `tsconfig.json` excludes `**/*.test.ts`, so the same assertions
// written in the co-located test would never be checked by the build.

type Expect<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;

/**
 * The table's values inhabit {@link EventRegistration}, which is what makes every entry below a
 * DR-2 registration rather than a look-alike. Weakening any value — dropping `consumedBy`, using
 * a rationale outside the closed vocabulary, naming a tenth gate class — fails here, at the
 * table, rather than at a runtime guard nobody ran.
 * @proof
 */
export type _EventAnnotations_TableValues_AreRegistrations = Expect<
  Assignable<(typeof EVENT_ANNOTATIONS)[string], EventRegistration>
>;

// The port-conformance proof — "this module satisfies the `EventAnnotationSource` task 008 opened"
// — MOVED to `event-declarations.ts` as `_EventDeclarations_AnnotatedEvents_ImplementsThePort`.
// It is the same assertion checked by the same `tsc` run; it simply cannot be written here without
// naming the port, and naming the port here is what would drag `contract/declaration.ts` into every
// registration site's reachable set (see the import-block note at the top of this file).
