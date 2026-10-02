/**
 * These characterization tests pin two rosters: the required reviews for each
 * workflow type and risk tier, and the `exarchos_orchestrate` action set. A
 * change to a roster must update these pins in the same change. Any other
 * drift is a regression.
 */

import { describe, it, expect } from 'vitest';

import { getRequiredReviews } from '../../../../src/workflow/review-contract.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';

describe('mutation-adequacy roster characterization (PIN)', () => {
  /**
   * `getRequiredReviews` is keyed by workflow type. Only the `feature` workflow
   * declares required reviews. The HIGH risk tier adds `mutation-adequacy`.
   */
  describe('ReviewDimensionRoster_CurrentBuild_StablePerWorkflowType', () => {
    it('feature workflow requires exactly review', () => {
      expect(getRequiredReviews('feature')).toEqual(['review']);
    });

    it('non-feature and unknown workflow types declare no required reviews', () => {
      for (const workflowType of ['debug', 'refactor', 'oneshot', 'discovery', 'unknown-type']) {
        expect(getRequiredReviews(workflowType)).toEqual([]);
      }
    });

    it('feature workflow at the HIGH tier adds exactly mutation-adequacy', () => {
      expect(getRequiredReviews('feature', 'high')).toEqual([
        'review',
        'mutation-adequacy',
      ]);
    });

    it('medium / low tiers reproduce the no-tier roster (high-tier-only)', () => {
      expect(getRequiredReviews('feature', 'medium')).toEqual(['review']);
      expect(getRequiredReviews('feature', 'low')).toEqual(['review']);
    });
  });

  /**
   * The roster comes from `TOOL_REGISTRY`, so the pin tracks the live surface.
   * `mutation-adequacy` is an action on this tool, not a separate tool.
   */
  describe('OrchestrateActionRoster_CurrentBuild_PinnedActionSet', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const actionNames = (orchestrate?.actions ?? []).map((a) => a.name);

    it('exposes exactly 85 actions (WLM operational-core #1578 added serialize_merge; DR-4 (#1630) added check_exploration_depth; WLM foundation task 008 added acquire_worktree, release_worktree, prune_worktrees; #1587 retired check_tdd_compliance; #1581 task 018 added discover_bridge; #1739 added cutover_readiness + cutover_decide; task 068 added invariants_amend; the effect-ledger remedy added reconcile_worktrees and moved stack_place here from exarchos_view; the bounded action executor added execute_intent; the semantic plane added settle, then prepare)', () => {
      expect(orchestrate).toBeDefined();
      expect(actionNames).toHaveLength(85);
    });

    it('carries the mutation-adequacy action (R5 / task 003)', () => {
      expect(actionNames).toContain('mutation-adequacy');
    });

    it('pins the current (sorted) action name set', () => {
      expect([...actionNames].sort()).toEqual([
        'acquire_worktree',
        'add_pr_comment',
        'agent_spec',
        'assess_refactor_scope',
        'assess_stack',
        'check_ci',
        'check_coderabbit',
        'check_context_economy',
        'check_contract_drift',
        'check_convergence',
        'check_coverage_thresholds',
        'check_design_completeness',
        'check_event_emissions',
        'check_exploration_depth',
        'check_integration_suite',
        'check_invariant_conformance',
        'check_mock_boundary',
        'check_operational_resilience',
        'check_plan_coverage',
        'check_polish_scope',
        'check_post_merge',
        'check_pr_comments',
        'check_provenance_chain',
        'check_review_verdict',
        'check_security_scan',
        'check_static_analysis',
        'check_task_decomposition',
        'check_test_adequacy',
        'check_workflow_determinism',
        'classify_review_items',
        'create_issue',
        'create_pr',
        'cutover_decide',
        'cutover_readiness',
        'debug_review_gate',
        'describe',
        'discover_bridge',
        'doctor',
        'execute_intent',
        'extract_fix_tasks',
        'extract_task',
        'finalize_oneshot',
        'generate_traceability',
        'get_pr_comments',
        'invariants_add',
        'invariants_amend',
        'invariants_scaffold',
        'investigation_timer',
        'list_prs',
        'merge_orchestrate',
        'merge_pr',
        'mutation-adequacy',
        'needs_schema_sync',
        'onboard',
        'post_delegation_check',
        'pre_synthesis_check',
        'prepare',
        'prepare_delegation',
        'prepare_review',
        'prepare_synthesis',
        'prune_stale_workflows',
        'prune_worktrees',
        'reconcile_state',
        'reconcile_worktrees',
        'release_worktree',
        'request_synthesize',
        'review_diff',
        'review_triage',
        'runbook',
        'select_debug_track',
        'serialize_merge',
        'settle',
        'setup_worktree',
        'spec_coverage_check',
        'stack_place',
        'task_claim',
        'task_complete',
        'task_fail',
        'validate_pr_body',
        'validate_pr_stack',
        'verify_delegation_saga',
        'verify_doc_links',
        'verify_review_triage',
        'verify_worktree',
        'verify_worktree_baseline',
      ]);
    });
  });
});
