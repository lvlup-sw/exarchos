import { coercedStringArray } from '../../coerce.js';
import { vacuityWaiver } from '../../output-schema-declaration.js';
import { AsOfSchema, CheckpointHandoffSchema, WorkflowTypeSchema } from '../../workflow/schemas.js';
import { z } from 'zod';
import { declared, none, withActionContract, type ActionEmission } from '../action-contract.js';
import { COMPENSABLE_LOCAL, LOCAL_MUTATION, LOCAL_MUTATION_IDEMPOTENT, READ_ONLY_LOCAL } from '../annotations.js';
import { makeWorkflowDescribeAction } from '../describe-actions.js';
import { WorkflowTransitionOutputSchema, WorkflowUpdateOutputSchema } from '../output-schemas.js';
import { ALL_PHASES, ROLE_ANY, ROLE_LEAD, featureIdSchema } from '../phases.js';
import type { BuiltinToolAction } from '../types.js';

// ─── Composite Tool: exarchos_workflow ───────────────────────────────────────
//
// EMISSION OWNERSHIP. Every contract emission below names `owner: 'workflow'`.
// An edge's owner is the action-declaration AREA it is declared in — the module
// group under `src/registry/actions/` that exports the declaring action list —
// and this file is the whole of the `workflow` area. Everything under
// `actions/orchestrate/` names `orchestrate` instead. The area is the honest
// accountability signal available at declaration time: it is a property of
// WHERE the action lives, never of WHICH event it emits, so an event declared
// from both areas is visibly a cross-area coupling rather than a single owner's
// business. `state.patched` is exactly that case — `update` below is its
// canonical emitter, and the `orchestrate` area's `discover_bridge` declares a
// second, time-boxed edge onto the same event.

const INIT_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  { event: 'workflow.started', condition: 'always', role: 'primary', owner: 'workflow' },
];

const TRANSITION_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  { event: 'workflow.transition', condition: 'always', role: 'primary', owner: 'workflow' },
  {
    event: 'workflow.fix-cycle',
    condition: 'conditional',
    description: 'When a phase is re-entered rather than advanced',
    role: 'primary',
    owner: 'workflow',
  },
];

const UPDATE_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  {
    event: 'state.patched',
    condition: 'conditional',
    description: 'When the target is event-sourced and the call carries at least one update key',
    role: 'primary',
    owner: 'workflow',
  },
];

const CANCEL_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  { event: 'workflow.cancel', condition: 'always', role: 'primary', owner: 'workflow' },
  {
    event: 'workflow.compensation',
    condition: 'conditional',
    description: 'Per compensation action',
    role: 'primary',
    owner: 'workflow',
  },
  // The destructive branch-deletion compensator journals intent then result.
  // Both are conditional on the saga reaching that action with an event store
  // wired: a dry run, an earlier failure, or a phase whose ladder never orders
  // the deletion leaves the pair absent.
  {
    event: 'branch.delete.requested',
    condition: 'conditional',
    description: 'Before the compensator deletes a feature branch',
    role: 'primary',
    owner: 'workflow',
  },
  {
    event: 'branch.delete.executed',
    condition: 'conditional',
    description: 'After the compensator deletes a feature branch',
    role: 'primary',
    owner: 'workflow',
  },
];

const CLEANUP_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  { event: 'workflow.cleanup', condition: 'always', role: 'primary', owner: 'workflow' },
];

const REHYDRATE_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  {
    event: 'workflow.rehydrated',
    condition: 'conditional',
    description: 'When rehydration succeeds (event-store emission failures are logged but do not fail the call — see rehydrate.ts).',
    role: 'primary',
    owner: 'workflow',
  },
];

const CHECKPOINT_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  { event: 'workflow.checkpoint', condition: 'always', role: 'primary', owner: 'workflow' },
];

const FEEDBACK_EMISSIONS: readonly [ActionEmission, ...ActionEmission[]] = [
  { event: 'feedback.recorded', condition: 'always', role: 'primary', owner: 'workflow' },
];

