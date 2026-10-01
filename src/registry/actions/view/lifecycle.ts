import { coercedNonnegativeInt, coercedPositiveInt } from '../../../coerce.js';
import { withCappedShape } from '../../../output-schema-declaration.js';
import { ExportOutputSchema } from '../../../projections/views/lifecycle/export.js';
import { InspectOutputSchema } from '../../../projections/views/lifecycle/inspect.js';
import { followField, allField as lifecycleAllField, limitField as lifecycleLimitField, operationField as lifecycleOperationField, outputField as lifecycleOutputField, phaseField as lifecyclePhaseField, scopeField as lifecycleScopeField, statusField as lifecycleStatusField, workflowTypeField as lifecycleWorkflowTypeField } from '../../../projections/views/lifecycle/schema-fields.js';
import { PsOutputSchema, WaitOutputSchema, WorktreesOutputSchema } from '../../../verbs/worktree/schemas.js';
import { z } from 'zod';
import { declared, none, withActionContract, type ActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION_IDEMPOTENT, LOCAL_MUTATION_OPEN_WORLD, READ_ONLY_LOCAL } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY, featureIdSchema } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

const READ_ONLY_VIEW_CONTRACT = {
  requires: none('read-only view has no admission obligations'),
  ensures: none('read-only view returns an ephemeral projection with no durable postcondition'),
  needs: none('read-only view folds in-process projections'),
  touches: {
    frame: 'single-machine',
    resources: none('read-only view does not claim exclusive stream, path, worktree, or git-ref ownership'),
  },
  executionAuthority: { kind: 'local' },
  replay: { kind: 'safe-repeat' },
  emissions: none('read-only view emits no catalog events'),
} satisfies ActionContract;

const EXPORT_VIEW_CONTRACT = {
  requires: none('export does not require admission gates or corroboration'),
  ensures: declared(
    { source: 'event-append', when: 'success', event: 'export.requested' },
    { source: 'event-append', when: 'success', event: 'export.executed' },
  ),
  needs: declared('fs:read', 'fs:write'),
  touches: {
    frame: 'single-machine',
    resources: declared(
      { kind: 'stream', selector: 'workflow' },
      { kind: 'path', selector: 'export-bundle' },
    ),
  },
  executionAuthority: { kind: 'local' },
  replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  emissions: declared(
    {
      event: 'export.requested',
      condition: 'conditional',
      owner: 'view',
      role: 'primary',
    },
    {
      event: 'export.executed',
      condition: 'conditional',
      owner: 'view',
      role: 'primary',
    },
  ),
} satisfies ActionContract;

