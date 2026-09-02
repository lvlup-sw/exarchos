import { eventActions } from './actions/event.js';
import { orchestrateActions } from './actions/orchestrate/index.js';
import { syncActions } from './actions/sync.js';
import { viewActions } from './actions/view/index.js';
import { workflowActions } from './actions/workflow.js';
import { validateAction } from './annotations.js';
import type { BuiltinCompositeTool } from './types.js';

// ─── Tool Registry ──────────────────────────────────────────────────────────

// The type on THIS constant is the registry's door. Declared `readonly
// BuiltinCompositeTool[]`, so every action reaching the registry must carry a
// `DeclaredOutputSchema`: the out-of-registry escape does not typecheck here,
// and neither does a `readonly ToolAction[]` array smuggled in beside the five
// below. It stays assignable to `readonly CompositeTool[]`, so consumers that
// only read the registry are unaffected by the narrower door.
export const TOOL_REGISTRY: readonly BuiltinCompositeTool[] = [
  {
    name: 'exarchos_workflow',
    description: 'Workflow lifecycle management — init, read, update, cancel, cleanup, checkpoint, reconcile, and rehydrate workflows',
    actions: workflowActions,
    cli: { alias: 'wf' },
    slimDescription: 'Workflow lifecycle management. Use describe(actions) for schemas.\n\nActions: init, get, update, transition, cancel, cleanup, reconcile, checkpoint, rehydrate',
  },
  {
    name: 'exarchos_event',
    description: 'Event sourcing — append and query events in streams',
    actions: eventActions,
    cli: { alias: 'ev' },
    slimDescription: 'Event sourcing — append and query events. Use describe(actions) for action schemas, describe(eventTypes) for event data schemas.\n\nActions: append, query, batch_append',
  },
  {
    name: 'exarchos_orchestrate',
    description: 'Task coordination — claim, complete, and fail tasks',
    actions: orchestrateActions,
    cli: { alias: 'orch' },
    slimDescription: 'Task coordination, gates, VCS. describe(actions).\n\nActions: task_claim, task_complete, task_fail, review_triage, prepare_delegation, prepare_synthesis, assess_stack, check_static_analysis, check_integration_suite, check_security_scan, check_context_economy, check_operational_resilience, check_workflow_determinism, check_review_verdict, check_convergence, check_provenance_chain, check_design_completeness, check_plan_coverage, check_post_merge, check_task_decomposition, check_event_emissions, extract_task, review_diff, verify_worktree, select_debug_track, investigation_timer, check_coverage_thresholds, assess_refactor_scope, check_pr_comments, validate_pr_body, validate_pr_stack, debug_review_gate, extract_fix_tasks, generate_traceability, spec_coverage_check, verify_worktree_baseline, setup_worktree, verify_delegation_saga, post_delegation_check, reconcile_state, pre_synthesis_check, runbook, agent_spec, onboard, doctor, create_pr, merge_pr, check_ci, list_prs, get_pr_comments, add_pr_comment, create_issue, merge_orchestrate, check_invariant_conformance, acquire_worktree, release_worktree, prune_worktrees, reconcile_worktrees, serialize_merge, stack_place, execute_intent',
  },
  {
    name: 'exarchos_view',
    description: 'CQRS materialized views — pipeline, tasks, workflow status, stack, and telemetry',
    actions: viewActions,
    cli: { alias: 'vw' },
    slimDescription: 'CQRS materialized views for pipeline, tasks, and telemetry. Use describe(actions) for schemas.\n\nActions: pipeline, tasks, workflow_status, stack_status, telemetry, team_performance, delegation_timeline, code_quality, eval_results, quality_correlation, quality_attribution, quality_hints, delegation_readiness, synthesis_readiness, shepherd_status, convergence, session_provenance, provenance, invariants_effective, worktrees, ps, wait',
  },
  {
    name: 'exarchos_sync',
    description: 'Remote synchronization — trigger immediate sync (planned)',
    actions: syncActions,
    cli: { alias: 'sy' },
    hidden: true,
    slimDescription: 'Remote synchronization. Use describe(actions) for schemas.\n\nActions: now',
  },
];

// ─── Registration-time invariant loop ───────────────────────────────────────
//
// Runs at module load so any built-in action that drifts away from the
// `outputSchema` + `annotations` contract fails the IMPORT rather than a later
// call — a startup failure names the offending action, where the same defect
// found at dispatch time surfaces far from its declaration. Custom tools
// registered through `registerCustomTool` are not covered here; that path
// validates per-action at call time through `validateAction`.
for (const tool of TOOL_REGISTRY) {
  for (const action of tool.actions) {
    validateAction(action, tool.name, 'load');
  }
}

// ─── Built-in Tool Names ────────────────────────────────────────────────────

export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((t) => t.name),
);
