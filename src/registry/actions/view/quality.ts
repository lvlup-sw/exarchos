import { coercedNonnegativeInt, coercedPositiveInt, coercedStringArray } from '../../../coerce.js';
import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { none, withActionContract } from '../../action-contract.js';
import { CORRELATION_TUPLE_FILTER_SHAPE, READ_ONLY_LOCAL } from '../../annotations.js';
import { ALL_PHASES, ROLE_ANY } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

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

const QUALITY_VIEW_DECLARATIONS: readonly BuiltinActionDraft[] = [
  // Wave 5 (#1437) — Group B telemetry view actions. These actions were
  // previously dispatched via `exarchos_view` through composite.ts but had
  // no entry in TOOL_REGISTRY's `viewActions`, so per-action schema
  // validation (DR-5) and describe-handler introspection both skipped them.
  // Registering them here brings them under the dispatch-validation contract
  // AND surfaces their correlation-filter slots through `describe(actions)`.
  {
    name: 'eval_results',
    description: 'Evaluation suite results with per-skill pass/fail rates and regression flags',
    schema: z.object({
      workflowId: z.string().optional(),
      skill: z.string().optional(),
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
    outputSchema: vacuityWaiver('exarchos_view.eval_results'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_correlation',
    description: 'Per-skill correlation of code-quality gate pass rates with eval scores',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 024) — paging + detail on the analytic view batch;
      // handler rides Task 024.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope BOTH underlying
      // projection folds (CQ + ER) to a single dispatch boundary so the
      // joined output stays internally consistent.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.quality_correlation'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_attribution',
    description: 'Attribute quality outcomes across a dimension (skill / model / gate / prompt-version)',
    schema: z.object({
      workflowId: z.string().optional(),
      dimension: z.enum(['skill', 'model', 'gate', 'prompt-version']).optional(),
      skill: z.string().optional(),
      timeRange: z
        .object({
          start: z.string(),
          end: z.string(),
        })
        .optional(),
      // DR-8 (Task 024) — paging + detail on the analytic view batch;
      // handler rides Task 024.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope BOTH underlying
      // projection folds (CQ + ER) to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.quality_attribution'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'delegation_readiness',
    description: 'Check delegation readiness: plan approval, quality gates, and worktree status. Pass `tasks` to scope readiness to the active wave instead of every historical assignment (WFQ-002).',
    schema: z.object({
      workflowId: z.string().optional(),
      tasks: coercedStringArray()
        .optional()
        .describe("Active wave's task IDs; scopes expected/ready/blockers to exactly this set"),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.delegation_readiness'),
    annotations: READ_ONLY_LOCAL,
  },
  // T1 (#1446 residue) — three view actions dispatched through
  // `projections/views/composite.ts` but previously absent from TOOL_REGISTRY.viewActions.
  // Without the registry entry, per-action Zod validation at
  // `dispatch/core/dispatch.ts:801` is silently skipped (DR-5 hole) and
  // `exarchos_view describe` cannot surface their schemas. Registering them
  // here closes both gaps. Schemas mirror the args the composite.ts handlers
  // route today (see `projections/views/composite.ts` cases for each action).
  {
    name: 'session_provenance',
    description: 'Per-session provenance roll-up (tokens, tools, cost attribution) — query by sessionId or workflowId, optionally narrowed by metric',
    schema: z.object({
      sessionId: z.string().optional(),
      workflowId: z.string().optional(),
      metric: z.string().optional(),
      // No correlation-tuple filter slots: the underlying handler
      // (`handleViewSessionProvenance`) does not receive the event store.
      // The session-provenance projection reads `stateDir` only, so there
      // is no event-store query for the tuple filters to scope.
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.session_provenance'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'provenance',
    description: 'Design-to-task provenance: per-requirement coverage and orphan-task detection from the design.linked / task.assigned event chain',
    schema: z.object({
      workflowId: z.string().optional(),
      // Underlying handler (`handleViewProvenance`) queries the event store
      // via `queryDeltaEvents`, so the correlation-tuple filter surface
      // mirrors the Wave 5 (#1437) telemetry-view contract — slots are
      // optional and pass through the cache-bypassing filtered fold path
      // when present.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.provenance'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'synthesis_readiness',
    description: 'Check synthesis readiness: task completion, reviews, tests, and typecheck status',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.synthesis_readiness'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'shepherd_status',
    description: 'PR shepherd status: CI, comments, unresolved findings, and iteration tracking',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.shepherd_status'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'convergence',
    description: 'Per-dimension gate convergence status (D1-D5) from gate.executed events',
    schema: z.object({
      workflowId: z.string().optional(),
      // DR-8 (Task 024) — paging + detail on the analytic view batch;
      // handler rides Task 024.
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.convergence'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'gate_reliability',
    description:
      'Diagnostic gate reliability: per-gate false-positive rate and verdict provenance from admission evidence/contradiction events (no admission authority)',
    schema: z.object({
      workflowId: z.string().optional(),
      detail: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.gate_reliability'),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_hints',
    description: 'Generate quality improvement hints from code quality view',
    schema: z.object({
      workflowId: z.string().optional().describe('Workflow ID to generate hints for'),
      skill: z.string().optional().describe('Filter hints by skill name'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.quality_hints'),
    annotations: READ_ONLY_LOCAL,
  },
  // DR-7 (T-20) — effective invariant catalog export. Surfaces the merged +
  // override-clamped + projected invariant set for a given SDLC context via
  // the single core fn `resolveEffectiveCatalog` (INV-2: one payload, many
  // facades). The CLI `--json` form routes the same handler.
  // SEAM (#1275): expose this same payload as
  // resources/exarchos-invariants/effective when MCP Resources land. Register
  // NO `resources/*` today.
  {
    name: 'invariants_effective',
    description:
      'Effective invariant catalog (merged dev + user catalogs, overrides clamped to each floor, projected to the given phase/workflow) — the resolveEffectiveCatalog payload (DR-7)',
    schema: z.object({
      phase: z.string().describe('SDLC phase to project for (e.g. ideate, plan, delegate)'),
      workflowType: z
        .string()
        .describe('Workflow kind to project for (e.g. feature, debug, discovery)'),
      repoRoot: z
        .string()
        .optional()
        .describe('Repo root for .exarchos.yml + dev-catalog resolution; defaults to cwd'),
      touchedFiles: coercedStringArray()
        .optional()
        .describe('Files the current task touches (delegate-phase projection narrowing)'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_view.invariants_effective'),
    annotations: READ_ONLY_LOCAL,
  },
];

export const qualityViewActions: readonly BuiltinToolAction[] = QUALITY_VIEW_DECLARATIONS.map((action) =>
  withActionContract(action, READ_ONLY_VIEW_CONTRACT, { annotations: action.annotations }),
);