export const workflowActions: readonly BuiltinToolAction[] = [
  withActionContract(
    {
      name: 'init',
      description: 'Initialize a new workflow. Auto-emits workflow.started event. For workflowType=oneshot, an optional synthesisPolicy (always | never | on-request) seeds state.oneshot.synthesisPolicy; silently ignored for other workflow types.',
      schema: z.object({
        featureId: featureIdSchema,
        workflowType: WorkflowTypeSchema,
        synthesisPolicy: z.enum(['always', 'never', 'on-request']).optional(),
      }),
      phases: new Set<string>(),
      roles: ROLE_LEAD,
      cli: {
        flags: { featureId: { alias: 'f' }, workflowType: { alias: 't' } },
        examples: [
          'exarchos wf init -f my-feature -t feature',
          'exarchos wf init -f my-oneshot -t oneshot --synthesisPolicy always',
        ],
      },
      outputSchema: vacuityWaiver('exarchos_workflow.init'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('init creates a workflow and does not wait on a prior gate'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'workflow.started' }),
      needs: none('init writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(...INIT_EMISSIONS),
    },
    { annotations: LOCAL_MUTATION },
  ),
  withActionContract(
    {
      name: 'get',
      description: 'Read workflow state with optional query or field projection',
      schema: z.object({
        featureId: featureIdSchema,
        query: z.string().optional(),
        fields: coercedStringArray().optional(),
        // #1555 — optional bounded-fold (as-of/time-travel) read. Shares the
        // single-source `AsOfSchema`; mutually-exclusive untilSequence /
        // untilTimestamp enforced at the schema. Omitted ⇒ live tip.
        asOf: AsOfSchema.optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      cli: {
        alias: 'status',
        flags: { featureId: { alias: 'f' }, query: { alias: 'q' } },
        examples: [
          'exarchos wf status -f my-feature',
          'exarchos wf status -f my-feature -q phase',
          'exarchos wf status -f my-feature --as-of \'{"untilSequence":3}\'',
        ],
      },
      outputSchema: vacuityWaiver('exarchos_workflow.get'),
      annotations: READ_ONLY_LOCAL,
    },
    {
      requires: none('get is a read of projected workflow state with no admission obligations'),
      ensures: none('get returns an ephemeral document with no durable postcondition'),
      needs: none('get reads through the in-process projection'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('get emits no catalog events'),
    },
    { annotations: READ_ONLY_LOCAL },
  ),
  withActionContract(
    {
      name: 'transition',
      description: 'Transition the workflow to a target phase. Canonical phase-mutation action. Routes through the HSM transition guard primitive — emits exactly one workflow.transition event on success, or returns a structured error envelope (validTargets, expectedShape, suggestedFix) on guard/topology failure.',
      schema: z.object({
        featureId: featureIdSchema,
        target: z.string().min(1).describe('Target phase (must be a declared transition from the current phase)'),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      cli: {
        flags: { featureId: { alias: 'f' }, target: { alias: 't' } },
        examples: ['exarchos wf transition -f my-feature -t plan'],
      },
      outputSchema: vacuityWaiver('exarchos_workflow.transition', WorkflowTransitionOutputSchema),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('edge obligations stay in the HSM transition guard, not on this action'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'workflow.transition' }),
      needs: none('transition writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(...TRANSITION_EMISSIONS),
    },
    { annotations: LOCAL_MUTATION },
  ),
  withActionContract(
    {
      // Wave 0 (#1340, v2.10.0-preview.2): canonical state-mutation surface.
      // Replaces the deprecated v2.10 `set({updates})` rerouting path that
      // was removed alongside `set({phase})` in v2.11. Phase mutation lives
      // on `transition`; non-phase fields (artifacts, planReview, task
      // results, etc.) flow through this action so callers see a single
      // validated, output-enveloped surface instead of being told to emit
      // `state.patched` directly via `event.append` (which bypasses input
      // validation, output enveloping, idempotency, and `next_actions`).
      //
      // Handler delegates to the existing internal `workflow.update()`
      // helper (`handleSet` with `updates` only, no `phase`). The phase
      // field is rejected at the input boundary with a structured
      // `INVALID_INPUT` + `suggestedFix` pointing callers at `transition`
      // (Task 0.2). `updates` is `Record<string, unknown>` so dot-paths
      // (`'artifacts.design'`) and nested objects both resolve through
      // `applyDotPath` in `handleSet`.
      name: 'update',
      description: 'Mutate non-phase workflow state fields (artifacts, planReview, task results, etc.). Canonical state-mutation surface. Emits exactly one state.patched event on success. For phase changes use action: transition.',
      schema: z.object({
        featureId: featureIdSchema,
        updates: z.record(z.string(), z.unknown()),
      }),
      // Wave 0 judgment call: the plan literally specified `new Set<string>()`
      // (no phases) but the registry has an existing invariant — enforced by
      // `registry.test.ts:should have non-empty phases for every action except
      // init` — that every non-init action declares at least one phase. Using
      // `ALL_PHASES` honors both the plan's intent (phase-agnostic mutation
      // surface, parallel to `transition`) and the existing invariant. The
      // semantically equivalent alternative would be to widen the test's
      // exception list, but adding `update` to the empty-phase exception
      // bucket would couple a foundational action to an `init`-only escape
      // hatch — fragile against future audits.
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      cli: {
        flags: { featureId: { alias: 'f' } },
        examples: ['exarchos wf update -f my-feature --updates \'{"artifacts":{"spec":"docs/specs/foo.md"}}\''],
      },
      // Wave 0 (#1340) — register WorkflowUpdateOutputSchema for envelope-
      // version discipline (#1266 prep). The schema mirrors the transition
      // surface's contract minus the `_meta.deprecation` slot (`update` is
      // not on a deprecation track) so a future contract-introspection
      // consumer can decode both surfaces with the same envelope shape.
      // `describe/handler.ts` exposes the schema via `outputSchema` in
      // action descriptions; callers reach it through
      // `exarchos_workflow.describe({actions: ['update']})`.
      outputSchema: vacuityWaiver('exarchos_workflow.update', WorkflowUpdateOutputSchema),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('update mutates non-phase fields without an admission gate'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'state.patched' }),
      needs: none('update writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(...UPDATE_EMISSIONS),
    },
    { annotations: LOCAL_MUTATION },
  ),
  withActionContract(
    {
      name: 'cancel',
      description: 'Cancel a workflow with saga compensation. Auto-emits workflow.cancel and compensation events',
      schema: z.object({
        featureId: featureIdSchema,
        dryRun: z.boolean().optional(),
        reason: z.string().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: vacuityWaiver('exarchos_workflow.cancel'),
      annotations: COMPENSABLE_LOCAL,
    },
    {
      requires: none('cancel starts compensation from the current phase without a prior gate'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'workflow.cancel' }),
      needs: none('cancel writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(...CANCEL_EMISSIONS),
    },
    { annotations: COMPENSABLE_LOCAL },
  ),
  withActionContract(
    {
      name: 'cleanup',
      description: 'Resolve a merged workflow to completed. Verifies merge, backfills synthesis metadata, force-resolves reviews, transitions to completed. Auto-emits workflow.cleanup event',
      schema: z.object({
        featureId: featureIdSchema,
        mergeVerified: z.boolean(),
        prUrl: z.union([z.string(), z.array(z.string())]).optional(),
        mergedBranches: z.array(z.string()).optional(),
        dryRun: z.boolean().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      // T9 (#1440 Op 2, preview-4 design §4.3): post-merge cleanup is a
      // long-running multi-step verb (merge verification, synthesis
      // metadata backfill, review force-resolve, transition) that benefits
      // from Tasks-augmented dispatch. The annotation is advisory — the
      // binding opt-in gate stays at `dispatch/core/dispatch.ts:927-954`.
      dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
      outputSchema: vacuityWaiver('exarchos_workflow.cleanup'),
      annotations: COMPENSABLE_LOCAL,
    },
    {
      requires: none('cleanup takes mergeVerified as an input flag, not a resolved gate'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'workflow.cleanup' }),
      needs: none('cleanup writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(...CLEANUP_EMISSIONS),
    },
    { annotations: COMPENSABLE_LOCAL },
  ),
  withActionContract(
    {
      name: 'reconcile',
      description: 'Rebuild workflow state from event store. Applies events newer than state _eventSequence. Idempotent — no new events returns {reconciled: false, eventsApplied: 0}. Use after compaction or crash recovery',
      schema: z.object({
        featureId: featureIdSchema,
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: vacuityWaiver('exarchos_workflow.reconcile'),
      annotations: LOCAL_MUTATION_IDEMPOTENT,
    },
    {
      requires: none('reconcile folds already-appended events and admits no extra gate'),
      ensures: none('reconcile rebuilds projection state and appends no catalog event'),
      needs: none('reconcile reads and folds through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: none('reconcile emits no catalog events'),
    },
    { annotations: LOCAL_MUTATION_IDEMPOTENT },
  ),
  withActionContract(
    {
      name: 'rehydrate',
      description: 'Rehydrate the canonical workflow document for a feature via the rehydration@v1 projection. Loads the latest snapshot and folds events written since, returning the full RehydrationDocument. Emits workflow.rehydrated on successful hydration (T032, DR-4) — the event records the deliveryPath used so downstream observers can correlate cache hints. Optional deliveryPath ∈ {direct, ndjson, snapshot}; defaults to "direct".',
      schema: z.object({
        featureId: featureIdSchema,
        // Closed enum mirrors `WorkflowRehydratedData.deliveryPath` so an
        // invalid value can't reach the workflow.rehydrated event payload.
        // Without this, registry validation accepted any string and let the
        // bad value bubble all the way to event-store append, where Zod
        // would reject it AFTER the read had already produced a document —
        // surfacing as a confusing "rehydrate succeeded but emit failed"
        // call. (CodeRabbit on PR #1178.)
        deliveryPath: z.enum(['direct', 'ndjson', 'snapshot']).optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      // T9 (#1440 Op 2, preview-4 design §4.3): full state rebuild is a
      // long-running projection fold (latest snapshot + every event since)
      // that benefits from Tasks-augmented dispatch. Advisory — the
      // binding opt-in gate stays at `dispatch/core/dispatch.ts:927-954`.
      dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
      outputSchema: vacuityWaiver('exarchos_workflow.rehydrate'),
      annotations: LOCAL_MUTATION_IDEMPOTENT,
    },
    {
      requires: none('rehydrate folds existing events and admits no extra gate'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'workflow.rehydrated' }),
      needs: none('rehydrate reads and folds through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: declared(...REHYDRATE_EMISSIONS),
    },
    { annotations: LOCAL_MUTATION_IDEMPOTENT },
  ),
  withActionContract(
    {
      name: 'checkpoint',
      description: 'Create an explicit checkpoint, resetting the operation counter. Persists checkpoint metadata to workflow state and emits workflow.checkpoint event',
      schema: z.object({
        featureId: featureIdSchema,
        summary: z.string().optional(),
        // T5 (#1240): formal `handoff` field on the dispatch surface so the
        // MCP arm validates the same shape `handleCheckpoint` re-validates
        // internally via `CheckpointInputSchema`. Without this, dispatch
        // silently strips `handoff` (registry per-action schemas are
        // non-strict) and an MCP caller passing `handoff` would observe a
        // successful checkpoint with no persisted handoff payload — the
        // CLI would honour the convenience flags while MCP would not,
        // breaking DR-3 surface parity.
        //
        // CodeRabbit nitpick on PR #1297: reuse the canonical
        // `CheckpointHandoffSchema` rather than redefining the shape inline.
        // The handler re-parses against `CheckpointInputSchema` so the
        // strictObject cap is ultimately enforced on a single line of code;
        // composing the canonical schema here keeps schema introspection
        // (`exarchos schema describe wf.checkpoint`) and the auto-gen CLI
        // flag table aligned with the handler's contract.
        handoff: CheckpointHandoffSchema.optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: vacuityWaiver('exarchos_workflow.checkpoint'),
      annotations: LOCAL_MUTATION_IDEMPOTENT,
    },
    {
      requires: none('checkpoint records progress without an admission gate'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'workflow.checkpoint' }),
      needs: none('checkpoint writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: declared(...CHECKPOINT_EMISSIONS),
    },
    { annotations: LOCAL_MUTATION_IDEMPOTENT },
  ),
  withActionContract(
    {
      // #1319 — agent→runtime friction back-channel (Trevin Principle 10b).
      // Deliberately on `exarchos_workflow` (INV-5d collapses to 4 visible
      // tools) yet NOT feature-scoped: it takes no featureId and lands on the
      // shared `meta/feedback` stream so reports are queryable across every
      // workflow. The handler owns the local write (offline-first, INV-15) and
      // the optional best-effort upstream POST; `/exarchos:dogfood` reads the
      // stream back as triage input.
      name: 'feedback',
      description:
        'File an agent→runtime friction report onto the shared meta/feedback stream (cross-workflow, queryable). Emits feedback.recorded; optionally POSTs upstream when .exarchos.yml sets feedback.upstream. No featureId — feedback is not feature-scoped.',
      schema: z.object({
        message: z.string().min(1).describe('The friction report (required, non-empty).'),
        // ZodObject (not a union) so the CLI flag classifies as `object` and
        // `coerceFlags` JSON-parses `--sessionContext '{...}'` into the same
        // shape the MCP wire receives (governing INV-2 — one registered schema
        // is the contract every client derives from; #1127
        // object-classification).
        sessionContext: z
          .object({
            workflow: z.string().optional(),
            action: z.string().optional(),
            errorCode: z.string().optional(),
          })
          .optional()
          .describe('Optional provenance: the workflow / action / errorCode the agent hit friction in.'),
      }),
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      cli: {
        flags: { message: { alias: 'm' } },
        examples: [
          'exarchos feedback "rehydrate envelope omitted taskProgress when projection lagged"',
          'exarchos wf feedback -m "check_static_analysis ran in the wrong worktree" --sessionContext \'{"action":"check_static_analysis","errorCode":"GATE_FAILED"}\'',
        ],
      },
      outputSchema: vacuityWaiver('exarchos_workflow.feedback'),
      annotations: LOCAL_MUTATION,
    },
    {
      requires: none('feedback records a friction report without an admission gate'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'feedback.recorded' }),
      needs: none('feedback writes through the in-process event store'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'meta/feedback' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(...FEEDBACK_EMISSIONS),
    },
    { annotations: LOCAL_MUTATION },
  ),
  makeWorkflowDescribeAction('exarchos_workflow.describe'),
];