const LIFECYCLE_VIEW_DECLARATIONS: readonly BuiltinActionDraft[] = [
  /**
   * The read leg of the worktree actions. It folds the `worktrees` stream through the
   * `worktrees@v1` projection. It does no adopt, no git probe, and no append.
   */
  {
    name: 'worktrees',
    surface: 'worktree',
    description:
      'List the governed worktree set — the live worktrees@v1 projection (each entry: worktreeId, path, featureId, lifecycle state, owner pid/start-time). Read-only; emits no events. DR-3 bounded output: omitting limit caps the item count deterministically and, if the capped page would still blow the output-token budget, returns a counts-by-state summary + first page instead of per-item detail; narrow with limit/offset. Use for: inspecting which worktrees are governed and their reservation/orphan state. Do NOT use for: claiming or freeing a worktree (use acquire_worktree / release_worktree); the in-flight merge/prune liveness set (use ps).',
    schema: z.object({
      /**
       * The same coerced base types as `pipeline`, so the MCP flattener sees one shape for the
       * shared `limit` and `offset` field names.
       */
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: withCappedShape(WorktreesOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  /**
   * The liveness reads. `ps` lists the in-flight operations, and `wait` blocks until a predicate
   * holds. Both are read-only. `exarchos_orchestrate.reconcile_worktrees` does the heals.
   */
  {
    name: 'ps',
    surface: 'worktree',
    description:
      "Scope-parameterized process-plane lister composing three folds (DR-3). scope:'all' (DEFAULT) returns a workflows section (every tracked workflow: featureId, workflowType, phase, status, age) PLUS an operations section (every IN-FLIGHT liveness instance across merge/launch/mutation/prune — a started-without-terminal pair, surface-generic). scope:'workflow' returns the workflows section only; filter it with status/phase/workflowType and all:true to include terminal workflows. scope:'worktree' returns the WLM-6 worktrees@v1 inFlightMerges/launches/inFlightPrunes fold. READ-ONLY on every scope: emits no events and heals nothing, so an in-flight entry whose holder has died still reads as in-flight here. Use for: a snapshot of what workflows exist and what operations are in flight. Do NOT use for: reconciling dead holders or reclaiming orphaned worktrees (use exarchos_orchestrate reconcile_worktrees — the former probe:true path); the governed worktree set (use worktrees); blocking until a condition holds (use wait).",
    schema: z.object({
      /**
       * The process-plane axis. `pipeline` and `ps` share one `scope` field. `ps` accepts `all`,
       * `workflow`, and `worktree`, and the handler rejects `repo`. The default is `all`.
       */
      scope: lifecycleScopeField.optional(),
      /**
       * Filters for the workflows section. The shared field module supplies the base types, so the
       * flattened registration keeps one shape for each shared field name.
       */
      status: lifecycleStatusField.optional(),
      phase: lifecyclePhaseField.optional(),
      workflowType: lifecycleWorkflowTypeField.optional(),
      all: lifecycleAllField.optional(),
      limit: lifecycleLimitField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    /**
     * Also a top-level CLI verb, `exarchos ps`. Both forms dispatch through `registerActionCommand`
     * with the same schema.
     */
    cli: { topLevel: 'ps' },
    outputSchema: withCappedShape(PsOutputSchema),
    /** No scope appends, so the action is read-only. */
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'wait',
    surface: 'worktree',
    description:
      "Block until an event-log predicate holds; PURE CONSUMER — emits NO events, never hangs (structured WAIT_TIMEOUT on expiry). Feature-scoped (needs featureId, pick one): phase resolves on entering the target phase (already-passed ⇒ immediate; a failed/cancelled terminal first ⇒ WAIT_FAILED); status resolves on the requested terminal (completed/failed/cancelled; a DIFFERENT terminal ⇒ WAIT_FAILED); operation <surface> is the S-6 predicate for feature-scoped surfaces (merge, mutation), resolving when the unpaired executing_started gains its registry terminal by instance key (none in flight ⇒ immediate; launch/prune ⇒ INVALID_INPUT → use until). Worktree scope: until:'merge' (default) awaits the serialized merge on integrationRef, until:'idle' awaits prune-idle; timeoutMs bounds it. Use for: gating on a phase/status/operation/merge/idle condition. Do NOT use for: a snapshot (use ps/inspect); running a merge (use serialize_merge).",
    schema: z.object({
      /**
       * The target of a feature-scoped predicate (`phase`, `status`, `operation`). The `until`
       * scope ignores it.
       */
      featureId: featureIdSchema.optional(),
      /**
       * The shared field module supplies these base types, so the flattened `exarchos_view`
       * registration keeps one shape for each shared field name.
       */
      phase: lifecyclePhaseField.optional(),
      status: lifecycleStatusField.optional(),
      operation: lifecycleOperationField.optional(),
      /**
       * Required only for `until: 'merge'`, where the handler rejects a missing ref. The base type
       * matches the required `integrationRef` of `serialize_merge`. The flattener accepts a
       * difference in optionality only.
       */
      integrationRef: z.string().min(1).optional(),
      /**
       * The worktree-scope selector. `merge` polls for the serialized-merge terminal, and `idle`
       * polls until the prune liveness pair clears. `wait` has no `scope` field.
       */
      until: z.enum(['merge', 'idle']).optional(),
      /**
       * The wait budget. It has the same base type as `timeoutMs` on `serialize_merge` and `doctor`,
       * so the MCP flattener sees one shape.
       */
      timeoutMs: z.number().int().positive().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    /** Also a top-level CLI verb, `exarchos wait`. */
    cli: { topLevel: 'wait' },
    outputSchema: withCappedShape(WaitOutputSchema),
    /**
     * `wait` appends nothing on any path, so it is read-only and idempotent. The event log records
     * domain facts, not observations of them.
     */
    annotations: READ_ONLY_LOCAL,
  },
  /**
   * The single-workflow projection. It folds one feature stream through `resolveWorkflowState`
   * and appends nothing. A cold probe of an unknown `featureId` returns `workflowExists: false`
   * and emits no event.
   */
  {
    name: 'inspect',
    description:
      'Project a single workflow in one read: state (phase / workflowType / timestamps via the canonical event-store-first resolveWorkflowState — SQLite is the only source of truth, NEVER .state.json presence), the recent event tail + the latest dispatch correlation tuple, the artifact map, and task progress (roster + counts-by-status). Read-only; emits no events. Cold-probe safe: an unknown/never-init\'d featureId returns workflowExists:false and appends nothing (no phantom stream). Bound the event tail with limit (the full state/artifacts/tasks are always complete). Use for: a one-call status snapshot of a specific workflow. Do NOT use for: the cross-workflow pipeline roll-up (use pipeline); mutating or advancing a workflow (use exarchos_workflow).',
    schema: z.object({
      featureId: featureIdSchema,
      /**
       * Shared field shapes. `limit` bounds the recent-event tail. `follow` gives the CLI its
       * `--follow` flag.
       */
      limit: lifecycleLimitField.optional(),
      follow: followField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      /**
       * The top-level `exarchos describe` verb maps to `inspect`. The schema `describe` is only a
       * per-tool subcommand, so the two names do not collide. A build-time guard checks the
       * top-level namespace.
       */
      topLevel: 'describe',
      flags: { featureId: { alias: 'f' } },
      examples: [
        'exarchos vw inspect -f my-feature',
        'exarchos describe -f my-feature',
      ],
    },
    /** Admits the projection and the capped `{summary,counts,firstPage}` envelope of dispatch. */
    outputSchema: withCappedShape(InspectOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  /**
   * The diagnostic bundle. `export` writes a zip of one workflow to a path outside `.exarchos/`,
   * so it is the write leg of these verbs. The `export.requested` and `export.executed` pair
   * journals the write. A cold probe of an unknown `featureId` writes nothing and emits no event.
   */
  {
    name: 'export',
    description:
      "Write a portable diagnostic zip bundle of ONE workflow to disk: events.jsonl (the domain event stream, one JSON event/line), state.json (fold(events.jsonl) via the canonical projection — replaying events.jsonl reconstructs it), metadata.json (featureId / eventCount / phase / workflowType / artifacts + missingArtifacts), and artifacts/ (every referenced artifact FILE that exists; missing references are tolerated and listed). Default destination ./<featureId>-export.zip; override with output. Writes to a path OUTSIDE .exarchos/ (openWorld) and journals the INV-13 export.requested → export.executed pair around the write, so a crash between the two is completed WITHOUT duplicating the intent and a fresh invocation mints a new pair (INV-8). Cold-probe safe: an unknown featureId returns workflowExists:false, writes no zip and emits no events. Use for: capturing a self-contained, replayable snapshot of a workflow for diagnosis or handoff. Do NOT use for: a live status snapshot (use inspect); advancing or mutating the workflow (use exarchos_workflow).",
    schema: z.object({
      featureId: featureIdSchema,
      /** The destination file path, not a format enum. The shared field module supplies the base type. */
      output: lifecycleOutputField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    /** The resolver mints `fs:write` for the bundle write, kept to the worktree of the caller. */
    posture: 'task-isolated',
    cli: {
      /** Also a top-level CLI verb, `exarchos export`. */
      topLevel: 'export',
      flags: { featureId: { alias: 'f' }, output: { alias: 'o' } },
      examples: [
        'exarchos vw export -f my-feature -o ./my-feature-export.zip',
        'exarchos export -f my-feature -o ./my-feature-export.zip',
      ],
    },
    /** Admits the bundle-write result and the capped envelope of dispatch. */
    outputSchema: withCappedShape(ExportOutputSchema),
    /** Open world, because it writes a file outside the managed store. */
    annotations: LOCAL_MUTATION_OPEN_WORLD,
  },
];

export const lifecycleViewActions: readonly BuiltinToolAction[] = LIFECYCLE_VIEW_DECLARATIONS.map((action) =>
  withActionContract(
    action,
    action.name === 'export' ? EXPORT_VIEW_CONTRACT : READ_ONLY_VIEW_CONTRACT,
    { annotations: action.annotations },
  ),
);
