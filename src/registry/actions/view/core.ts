import { coercedNonnegativeInt, coercedPositiveInt, coercedRecord, coercedStringArray } from '../../../coerce.js';
import { vacuityWaiver, withCappedShape } from '../../../output-schema-declaration.js';
import { scopeField as lifecycleScopeField } from '../../../projections/views/lifecycle/schema-fields.js';
import { AsOfSchema } from '../../../workflow/schemas.js';
import { z } from 'zod';
import { none, withActionContract } from '../../action-contract.js';
import { CORRELATION_TUPLE_FILTER_SHAPE, LOCAL_MUTATION, READ_ONLY_LOCAL } from '../../annotations.js';
import { TelemetryViewOutputSchema } from '../../output-schemas.js';
import { ALL_PHASES, ROLE_ANY, STACK_PHASES } from '../../phases.js';
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
};

const CORE_VIEW_DECLARATIONS: readonly BuiltinActionDraft[] = [
  {
    name: 'pipeline',
    description: "Aggregated view of active workflows with stack positions, repo-scoped by default to the caller's repo (excludes completed/cancelled unless includeCompleted=true). Returns ≤ 10 compact entries; data.page carries {total, offset, limit, hasMore} and data.scope/data.unscopedTotal report the effective scope and the pre-scope count so hidden rows are perceivable. Pass scope='all' to span every repo, an explicit repoRoot to scope to another repo, or detail=true for the full per-task map.",
    schema: z.object({
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      includeCompleted: z.boolean().optional(),
      /** Default entries omit the per-task `tasksById` map. `detail: true` restores it. */
      detail: z.boolean().optional(),
      /** Scopes the view to another repo. The handler normalizes it before the comparison. */
      repoRoot: z.string().optional(),
      /**
       * The `scope` field that `pipeline` and `ps` share, so the flattener sees one definition.
       * `pipeline` acts on `repo` and `all`. The handler rejects `workflow` and `worktree` with `INVALID_INPUT`.
       */
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
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      /**
       * An optional as-of read over one stream, with the same `AsOfSchema` as `get`.
       * The bounded read skips the high-water-mark cache, so the projection folds only the events up to the bound.
       * `pipeline` has no `asOf`, because its cross-stream view has no single `(timestamp, sequence)` axis.
       */
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
      detail: z.boolean().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.stack_status'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'telemetry',
    description: 'Get telemetry metrics with per-tool performance data and optimization hints',
    schema: z.object({
      compact: z.boolean().optional(),
      tool: z.string().optional(),
      sort: z.enum(['tokens', 'invocations', 'duration']).optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      /** The correlation tuple filters scope the telemetry rollup to one dispatch boundary. */
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    /** The typed envelope includes the capped-shape fallback, so a capped telemetry response validates against its own contract. */
    outputSchema: withCappedShape(TelemetryViewOutputSchema),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'team_performance',
    description: 'Team performance metrics from delegation events',
    schema: z.object({
      workflowId: z.string().optional(),
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
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      /** The correlation tuple filters scope the projection fold to one dispatch boundary. */
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
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      /** The correlation tuple filters scope the projection fold to one dispatch boundary. */
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
