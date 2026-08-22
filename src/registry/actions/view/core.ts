import { coercedNonnegativeInt, coercedPositiveInt, coercedRecord, coercedStringArray } from '../../../coerce.js';
import { vacuityWaiver, withCappedShape } from '../../../output-schema-declaration.js';
import { scopeField as lifecycleScopeField } from '../../../projections/views/lifecycle/schema-fields.js';
import { AsOfSchema } from '../../../workflow/schemas.js';
import { z } from 'zod';
import { none, withActionContract } from '../../action-contract.js';
import { CORRELATION_TUPLE_FILTER_SHAPE, LOCAL_MUTATION, READ_ONLY_LOCAL } from '../../annotations.js';
import { TelemetryViewOutputSchema } from '../../output-schemas.js';
import { ALL_PHASES, ROLE_ANY, STACK_PHASES } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

const READ_ONLY_VIEW_CONTRACT = {
  requires: none('read-only view has no admission obligations'),
  ensures: none('read-only view returns an ephemeral projection with no durable postcondition'),
  needs: none('read-only view folds in-process projections'),
  touches: {
    frame: 'single-machine' as const,
    resources: none('read-only view does not claim exclusive stream, path, worktree, or git-ref ownership'),
  },
  executionAuthority: { kind: 'local' as const },
  replay: { kind: 'safe-repeat' as const },
  emissions: none('read-only view emits no catalog events'),
};

const CORE_VIEW_DECLARATIONS: readonly BuiltinToolAction[] = [
  {
    name: 'pipeline',
    description: "Aggregated view of active workflows with stack positions, repo-scoped by default to the caller's repo (excludes completed/cancelled unless includeCompleted=true). Returns ≤ 10 compact entries; data.page carries {total, offset, limit, hasMore} and data.scope/data.unscopedTotal report the effective scope and the pre-scope count so hidden rows are perceivable. Pass scope='all' to span every repo, an explicit repoRoot to scope to another repo, or detail=true for the full per-task map.",
    schema: z.object({
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      includeCompleted: z.boolean().optional(),
      // DR-1 — schema-level flag so the CLI flag auto-emits. Default entries
      // omit the per-task `tasksById` map; `detail: true` restores it.
      detail: z.boolean().optional(),
      // DR-6 — repo-scope inputs, schema-declared so the CLI flags auto-emit.
      // `repoRoot` scopes to an arbitrary repo (normalized before compare);
      // `scope` forces 'all' (unfiltered) or 'repo' (requires a resolvable key).
      repoRoot: z.string().optional(),
      // DR-3 (task 007) — `scope` migrated onto the shared `schema-fields.ts`
      // shape so `pipeline` and `ps` declare ONE `scope` definition on this tool
      // (no flattener collision). The shared shape is the UNION
      // `['repo','all','workflow','worktree']`; `pipeline` acts ONLY on the
      // `{repo, all}` subset and REJECTS the `ps`-only members (`workflow`/
      // `worktree`) at the handler with a structured `INVALID_INPUT` (mirroring
      // how `ps` rejects the pipeline-only `repo` member) — never a silent
      // coerce to unscoped (see the subset guard in `projections/views/tools.ts`).
      scope: lifecycleScopeField.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      alias: 'ls',
      examples: ['exarchos vw ls'],
    },
    outputSchema: vacuityWaiver('exarchos_view.pipeline'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'tasks',
    description: 'Task detail view with filtering and projection',
    schema: z.object({
      workflowId: z.string().optional(),
      filter: coercedRecord().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      fields: coercedStringArray().optional(),
      // DR-8 (Task 013) — schema-declared so the CLI flag auto-emits; the
      // compact-by-default fold + `detail:true` full-row restore land in the
      // handler under Task 013.
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      flags: { workflowId: { alias: 'w' }, limit: { alias: 'l' } },
      examples: ['exarchos vw tasks -w my-feature'],
    },
    outputSchema: vacuityWaiver('exarchos_view.tasks'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'workflow_status',
    description: 'Workflow phase, task counts, and metadata',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 013) — list/inventory paging + detail inputs, schema-
      // declared so the CLI flags auto-emit; the `page` metadata + `detail:true`
      // fold land in the handler under Task 013.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // #1555 — optional bounded-fold (as-of/time-travel) read over a single
      // stream. Same single-source `AsOfSchema` as `get`. The bounded read
      // bypasses the hwm cache (see views/tools.ts) so the projection folds
      // only `events[0..N]`. `pipeline` is intentionally excluded: its
      // cross-stream aggregation has no single `(timestamp, sequence)` axis
      // to bound coherently.
      asOf: AsOfSchema.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      flags: { workflowId: { alias: 'w' } },
      examples: [
        'exarchos vw workflow_status -w my-feature',
        'exarchos vw workflow_status -w my-feature --as-of \'{"untilSequence":3}\'',
      ],
    },
    outputSchema: vacuityWaiver('exarchos_view.workflow_status'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'stack_status',
    description: 'Get current stack positions from events',
    schema: z.object({
      streamId: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      // DR-8 (Task 013) — `detail:true` full-row restore; handler rides Task 013.
      detail: z.boolean().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.stack_status'),
    annotations: READ_ONLY_LOCAL,
  },
  // `stack_place` was here. It appends `stack.position-filled` while its
  // registration named `exarchos_orchestrate` as the effect provider, so the
  // declared provider and the declaring tool could not both be right. The
  // writer moved to the orchestrate surface; `stack_status` above is the read
  // half and stays.
  {
    name: 'telemetry',
    description: 'Get telemetry metrics with per-tool performance data and optimization hints',
    schema: z.object({
      compact: z.boolean().optional(),
      tool: z.string().optional(),
      sort: z.enum(['tokens', 'invocations', 'duration']).optional(),
      limit: coercedPositiveInt().optional(),
      // DR-8 (Task 024) — offset paging + detail inputs on the analytic view
      // batch, schema-declared so the CLI flags auto-emit; the `page`/`scope`
      // metadata + `detail:true` fold land in the handler under Task 024.
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the telemetry
      // rollup to a single dispatch boundary. Honored at the backend layer
      // (indexed columns / post-fetch JS filter); INV-1 keeps payload as
      // truth, mirrored to the indexed columns.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // PR3/T10 (#1364) — typed envelope advertises the per-tool
    // `actionErrors` + `actionErrorBreakdown` fields (post Wave 0 carrier
    // composition).
    // Task 022 (DR-1/DR-8): union the capped-shape fallback into the typed
    // telemetry `data` so a summarized/capped telemetry response validates
    // against its own registered contract (D.5 totality).
    outputSchema: withCappedShape(TelemetryViewOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'team_performance',
    description: 'Team performance metrics from delegation events',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 013) — list/inventory paging + detail; handler rides Task 013.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.team_performance'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'delegation_timeline',
    description: 'Delegation timeline with bottleneck detection',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 013) — list/inventory paging + detail; handler rides Task 013.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.delegation_timeline'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'code_quality',
    description: 'Code quality metrics with gate pass rates, skill attribution, and regression detection',
    schema: z.object({
      workflowId: z.string().optional(),
      skill: z.string().optional(),
      gate: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      // DR-8 (Task 024) — offset paging + detail on the analytic view batch;
      // handler rides Task 024.
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.code_quality'),
    annotations: READ_ONLY_LOCAL,
  },
];

export const coreViewActions: readonly BuiltinToolAction[] = CORE_VIEW_DECLARATIONS.map((action) =>
  withActionContract(action, READ_ONLY_VIEW_CONTRACT, { annotations: action.annotations }),
);
