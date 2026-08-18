import { coercedNonnegativeInt, coercedPositiveInt } from '../../../coerce.js';
import { withCappedShape } from '../../../output-schema-declaration.js';
import { ExportOutputSchema } from '../../../projections/views/lifecycle/export.js';
import { InspectOutputSchema } from '../../../projections/views/lifecycle/inspect.js';
import { followField, allField as lifecycleAllField, limitField as lifecycleLimitField, operationField as lifecycleOperationField, outputField as lifecycleOutputField, phaseField as lifecyclePhaseField, scopeField as lifecycleScopeField, statusField as lifecycleStatusField, workflowTypeField as lifecycleWorkflowTypeField } from '../../../projections/views/lifecycle/schema-fields.js';
import { PsOutputSchema, WaitOutputSchema, WorktreesOutputSchema } from '../../../verbs/worktree/schemas.js';
import { z } from 'zod';
import { LOCAL_MUTATION_IDEMPOTENT, LOCAL_MUTATION_OPEN_WORLD, READ_ONLY_LOCAL } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY, featureIdSchema } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

export const lifecycleViewActions: readonly BuiltinToolAction[] = [
  // ─── Worktree-lifecycle view (WLM foundation, task 008) ───────────────────
  // The read leg of the worktree actions: folds the `worktrees` stream through
  // the `worktrees@v1` projection. Pure read — no adopt, no git probe, no
  // append — so it sits on the wholesale-read-only exarchos_view tool.
  {
    name: 'worktrees',
    surface: 'worktree',
    description:
      'List the governed worktree set — the live worktrees@v1 projection (each entry: worktreeId, path, featureId, lifecycle state, owner pid/start-time). Read-only; emits no events. DR-3 bounded output: omitting limit caps the item count deterministically and, if the capped page would still blow the output-token budget, returns a counts-by-state summary + first page instead of per-item detail; narrow with limit/offset. Use for: inspecting which worktrees are governed and their reservation/orphan state. Do NOT use for: claiming or freeing a worktree (use acquire_worktree / release_worktree); the in-flight merge/prune liveness set (use ps).',
    schema: z.object({
      // Reuse pipeline's EXACT coerced base field types (coercedPositiveInt /
      // coercedNonnegativeInt) so the MCP-registration flattener sees no divergent
      // shape for the shared `limit` / `offset` field names (DR-3).
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: withCappedShape(WorktreesOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  // ─── Worktree-lifecycle liveness reads (WLM operational core, DR-4) ────────
  // The `ps` / `wait` leg over the singleton `worktrees` stream: `ps` surfaces
  // the live `inFlightMerges` set, `wait` blocks (caller-bounded) on a serialized
  // merge reaching its terminal. BOTH are genuinely read-only. `ps` carried a
  // conditional write path under `probe:true` until the reclaim and the two
  // reconcilers moved to `exarchos_orchestrate.reconcile_worktrees`: the appends
  // live in `verbs/`, so a read surface could not honestly declare them, and the
  // events they raise now have an action that names them.
  {
    name: 'ps',
    surface: 'worktree',
    description:
      "Scope-parameterized process-plane lister composing three folds (DR-3). scope:'all' (DEFAULT) returns a workflows section (every tracked workflow: featureId, workflowType, phase, status, age) PLUS an operations section (every IN-FLIGHT liveness instance across merge/launch/mutation/prune — a started-without-terminal pair, surface-generic). scope:'workflow' returns the workflows section only; filter it with status/phase/workflowType and all:true to include terminal workflows. scope:'worktree' returns the WLM-6 worktrees@v1 inFlightMerges/launches/inFlightPrunes fold. READ-ONLY on every scope: emits no events and heals nothing, so an in-flight entry whose holder has died still reads as in-flight here. Use for: a snapshot of what workflows exist and what operations are in flight. Do NOT use for: reconciling dead holders or reclaiming orphaned worktrees (use exarchos_orchestrate reconcile_worktrees — the former probe:true path); the governed worktree set (use worktrees); blocking until a condition holds (use wait).",
    schema: z.object({
      // DR-3 (task 007) — the process-plane axis. Imported from the shared
      // schema-fields SoT (widened to the union `['repo','all','workflow',
      // 'worktree']` so `pipeline` and `ps` share ONE `scope` definition on this
      // tool). `ps` accepts the `workflow|worktree|all` subset and rejects `repo`
      // at the handler; default `all`.
      scope: lifecycleScopeField.optional(),
      // Workflows-section filters (scope workflow|all). Base types imported from
      // the DR-8 schema-fields SoT so the flattened registration cannot drift them:
      // `phase`/`workflowType` collide with invariants_effective (both z.string());
      // `status` is new; `all` is a new boolean; `limit` reuses the shared coerced int.
      status: lifecycleStatusField.optional(),
      phase: lifecyclePhaseField.optional(),
      workflowType: lifecycleWorkflowTypeField.optional(),
      all: lifecycleAllField.optional(),
      limit: lifecycleLimitField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-7 (task-015): promote `ps` to a TOP-LEVEL CLI verb (`exarchos ps`)
    // alongside its `vw ps` subcommand form. Both dispatch through the ONE
    // `registerActionCommand` path (same Zod schema, no divergent parsing).
    cli: { topLevel: 'ps' },
    outputSchema: withCappedShape(PsOutputSchema),
    // Now genuinely READ_ONLY_LOCAL, matching `wait` / `worktrees` / `inspect`.
    // The sole write path (the `probe:true` reclaim + reconcilers) left with the
    // `probe` field, so no scope appends and the conservative local-mutation
    // annotation this action used to carry would now overstate its effect.
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'wait',
    surface: 'worktree',
    description:
      "Block until an event-log predicate holds; PURE CONSUMER — emits NO events, never hangs (structured WAIT_TIMEOUT on expiry). Feature-scoped (needs featureId, pick one): phase resolves on entering the target phase (already-passed ⇒ immediate; a failed/cancelled terminal first ⇒ WAIT_FAILED); status resolves on the requested terminal (completed/failed/cancelled; a DIFFERENT terminal ⇒ WAIT_FAILED); operation <surface> is the S-6 predicate for feature-scoped surfaces (merge, mutation), resolving when the unpaired executing_started gains its registry terminal by instance key (none in flight ⇒ immediate; launch/prune ⇒ INVALID_INPUT → use until). Worktree scope: until:'merge' (default) awaits the serialized merge on integrationRef, until:'idle' awaits prune-idle; timeoutMs bounds it. Use for: gating on a phase/status/operation/merge/idle condition. Do NOT use for: a snapshot (use ps/inspect); running a merge (use serialize_merge).",
    schema: z.object({
      // Feature-scoped predicate target. Required by every feature-scoped
      // predicate (phase/status/operation); the worktree `until` scope ignores it.
      featureId: featureIdSchema.optional(),
      // DR-8 shared field shapes — imported from the schema-fields SoT so the
      // flattened exarchos_view registration cannot drift these names' base types
      // across lifecycle verbs. `phase` collides with invariants_effective.phase
      // (both z.string()); `status`/`operation` are new to exarchos_view.
      phase: lifecyclePhaseField.optional(),
      status: lifecycleStatusField.optional(),
      operation: lifecycleOperationField.optional(),
      // Optional: required only in the worktree until:'merge' mode (the handler
      // rejects a missing ref there). until:'idle' does not consult it. Base
      // type (ZodString) is unchanged, so the MCP-registration flattener sees no
      // divergent shape vs serialize_merge's required integrationRef (optionality
      // drift is allowed; base-type/enum/default drift is not).
      integrationRef: z.string().min(1).optional(),
      // Worktree-scope selector (WLM-6, absorbed). 'merge' polls the serialized-
      // merge terminal; 'idle' polls until the prune liveness pair clears. New
      // field name — no other action declares `until`, so no field-collision at
      // the flattener. NB: `wait` declares NO `scope` field at all — the worktree
      // scope axis rides `until` (the feature scope rides `phase`/`status`/
      // `operation`). (The shared `scopeField` is the 4-member union since task
      // 007; `wait` simply does not use it.)
      until: z.enum(['merge', 'idle']).optional(),
      // Bounded-wait budget. Same base type (ZodNumber) as serialize_merge /
      // doctor `timeoutMs` so the MCP-registration flattener sees no divergent
      // shape for the shared `timeoutMs` field name.
      timeoutMs: z.number().int().positive().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // DR-7 (task-015): promote `wait` to a TOP-LEVEL CLI verb (`exarchos wait`)
    // alongside its `vw wait` subcommand form (one registerActionCommand path).
    cli: { topLevel: 'wait' },
    outputSchema: withCappedShape(WaitOutputSchema),
    // Pure read: appends nothing on every path → readOnlyHint + idempotentHint
    // (the MCP-annotation hints derive from `readOnly`/`idempotent` here). DR-5
    // revises #1316 Q7 — the log records domain facts, not observations of them.
    annotations: READ_ONLY_LOCAL,
  },
  // ─── Worktree-lifecycle single-workflow projection (DR-4) ─────────────────
  // The `inspect` read leg of the lifecycle verbs: folds ONE feature stream and
  // projects state (via the canonical event-store-first `resolveWorkflowState` —
  // SQLite is the only source of truth), recent events + the correlation tuple,
  // artifacts, and task progress. Pure read — appends nothing on any path — so it
  // sits on the wholesale-read-only exarchos_view tool as an ACTION (INV-5d: NO
  // new visible tool; the visible composite count stays 4). A cold probe of an
  // unknown featureId returns `workflowExists:false` and emits ZERO events (the
  // CB-2 no-phantom-stream guarantee). The CLI verb re-map (`inspect`→`describe`)
  // is task-015; the `--follow` streaming behavior is task-009 — the `follow`
  // field is schema-declared here (imported from the DR-8 SoT) so its CLI flag
  // auto-emits ahead of that handler work.
  {
    name: 'inspect',
    description:
      'Project a single workflow in one read: state (phase / workflowType / timestamps via the canonical event-store-first resolveWorkflowState — SQLite is the only source of truth, NEVER .state.json presence), the recent event tail + the latest dispatch correlation tuple, the artifact map, and task progress (roster + counts-by-status). Read-only; emits no events. Cold-probe safe: an unknown/never-init\'d featureId returns workflowExists:false and appends nothing (no phantom stream). Bound the event tail with limit (the full state/artifacts/tasks are always complete). Use for: a one-call status snapshot of a specific workflow. Do NOT use for: the cross-workflow pipeline roll-up (use pipeline); mutating or advancing a workflow (use exarchos_workflow).',
    schema: z.object({
      featureId: featureIdSchema,
      // DR-8 shared shapes (imported from the SoT so the flattened exarchos_view
      // registration cannot drift these field names' base types across verbs).
      // `limit` bounds the recent-event tail; `follow` is reserved for task-009's
      // `--follow` streaming (schema-declared now so its CLI flag auto-emits).
      limit: lifecycleLimitField.optional(),
      follow: followField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      // DR-7 (task-015): promote `inspect` to the TOP-LEVEL `describe` verb — the
      // workflow-PROJECTION describe (`exarchos describe -f my-feature`). The
      // top-level NAME intentionally differs from the action name: the schema-
      // introspection `describe` is a per-tool ACTION subcommand (`vw describe`,
      // `wf describe`), NEVER a top-level command, so `exarchos describe` (→ the
      // `inspect` action) does not collide with it. The task-014 hoist-loop guard
      // re-checks the full top-level namespace at build time and confirms this.
      topLevel: 'describe',
      flags: { featureId: { alias: 'f' } },
      examples: [
        'exarchos vw inspect -f my-feature',
        'exarchos describe -f my-feature',
      ],
    },
    // Typed-output totality (DR-1): union the generic capped-fallback shape so
    // the schema admits BOTH the baseline projection AND a dispatch-core-capped
    // {summary,counts,firstPage} envelope, keeping it total over emittable shapes.
    outputSchema: withCappedShape(InspectOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  // ─── Worktree-lifecycle diagnostic bundle (DR-6) ──────────────────────────
  // The `export` WRITE leg of the lifecycle verbs (the last verb): writes a
  // portable zip bundle (events.jsonl / state.json / metadata.json / artifacts/)
  // of one workflow to a path OUTSIDE `.exarchos/`. Unlike the pure-read `ps` /
  // `wait` / `inspect` legs it has an unconditional external side effect (a file
  // write), so it declares the `task-isolated` posture (the capability resolver
  // mints fs:write from it, containing the blast radius to the caller's
  // worktree) and an openWorld annotation (writes outside the managed store).
  // It still rides `exarchos_view` as an ACTION (INV-5d — no new visible tool;
  // the composite count stays 4), like `ps`'s conditional probe-write path.
  // The write is journaled as the INV-13 export.requested → export.executed
  // pair, the storage idempotency key is derived from a logical key (INV-8), a
  // crashed pair is completed without duplicating the intent, and a cold probe
  // of an unknown featureId writes nothing + emits zero events. The CLI verb
  // promotion (`export`→top-level) is task-015.
  {
    name: 'export',
    description:
      "Write a portable diagnostic zip bundle of ONE workflow to disk: events.jsonl (the domain event stream, one JSON event/line), state.json (fold(events.jsonl) via the canonical projection — replaying events.jsonl reconstructs it), metadata.json (featureId / eventCount / phase / workflowType / artifacts + missingArtifacts), and artifacts/ (every referenced artifact FILE that exists; missing references are tolerated and listed). Default destination ./<featureId>-export.zip; override with output. Writes to a path OUTSIDE .exarchos/ (openWorld) and journals the INV-13 export.requested → export.executed pair around the write, so a crash between the two is completed WITHOUT duplicating the intent and a fresh invocation mints a new pair (INV-8). Cold-probe safe: an unknown featureId returns workflowExists:false, writes no zip and emits no events. Use for: capturing a self-contained, replayable snapshot of a workflow for diagnosis or handoff. Do NOT use for: a live status snapshot (use inspect); advancing or mutating the workflow (use exarchos_workflow).",
    schema: z.object({
      featureId: featureIdSchema,
      // DR-8 shared shape — imported from the schema-fields SoT (z.string(), a
      // destination FILE PATH, not a table|json format enum) so the flattened
      // exarchos_view registration cannot drift the `output` field's base type.
      output: lifecycleOutputField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // #1305 — task-isolated trust tier: the resolver mints fs:write for the
    // bundle write, contained to the caller's worktree. The last worktree verb.
    posture: 'task-isolated',
    cli: {
      // DR-7 (task-015): promote `export` to a TOP-LEVEL CLI verb
      // (`exarchos export`) alongside its `vw export` subcommand form.
      topLevel: 'export',
      flags: { featureId: { alias: 'f' }, output: { alias: 'o' } },
      examples: [
        'exarchos vw export -f my-feature -o ./my-feature-export.zip',
        'exarchos export -f my-feature -o ./my-feature-export.zip',
      ],
    },
    // Typed-output totality (DR-1): union the generic capped-fallback shape so
    // the schema admits BOTH the bundle-write result AND a dispatch-core-capped
    // envelope.
    outputSchema: withCappedShape(ExportOutputSchema),
    // openWorldHint: true — writes a file outside the managed store.
    annotations: LOCAL_MUTATION_OPEN_WORLD,
  },
];
